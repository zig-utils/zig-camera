#define _POSIX_C_SOURCE 200809L
#include "zig_camera.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
_Static_assert(sizeof(zc_raster_composite_options)==32,"composite ABI");
static zc_raster raster(uint8_t *data,uint64_t size,unsigned w,unsigned h,unsigned format,unsigned bits,unsigned big,unsigned stride) {
    zc_raster r={0};r.struct_size=sizeof(r);r.data=data;r.length=size;r.width=w;r.height=h;r.format=format;r.bits=bits;r.big_endian=big;r.stride=stride;return r;
}
static zc_image_job_state wait_job(zc_image_job *job) {
    zc_image_job_state state={0};
    for(unsigned i=0;i<10000;i++) {
        assert(!zc_image_job_state_get(job,&state));
        if(state.finished)return state;
        const struct timespec pause={0,1000000};nanosleep(&pause,NULL);
    }
    assert(!"image worker deadline");return state;
}
int main(void) {
    uint8_t bg[32];memset(bg,17,sizeof(bg));
    uint8_t fg[]={1,2,3,255,4,5,6,255,7,8,9,255,9,8,7,255};
    zc_raster base=raster(bg,sizeof(bg),1,1,0,8,0,1),overlay=raster(fg,sizeof(fg),2,2,2,8,0,8);
    zc_raster_composite_options options;zc_default_raster_composite_options(&options);
    assert(options.struct_size==32 && options.bits==0 && options.opacity==65535 && options.blend==ZC_COMPOSITE_OVER);
    options.x=options.y=-1;
    uint64_t size=0;assert(!zc_raster_composite(&base,&overlay,&options,NULL,0,&size) && size==4);
    uint8_t out[40];memset(out,73,sizeof(out));
    assert(zc_raster_composite(&base,&overlay,&options,out,3,&size)==ZC_INVALID);
    assert(zc_raster_composite(&base,&overlay,&options,bg,sizeof(bg),&size)==ZC_INVALID);
    for(unsigned i=0;i<sizeof(bg);i++)assert(bg[i]==17);
    assert(!zc_raster_composite(&base,&overlay,&options,out,sizeof(out),&size));
    assert(!memcmp(out,(uint8_t[]){9,8,7,255},4));for(unsigned i=4;i<sizeof(out);i++)assert(out[i]==73);
    options.struct_size--;memset(out,73,sizeof(out));
    assert(zc_raster_composite(&base,&overlay,&options,out,sizeof(out),&size)==ZC_INVALID && size==0);
    options.struct_size++;options.opacity=65536;
    assert(zc_raster_composite(&base,&overlay,&options,out,sizeof(out),&size)==ZC_INVALID);
    options.opacity=65535;options.reserved=1;
    assert(zc_raster_composite(&base,&overlay,&options,out,sizeof(out),&size)==ZC_INVALID);
    for(unsigned i=0;i<sizeof(out);i++)assert(out[i]==73);

    uint8_t gray[]={7,9,73,73,11,13},words[]={0x12,0x34,0x80,0x01,0xfe,0xdc,0xff,0xff};
    base=raster(gray,sizeof(gray),2,2,0,8,0,4);overlay=raster(words,sizeof(words),1,1,2,16,1,8);
    zc_default_raster_composite_options(&options);options.big_endian=1;
    zc_image_job_limits limits;zc_default_image_job_limits(&limits);limits.max_input_bytes=12;limits.max_output_bytes=32;limits.max_working_bytes=32;
    zc_image_job *job=NULL;assert(!zc_raster_composite_async(&base,&overlay,&options,&limits,&job) && job);
    memset(gray,99,sizeof(gray));memset(words,99,sizeof(words));
    const zc_image_job_state state=wait_job(job);
    assert(state.result==ZC_OK && state.input_bytes==12 && state.output_bytes==32 && state.working_peak==32);
    zc_image_blob *blob=NULL;assert(!zc_image_job_take_blob(job,&blob) && blob);
    assert(!zc_image_blob_copy(blob,out,sizeof(out),&size) && size==32);
    assert(!memcmp(out,(uint8_t[]){0x12,0x34,0x80,0x01,0xfe,0xdc,0xff,0xff},8));
    assert(!memcmp(out+8,(uint8_t[]){9,9,9,9,9,9,255,255},8));
    assert(!memcmp(out+16,(uint8_t[]){11,11,11,11,11,11,255,255},8));
    assert(!zc_image_job_close(job));zc_image_blob_close(blob);
    limits.max_input_bytes=11;job=(zc_image_job*)(uintptr_t)1;
    assert(zc_raster_composite_async(&base,&overlay,&options,&limits,&job)==ZC_INVALID && !job);
    limits.max_input_bytes=12;limits.max_output_bytes=31;
    assert(zc_raster_composite_async(&base,&overlay,&options,&limits,&job)==ZC_INVALID && !job);
    limits.max_output_bytes=32;limits.max_working_bytes=31;
    assert(!zc_raster_composite_async(&base,&overlay,&options,&limits,&job));
    assert(wait_job(job).result==ZC_NOMEM);assert(!zc_image_job_close(job));
    limits.max_working_bytes=32;assert(!zc_raster_composite_async(&base,&overlay,&options,&limits,&job));
    assert(wait_job(job).result==ZC_OK);assert(zc_image_job_cancel(job)==1);
    blob=(zc_image_blob*)(uintptr_t)1;assert(zc_image_job_take_blob(job,&blob)==ZC_CANCELLED && !blob);
    assert(!zc_image_job_close(job));
    puts("public raster compositing: clipping, words, guarded output, copied inputs, shared limits and joined cancellation passed");
    return 0;
}
