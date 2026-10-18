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
typedef struct zc_camera zc_camera;
/* Pipeline extensions preserve zc_config/zc_frame/zc_info ABI v1 layouts.
 * Explicit sensor selection requires both size and bit depth. Zero = automatic.
 * Lores: both dimensions zero disable; YUV420 requires even dimensions.
 * Its negotiated size must not exceed main. All three streams share one lease. */
enum { ZC_MAIN=0, ZC_RAW=1, ZC_LORES=2 };
enum { ZC_YUV420=0, ZC_RGB24=1 };
typedef struct {
    uint32_t struct_size;
    zc_capture_options capture;
    uint32_t sensor_width, sensor_height, sensor_bit_depth;
    uint32_t lores_width, lores_height, lores_format;
} zc_pipeline_options;
typedef struct { uint32_t width,height,bit_depth; char format[32]; } zc_sensor_mode;
typedef struct {
    uint32_t struct_size,sensor_width,sensor_height,sensor_bit_depth;
    zc_stream lores;
} zc_pipeline_info;
void zc_default_pipeline_options(zc_pipeline_options *);
int zc_open_pipeline(const zc_config *,const zc_pipeline_options *,zc_camera **);
int zc_get_pipeline_info(zc_camera *,zc_pipeline_info *);
/* Cached discovery: no reconfiguration or capture interruption. Query with
 * NULL/0 first. count is total; insufficient capacity returns INVALID. Formats
 * advertise raw outputs, not measured FPS, exposure or optical guarantees. */
int zc_get_sensor_modes(zc_camera *,zc_sensor_mode *,uint32_t capacity,uint32_t *count);
/* Borrowed descriptor valid only for this lease. Disabled stream: UNSUPPORTED. */
int zc_get_stream(zc_camera *,uint64_t token,uint32_t stream,zc_stream *);
/* Tight owned copy: BGR888 => RGB bytes; YUV420 => I420 Y,U,V. */
int zc_copy_stream(const zc_stream *,uint8_t *out,uint64_t length);
typedef struct {
    uint32_t valid; /* bit 0 black levels, bit 1 CCM, bit 2 white balance */
    float black_levels[4]; /* R, Gr, Gb, B; normalized to a 16-bit range */
    float camera_to_srgb[9]; /* libcamera ColourCorrectionMatrix; WB is separate */
    char model[128];
} zc_raw_metadata;
/* Typed bounded runtime controls. IDs map to libcamera names in docs/controls.md.
 * Query support/ranges; a batch is validated atomically and staged for the next
 * recycled request. Already queued frames and sensor pipeline latency remain.
 * ControlRevision denotes request submission, not proof of physical application. */
enum { ZC_BOOL=1,ZC_INT=2,ZC_FLOAT=3,ZC_RECT=4,ZC_MAX_CONTROLS=32 };
enum { ZC_AE_ENABLE=1,ZC_EXPOSURE_TIME,ZC_ANALOGUE_GAIN,ZC_EXPOSURE_VALUE,
 ZC_AWB_ENABLE,ZC_COLOUR_GAINS,ZC_BRIGHTNESS,ZC_CONTRAST,ZC_SATURATION,
 ZC_SHARPNESS,ZC_FRAME_DURATION_LIMITS,ZC_LENS_POSITION,ZC_AF_MODE,ZC_AF_TRIGGER,
 ZC_AF_RANGE,ZC_AF_SPEED,ZC_AF_METERING,ZC_AF_WINDOWS,ZC_SCALER_CROP,
 ZC_NOISE_REDUCTION,ZC_AE_METERING,ZC_AE_EXPOSURE,ZC_AWB_MODE,
 ZC_EXPOSURE_TIME_MODE,ZC_ANALOGUE_GAIN_MODE,ZC_AF_PAUSE,ZC_AE_CONSTRAINT,
 ZC_COLOUR_TEMPERATURE,ZC_AE_FLICKER_MODE,ZC_AE_FLICKER_PERIOD };
typedef struct {uint32_t id,type,count,reserved;double values[16];} zc_control;
typedef struct {
 uint32_t id,type,min_count,max_count;
 double min[4],max[4],def[4]; uint64_t enum_mask;
} zc_control_info;
typedef struct {
 uint32_t struct_size,valid; /* AF=1, lens=2, duration=4, crop=8 */
 uint64_t event_id,sequence,timestamp_ns,control_revision;
 uint32_t exposure_us; int32_t af_state,af_pause_state; uint32_t reserved;
 float analogue_gain,lens_position,red_gain,blue_gain;
 uint64_t frame_duration_us; int32_t crop[4];
} zc_metadata;
int zc_get_control_info(zc_camera *,uint32_t id,zc_control_info *);
int zc_set_controls(zc_camera *,const zc_control *,uint32_t count,uint64_t *revision);
int zc_get_frame_metadata(zc_camera *,uint64_t token,zc_metadata *);
/* Observer only: consumes no frame. event_id is monotonic across restart.
 * Wait/AF wait must have returned before close; stop wakes all observers. */
int zc_wait_metadata(zc_camera *,uint64_t after_event,uint32_t timeout_ms,zc_metadata *);
enum { ZC_AF_PENDING=1,ZC_AF_SCANNING=2,ZC_AF_SUCCEEDED=3,ZC_AF_FAILED=4,
 ZC_AF_CANCELLED=5,ZC_AF_STOPPED=6 };
int zc_autofocus_start(zc_camera *,uint64_t *job_id);
int zc_autofocus_cancel(zc_camera *,uint64_t job_id);
int zc_autofocus_wait(zc_camera *,uint64_t job_id,uint32_t timeout_ms,uint32_t *state);
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
/* Copy active RGB pixels into an owned tightly packed buffer; caller keeps lease. */
int zc_copy_rgb(const zc_frame *,uint8_t *out,uint64_t length);
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
 * maps linearly to CRF 51..0 (AVC minimum 1). MP4 retains one encoded packet for duration;
 * close drains encoder output and writes the last packet at nominal FPS.
 * No B frames/lookahead; AVC VFR retains one input internally.
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
