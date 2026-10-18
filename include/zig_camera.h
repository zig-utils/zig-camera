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
    uint32_t raw; /* optional paired raw stream */
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
enum { ZC_STILL=0, ZC_PREVIEW=1, ZC_VIDEO=2 };
/* Additive API: all original ABI v1 layouts and functions remain unchanged. */
typedef struct {
    uint32_t struct_size, role, unpacked_raw, noise_reduction; /* NR: 0..4, UINT32_MAX = role default */
} zc_capture_options;
typedef struct {
    uint32_t valid; /* bit 0 black levels, bit 1 CCM, bit 2 white balance */
    float black_levels[4]; /* R, Gr, Gb, B; normalized to a 16-bit range */
    float camera_to_srgb[9]; /* libcamera ColourCorrectionMatrix; WB is separate */
    char model[128];
} zc_raw_metadata;
typedef struct zc_camera zc_camera;
uint32_t zc_abi_version(void);
void zc_default_config(zc_config *config);
/* Camera lifecycle calls must be serialized by the caller. acquire/release/stats
 * may run on different threads; stop wakes waiters. close requires all leases released.
 * A stopped camera keeps leased mappings valid until release; restart rejects leases. */
int zc_open(const zc_config *config, zc_camera **out);
void zc_default_capture_options(zc_capture_options *);
int zc_open_ex(const zc_config *, const zc_capture_options *, zc_camera **out);
int zc_get_raw_metadata(zc_camera *, uint64_t token, zc_raw_metadata *out);
int zc_save_dng(zc_camera *, uint64_t token, const char *path);
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
/* Optional SDL preview. Create/show/close on the same main/UI thread. show returns
 * 1 for a window-close request, 0 success, negative status for errors. */
typedef struct zc_preview zc_preview;
int zc_preview_open(const char *title, uint32_t width, uint32_t height, zc_preview **);
int zc_preview_show(zc_preview *, const zc_frame *);
int zc_preview_close(zc_preview *);
enum { ZC_H264=1, ZC_HEVC=2, ZC_MJPEG=3, ZC_FFV1=4 };
typedef struct {
    uint32_t width, height, fps_num, fps_den, codec, bitrate, quality, gop;
} zc_video_config;
typedef struct zc_recorder zc_recorder;
void zc_default_video_config(zc_video_config *);
int zc_video_open(const char *path, const zc_video_config *, zc_recorder **);
/* Synchronous bounded conversion/encode; the input lease can be released after
 * return. Timestamp is a monotonic capture time, in ns; gaps are preserved.
 * Home MJPEG: .mkv; optional Home x264/x265 adapter (-Dcodecs=true):
 * H.264/HEVC in fragmented .mp4, 8-bit SDR 4:2:0, even dimensions >=16.
 * bitrate is bits/sec (0 selects CRF); gop 0 selects 60. Quality 1..100
 * maps linearly to CRF 51..0. MP4 retains one encoded packet for duration;
 * close writes the last packet at nominal FPS. No B frames/lookahead.
 * MP4 timestamps must advance by >=1 microsecond; max gap ~4294 seconds.
 * Codecs/containers unavailable in this build return UNSUPPORTED. */
int zc_video_write(zc_recorder *, const zc_frame *, uint64_t timestamp_ns);
/* Finishes the stream. Always consumes the handle,
 * including on failure. Recorder calls require caller serialization. */
int zc_video_close(zc_recorder *);
#ifdef __cplusplus
}
#endif
#endif
