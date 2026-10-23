/* Independent test-only APNG framing/CRC and libpng raster readback. The output
 * describes raw frame rectangles and controls, not composited playback. */
#include <png.h>
#include <zlib.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define LIMIT ((size_t)256*1024*1024)
typedef struct { unsigned char *data; size_t size; } Bytes;
typedef struct { Bytes compressed; uint32_t w,h,x,y,num,den,dispose,blend; } Image;
static void require(int ok,const char *why) { if(!ok){fprintf(stderr,"APNG readback: %s\n",why);exit(1);} }
static uint32_t number(const unsigned char *p) { return (uint32_t)p[0]<<24|(uint32_t)p[1]<<16|(uint32_t)p[2]<<8|p[3]; }
static void put(unsigned char *p,uint32_t n) { p[0]=(unsigned char)(n>>24);p[1]=(unsigned char)(n>>16);p[2]=(unsigned char)(n>>8);p[3]=(unsigned char)n; }
static void output(uint32_t n) { unsigned char p[4];put(p,n);require(fwrite(p,1,4,stdout)==4,"stdout"); }
static void append(Bytes *b,const void *p,size_t n) {
    require(n<=LIMIT-b->size,"buffer cap");if(!n)return;
    unsigned char *next=realloc(b->data,b->size+n);require(next!=NULL,"allocation");b->data=next;memcpy(b->data+b->size,p,n);b->size+=n;
}
static void chunk(Bytes *b,const char *type,const unsigned char *p,size_t n) {
    unsigned char u[4];put(u,(uint32_t)n);append(b,u,4);append(b,type,4);append(b,p,n);
    uLong crc=crc32(0,(const Bytef*)type,4);if(n)crc=crc32(crc,p,(uInt)n);put(u,(uint32_t)crc);append(b,u,4);
}
typedef struct {const unsigned char *data;size_t size;} Reader;
static void read_bytes(png_structp png,png_bytep out,png_size_t n) {
    Reader *r=png_get_io_ptr(png);if(n>r->size)png_error(png,"truncated reconstructed PNG");memcpy(out,r->data,n);r->data+=n;r->size-=n;
}
static void decode(const unsigned char header[13],const Image *image,unsigned channels,unsigned bits) {
    Bytes bytes={0};unsigned char ihdr[13];memcpy(ihdr,header,13);put(ihdr,image->w);put(ihdr+4,image->h);
    append(&bytes,"\211PNG\r\n\032\n",8);chunk(&bytes,"IHDR",ihdr,13);chunk(&bytes,"IDAT",image->compressed.data,image->compressed.size);chunk(&bytes,"IEND",NULL,0);
    Reader reader={bytes.data,bytes.size};png_structp png=png_create_read_struct(PNG_LIBPNG_VER_STRING,NULL,NULL,NULL);require(png!=NULL,"PNG owner");png_infop info=png_create_info_struct(png);require(info!=NULL,"PNG info");
    if(setjmp(png_jmpbuf(png))){fputs("APNG libpng decode failed\n",stderr);exit(1);}
    png_set_crc_action(png,PNG_CRC_ERROR_QUIT,PNG_CRC_ERROR_QUIT);png_set_read_fn(png,&reader,read_bytes);png_read_info(png,info);
    require(png_get_image_width(png,info)==image->w&&png_get_image_height(png,info)==image->h,"libpng geometry");
    require(png_get_channels(png,info)==channels&&png_get_bit_depth(png,info)==bits,"libpng format");
    size_t row=(size_t)image->w*channels*(bits/8);require(image->h<=LIMIT/row&&png_get_rowbytes(png,info)==row,"raster span");
    output(image->w);output(image->h);output(image->x);output(image->y);output(image->num);output(image->den);output(image->dispose);output(image->blend);output((uint32_t)(row*image->h));
    unsigned char *pixels=malloc(row);require(pixels!=NULL,"row allocation");
    for(uint32_t y=0;y<image->h;y++){png_read_row(png,pixels,NULL);require(fwrite(pixels,1,row,stdout)==row,"raster stdout");}
    png_read_end(png,info);png_destroy_read_struct(&png,&info,NULL);free(pixels);free(bytes.data);
}
int main(int argc,char **argv) {
    require(argc==2,"usage: decode-apng file");FILE *file=fopen(argv[1],"rb");require(file!=NULL,"open");require(fseek(file,0,SEEK_END)==0,"seek");long length=ftell(file);require(length>=8&&(size_t)length<=LIMIT,"input span");rewind(file);
    unsigned char *data=malloc((size_t)length);require(data!=NULL,"input allocation");require(fread(data,1,(size_t)length,file)==(size_t)length,"read");fclose(file);require(!memcmp(data,"\211PNG\r\n\032\n",8),"signature");
    Image images[257]={0};unsigned char header[13]={0};size_t at=8,current=0;uint32_t declared=0,plays=0,count=0,seq=0,poster=0;int ihdr=0,idat=0,ended=0;
    while(at<(size_t)length){
        require((size_t)length-at>=12,"chunk header");uint32_t n=number(data+at);require(n<=(size_t)length-at-12,"chunk span");const unsigned char *type=data+at+4,*p=type+4;
        require(crc32(0,type,n+4)==number(p+n),"CRC");
        if(!memcmp(type,"IHDR",4)){
            require(!ihdr++&&at==8&&n==13,"IHDR");memcpy(header,p,13);images[0].w=number(p);images[0].h=number(p+4);require(images[0].w&&images[0].h&&(p[8]==8||p[8]==16)&&(p[9]==0||p[9]==2||p[9]==6)&&!p[10]&&!p[11]&&!p[12],"supported noninterlaced header");
        }else if(!memcmp(type,"acTL",4)){
            require(ihdr&&!declared&&!idat&&n==8,"acTL order");declared=number(p);plays=number(p+4);require(declared&&declared<=256,"frame cap");
        }else if(!memcmp(type,"fcTL",4)){
            require(declared&&n==26&&count<declared&&number(p)==seq++,"fcTL sequence");if(!count)poster=idat?1:0;current=count+poster;
            Image *image=&images[current];image->w=number(p+4);image->h=number(p+8);image->x=number(p+12);image->y=number(p+16);image->num=(uint32_t)p[20]*256+p[21];image->den=(uint32_t)p[22]*256+p[23];image->dispose=p[24];image->blend=p[25];
            require(image->w&&image->h&&image->x<=number(header)&&image->y<=number(header+4)&&image->w<=number(header)-image->x&&image->h<=number(header+4)-image->y&&image->dispose<=2&&image->blend<=1,"frame control");
            if(!count&&!poster){require(!image->x&&!image->y&&image->w==number(header)&&image->h==number(header+4),"default frame geometry");}count++;
        }else if(!memcmp(type,"IDAT",4)){
            require(declared&&!current&&count<=1,"IDAT order");idat=1;append(&images[0].compressed,p,n);
        }else if(!memcmp(type,"fdAT",4)){
            require(idat&&count&&current>0&&n>=4&&number(p)==seq++,"fdAT sequence");append(&images[current].compressed,p+4,n-4);
        }else if(!memcmp(type,"IEND",4)){
            require(!n&&at+12==(size_t)length,"IEND");ended=1;
        }else require((type[0]&32)!=0,"unknown critical chunk");
        at+=12+n;
    }
    require(ended&&idat&&count==declared,"complete animation");unsigned channels=header[9]==0?1:header[9]==2?3:4;
    require(fwrite("ZCAP",1,4,stdout)==4,"stdout");output(number(header));output(number(header+4));output(count);output(plays);output(poster);output(header[8]);output(channels);output(0);
    for(uint32_t i=0;i<count+poster;i++){decode(header,&images[i],channels,header[8]);free(images[i].compressed.data);}
    free(data);return 0;
}
