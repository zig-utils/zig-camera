#include "zig_camera.h"
#include <assert.h>
#include <string.h>
int main(void) {
    _Static_assert(sizeof(zc_drm_preview_config)==96,"config ABI");
    _Static_assert(sizeof(zc_drm_preview_state)==40,"state ABI");
    zc_drm_preview_config cfg;zc_default_drm_preview_config(&cfg);
    zc_preview *out=(void *)1;
    assert(zc_preview_open_drm(&cfg,&out)==ZC_INVALID && !out);
    cfg.width=8;cfg.height=6;
    memset(cfg.card,'a',sizeof(cfg.card));
    assert(zc_preview_open_drm(&cfg,&out)==ZC_INVALID && !out);
    memset(cfg.card,0,sizeof(cfg.card));strcpy(cfg.card,"/dev/null");
    for(int i=0;i<10;i++)assert(zc_preview_open_drm(&cfg,&out)==ZC_UNSUPPORTED && !out);
    return 0;
}
