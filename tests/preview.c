/* Exercise the actual SDL composition path before presentation/readback. */
#include "../native/preview.c"
#include <assert.h>
static void pixels(zc_preview *p,uint8_t *out) {
    assert(zcm_preview_render(p,0)==ZC_OK);
    assert(SDL_RenderReadPixels(p->renderer,NULL,SDL_PIXELFORMAT_RGB24,out,12)==0);
}
static int wrong_thread(void *value) {
    zc_preview *p=value;
    uint8_t rgba[4]={1,2,3,255};
    assert(zcm_preview_overlay(p,rgba,1,1,4)==ZC_STATE);
    assert(zcm_preview_close(p)==ZC_STATE);
    return 0;
}
int main(void) {
    assert(SDL_setenv("SDL_VIDEODRIVER","dummy",1)==0);
    SDL_SetHint(SDL_HINT_RENDER_DRIVER,"software");
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY,"0");
    zc_preview *p=NULL;
    assert(zcm_preview_open("overlay-test",4,2,&p)==ZC_OK);
    uint8_t rgb[24]; memset(rgb,100,sizeof(rgb));
    zc_frame f={0}; f.token=1; f.main.width=4; f.main.height=2; f.main.stride=12; f.main.plane_count=1;
    strcpy(f.main.format,"BGR888"); f.main.planes[0].data=rgb; f.main.planes[0].length=24; f.main.planes[0].bytes_used=24;
    assert(zcm_preview_show(p,&f)==ZC_OK);
    uint8_t rgba[]={255,0,0,0, 0,200,0,128};
    assert(zcm_preview_overlay(p,rgba,2,1,8)==ZC_OK);
    memset(rgba,0,sizeof(rgba)); /* SDL owns uploaded pixels. */
    uint8_t out[24]; pixels(p,out);
    for (int y=0;y<2;y++) for (int x=0;x<4;x++) {
        const uint8_t *v=out+y*12+x*3;
        if(x<2) assert(v[0]==100 && v[1]==100 && v[2]==100);
        else { assert(v[0]>=49 && v[0]<=50); assert(v[1]>=149 && v[1]<=150); assert(v[2]>=49 && v[2]<=50); }
    }
    assert(zcm_preview_overlay(p,rgba,2,1,7)==ZC_INVALID);
    uint8_t previous[24]; memcpy(previous,out,24); pixels(p,out); assert(!memcmp(previous,out,24));
    uint8_t solid[]={5,10,240,255};
    assert(zcm_preview_overlay(p,solid,1,1,4)==ZC_OK); pixels(p,out);
    for(int i=0;i<24;i+=3) assert(out[i]==5 && out[i+1]==10 && out[i+2]==240);
    assert(!memcmp(rgb,(uint8_t[24]){100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100},24));
    assert(zcm_preview_overlay(p,NULL,0,0,0)==ZC_OK); pixels(p,out);
    for(int i=0;i<24;i++) assert(out[i]==100);
    /* One preview's overlay does not affect another window. */
    zc_preview *peer=NULL; assert(zcm_preview_open("peer",4,2,&peer)==ZC_OK);
    assert(zcm_preview_overlay(p,solid,1,1,4)==ZC_OK);
    assert(zcm_preview_show(peer,&f)==ZC_OK); pixels(peer,out);
    for(int i=0;i<24;i++) assert(out[i]==100);
    SDL_Thread *thread=SDL_CreateThread(wrong_thread,"owner-check",p);
    assert(thread); int status=1; SDL_WaitThread(thread,&status); assert(status==0);
    /* Logical camera extent excludes the resized window's black bars. */
    SDL_SetWindowSize(p->window,8,8);
    SDL_PumpEvents();
    int ow=0,oh=0; assert(SDL_GetRendererOutputSize(p->renderer,&ow,&oh)==0 && ow==8 && oh==8);
    assert(SDL_RenderSetLogicalSize(p->renderer,4,2)==0);
    assert(zcm_preview_render(p,0)==ZC_OK);
    /* SDL 2 readback clips to its viewport: reset after queuing composition
     * so this assertion also reads the surrounding bars. */
    assert(SDL_RenderSetLogicalSize(p->renderer,0,0)==0);
    uint8_t resized[8*8*3];
    assert(SDL_RenderReadPixels(p->renderer,NULL,SDL_PIXELFORMAT_RGB24,resized,8*3)==0);
    for(int y=0;y<8;y++) for(int x=0;x<8;x++) {
        const uint8_t *v=resized+(y*8+x)*3;
        if(y<2 || y>=6) assert(v[0]==0 && v[1]==0 && v[2]==0);
        else assert(v[0]==5 && v[1]==10 && v[2]==240);
    }
    assert(zcm_preview_close(peer)==ZC_OK);
    assert(zcm_preview_close(p)==ZC_OK);
    return 0;
}
