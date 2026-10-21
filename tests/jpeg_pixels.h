/* Shared independent libjpeg pixel reader for image and codec validation. */
#ifndef ZC_TEST_JPEG_PIXELS_H
#define ZC_TEST_JPEG_PIXELS_H
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <jpeglib.h>
static void jpegPut32(uint32_t value) {
    for(unsigned i=0;i<4;i++)putchar((int)((value>>(8*i))&255));
}
static int decodeJpegPixels(const char *path) {
    FILE *file=fopen(path,"rb");if(!file)return 14;
    struct jpeg_decompress_struct decoder;
    struct jpeg_error_mgr errors;
    decoder.err=jpeg_std_error(&errors);jpeg_create_decompress(&decoder);
    jpeg_stdio_src(&decoder,file);
    int rc=15;unsigned char *row=NULL;
    if(jpeg_read_header(&decoder,TRUE)!=JPEG_HEADER_OK)goto done;
    decoder.out_color_space=JCS_RGB;
    if(!jpeg_start_decompress(&decoder))goto done;
    const uint32_t width=decoder.output_width,height=decoder.output_height;
    if(!width||!height||decoder.output_components!=3||width>SIZE_MAX/3/height)goto done;
    const size_t stride=(size_t)width*3;
    row=malloc(stride);if(!row){rc=16;goto done;}
    jpegPut32(width);jpegPut32(height);
    while(decoder.output_scanline<decoder.output_height) {
        JSAMPROW rows[]={row};
        if(jpeg_read_scanlines(&decoder,rows,1)!=1||fwrite(row,1,stride,stdout)!=stride)goto done;
    }
    if(!jpeg_finish_decompress(&decoder))goto done;
    rc=fflush(stdout)!=0;
 done:
    free(row);jpeg_destroy_decompress(&decoder);fclose(file);return rc;
}
#endif
