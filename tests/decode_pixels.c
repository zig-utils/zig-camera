/* Test-only libpng raw sample reader, including gray/RGBA and network u16. */
#include <png.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
static void number(uint32_t n){uint8_t p[4]={(uint8_t)(n>>24),(uint8_t)(n>>16),(uint8_t)(n>>8),(uint8_t)n};if(fwrite(p,1,4,stdout)!=4)exit(1);}
int main(int argc,char **argv){
    if(argc!=2)return 2;
    FILE *file=fopen(argv[1],"rb");if(!file)return 3;
    png_structp png=png_create_read_struct(PNG_LIBPNG_VER_STRING,NULL,NULL,NULL);if(!png)return 4;
    png_infop info=png_create_info_struct(png);if(!info)return 5;
    if(setjmp(png_jmpbuf(png)))return 6;
    png_set_crc_action(png,PNG_CRC_ERROR_QUIT,PNG_CRC_ERROR_QUIT);png_init_io(png,file);png_read_info(png,info);
    const png_uint_32 w=png_get_image_width(png,info),h=png_get_image_height(png,info);
    const unsigned bits=png_get_bit_depth(png,info),channels=png_get_channels(png,info),kind=png_get_color_type(png,info);
    if(!w||!h||(bits!=8&&bits!=16)||(kind!=0&&kind!=2&&kind!=6)||(channels!=1&&channels!=3&&channels!=4)||(size_t)w*h>64*1024*1024)return 7;
    png_read_update_info(png,info);const size_t row=(size_t)w*channels*(bits/8);
    if(png_get_rowbytes(png,info)!=row)return 8;
    uint8_t *pixels=malloc(row);if(!pixels)return 9;
    if(fwrite("ZCPI",1,4,stdout)!=4){return 10;}
    number(w);number(h);number(bits);number(channels);
    for(png_uint_32 y=0;y<h;y++){png_read_row(png,pixels,NULL);if(fwrite(pixels,1,row,stdout)!=row)return 11;}
    png_read_end(png,info);free(pixels);png_destroy_read_struct(&png,&info,NULL);fclose(file);return 0;
}
