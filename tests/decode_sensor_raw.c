/* Independent libtiff sample readback for uncompressed Bayer/monochrome DNG. */
#include <tiffio.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void put32(uint32_t value){for(unsigned i=0;i<4;i++)putchar((int)((value>>(i*8))&255));}
int main(int argc,char **argv){
    if(argc!=2)return 2;
    TIFF *image=TIFFOpen(argv[1],"r");if(!image)return 3;
    uint32_t width=0,height=0;uint16_t bits=0,samples=0,planar=0,photo=0,compression=0;
    if(!TIFFGetField(image,TIFFTAG_IMAGEWIDTH,&width)||!TIFFGetField(image,TIFFTAG_IMAGELENGTH,&height)||!width||!height||width>SIZE_MAX/2/height){TIFFClose(image);return 4;}
    TIFFGetFieldDefaulted(image,TIFFTAG_BITSPERSAMPLE,&bits);TIFFGetFieldDefaulted(image,TIFFTAG_SAMPLESPERPIXEL,&samples);
    TIFFGetFieldDefaulted(image,TIFFTAG_PLANARCONFIG,&planar);TIFFGetFieldDefaulted(image,TIFFTAG_PHOTOMETRIC,&photo);TIFFGetFieldDefaulted(image,TIFFTAG_COMPRESSION,&compression);
    if(bits!=16||samples!=1||planar!=PLANARCONFIG_CONTIG||(photo!=32803&&photo!=34892)||compression!=1||TIFFScanlineSize(image)!=(tmsize_t)((size_t)width*2)){TIFFClose(image);return 5;}
    uint8_t *row=malloc((size_t)width*2);if(!row){TIFFClose(image);return 6;}
    put32(width);put32(height);int result=0;
    for(uint32_t y=0;y<height;y++){
        if(TIFFReadScanline(image,row,y,0)<0){result=7;break;}
        for(size_t x=0;x<width;x++){uint16_t value;memcpy(&value,row+x*2,2);putchar(value&255);putchar(value>>8);}
    }
    free(row);TIFFClose(image);return result?result:fflush(stdout)!=0;
}
