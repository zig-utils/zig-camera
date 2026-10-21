/* Exercise the actual SDL composition path before presentation/readback. */
#include "../native/preview.c"
#include <assert.h>
#include <stdio.h>
static void pixels(zc_preview *p,uint8_t *out) {
    assert(zcm_preview_render(p,0)==ZC_OK);
    assert(SDL_RenderReadPixels(p->renderer,NULL,SDL_PIXELFORMAT_RGB24,out,12)==0);
}
static int wrong_thread(void *value) {
    zc_preview *p=value;
    uint8_t rgba[4]={1,2,3,255};
    assert(zcm_preview_overlay(p,rgba,1,1,4)==ZC_STATE);
    assert(zcm_preview_close(p)==ZC_STATE);
    zc_preview_view view;zc_default_preview_view(&view);assert(zc_preview_set_view(p,&view)==ZC_STATE);
    return 0;
}
static void transforms(void) {
    zc_preview *p=NULL; assert(zcm_preview_open("transforms",3,2,&p)==ZC_OK);
    uint8_t rgb[18]; for(int i=0;i<6;i++) { rgb[i*3]=(uint8_t)((i+1)*30);rgb[i*3+1]=100;rgb[i*3+2]=5; }
    zc_frame f={0};f.token=1;f.main.width=3;f.main.height=2;f.main.stride=9;f.main.plane_count=1;
    strcpy(f.main.format,"BGR888");f.main.planes[0].data=rgb;f.main.planes[0].length=18;f.main.planes[0].bytes_used=18;
    const int expected[8][6]={{1,2,3,4,5,6},{3,2,1,6,5,4},{6,5,4,3,2,1},{4,5,6,1,2,3},{1,4,2,5,3,6},{3,6,2,5,1,4},{6,3,5,2,4,1},{4,1,5,2,6,3}};
    for(uint32_t scale=1;scale<=2;scale++) for(uint32_t orientation=1;orientation<=8;orientation++) {
        zc_preview_view view;zc_default_preview_view(&view);view.flags=2|4;
        view.image_orientation=orientation;view.window_width=(orientation<5?3:2)*scale;view.window_height=(orientation<5?2:3)*scale;
        view.window_x=12;view.window_y=24;
        assert(zc_preview_set_view(p,&view)==ZC_OK);SDL_PumpEvents();
        int x=0,y=0;SDL_GetWindowPosition(p->window,&x,&y);assert(x==12 && y==24);
        assert(zcm_preview_show(p,&f)==ZC_OK);assert(zcm_preview_render(p,0)==ZC_OK);
        uint8_t out[72];assert(SDL_RenderReadPixels(p->renderer,NULL,SDL_PIXELFORMAT_RGB24,out,(int)view.window_width*3)==0);
        for(uint32_t y=0;y<view.window_height;y++) for(uint32_t x=0;x<view.window_width;x++) {
            const uint8_t *v=out+(y*view.window_width+x)*3;
            const uint32_t index=(y/scale)*(view.window_width/scale)+x/scale;
            assert(v[0]==expected[orientation-1][index]*30);assert(v[1]==100&&v[2]==5);
        }
        for(int i=0;i<6;i++) assert(rgb[i*3]==(i+1)*30);
    }
    assert(zcm_preview_close(p)==ZC_OK);
}
static void overlay_views(zc_preview *p,const zc_frame *frame) {
    const uint8_t rgba[16]={0,0,30,255,0,0,60,255,0,0,90,255,0,0,120,255};
    const int expected[8][4]={{1,2,3,4},{2,1,4,3},{4,3,2,1},{3,4,1,2},{1,3,2,4},{2,4,1,3},{4,2,3,1},{3,1,4,2}};
    assert(zcm_preview_overlay(p,rgba,2,2,8)==ZC_OK);
    for(uint32_t orientation=1;orientation<=8;orientation++) {
        zc_preview_view view;zc_default_preview_view(&view);view.flags=8;
        view.overlay_orientation=orientation;view.overlay_x=1;view.overlay_width=2;view.overlay_height=2;
        assert(zc_preview_set_view(p,&view)==ZC_OK);assert(zcm_preview_show(p,frame)==ZC_OK);
        uint8_t out[24];pixels(p,out);
        for(int y=0;y<2;y++) for(int x=0;x<4;x++) {
            const uint8_t *v=out+(y*4+x)*3;
            if(x==0||x==3) assert(v[0]==100&&v[1]==100&&v[2]==100);
            else { if(v[0]!=0||v[1]!=0||v[2]!=expected[orientation-1][y*2+x-1]*30) fprintf(stderr,"overlay orientation=%u xy=%d,%d expected-blue=%d actual=%u,%u,%u\n",orientation,x,y,expected[orientation-1][y*2+x-1]*30,v[0],v[1],v[2]); assert(v[0]==0&&v[1]==0&&v[2]==expected[orientation-1][y*2+x-1]*30); }
        }
        zc_preview_view bad=view;bad.overlay_width=UINT32_MAX;
        assert(zc_preview_set_view(p,&bad)==ZC_INVALID);assert(!memcmp(&p->view,&view,sizeof(view)));
        uint8_t after[24];pixels(p,after);assert(!memcmp(out,after,24));
    }
    zc_preview_view tiny;zc_default_preview_view(&tiny);tiny.flags=1|2|8;tiny.window_width=1;tiny.window_height=1;tiny.overlay_x=1;tiny.overlay_width=1;tiny.overlay_height=1;
    assert(zc_preview_set_view(p,&tiny)==ZC_OK);SDL_PumpEvents();assert(zcm_preview_show(p,frame)==ZC_OK);assert(zcm_preview_render(p,0)==ZC_OK);
    uint8_t pixel[3];assert(SDL_RenderReadPixels(p->renderer,NULL,SDL_PIXELFORMAT_RGB24,pixel,3)==0);assert(pixel[0]==100&&pixel[1]==100&&pixel[2]==100);
    zc_preview_view normal;zc_default_preview_view(&normal);normal.flags|=2;normal.window_width=4;normal.window_height=2;assert(zc_preview_set_view(p,&normal)==ZC_OK);SDL_PumpEvents();
    assert(zcm_preview_overlay(p,NULL,0,0,0)==ZC_OK);
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
    overlay_views(p,&f);
    transforms();
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
    zc_preview_view stretch;zc_default_preview_view(&stretch);stretch.flags=0;assert(zc_preview_set_view(p,&stretch)==ZC_OK);
    assert(zcm_preview_render(p,0)==ZC_OK);assert(SDL_RenderReadPixels(p->renderer,NULL,SDL_PIXELFORMAT_RGB24,resized,8*3)==0);
    for(int i=0;i<8*8*3;i+=3) assert(resized[i]==5&&resized[i+1]==10&&resized[i+2]==240);
    assert(zcm_preview_close(peer)==ZC_OK);
    assert(zcm_preview_close(p)==ZC_OK);
    return 0;
}
