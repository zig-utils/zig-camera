#define _POSIX_C_SOURCE 200809L
#include "zig_camera.h"
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
_Static_assert(sizeof(zc_image_job_limits)==32,"image limits ABI");
_Static_assert(sizeof(zc_image_job_state)==48,"image state ABI");
static zc_image_job_state wait_job(zc_image_job *job){
  zc_image_job_state state;
  for(int i=0;i<10000;i++){
    assert(zc_image_job_state_get(job,&state)==ZC_OK);
    if(state.finished)return state;
    assert(poll(NULL,0,1)==0);
  }
  assert(0);return state;
}
static void same_result(zc_image_job *job,zc_image_blob *expected){
  assert(wait_job(job).result==ZC_OK);
  zc_image_blob *actual=NULL;assert(zc_image_job_take_blob(job,&actual)==ZC_OK);
  uint64_t a=0,b=0;assert(zc_image_blob_copy(actual,NULL,0,&a)==ZC_OK);
  assert(zc_image_blob_copy(expected,NULL,0,&b)==ZC_OK && a==b && a>0);
  uint8_t *first=malloc((size_t)a),*second=malloc((size_t)b);assert(first && second);
  assert(zc_image_blob_copy(actual,first,a,&a)==ZC_OK);
  assert(zc_image_blob_copy(expected,second,b,&b)==ZC_OK && !memcmp(first,second,(size_t)a));
  free(first);free(second);zc_image_blob_close(actual);zc_image_blob_close(expected);
  assert(zc_image_job_close(job)==ZC_OK);
}
int main(void){
  zc_image_options options;zc_default_image_options(&options);options.format=ZC_IMAGE_PNG;
  zc_image_job_limits limits;zc_default_image_job_limits(&limits);
  limits.max_input_bytes=4096;limits.max_output_bytes=4096;limits.max_working_bytes=1024*1024;
  uint8_t pixels[31];memset(pixels,73,sizeof(pixels));
  zc_raster raster={.struct_size=sizeof(zc_raster),.width=2,.height=2,.format=2,.bits=16,.big_endian=1,.stride=17,.length=sizeof(pixels),.data=pixels};
  /* Exact last-row bound is 33 here: reject before native ownership. */
  zc_image_job *job=(zc_image_job *)1;
  assert(zc_raster_encode_async(&raster,&options,NULL,NULL,NULL,&limits,NULL,&job)==ZC_INVALID && !job);
  raster.format=1;raster.stride=15; /* 12+15 bytes, source padding excluded. */
  zc_image_blob *expected=NULL;assert(zc_raster_encode(&raster,&options,NULL,NULL,NULL,&expected)==ZC_OK);
  assert(zc_raster_encode_async(&raster,&options,NULL,NULL,NULL,&limits,NULL,&job)==ZC_OK);
  memset(pixels,99,sizeof(pixels));assert(wait_job(job).input_bytes==24);same_result(job,expected);
  zc_config cfg;zc_default_config(&cfg);cfg.width=18;cfg.height=10;cfg.raw=1;
  zc_camera *camera=NULL;assert(zc_open(&cfg,&camera)==ZC_OK);assert(zc_start(camera)==ZC_OK);
  zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
  assert(zc_encode_stream_image(camera,frame.token,ZC_MAIN,&options,&expected)==ZC_OK);
  assert(zc_encode_stream_image_async(camera,frame.token,ZC_MAIN,&options,NULL,NULL,&limits,NULL,&job)==ZC_OK);
  zc_image_blob *dng_expected=NULL;zc_image_job *dng_job=NULL;options.format=ZC_IMAGE_DNG;
  assert(zc_encode_stream_image(camera,frame.token,ZC_RAW,&options,&dng_expected)==ZC_OK);
  assert(zc_encode_stream_image_async(camera,frame.token,ZC_RAW,&options,NULL,NULL,&limits,NULL,&dng_job)==ZC_OK);
  options.format=ZC_IMAGE_PNG;
  assert(zc_release(camera,frame.token)==ZC_OK);
  zc_image_job *stale=(zc_image_job *)1;
  assert(zc_encode_stream_image_async(camera,frame.token,ZC_MAIN,&options,NULL,NULL,&limits,NULL,&stale)==ZC_STALE && !stale);
  assert(zc_stop(camera)==ZC_OK && zc_close(camera)==ZC_OK);
  same_result(job,expected);
  same_result(dng_job,dng_expected);
  puts("image jobs copy local requests and native-precision raster rows, reject stale/bounds and join after source closure");
  return 0;
}
