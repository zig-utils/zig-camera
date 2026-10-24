#ifndef ZIG_CAMERA_ALLOCATOR_BRIDGE_H
#define ZIG_CAMERA_ALLOCATOR_BRIDGE_H
#include "zig_camera.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Internal SDK boundary. Full normalized camera identity/configuration is the
 * key. A loan is exclusive to one Device, including all its requests/exports. */
typedef struct {
    uint32_t width,height,stride,buffer_count;
    uint64_t frame_bytes,modifier;
    char format[32];
} zci_allocation_stream;
typedef struct {
    const uint8_t *data;
    uint64_t length,frame_bytes;
    int32_t fd;
    uint32_t reserved;
} zci_allocation_buffer;
int zci_capture_allocator_acquire(zc_capture_allocator *,const uint8_t *id,uint32_t id_length,
    const zci_allocation_stream *,uint32_t streams,uint64_t *out_loan);
int zci_capture_allocator_buffer(zc_capture_allocator *,uint64_t loan,uint32_t stream,uint32_t buffer,
    uint32_t writable,zci_allocation_buffer *out);
/* Bookkeeping only, after SDK requests/imported buffers/maps have retired.
 * Exactly one release per successful acquire; no I/O or cleanup is performed. */
void zci_capture_allocator_release(zc_capture_allocator *,uint64_t loan);
/* Failed fence/device backing is retired without I/O after all SDK users join;
 * it remains charged and unavailable until physical cleanup succeeds. */
void zci_capture_allocator_discard(zc_capture_allocator *,uint64_t loan);
#ifdef __cplusplus
}
#endif
#endif
