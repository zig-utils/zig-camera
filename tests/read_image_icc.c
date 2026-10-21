/* Independent container libraries extract the profile; Little CMS opens it.
 * Test-only. stdout is the original embedded ICC bytes. */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <jpeglib.h>
#include <png.h>
#include <tiffio.h>
#include <lcms2.h>
static int emit(const void *bytes,size_t size) {
    if(!bytes || size<132 || size>16*1024*1024)return 3;
    cmsHPROFILE profile=cmsOpenProfileFromMem(bytes,(cmsUInt32Number)size);
    if(!profile)return 4;
    const int rgb=cmsGetColorSpace(profile)==cmsSigRgbData;
    cmsCloseProfile(profile);
    if(!rgb)return 5;
    return fwrite(bytes,1,size,stdout)==size && !fflush(stdout) ? 0 : 6;
}
int main(int argc,char **argv) {
    if(argc!=3)return 2;
    if(!strcmp(argv[1],"jpeg")) {
        FILE *file=fopen(argv[2],"rb");if(!file)return 7;
        struct jpeg_decompress_struct decoder;
        struct jpeg_error_mgr errors;
        decoder.err=jpeg_std_error(&errors);jpeg_create_decompress(&decoder);
        jpeg_stdio_src(&decoder,file);jpeg_save_markers(&decoder,JPEG_APP0+2,0xffff);
        if(jpeg_read_header(&decoder,TRUE)!=JPEG_HEADER_OK){jpeg_destroy_decompress(&decoder);fclose(file);return 8;}
        JOCTET *bytes=NULL;unsigned int size=0;
        const int found=jpeg_read_icc_profile(&decoder,&bytes,&size);
        const int rc=found ? emit(bytes,size) : 9;
        free(bytes);jpeg_destroy_decompress(&decoder);fclose(file);return rc;
    }
    if(!strcmp(argv[1],"png")) {
        FILE *file=fopen(argv[2],"rb");if(!file)return 10;
        png_structp png=png_create_read_struct(PNG_LIBPNG_VER_STRING,NULL,NULL,NULL);
        if(!png){fclose(file);return 11;}
        png_infop info=png_create_info_struct(png);
        if(!info){png_destroy_read_struct(&png,NULL,NULL);fclose(file);return 12;}
        if(setjmp(png_jmpbuf(png))){png_destroy_read_struct(&png,&info,NULL);fclose(file);return 13;}
        png_init_io(png,file);png_read_info(png,info);
        png_charp name=NULL;int compression=0;png_bytep bytes=NULL;png_uint_32 size=0;
        const int found=png_get_iCCP(png,info,&name,&compression,&bytes,&size);
        const int rc=found && compression==0 ? emit(bytes,size) : 14;
        png_destroy_read_struct(&png,&info,NULL);fclose(file);return rc;
    }
    if(!strcmp(argv[1],"tiff")) {
        TIFF *image=TIFFOpen(argv[2],"r");if(!image)return 15;
        uint32_t size=0;void *bytes=NULL;
        const int found=TIFFGetField(image,TIFFTAG_ICCPROFILE,&size,&bytes);
        const int rc=found ? emit(bytes,size) : 16;
        TIFFClose(image);return rc;
    }
    return 17;
}
