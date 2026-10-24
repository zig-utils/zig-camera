#include "zig_camera.h"
#include <assert.h>
#include <stdint.h>
int main(void) {
  zc_socket_write_cursor c;
  _Static_assert(sizeof(c)==32,"cursor layout");
  assert(zc_socket_write_init(10,4,1,&c)==ZC_OK);
  assert(zc_socket_write_accept(&c,1)==ZC_INVALID && c.offset==0);
  assert(zc_socket_write_accept(&c,0)==ZC_OK && c.offset==0);
  assert(zc_socket_write_accept(&c,4)==ZC_OK && c.offset==4);
  uint64_t offset=99; uint32_t size=99;
  assert(zc_socket_write_next(&c,&offset,&size)==ZC_OK && offset==4 && size==4);
  assert(zc_socket_write_accept(&c,4)==ZC_OK);
  assert(zc_socket_write_accept(&c,2)==ZC_OK);
  assert(zc_socket_write_next(&c,&offset,&size)==ZC_OK && offset==10 && size==0);
  assert(zc_socket_write_init(UINT64_MAX,7,0,&c)==ZC_OK);
  c.offset=UINT64_MAX-3;
  assert(zc_socket_write_accept(&c,2)==ZC_OK);
  assert(zc_socket_write_next(&c,&offset,&size)==ZC_OK && size==1);
  assert(zc_socket_write_accept(&c,1)==ZC_OK);
  c.reserved=1;
  assert(zc_socket_write_next(&c,&offset,&size)==ZC_INVALID && offset==0 && size==0);
  assert(zc_socket_write_init(10,65508,1,&c)==ZC_INVALID && c.struct_size==0);
}
