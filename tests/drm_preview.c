#include "zig_camera.h"
#include <assert.h>
#include <string.h>
int main(void) {
    _Static_assert(sizeof(zc_drm_preview_config)==96,"config ABI");
    _Static_assert(sizeof(zc_drm_preview_state)==40,"state ABI");
    _Static_assert(sizeof(zc_drm_preview_queue_state)==56,"queue state ABI");
    _Static_assert(sizeof(zc_drm_preview_storage_state)==48,"storage ABI");
    _Static_assert(sizeof(zc_drm_preview_overlay_state)==56,"overlay ABI");
    zc_drm_preview_overlay_state overlay;memset(&overlay,1,sizeof(overlay));
    assert(zc_drm_preview_overlay_state_get((void *)1,&overlay)==ZC_UNSUPPORTED && !overlay.struct_size);
    assert(zc_drm_preview_overlay_seed((void *)1,NULL)==ZC_UNSUPPORTED);
    zc_drm_preview_job *overlay_job=(void *)1;
    assert(zc_drm_preview_overlay_async((void *)1,NULL,&overlay_job)==ZC_UNSUPPORTED && !overlay_job);
    zc_drm_preview_storage_state storage;memset(&storage,1,sizeof(storage));
    zc_preview *invalid=(void *)1;
    assert(zc_drm_preview_storage_state_get(invalid,&storage)==ZC_UNSUPPORTED && storage.struct_size==0);
    zc_drm_preview_job *job=(void *)1;
    assert(zc_drm_preview_enable_async(invalid,0)==ZC_INVALID);
    assert(zc_drm_preview_enable_async(invalid,9)==ZC_INVALID);
    assert(zc_drm_preview_enable_async(invalid,1)==ZC_UNSUPPORTED);
    assert(zc_drm_preview_command_async(invalid,4,NULL,&job)==ZC_INVALID && !job);
    job=(void *)1;
    assert(zc_drm_preview_command_async(invalid,2,NULL,&job)==ZC_INVALID && !job);
    assert(zc_drm_preview_show_async(invalid,NULL,1,ZC_MAIN,&job)==ZC_UNSUPPORTED && !job);
    zc_drm_preview_config cfg;zc_default_drm_preview_config(&cfg);
    zc_preview *out=(void *)1;
    assert(zc_preview_open_drm(&cfg,&out)==ZC_INVALID && !out);
    cfg.width=8;cfg.height=6;
    assert(zc_preview_open_drm_rgb16(&cfg,&out)==ZC_INVALID && !out);
    memset(cfg.card,'a',sizeof(cfg.card));
    assert(zc_preview_open_drm(&cfg,&out)==ZC_INVALID && !out);
    memset(cfg.card,0,sizeof(cfg.card));strcpy(cfg.card,"/dev/null");
    for(int i=0;i<10;i++)assert(zc_preview_open_drm(&cfg,&out)==ZC_UNSUPPORTED && !out);
    cfg.format=ZC_RGB48;
    for(int i=0;i<10;i++)assert(zc_preview_open_drm_rgb16(&cfg,&out)==ZC_UNSUPPORTED && !out);
    return 0;
}
