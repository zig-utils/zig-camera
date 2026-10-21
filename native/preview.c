#include "zig_camera.h"
#include <SDL.h>
#include <stdlib.h>
#include <limits.h>
#include <string.h>
struct zc_preview { SDL_Window *window; SDL_Renderer *renderer; SDL_Texture *texture, *overlay; SDL_threadID thread; uint32_t width, height; zc_preview_view view; };
extern int zcm_preview_geometry(uint32_t,uint32_t,uint32_t,uint32_t,const zc_preview_view *,uint32_t *,float *);
int zcm_preview_close(zc_preview *p) {
    if (!p || p->thread != SDL_ThreadID()) return ZC_STATE;
    SDL_DestroyTexture(p->overlay); SDL_DestroyTexture(p->texture); SDL_DestroyRenderer(p->renderer); SDL_DestroyWindow(p->window);
    SDL_QuitSubSystem(SDL_INIT_VIDEO); free(p); return ZC_OK;
}
int zcm_preview_open(const char *title, uint32_t w, uint32_t h, zc_preview **out) {
    *out = NULL;
    if (!w || !h || w > 16384 || h > 16384) return ZC_INVALID;
    if (SDL_InitSubSystem(SDL_INIT_VIDEO) != 0) return ZC_IO;
    zc_preview *p = calloc(1,sizeof(*p));
    if (!p) { SDL_QuitSubSystem(SDL_INIT_VIDEO); return ZC_NOMEM; }
    p->thread = SDL_ThreadID(); p->width = w; p->height = h;
    p->view=(zc_preview_view){.struct_size=sizeof(zc_preview_view),.flags=1,.image_orientation=1,.overlay_orientation=1};
    int ww = w > 1280 ? 1280 : (int)w, hh = (int)((uint64_t)h * ww / w);
    if (!hh) hh = 1;
    p->window = SDL_CreateWindow(title, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, ww, hh, SDL_WINDOW_RESIZABLE|SDL_WINDOW_ALLOW_HIGHDPI);
    if (p->window) p->renderer = SDL_CreateRenderer(p->window,-1,SDL_RENDERER_ACCELERATED|SDL_RENDERER_PRESENTVSYNC);
    if (!p->renderer && p->window) p->renderer = SDL_CreateRenderer(p->window,-1,SDL_RENDERER_SOFTWARE);
    if (p->renderer) p->texture = SDL_CreateTexture(p->renderer,SDL_PIXELFORMAT_RGB24,SDL_TEXTUREACCESS_STREAMING,(int)w,(int)h);
    if (!p->texture || SDL_RenderSetLogicalSize(p->renderer,(int)w,(int)h) != 0) { zcm_preview_close(p); return ZC_IO; }
    *out = p; return ZC_OK;
}
int zcm_preview_overlay(zc_preview *p,const uint8_t *rgba,uint32_t w,uint32_t h,uint32_t stride) {
    if (!p || p->thread != SDL_ThreadID()) return ZC_STATE;
    if (!rgba) { SDL_DestroyTexture(p->overlay); p->overlay=NULL; return ZC_OK; }
    if (!w || !h || w>4096 || h>4096 || stride<(uint64_t)w*4 || stride>INT_MAX) return ZC_INVALID;
    SDL_Texture *next=SDL_CreateTexture(p->renderer,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_STATIC,(int)w,(int)h);
    if (!next) return ZC_IO;
    if (SDL_SetTextureBlendMode(next,SDL_BLENDMODE_BLEND)!=0 || SDL_UpdateTexture(next,NULL,rgba,(int)stride)!=0) {
        SDL_DestroyTexture(next); return ZC_IO;
    }
    SDL_DestroyTexture(p->overlay); p->overlay=next; return ZC_OK;
}
int zcm_preview_extent(zc_preview *p,uint32_t *w,uint32_t *h) {
    if (!p || p->thread != SDL_ThreadID()) return ZC_STATE;
    *w=p->width; *h=p->height; return ZC_OK;
}
int zcm_preview_view(zc_preview *p,const zc_preview_view *view) {
    if (!p || p->thread != SDL_ThreadID()) return ZC_STATE;
    /* Public Zig entry point validated the complete immutable scalar snapshot. */
    if(view->flags&2) SDL_SetWindowSize(p->window,(int)view->window_width,(int)view->window_height);
    if(view->flags&4) SDL_SetWindowPosition(p->window,view->window_x,view->window_y);
    p->view=*view; return ZC_OK;
}
static int zcm_preview_draw(zc_preview *p,SDL_Texture *texture,const uint32_t *rect,const float *uv) {
    if(!rect[2] || !rect[3]) return ZC_OK;
    const int transposed=uv[0]==uv[2];
    SDL_RendererFlip flip=SDL_FLIP_NONE;
    if(uv[0]==1.0f) flip=(SDL_RendererFlip)(flip|SDL_FLIP_HORIZONTAL);
    if((!transposed && uv[1]==1.0f)||(transposed && uv[1]==0.0f)) flip=(SDL_RendererFlip)(flip|SDL_FLIP_VERTICAL);
    SDL_FRect dst={(float)rect[0],(float)rect[1],(float)rect[2],(float)rect[3]};
    SDL_FPoint pivot={0,0};
    if(transposed) { dst.x+=(float)rect[2];dst.w=(float)rect[3];dst.h=(float)rect[2]; }
    /* Integer corner pivot avoids half-pixel loss on odd rectangular textures.
     * SDL's geometry-to-rectangle optimization does not preserve transposed UVs. */
    return SDL_RenderCopyExF(p->renderer,texture,NULL,&dst,transposed?90.0:0.0,&pivot,flip)==0 ? ZC_OK : ZC_IO;
}
static int zcm_preview_render(zc_preview *p,int present) {
    int w=0,h=0;
    if(SDL_GetRendererOutputSize(p->renderer,&w,&h)!=0) return ZC_IO;
    if(w<=0 || h<=0) return ZC_OK;
    uint32_t rectangles[8]; float uv[16];
    int result=zcm_preview_geometry(p->width,p->height,(uint32_t)w,(uint32_t)h,&p->view,rectangles,uv);
    if(result!=ZC_OK) return result;
    if (SDL_RenderSetLogicalSize(p->renderer,0,0)!=0 || SDL_SetRenderDrawColor(p->renderer,0,0,0,255)!=0 || SDL_RenderClear(p->renderer)!=0) return ZC_IO;
    result=zcm_preview_draw(p,p->texture,rectangles,uv); if(result!=ZC_OK) return result;
    if(p->overlay) { result=zcm_preview_draw(p,p->overlay,rectangles+4,uv+8); if(result!=ZC_OK) return result; }
    if (present) SDL_RenderPresent(p->renderer);
    return ZC_OK;
}
int zcm_preview_show(zc_preview *p, const zc_frame *frame) {
    if (!p || p->thread != SDL_ThreadID()) return ZC_STATE;
    const zc_stream *s = &frame->main;
    if (!frame->token || s->width != p->width || s->height != p->height || s->plane_count != 1 ||
        strcmp(s->format,"BGR888") || s->stride < (uint64_t)s->width*3 ||
        !s->planes[0].data || s->planes[0].bytes_used > s->planes[0].length || s->planes[0].bytes_used < (uint64_t)(s->height-1)*s->stride+(uint64_t)s->width*3) return ZC_INVALID;
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_QUIT || (event.type == SDL_WINDOWEVENT && event.window.windowID == SDL_GetWindowID(p->window) && event.window.event == SDL_WINDOWEVENT_CLOSE) ||
            (event.type == SDL_KEYDOWN && event.key.windowID == SDL_GetWindowID(p->window) && event.key.keysym.sym == SDLK_ESCAPE)) return 1;
    }
    void *pixels = NULL; int pitch = 0;
    if (SDL_LockTexture(p->texture,NULL,&pixels,&pitch) != 0) return ZC_IO;
    for (uint32_t y=0; y<s->height; ++y) memcpy((uint8_t *)pixels+(size_t)y*pitch,s->planes[0].data+(size_t)y*s->stride,(size_t)s->width*3);
    SDL_UnlockTexture(p->texture);
    return zcm_preview_render(p,1);
}
