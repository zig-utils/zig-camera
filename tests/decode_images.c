/* Independent platform image decoders. stdout: LE width/height, tight RGB8. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#ifdef __APPLE__
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#else
#include <png.h>
#include <tiffio.h>
#include <SDL.h>
#endif
static void put32(uint32_t v) { for(unsigned i=0;i<4;i++) putchar((int)(v>>(8*i)&255)); }
static int emit(uint32_t width,uint32_t height,const uint8_t *data,size_t stride,unsigned channels) {
    put32(width);put32(height);
    for(uint32_t y=0;y<height;y++) for(uint32_t x=0;x<width;x++)
        if(fwrite(data+(size_t)y*stride+(size_t)x*channels,1,3,stdout)!=3)return 1;
    return fflush(stdout)!=0;
}
int main(int argc,char **argv) {
    if(argc!=3)return 2;
#ifdef __APPLE__
    (void)argv[1];
    CFURLRef url=CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)argv[2],strlen(argv[2]),false);
    if(!url)return 3;
    CGImageSourceRef source=CGImageSourceCreateWithURL(url,NULL);CFRelease(url);
    if(!source)return 4;
    CGImageRef image=CGImageSourceCreateImageAtIndex(source,0,NULL);CFRelease(source);
    if(!image)return 5;
    size_t w=CGImageGetWidth(image),h=CGImageGetHeight(image);
    if(!w||!h||w>UINT32_MAX||h>UINT32_MAX||w>SIZE_MAX/4/h){CGImageRelease(image);return 6;}
    uint8_t *pixels=calloc(w*h,4);if(!pixels){CGImageRelease(image);return 7;}
    CGColorSpaceRef colors=CGColorSpaceCreateDeviceRGB();
    CGContextRef context=CGBitmapContextCreate(pixels,w,h,8,w*4,colors,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(colors);
    if(!context){free(pixels);CGImageRelease(image);return 8;}
    CGContextDrawImage(context,CGRectMake(0,0,w,h),image);
    const int rc=emit((uint32_t)w,(uint32_t)h,pixels,w*4,4);
    CGContextRelease(context);CGImageRelease(image);free(pixels);return rc;
#else
    if(!strcmp(argv[1],"png")) {
        png_image image;memset(&image,0,sizeof(image));image.version=PNG_IMAGE_VERSION;
        if(!png_image_begin_read_from_file(&image,argv[2]))return 3;
        image.format=PNG_FORMAT_RGB;
        uint8_t *pixels=malloc(PNG_IMAGE_SIZE(image));if(!pixels){png_image_free(&image);return 4;}
        if(!png_image_finish_read(&image,NULL,pixels,0,NULL)){free(pixels);png_image_free(&image);return 5;}
        int rc=emit(image.width,image.height,pixels,PNG_IMAGE_ROW_STRIDE(image),3);
        free(pixels);png_image_free(&image);return rc;
    }
    if(!strcmp(argv[1],"bmp")) {
        SDL_Surface *source=SDL_LoadBMP(argv[2]);if(!source)return 6;
        SDL_Surface *rgb=SDL_ConvertSurfaceFormat(source,SDL_PIXELFORMAT_RGB24,0);SDL_FreeSurface(source);
        if(!rgb)return 7;
        int rc=emit((uint32_t)rgb->w,(uint32_t)rgb->h,rgb->pixels,(size_t)rgb->pitch,3);
        SDL_FreeSurface(rgb);return rc;
    }
    if(!strcmp(argv[1],"tiff")) {
        TIFF *image=TIFFOpen(argv[2],"r");if(!image)return 8;
        uint32_t w=0,h=0;uint16_t bits=0,samples=0,planar=0,photometric=0,orientation=0;
        if(!TIFFGetField(image,TIFFTAG_IMAGEWIDTH,&w)||!TIFFGetField(image,TIFFTAG_IMAGELENGTH,&h)||!w||!h){TIFFClose(image);return 9;}
        TIFFGetFieldDefaulted(image,TIFFTAG_BITSPERSAMPLE,&bits);TIFFGetFieldDefaulted(image,TIFFTAG_SAMPLESPERPIXEL,&samples);
        TIFFGetFieldDefaulted(image,TIFFTAG_PLANARCONFIG,&planar);TIFFGetFieldDefaulted(image,TIFFTAG_PHOTOMETRIC,&photometric);TIFFGetFieldDefaulted(image,TIFFTAG_ORIENTATION,&orientation);
        if(bits!=8||samples!=3||planar!=PLANARCONFIG_CONTIG||photometric!=PHOTOMETRIC_RGB||orientation!=ORIENTATION_TOPLEFT||w>SIZE_MAX/3/h){TIFFClose(image);return 10;}
        const size_t stride=(size_t)w*3;uint8_t *pixels=malloc(stride*h);if(!pixels){TIFFClose(image);return 11;}
        for(uint32_t y=0;y<h;y++)if(TIFFReadScanline(image,pixels+(size_t)y*stride,y,0)<0){free(pixels);TIFFClose(image);return 12;}
        int rc=emit(w,h,pixels,stride,3);free(pixels);TIFFClose(image);return rc;
    }
    return 13;
#endif
}
