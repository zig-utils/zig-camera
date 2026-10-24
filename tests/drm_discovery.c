#include "zig_camera.h"
#include <assert.h>
#include <string.h>
int main(void) {
    _Static_assert(sizeof(zc_drm_display_info)==2336,"display ABI");
    _Static_assert(sizeof(zc_drm_discovery_issue)==80,"issue ABI");
    zc_drm_discovery *out=(void *)1;
    assert(zc_drm_discover("",&out)==ZC_INVALID && !out);
    char long_path[65];memset(long_path,'a',64);long_path[64]=0;
    assert(zc_drm_discover(long_path,&out)==ZC_INVALID && !out);
#ifdef __linux__
    zc_drm_discovery *held[4];
    for(int i=0;i<4;i++)assert(zc_drm_discover("/dev/zig-camera-kms-absent",&held[i])==ZC_OK);
    assert(zc_drm_discover("/dev/null",&out)==ZC_BUSY && !out);
    for(int i=0;i<4;i++)zc_drm_discovery_close(held[i]);
    for(int i=0;i<40;i++) {
        assert(zc_drm_discover("/dev/null",&out)==ZC_OK);
        zc_drm_discovery_info info;assert(zc_drm_discovery_info_get(out,&info)==ZC_OK);
        assert(info.struct_size==sizeof(info) && !info.display_count && info.issue_count==1 && info.cards_opened==1);
        zc_drm_discovery_issue issue;assert(zc_drm_discovery_issue_get(out,0,&issue)==ZC_OK);
        assert(issue.stage==ZC_DRM_RESOURCES && issue.reason==ZC_DRM_SYSTEM && issue.error_number==25 && !strcmp(issue.card,"/dev/null"));
        assert(zc_drm_discovery_issue_get(out,1,&issue)==ZC_INVALID);
        zc_drm_display_info display;assert(zc_drm_discovery_display_get(out,0,&display)==ZC_INVALID && !display.struct_size);
        zc_drm_discovery_close(out);
    }
#else
    assert(zc_drm_discover(NULL,&out)==ZC_UNSUPPORTED && !out);
#endif
    zc_drm_discovery_close(NULL);
    return 0;
}
