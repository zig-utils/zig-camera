/* Independent libjpeg decoder for Home and optional system-JPEG output. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <jpeglib.h>
#include <assert.h>
#include <string.h>
#include "jpeg_pixels.h"
int main(int argc,char **argv) {
    if(argc==3&&!strcmp(argv[1],"jpeg"))return decodeJpegPixels(argv[2]);
    assert(argc==4);
    FILE *file=fopen(argv[1],"rb");assert(file);
    struct jpeg_decompress_struct decoder;
    struct jpeg_error_mgr errors;
    decoder.err=jpeg_std_error(&errors);jpeg_create_decompress(&decoder);
    jpeg_stdio_src(&decoder,file);assert(jpeg_read_header(&decoder,TRUE)==JPEG_HEADER_OK);
    assert(decoder.image_width==(unsigned)atoi(argv[2]) && decoder.image_height==(unsigned)atoi(argv[3]));
    for(int i=0;i<decoder.num_components;i++)assert(decoder.comp_info[i].h_samp_factor==1 && decoder.comp_info[i].v_samp_factor==1);
    decoder.out_color_space=JCS_RGB;assert(jpeg_start_decompress(&decoder));
    const size_t stride=(size_t)decoder.output_width*decoder.output_components;
    unsigned char *row=malloc(stride);assert(row);
    while(decoder.output_scanline<decoder.output_height){JSAMPROW rows[]={row};assert(jpeg_read_scanlines(&decoder,rows,1)==1);}
    assert(jpeg_finish_decompress(&decoder));jpeg_destroy_decompress(&decoder);free(row);fclose(file);
    return 0;
}
