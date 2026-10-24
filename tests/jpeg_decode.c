#define _POSIX_C_SOURCE 200809L
#include "zig_camera.h"
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
_Static_assert(sizeof(zc_jpeg_limits)==56,"JPEG limits ABI");
_Static_assert(sizeof(zc_jpeg_info)==96,"JPEG info ABI");
static zc_image_job_state wait_job(zc_jpeg_job *job){zc_image_job_state state;for(int i=0;i<10000;i++){assert(zc_jpeg_job_state_get(job,&state)==ZC_OK);if(state.finished)return state;assert(poll(NULL,0,1)==0);}assert(0);return state;}
static void pixels_equal(zc_jpeg_image *image){
 zc_jpeg_info info;uint64_t length=0;assert(zc_jpeg_info_get(image,&info)==ZC_OK&&info.struct_size==96&&info.width==1&&info.height==1&&info.components==3&&info.color_model==2&&info.scans==1&&info.stride==3&&info.length==3);
 uint8_t bytes[3]={0};const uint8_t expected[3]={213,74,31};assert(zc_jpeg_pixels_copy(image,NULL,0,&length)==ZC_OK&&length==3);assert(zc_jpeg_pixels_copy(image,bytes,3,&length)==ZC_OK);for(unsigned i=0;i<3;i++)assert(abs((int)bytes[i]-expected[i])<=3);
 memset(bytes,77,3);assert(zc_jpeg_pixels_copy(image,bytes,2,&length)==ZC_INVALID&&length==3);for(unsigned i=0;i<3;i++)assert(bytes[i]==77);
 assert(zc_jpeg_metadata_copy(image,1,NULL,0,&length)==ZC_OK&&length==0);assert(zc_jpeg_metadata_copy(image,3,NULL,0,&length)==ZC_INVALID&&length==0);
}
int main(void){
 uint8_t pixels[]={213,74,31};zc_raster raster={.struct_size=sizeof(zc_raster),.width=1,.height=1,.format=1,.bits=8,.stride=3,.length=3,.data=pixels};
 zc_image_options options;zc_default_image_options(&options);options.format=ZC_IMAGE_JPEG;options.quality=95;zc_image_blob *blob=NULL;assert(zc_raster_encode(&raster,&options,NULL,NULL,NULL,&blob)==ZC_OK);
 uint64_t size=0;assert(zc_image_blob_copy(blob,NULL,0,&size)==ZC_OK);uint8_t *encoded=malloc((size_t)size);assert(encoded);assert(zc_image_blob_copy(blob,encoded,size,&size)==ZC_OK);zc_image_blob_close(blob);
 zc_jpeg_limits limits;zc_default_jpeg_limits(&limits);limits.max_working_bytes=1024*1024;zc_jpeg_image *image=NULL;assert(zc_jpeg_decode(encoded,size,&limits,&image)==ZC_OK);pixels_equal(image);zc_jpeg_close(image);
 zc_jpeg_job *pending[4]={0};for(unsigned i=0;i<4;i++){assert(zc_jpeg_decode_async(encoded,size,&limits,&pending[i])==ZC_OK);assert(wait_job(pending[i]).result==ZC_OK);assert(zc_jpeg_job_take_image(pending[i],&image)==ZC_OK);zc_jpeg_close(image);}
 image=(void *)1;assert(zc_jpeg_decode(encoded,size,&limits,&image)==ZC_BUSY&&!image);for(unsigned i=0;i<4;i++)assert(zc_jpeg_job_close(pending[i])==ZC_OK);
 /* Unsupported coding must clear the result rather than return fabricated pixels. */
 int changed=0;for(uint64_t i=0;i+1<size;i++)if(encoded[i]==255&&encoded[i+1]==192){encoded[i+1]=195;image=(void *)1;assert(zc_jpeg_decode(encoded,size,&limits,&image)==ZC_UNSUPPORTED&&!image);encoded[i+1]=192;changed=1;break;}assert(changed);
 zc_jpeg_job *job=NULL;assert(zc_jpeg_decode_async(encoded,size,&limits,&job)==ZC_OK);memset(encoded,0,(size_t)size);zc_image_job_state state=wait_job(job);assert(state.result==ZC_OK&&state.input_bytes==size&&state.working_peak<=limits.max_working_bytes);
 assert(zc_jpeg_job_take_image(job,&image)==ZC_OK);zc_jpeg_image *twice=(void *)1;assert(zc_jpeg_job_take_image(job,&twice)==ZC_STATE&&!twice);assert(zc_jpeg_job_cancel(job)==0&&zc_jpeg_job_close(job)==ZC_OK);pixels_equal(image);zc_jpeg_close(image);
 image=(void *)1;assert(zc_jpeg_decode(encoded,size,&limits,&image)==ZC_INVALID&&!image);free(encoded);zc_jpeg_close(NULL);assert(zc_jpeg_job_close(NULL)==ZC_OK);
 puts("JPEG C ABI bounded copies, owned source/result, shared job admission, unsupported coding and transferred lifetime passed");return 0;
}
