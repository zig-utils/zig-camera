#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
_Static_assert(sizeof(zc_control)==144,"control ABI");
_Static_assert(sizeof(zc_control_info)==120,"control info ABI");
_Static_assert(sizeof(zc_metadata)==96,"extended metadata ABI");
_Static_assert(sizeof(zc_capture_options) == 16, "capture options ABI");
_Static_assert(sizeof(zc_raw_metadata) == 184, "raw metadata ABI");
_Static_assert(sizeof(zc_video_config) == 32, "video config ABI");
_Static_assert(sizeof(zc_config) == 72, "config ABI");
_Static_assert(sizeof(zc_plane) == 40, "plane ABI");
_Static_assert(sizeof(zc_stream) == 208, "stream ABI");
_Static_assert(sizeof(zc_frame) == 456, "frame ABI");
_Static_assert(sizeof(zc_info) == 680, "info ABI");
_Static_assert(offsetof(zc_frame, main) == 40, "frame alignment");
int main(void) {
    assert(zc_abi_version() == ZC_ABI_VERSION);
    zc_config config;
    zc_default_config(&config);
    assert(config.buffer_count == 4);
    config.width = 1; /* deliberately mismatched geometry */
    zc_camera *camera = NULL;
    assert(zc_open(&config, &camera) == ZC_INVALID);
    assert(!camera);
    return 0;
}
