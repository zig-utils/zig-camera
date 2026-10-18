#include "zig_camera.h"
#include <SDL.h>
#include <stdlib.h>
#include <string.h>
struct zc_preview { SDL_Window *window; SDL_Renderer *renderer; SDL_Texture *texture; SDL_threadID thread; uint32_t width, height; };
int zcm_preview_close(zc_preview *p) {
    if (!p || p->thread != SDL_ThreadID()) return ZC_STATE;
    SDL_DestroyTexture(p->texture); SDL_DestroyRenderer(p->renderer); SDL_DestroyWindow(p->window);
    SDL_QuitSubSystem(SDL_INIT_VIDEO); free(p); return ZC_OK;
}
int zcm_preview_open(const char *title, uint32_t w, uint32_t h, zc_preview **out) {
    *out = NULL;
    if (!w || !h || w > 16384 || h > 16384) return ZC_INVALID;
    if (SDL_InitSubSystem(SDL_INIT_VIDEO) != 0) return ZC_IO;
    zc_preview *p = calloc(1,sizeof(*p));
    if (!p) { SDL_QuitSubSystem(SDL_INIT_VIDEO); return ZC_NOMEM; }
    p->thread = SDL_ThreadID(); p->width = w; p->height = h;
    int ww = w > 1280 ? 1280 : (int)w, hh = (int)((uint64_t)h * ww / w);
    if (!hh) hh = 1;
    p->window = SDL_CreateWindow(title, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, ww, hh, SDL_WINDOW_RESIZABLE|SDL_WINDOW_ALLOW_HIGHDPI);
    if (p->window) p->renderer = SDL_CreateRenderer(p->window,-1,SDL_RENDERER_ACCELERATED|SDL_RENDERER_PRESENTVSYNC);
    if (!p->renderer && p->window) p->renderer = SDL_CreateRenderer(p->window,-1,SDL_RENDERER_SOFTWARE);
    if (p->renderer) p->texture = SDL_CreateTexture(p->renderer,SDL_PIXELFORMAT_RGB24,SDL_TEXTUREACCESS_STREAMING,(int)w,(int)h);
    if (!p->texture || SDL_RenderSetLogicalSize(p->renderer,(int)w,(int)h) != 0) { zcm_preview_close(p); return ZC_IO; }
    *out = p; return ZC_OK;
}
int zcm_preview_show(zc_preview *p, const zc_frame *frame) {
    if (!p || p->thread != SDL_ThreadID()) return ZC_STATE;
    const zc_stream *s = &frame->main;
    if (!frame->token || s->width != p->width || s->height != p->height || s->plane_count != 1 ||
        strcmp(s->format,"BGR888") || s->stride < (uint64_t)s->width*3 ||
        s->planes[0].bytes_used > s->planes[0].length || s->planes[0].bytes_used < (uint64_t)(s->height-1)*s->stride+(uint64_t)s->width*3) return ZC_INVALID;
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_QUIT || (event.type == SDL_WINDOWEVENT && event.window.windowID == SDL_GetWindowID(p->window) && event.window.event == SDL_WINDOWEVENT_CLOSE) ||
            (event.type == SDL_KEYDOWN && event.key.windowID == SDL_GetWindowID(p->window) && event.key.keysym.sym == SDLK_ESCAPE)) return 1;
    }
    void *pixels = NULL; int pitch = 0;
    if (SDL_LockTexture(p->texture,NULL,&pixels,&pitch) != 0) return ZC_IO;
    for (uint32_t y=0; y<s->height; ++y) memcpy((uint8_t *)pixels+(size_t)y*pitch,s->planes[0].data+(size_t)y*s->stride,(size_t)s->width*3);
    SDL_UnlockTexture(p->texture);
    if (SDL_SetRenderDrawColor(p->renderer,0,0,0,255) != 0 || SDL_RenderClear(p->renderer) != 0 || SDL_RenderCopy(p->renderer,p->texture,NULL,NULL) != 0) return ZC_IO;
    SDL_RenderPresent(p->renderer); return ZC_OK;
}
