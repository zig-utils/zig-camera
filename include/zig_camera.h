#ifndef ZIG_CAMERA_H
#define ZIG_CAMERA_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define ZC_ABI_VERSION 1
#define ZC_MAX_BUFFERS 32
#define ZC_MAX_PLANES 4
/* Negative results, stable across platforms. */
enum { ZC_OK=0, ZC_INVALID=-1, ZC_STATE=-2, ZC_TIMEOUT=-3, ZC_BUSY=-4,
       ZC_STALE=-5, ZC_IO=-6, ZC_NOMEM=-7, ZC_UNSUPPORTED=-8, ZC_DEVICE=-9 };
enum { ZC_FIFO=0, ZC_LATEST=1 };
enum { ZC_SYNTHETIC=0, ZC_LIBCAMERA=1 };
/* Zero dimensions select libcamera's default still size. Set both or neither.
 * All other fields must be initialized with zc_default_config(). */
typedef struct {
    uint32_t width, height, buffer_count, camera_index, policy;
    uint32_t exposure_us, frame_duration_us;
    float analogue_gain, lens_position; /* exposure and gain: both zero or both positive; lens: -1 auto */
    uint32_t raw; /* optional paired raw stream; exact native bytes, not a DNG */
    char raw_format[32]; /* empty = libcamera default; e.g. SRGGB12 */
} zc_config;
typedef struct {
    const uint8_t *data;
    uint64_t length, bytes_used, offset;
    int32_t fd; /* borrowed DMA-BUF; -1 for synthetic. Never close this fd. */
    uint32_t reserved;
} zc_plane;
typedef struct {
    uint32_t width, height, stride, plane_count;
    char format[32]; /* main: BGR888 (RGB byte order); raw: negotiated libcamera name */
    zc_plane planes[ZC_MAX_PLANES];
} zc_stream;
typedef struct {
    uint64_t token, sequence, timestamp_ns;
    uint32_t exposure_us;
    float analogue_gain, red_gain, blue_gain;
    zc_stream main, raw;
} zc_frame;
typedef struct {
    uint32_t backend, buffer_count;
    zc_stream main, raw; /* plane pointers/fds are empty; geometry describes negotiated config */
    char camera_id[256];
} zc_info;
typedef struct {
    uint64_t completed, delivered, dropped, errors;
    uint32_t ready, leased;
} zc_stats;
typedef struct zc_camera zc_camera;
uint32_t zc_abi_version(void);
void zc_default_config(zc_config *config);
/* Camera lifecycle calls must be serialized by the caller. acquire/release/stats
 * may run on different threads; stop wakes waiters. close requires all leases released.
 * A stopped camera keeps leased mappings valid until release; restart rejects leases. */
int zc_open(const zc_config *config, zc_camera **out);
int zc_get_info(zc_camera *, zc_info *out);
int zc_start(zc_camera *);
int zc_acquire(zc_camera *, uint32_t timeout_ms, zc_frame *out);
int zc_release(zc_camera *, uint64_t token);
int zc_stop(zc_camera *);
int zc_close(zc_camera *);
int zc_get_stats(zc_camera *, zc_stats *out);
/* quality 1..100, 4:4:4 sampling; operates on an outstanding lease, no RGB copy. */
int zc_save_jpeg(zc_camera *, uint64_t token, const char *path, uint32_t quality);
const char *zc_status_string(int status);
#ifdef __cplusplus
}
#endif
#endif
