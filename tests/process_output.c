#include "zig_camera.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>
int main(void) {
  _Static_assert(sizeof(zc_byte_tail_state)==40,"tail layout");
  _Static_assert(sizeof(zc_process_output_message)==32,"message layout");
  zc_byte_tail_state state;uint8_t arena[5],out[5];uint64_t length=0;
  assert(zc_byte_tail_init(5,&state)==ZC_OK);
  assert(zc_byte_tail_append(&state,arena,5,(const uint8_t *)"abcdefg",7)==ZC_OK);
  assert(zc_byte_tail_copy(&state,arena,5,0,0,&length)==ZC_OK && length==5);
  memset(out,0xa5,5);
  assert(zc_byte_tail_copy(&state,arena,5,out,4,&length)==ZC_INVALID && out[0]==0xa5);
  assert(zc_byte_tail_copy(&state,arena,5,out,5,&length)==ZC_OK && !memcmp(out,"cdefg",5));
  const uint8_t ready[32]={'Z','C','O','1',1,0,0,0,0,0,0,0,0,0,0,0,123,0,0,0,0,0,0,0,200,1,0,0,0,0,0,0};
  zc_process_output_message message;
  assert(zc_process_output_decode(ready,32,&message)==ZC_OK && message.kind==ZC_PROCESS_OUTPUT_READY && message.consumer_pid==456);
  assert(zc_process_output_decode(ready,31,&message)==ZC_INVALID && message.consumer_pid==0);
  assert(zc_byte_tail_init(0,&state)==ZC_OK);
  assert(zc_byte_tail_append(&state,0,0,(const uint8_t *)"discarded",9)==ZC_OK && state.total==9);
  assert(zc_byte_tail_copy(&state,0,0,0,0,&length)==ZC_OK && length==0);
}
