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
static void reference_rgb(int y,int u,int v,uint32_t matrix,uint32_t range,int out[3]) {
    const double kr=matrix==ZC_YCBCR_REC601?0.299:matrix==ZC_YCBCR_REC709?0.2126:0.2627;
    const double kb=matrix==ZC_YCBCR_REC601?0.114:matrix==ZC_YCBCR_REC709?0.0722:0.0593;
    const double l=(y-(range==ZC_RANGE_LIMITED?16:0))*255.0/(range==ZC_RANGE_LIMITED?219.0:255.0);
    const double cb=(u-128)*255.0/(range==ZC_RANGE_LIMITED?224.0:255.0),cr=(v-128)*255.0/(range==ZC_RANGE_LIMITED?224.0:255.0);
    double rgb[3]={l+2*(1-kr)*cr,l-2*kb*(1-kb)/(1-kr-kb)*cb-2*kr*(1-kr)/(1-kr-kb)*cr,l+2*(1-kb)*cb};
    for(int i=0;i<3;i++){if(rgb[i]<0)rgb[i]=0;if(rgb[i]>255)rgb[i]=255;out[i]=(int)(rgb[i]+0.5);}
}
static void read_small(zc_preview *p,uint8_t out[12]) {
    assert(zcm_preview_render(p,0)==ZC_OK);assert(SDL_RenderReadPixels(p->renderer,NULL,SDL_PIXELFORMAT_RGB24,out,6)==0);
}
static void yuv_inputs(void) {
    zc_preview *p=NULL;assert(zcm_preview_open("I420",2,2,&p)==ZC_OK);
    uint8_t ys[6]={16,235,77,77,80,120},us[1]={64},vs[1]={192};
    zc_frame frame={0};frame.token=1;frame.main.width=2;frame.main.height=2;frame.main.stride=4;frame.main.plane_count=3;strcpy(frame.main.format,"YUV420");
    frame.main.planes[0]=(zc_plane){.data=ys,.length=6,.bytes_used=6,.fd=-1};
    frame.main.planes[1]=(zc_plane){.data=us,.length=1,.bytes_used=1,.fd=-1};frame.main.planes[2]=(zc_plane){.data=vs,.length=1,.bytes_used=1,.fd=-1};
    zc_color_space color={.struct_size=sizeof(color),.present=1,.primaries=ZC_PRIMARIES_REC709,.transfer=ZC_TRANSFER_SRGB};
    for(uint32_t matrix=ZC_YCBCR_REC601;matrix<=ZC_YCBCR_REC2020;matrix++) for(uint32_t range=ZC_RANGE_FULL;range<=ZC_RANGE_LIMITED;range++) {
        color.ycbcr_encoding=matrix;color.range=range;assert(zc_preview_show_input(p,&frame,&color)==ZC_OK);
        uint8_t out[12];read_small(p,out);
        for(int i=0;i<4;i++){int rgb[3];reference_rgb(ys[(i/2)*4+i%2],64,192,matrix,range,rgb);for(int k=0;k<3;k++)assert(abs((int)out[i*3+k]-rgb[k])<=1);}
        frame.main.planes[2].bytes_used=0;assert(zc_preview_show_input(p,&frame,&color)==ZC_INVALID);frame.main.planes[2].bytes_used=1;
        uint8_t after[12];read_small(p,after);assert(!memcmp(out,after,12));
    }
    assert(zc_preview_show_input(p,&frame,NULL)==ZC_UNSUPPORTED);
    uint8_t packed[12]={16,235,77,77,80,120,77,77,64,77,192,77};
    frame.main.plane_count=1;frame.main.planes[0]=(zc_plane){.data=packed,.length=12,.bytes_used=12,.fd=-1};
    assert(zc_preview_show_input(p,&frame,&color)==ZC_OK);
    frame.main.planes[0].bytes_used=10;assert(zc_preview_show_input(p,&frame,&color)==ZC_INVALID);frame.main.planes[0].bytes_used=12;
    uint8_t *locked=NULL;uint64_t length=0;uint32_t stride=0;
    assert(zcm_preview_rgb_begin(p,&locked,&length,&stride)==ZC_OK && locked && length>=12 && stride>=6);
    uint8_t *other=NULL;uint64_t other_length=0;uint32_t other_stride=0;
    assert(zcm_preview_rgb_begin(p,&other,&other_length,&other_stride)==ZC_BUSY);
    assert(zcm_preview_close(p)==ZC_BUSY);assert(zcm_preview_background(p)==ZC_BUSY);
    assert(zcm_preview_rgb_end(p,0)==ZC_OK);assert(zcm_preview_rgb_end(p,0)==ZC_STATE);
    assert(zc_preview_show_background(p)==ZC_OK);uint8_t background[12];read_small(p,background);for(int i=0;i<12;i++)assert(background[i]==0);
    assert(zcm_preview_close(p)==ZC_OK);
    zc_preview *blank=NULL;assert(zc_preview_open_background("no image texture",2,2,&blank)==ZC_OK && !blank->texture);
    assert(zc_preview_show_background(blank)==ZC_OK);read_small(blank,background);for(int i=0;i<12;i++)assert(background[i]==0);
    assert(zc_preview_show_input(blank,&frame,&color)==ZC_UNSUPPORTED);assert(zc_preview_close(blank)==ZC_OK);
}
static void leased_processed(uint32_t which) {
    zc_config cfg;zc_default_config(&cfg);cfg.width=4;cfg.height=4;
    zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);pipeline.lores_width=2;pipeline.lores_height=2;
    if(which==ZC_MAIN){cfg.width=2;cfg.height=2;pipeline.lores_width=0;pipeline.lores_height=0;}
    zc_camera *camera=NULL;assert(zc_open_formatted_pipeline(&cfg,&pipeline,which==ZC_MAIN?ZC_YUV420:ZC_RGB24,ZC_ROTATE0,0,&camera)==ZC_OK);assert(zc_enable_writable(camera)==ZC_OK);assert(zc_start(camera)==ZC_OK);
    zc_frame frame;assert(zc_acquire(camera,1000,&frame)==ZC_OK);
    zc_preview *p=NULL;assert(zcm_preview_open("leased lores",2,2,&p)==ZC_OK);
    zc_frame_map *map=NULL;assert(zc_frame_map_open(camera,frame.token,which,1,&map)==ZC_OK);
    zc_stream input;assert(zc_frame_map_stream(map,&input)==ZC_OK);
    assert(input.plane_count==3);uint8_t *bytes=(uint8_t *)input.planes[0].data;
    bytes[0]=100;bytes[1]=100;bytes[input.stride]=100;bytes[input.stride+1]=100;
    ((uint8_t *)input.planes[1].data)[0]=64;((uint8_t *)input.planes[2].data)[0]=192;
    assert(zc_preview_show_stream(p,camera,frame.token,which)==ZC_BUSY);
    assert(zc_frame_map_close(map)==ZC_OK);
    assert(zc_preview_show_stream(p,camera,frame.token,which)==ZC_OK);
    zc_color_space color;assert(zc_get_stream_color_space(camera,which,&color)==ZC_OK);
    uint8_t out[12];read_small(p,out);int expected[3];reference_rgb(100,64,192,color.ycbcr_encoding,color.range,expected);
    for(int i=0;i<4;i++)for(int k=0;k<3;k++)assert(abs(out[i*3+k]-expected[k])<=1);
    if(which==ZC_LORES)assert(zc_preview_show_stream(p,camera,frame.token,ZC_MAIN)==ZC_INVALID);
    else assert(zc_preview_show_stream(p,camera,frame.token,ZC_RAW)==ZC_UNSUPPORTED);
    assert(zc_frame_readable(camera,frame.token)==ZC_OK);
    assert(zc_release(camera,frame.token)==ZC_OK);assert(zc_preview_show_stream(p,camera,frame.token,which)==ZC_STALE);
    assert(zc_preview_close(p)==ZC_OK);assert(zc_close(camera)==ZC_OK);
}
static void configured_colors(void) {
    for(uint32_t matrix=ZC_YCBCR_REC601;matrix<=ZC_YCBCR_REC2020;matrix++)for(uint32_t range=ZC_RANGE_FULL;range<=ZC_RANGE_LIMITED;range++) {
        zc_config cfg;zc_default_config(&cfg);cfg.width=2;cfg.height=2;
        zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);
        zc_processed_options processed;zc_default_processed_options(&processed);processed.main_format=ZC_YUV420;processed.strict_color=1;
        assert(zc_color_space_preset(ZC_COLOR_SYCC,&processed.color_space)==ZC_OK);
        processed.color_space.ycbcr_encoding=matrix;processed.color_space.range=range;
        zc_camera *camera=NULL;assert(zc_open_processed_pipeline(&cfg,&pipeline,&processed,ZC_ROTATE0,0,&camera)==ZC_OK);
        assert(zc_enable_writable(camera)==ZC_OK && zc_start(camera)==ZC_OK);
        zc_frame frame;assert(zc_acquire(camera,1000,&frame)==ZC_OK);
        zc_frame_map *map=NULL;assert(zc_frame_map_open(camera,frame.token,ZC_MAIN,1,&map)==ZC_OK);
        zc_stream input;assert(zc_frame_map_stream(map,&input)==ZC_OK);
        memset((void *)input.planes[0].data,100,input.planes[0].bytes_used);memset((void *)input.planes[1].data,64,input.planes[1].bytes_used);memset((void *)input.planes[2].data,192,input.planes[2].bytes_used);
        assert(zc_frame_map_close(map)==ZC_OK);
        zc_preview *preview=NULL;assert(zc_preview_open("configured color",2,2,&preview)==ZC_OK);
        assert(zc_preview_show_stream(preview,camera,frame.token,ZC_MAIN)==ZC_OK);
        uint8_t out[12];read_small(preview,out);int expected[3];reference_rgb(100,64,192,matrix,range,expected);
        for(int i=0;i<4;i++)for(int channel=0;channel<3;channel++)assert(abs((int)out[i*3+channel]-expected[channel])<=1);
        assert(zc_preview_close(preview)==ZC_OK && zc_release(camera,frame.token)==ZC_OK && zc_close(camera)==ZC_OK);
    }
}
static void packed_inputs(void) {
    const char *names[]={"RGB888","XBGR8888","XRGB8888"};
    for(unsigned i=0;i<3;i++) {
        zc_preview *p=NULL; assert(zcm_preview_open("packed",4,3,&p)==ZC_OK);
        unsigned char src[64]={0}, expected[36], actual[36];
        const unsigned bpp=i==0?3:4;
        for(unsigned y=0;y<3;y++)for(unsigned x=0;x<4;x++) {
            unsigned char *v=src+y*(4*bpp+3)+x*bpp;
            unsigned char *rgb=expected+(y*4+x)*3;
            rgb[0]=30+x*40;rgb[1]=10+y*60;rgb[2]=5;
            v[0]=i==1?rgb[0]:rgb[2];v[1]=rgb[1];v[2]=i==1?rgb[2]:rgb[0];
        }
        zc_frame f={0}; f.token=1;f.main.width=4;f.main.height=3;f.main.stride=4*bpp+3;f.main.plane_count=1;
        strcpy(f.main.format,names[i]);f.main.planes[0].data=src;f.main.planes[0].length=sizeof(src);f.main.planes[0].bytes_used=2*f.main.stride+4*bpp;
        assert(zc_preview_show_input(p,&f,NULL)==ZC_OK);pixels(p,actual);assert(!memcmp(expected,actual,sizeof(actual)));
        assert(zc_preview_show(p,&f)==ZC_OK);pixels(p,actual);assert(!memcmp(expected,actual,sizeof(actual)));
        f.main.planes[0].bytes_used--;assert(zc_preview_show_input(p,&f,NULL)==ZC_INVALID);
        pixels(p,actual);assert(!memcmp(expected,actual,sizeof(actual)));
        assert(zcm_preview_close(p)==ZC_OK);
    }
}
int main(void) {
    packed_inputs();
    assert(SDL_setenv("SDL_VIDEODRIVER","dummy",1)==0);
    SDL_SetHint(SDL_HINT_RENDER_DRIVER,"software");
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY,"0");
    yuv_inputs();
    configured_colors();
    leased_processed(ZC_MAIN);
    leased_processed(ZC_LORES);
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
