#define _POSIX_C_SOURCE 200809L
#include "zig_camera.h"
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void){
 for(int cancel=0;cancel<2;cancel++){
  char path[]="/tmp/zc-encoded-bytes-XXXXXX";int fd=mkstemp(path);assert(fd>=0);assert(write(fd,"old",3)==3 && close(fd)==0);
  zc_image_file *file=NULL;assert(zc_image_file_create(path,&file)==ZC_OK && file);
  int32_t result=0;assert(zc_image_file_preparation_result(file,&result)==ZC_TIMEOUT);
  uint8_t bytes[32];memset(bytes,73,sizeof(bytes));assert(zc_image_file_prepare_bytes(file,bytes,sizeof(bytes))==ZC_OK);memset(bytes,99,sizeof(bytes));
  if(cancel)assert(zc_image_file_cancel(file)==1);
  int ready=0;for(int i=0;i<10000;i++){int rc=zc_image_file_preparation_result(file,&result);if(rc!=ZC_TIMEOUT){assert(rc==ZC_OK);ready=1;break;}assert(poll(NULL,0,1)==0);}
  assert(ready && result==(cancel?ZC_STALE:ZC_OK));
  assert(zc_image_file_close(file)==ZC_BUSY);
  assert(zc_image_file_finish(file,cancel?0:1)==ZC_OK);
  zc_image_file_state state;ready=0;for(int i=0;i<10000;i++){assert(zc_image_file_state_get(file,&state)==ZC_OK);if(state.finished){ready=1;break;}assert(poll(NULL,0,1)==0);}
  assert(ready && state.committed==(cancel?0u:1u));assert(zc_image_file_close(file)==ZC_OK);
  FILE *input=fopen(path,"rb");assert(input);uint8_t saved[64];size_t length=fread(saved,1,sizeof(saved),input);assert(fclose(input)==0);
  if(cancel)assert(length==3 && !memcmp(saved,"old",3));else{assert(length==32);for(size_t i=0;i<length;i++)assert(saved[i]==73);}
  assert(unlink(path)==0);
 }
 puts("encoded file staging owns copied bytes, joins its worker and preserves cancellation/publication");return 0;
}
