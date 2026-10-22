/* Independent raw RGB16 decoding; stdout LE width/height then RGB16 LE words. */
#include <png.h>
#include <tiffio.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
static void put32(uint32_t value){for(unsigned i=0;i<4;i++)putchar((int)(value>>(i*8)&255));}
static int png16(const char *path){
    FILE *file=fopen(path,"rb");if(!file)return 3;
    png_structp png=png_create_read_struct(PNG_LIBPNG_VER_STRING,NULL,NULL,NULL);if(!png){fclose(file);return 4;}
    png_infop info=png_create_info_struct(png);if(!info){png_destroy_read_struct(&png,NULL,NULL);fclose(file);return 5;}
    if(setjmp(png_jmpbuf(png))){png_destroy_read_struct(&png,&info,NULL);fclose(file);return 6;}
    png_init_io(png,file);png_read_png(png,info,PNG_TRANSFORM_SWAP_ENDIAN,NULL);
    const png_uint_32 width=png_get_image_width(png,info),height=png_get_image_height(png,info);
    if(!width||!height||png_get_bit_depth(png,info)!=16||png_get_color_type(png,info)!=PNG_COLOR_TYPE_RGB||width>SIZE_MAX/6/height||png_get_rowbytes(png,info)!=(size_t)width*6){png_destroy_read_struct(&png,&info,NULL);fclose(file);return 7;}
    png_bytepp rows=png_get_rows(png,info);put32(width);put32(height);
    int result=0;for(uint32_t y=0;y<height;y++)if(fwrite(rows[y],1,(size_t)width*6,stdout)!=(size_t)width*6){result=8;break;}
    png_destroy_read_struct(&png,&info,NULL);fclose(file);return result?result:fflush(stdout)!=0;
}
static int tiff16(const char *path){
    TIFF *image=TIFFOpen(path,"r");if(!image)return 9;
    uint32_t width=0,height=0;uint16_t bits=0,samples=0,planar=0,photo=0,orientation=0;
    if(!TIFFGetField(image,TIFFTAG_IMAGEWIDTH,&width)||!TIFFGetField(image,TIFFTAG_IMAGELENGTH,&height)||!width||!height||width>SIZE_MAX/6/height){TIFFClose(image);return 10;}
    TIFFGetFieldDefaulted(image,TIFFTAG_BITSPERSAMPLE,&bits);TIFFGetFieldDefaulted(image,TIFFTAG_SAMPLESPERPIXEL,&samples);
    TIFFGetFieldDefaulted(image,TIFFTAG_PLANARCONFIG,&planar);TIFFGetFieldDefaulted(image,TIFFTAG_PHOTOMETRIC,&photo);TIFFGetFieldDefaulted(image,TIFFTAG_ORIENTATION,&orientation);
    if(bits!=16||samples!=3||planar!=PLANARCONFIG_CONTIG||photo!=PHOTOMETRIC_RGB||orientation!=ORIENTATION_TOPLEFT||TIFFScanlineSize(image)!=(tmsize_t)((size_t)width*6)){TIFFClose(image);return 11;}
    uint8_t *row=malloc((size_t)width*6);if(!row){TIFFClose(image);return 12;}
    put32(width);put32(height);int result=0;
    for(uint32_t y=0;y<height;y++){
        if(TIFFReadScanline(image,row,y,0)<0){result=13;break;}
        for(size_t i=0;i<(size_t)width*3;i++){uint16_t value;memcpy(&value,row+i*2,2);putchar(value&255);putchar(value>>8);}
    }
    free(row);TIFFClose(image);return result?result:fflush(stdout)!=0;
}
int main(int argc,char **argv){if(argc!=3)return 2;if(!strcmp(argv[1],"png"))return png16(argv[2]);if(!strcmp(argv[1],"tiff"))return tiff16(argv[2]);return 14;}
