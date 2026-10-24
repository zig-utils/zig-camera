#define _POSIX_C_SOURCE 200809L
#include "zig_camera.h"
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
_Static_assert(sizeof(zc_png_limits)==48,"PNG limits ABI");
_Static_assert(sizeof(zc_png_info)==96,"PNG info ABI");
_Static_assert(sizeof(zc_png_frame_info)==64,"PNG frame ABI");
static zc_image_job_state wait_job(zc_png_job *job){
  zc_image_job_state state;
  for(int i=0;i<10000;i++){
    assert(zc_png_job_state_get(job,&state)==ZC_OK);
    if(state.finished)return state;
    assert(poll(NULL,0,1)==0);
  }
  assert(0);return state;
}
static void pixels_equal(zc_png_image *image){
  zc_png_info info;zc_png_frame_info frame;uint64_t length=0;
  assert(zc_png_info_get(image,&info)==ZC_OK && info.struct_size==sizeof(info) && info.frame_count==0 && info.source_depth==16 && info.source_color==2);
  assert(zc_png_frame_get(image,0,&frame)==ZC_OK && frame.width==1 && frame.height==1 && frame.format==1 && frame.bits==16 && frame.stride==6 && frame.length==6);
  assert(zc_png_frame_copy(image,0,NULL,0,&length)==ZC_OK && length==6);
  uint8_t bytes[6]={0};const uint8_t expected[6]={0x34,0x12,0x78,0x56,0xbc,0x9a};
  assert(zc_png_frame_copy(image,0,bytes,6,&length)==ZC_OK && !memcmp(bytes,expected,6));
  memset(bytes,77,6);assert(zc_png_frame_copy(image,0,bytes,5,&length)==ZC_INVALID && length==6);
  for(int i=0;i<6;i++)assert(bytes[i]==77);
  assert(zc_png_frame_copy(image,1,bytes,6,&length)==ZC_INVALID && length==0);
  assert(zc_png_metadata_copy(image,1,NULL,0,&length)==ZC_OK && length==0);
  assert(zc_png_metadata_copy(image,4,NULL,0,&length)==ZC_INVALID && length==0);
}
int main(void){
  uint8_t pixels[]={0x34,0x12,0x78,0x56,0xbc,0x9a};
  zc_raster raster={.struct_size=sizeof(zc_raster),.width=1,.height=1,.format=1,.bits=16,.stride=6,.length=6,.data=pixels};
  zc_image_options options;zc_default_image_options(&options);options.format=ZC_IMAGE_PNG;
  zc_image_blob *blob=NULL;assert(zc_raster_encode(&raster,&options,NULL,NULL,NULL,&blob)==ZC_OK);
  uint64_t size=0;assert(zc_image_blob_copy(blob,NULL,0,&size)==ZC_OK);
  uint8_t *encoded=malloc((size_t)size);assert(encoded);assert(zc_image_blob_copy(blob,encoded,size,&size)==ZC_OK);zc_image_blob_close(blob);
  zc_png_limits limits;zc_default_png_limits(&limits);limits.max_working_bytes=1024*1024;
  zc_png_image *sync=NULL;assert(zc_png_decode(encoded,size,&limits,&sync)==ZC_OK);pixels_equal(sync);zc_png_close(sync);
  /* Closing taken images must not retire copied job inputs/admission. */
  zc_png_job *pending[4]={0};
  for(int i=0;i<4;i++){
    assert(zc_png_decode_async(encoded,size,&limits,&pending[i])==ZC_OK);
    assert(wait_job(pending[i]).result==ZC_OK);
    zc_png_image *taken=NULL;assert(zc_png_job_take_image(pending[i],&taken)==ZC_OK);zc_png_close(taken);
  }
  sync=(zc_png_image *)1;int held=zc_png_decode(encoded,size,&limits,&sync);
  if(held!=ZC_BUSY||sync){
    if(held==ZC_OK)zc_png_close(sync);
    for(int i=0;i<4;i++)assert(zc_png_job_close(pending[i])==ZC_OK);
    free(encoded);fputs("PNG reservation released before copied job inputs retired\n",stderr);return 44;
  }
  for(int i=0;i<4;i++)assert(zc_png_job_close(pending[i])==ZC_OK);
  zc_png_job *job=NULL;assert(zc_png_decode_async(encoded,size,&limits,&job)==ZC_OK);memset(encoded,0,(size_t)size);
  zc_image_job_state state=wait_job(job);assert(state.result==ZC_OK && state.input_bytes==size && state.working_peak<=limits.max_working_bytes);
  zc_png_image *image=NULL;assert(zc_png_job_take_image(job,&image)==ZC_OK);
  zc_png_image *twice=(zc_png_image *)1;assert(zc_png_job_take_image(job,&twice)==ZC_STATE && !twice);
  assert(zc_png_job_cancel(job)==0 && zc_png_job_close(job)==ZC_OK);pixels_equal(image);zc_png_close(image);
  sync=(zc_png_image *)1;assert(zc_png_decode(encoded,size,&limits,&sync)==ZC_INVALID && !sync);free(encoded);
  zc_png_close(NULL);assert(zc_png_job_close(NULL)==ZC_OK);
  puts("PNG ABI exact words, bounded copies, copied async source and transferred image lifetime passed");return 0;
}
