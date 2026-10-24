#include "zig_camera.h"
#include <assert.h>
#include <string.h>
int main(void) {
    zc_apng_compositor *canvas = (void *)1;
    assert(zc_apng_compositor_open(2, 1, 8, 15, &canvas) == ZC_INVALID && !canvas);
    assert(zc_apng_compositor_open(2, 1, 8, 16, &canvas) == ZC_OK);
    uint8_t red[] = {255,0,0,255}, blue[] = {0,0,255,128}, actual[8];
    zc_raster patch = {.struct_size=sizeof(patch),.width=1,.height=1,.format=ZC_APNG_RGBA,.bits=8,.stride=4,.length=4,.data=red};
    assert(zc_apng_compositor_push(canvas,&patch,0,0,ZC_APNG_DISPOSE_NONE,ZC_APNG_BLEND_SOURCE)==ZC_OK);
    patch.data=blue;
    assert(zc_apng_compositor_push(canvas,&patch,0,0,ZC_APNG_DISPOSE_PREVIOUS,ZC_APNG_BLEND_OVER)==ZC_OK);
    uint64_t length=0;
    memset(actual,73,sizeof(actual));
    assert(zc_apng_compositor_copy(canvas,actual,7,&length)==ZC_INVALID && length==8 && actual[0]==73);
    assert(zc_apng_compositor_copy(canvas,actual,8,&length)==ZC_OK);
    assert(!memcmp(actual,(uint8_t[]){127,0,128,255,0,0,0,0},8));
    assert(zc_apng_compositor_push(canvas,&patch,2,0,0,0)==ZC_INVALID);
    assert(zc_apng_compositor_copy(canvas,actual,8,&length)==ZC_OK && actual[0]==127);
    assert(zc_apng_compositor_push(canvas,&patch,1,0,0,0)==ZC_OK);
    assert(zc_apng_compositor_copy(canvas,actual,8,&length)==ZC_OK);
    assert(!memcmp(actual,(uint8_t[]){255,0,0,255,0,0,255,128},8));
    zc_apng_compositor_reset(canvas);
    assert(zc_apng_compositor_copy(canvas,actual,8,&length)==ZC_OK);
    assert(!memcmp(actual,(uint8_t[8]){0},8));
    zc_apng_compositor_close(canvas);
    zc_apng_compositor_close(NULL);
    zc_apng_compositor *held[4];
    for(int i=0;i<4;i++) assert(zc_apng_compositor_open(1,1,16,16,&held[i])==ZC_OK);
    assert(zc_apng_compositor_open(1,1,16,16,&canvas)==ZC_BUSY && !canvas);
    for(int i=0;i<4;i++) zc_apng_compositor_close(held[i]);
    assert(zc_apng_compositor_open(1,1,16,16,&canvas)==ZC_OK);
    zc_apng_compositor_close(canvas);
    return 0;
}
