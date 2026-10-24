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
#define ZC_MAX_FRAME_REFERENCES 256
/* Negative results, stable across platforms. */
enum { ZC_OK=0, ZC_INVALID=-1, ZC_STATE=-2, ZC_TIMEOUT=-3, ZC_BUSY=-4,
       ZC_STALE=-5, ZC_IO=-6, ZC_NOMEM=-7, ZC_UNSUPPORTED=-8, ZC_DEVICE=-9, ZC_CANCELLED=-10, ZC_DISCONNECTED=-11 };
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
    char format[32]; /* processed: BGR888/RGB888/XBGR8888/XRGB8888/YUV420/YVU420/NV12/NV21/YUYV/YVYU/UYVY/VYUY/BGR161616/RGB161616; raw: negotiated name */
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
/* Processed format names use libcamera FourCC; constants describe memory bytes.
 * RGB48/BGR48 contain three little-endian u16 words (BGR161616/RGB161616). */
enum { ZC_YUV420=0, ZC_RGB24=1, ZC_BGR24=2, ZC_RGBX32=3, ZC_BGRX32=4, ZC_YVU420=5, ZC_NV12=6, ZC_NV21=7, ZC_YUYV=8, ZC_YVYU=9, ZC_UYVY=10, ZC_VYUY=11, ZC_RGB48=12, ZC_BGR48=13 };
/* Negotiated color values, not configuration defaults. Zero means unknown.
 * Decoding YCbCr converts encoded R'G'B' values; it does not transform primaries
 * or transfer functions. present=0 means the pipeline supplied no color space. */
enum { ZC_PRIMARIES_RAW=1,ZC_PRIMARIES_SMPTE170M=2,ZC_PRIMARIES_REC709=3,ZC_PRIMARIES_REC2020=4 };
enum { ZC_TRANSFER_LINEAR=1,ZC_TRANSFER_SRGB=2,ZC_TRANSFER_REC709=3 };
enum { ZC_YCBCR_NONE=1,ZC_YCBCR_REC601=2,ZC_YCBCR_REC709=3,ZC_YCBCR_REC2020=4 };
enum { ZC_RANGE_FULL=1,ZC_RANGE_LIMITED=2 };
typedef struct { uint32_t struct_size,present,primaries,transfer,ycbcr_encoding,range; } zc_color_space;
int zc_get_stream_color_space(zc_camera *,uint32_t stream,zc_color_space *out);
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
/* Shared processed-stream color request. present=0 selects the legacy default recipe and
 * requires zero color components and strict_color=0. RGB normalizes the requested
 * matrix/range to none/full while preserving primaries/transfer. YUV requires a
 * matrix. Raw primaries cannot describe processed streams. */
typedef struct { uint32_t struct_size,main_format,strict_color; zc_color_space color_space; } zc_processed_options;
enum { ZC_COLOR_SRGB=1,ZC_COLOR_SYCC=2,ZC_COLOR_SMPTE170M=3,ZC_COLOR_REC709=4,ZC_COLOR_REC2020=5,ZC_COLOR_RAW=6 };
void zc_default_processed_options(zc_processed_options *);
int zc_color_space_preset(uint32_t preset,zc_color_space *out);
int zc_check_processed_options(const zc_processed_options *,const zc_pipeline_options *);
/* Allocation-free structural preflight shared by open. Does not negotiate with
 * hardware or validate a camera identity/sensor's available modes. */
int zc_check_camera_configuration(const zc_config *,const zc_pipeline_options *,const zc_processed_options *,uint32_t orientation,uint32_t strict_orientation);
/* Explicit geometry planning, without opening/negotiating a device or changing
 * pixels/strides. Profiles use Picamera2's VC4/PiSP recipes. optimal=0 uses 2x2.
 * Positive extents which round to zero reject. Failure preserves every output. */
enum { ZC_ALIGN_VC4=0, ZC_ALIGN_PISP=1 };
enum { ZC_ALIGN_PACKED=0, ZC_ALIGN_PLANAR420=1, ZC_ALIGN_WIDE=2 };
typedef struct { uint32_t struct_size,width,height,width_alignment,height_alignment; } zc_stream_alignment;
int zc_align_stream_geometry(uint32_t width,uint32_t height,uint32_t layout,uint32_t profile,uint32_t optimal,zc_stream_alignment *out);
/* Align explicit main/lores geometry, preserve auto 0/0 and raw/sensor settings,
 * then run structural preflight. Outputs must be disjoint from each other; they
 * may replace their respective input objects in place. No hardware acceptance. */
int zc_align_camera_configuration(const zc_config *,const zc_pipeline_options *,const zc_processed_options *,uint32_t profile,uint32_t optimal,zc_config *out_config,zc_pipeline_options *out_pipeline);
/* Existing config/stream/frame layouts remain ABI v1. Strict color rejects
 * backend adjustments against the format-normalized effective request. */
int zc_open_processed_pipeline(const zc_config *,const zc_pipeline_options *,const zc_processed_options *,uint32_t orientation,uint32_t strict_orientation,zc_camera **out);
int zc_open_id_processed_pipeline(const zc_config *,const zc_pipeline_options *,const zc_processed_options *,uint32_t orientation,uint32_t strict_orientation,const uint8_t *id,uint32_t length,zc_camera **out);
/* flags: configured=1, strict=2, RGB-normalized=4, backend-adjusted=8.
 * Absent/unknown actual metadata counts as adjusted for configured requests.
 * main/lores only; requested/effective are absent for backend-default requests. */
typedef struct { uint32_t struct_size,flags,format,reserved; zc_color_space requested,effective,actual; } zc_color_negotiation;
int zc_get_color_negotiation(zc_camera *,uint32_t stream,zc_color_negotiation *out);
/* Exact UTF-8 backend ID selection. ID bytes are nonempty, at most 4096 bytes,
 * with no NUL or terminator. cfg.camera_index must be zero; never falls back.
 * Old config/ABI layouts remain unchanged. Copy returns the full selected ID;
 * null/zero queries length, short buffers reject without writing a prefix. */
#define ZC_MAX_CAMERA_ID 4096
/* A watch pins the backend manager without acquiring a camera. Open before
 * discovery; subsequent events invalidate discovery snapshots. No initial added
 * events or atomic snapshot/event boundary is promised. Each event is consumed
 * once. missed is a cumulative eviction/invalid-ID count; rescan on any change.
 * RESCAN carries no ID. Other IDs are exact length-delimited UTF-8, never cut.
 * Capacity is 1..64; at most 32 live watches per backend. Callbacks only copy to
 * preallocated storage. stop retires callbacks/releases the manager and wakes
 * waiters; queued events remain readable, then wait returns CANCELLED. close
 * stops first and returns BUSY while waits remain; retry after joining them.
 * Synchronize all other entries with close. Failed wait leaves out untouched.
 * Choose custom tuning BEFORE opening a watch, using a tuning session. */
enum { ZC_CAMERA_ADDED=1, ZC_CAMERA_REMOVED=2, ZC_CAMERA_RESCAN=3 };
typedef struct zc_camera_watch zc_camera_watch;
typedef struct {
    uint32_t struct_size,backend,kind,id_length;
    uint64_t sequence,missed;
    uint8_t id[ZC_MAX_CAMERA_ID];
} zc_camera_event;
typedef struct {
    uint32_t struct_size,backend,capacity,queued;
    uint64_t sequence,missed;
    uint32_t stopped,waiters;
} zc_camera_watch_state;
int zc_camera_watch_open(uint32_t backend,uint32_t capacity,zc_camera_watch **out);
int zc_camera_watch_wait(zc_camera_watch *,uint32_t timeout_ms,zc_camera_event *out);
int zc_camera_watch_get_state(zc_camera_watch *,zc_camera_watch_state *out);
int zc_camera_watch_stop(zc_camera_watch *);
int zc_camera_watch_close(zc_camera_watch *);
/* Scoped synthetic event injection; does not change discovery/capture topology.
 * Real watches reject UNSUPPORTED. Invalid input does not mutate the queue. */
int zc_camera_watch_simulate_event(zc_camera_watch *,uint32_t kind,const uint8_t *id,uint32_t length);
/* Caller-owned, serialized Home retry policy on a supplied monotonic ns clock.
 * 1..1024 attempts; no allocation/timers/I/O. Poll returns 1 for a claim, 0 when
 * not due/exhausted, negative on invalid state without mutation.
 * First claim waits initial_ns, later failures use capped exponential backoff.
 * Observe failure at completion to arm without shifting the next deadline;
 * success clears the deadline, never the lifetime attempt budget. */
typedef struct {
    uint32_t struct_size,max_attempts,attempts,armed;
    uint64_t initial_ns,maximum_ns,deadline_ns;
} zc_recovery_retry;
int zc_recovery_retry_init(uint32_t max_attempts,uint64_t initial_ns,uint64_t maximum_ns,zc_recovery_retry *out);
int zc_recovery_retry_poll(zc_recovery_retry *,uint64_t now_ns,uint32_t failed);
int zc_recovery_retry_observe(zc_recovery_retry *,uint64_t now_ns,uint32_t failed);
/* Owned JSON tuning data; does not apply an ISP policy. Native limits are
 * 16 MiB, 262144 scanner tokens and 64 container levels. Number text is exact.
 * Copy/find NULL+0 queries required length; short outputs remain untouched.
 * Mutations are serialized and transactional. Close requires caller lifetime
 * coordination. Missing algorithms return UNSUPPORTED; ambiguous/invalid data
 * returns INVALID. Old ABI layouts are unchanged. */
typedef struct zc_tuning_document zc_tuning_document;
int zc_tuning_document_open(const uint8_t *,uint64_t length,zc_tuning_document **out);
int zc_tuning_document_version(zc_tuning_document *,uint32_t *out);
int zc_tuning_document_copy(zc_tuning_document *,uint8_t *data,uint64_t capacity,uint64_t *length);
int zc_tuning_document_find(zc_tuning_document *,const uint8_t *name,uint32_t name_length,uint8_t *data,uint64_t capacity,uint64_t *length);
int zc_tuning_document_replace(zc_tuning_document *,const uint8_t *name,uint32_t name_length,const uint8_t *json,uint64_t length);
void zc_tuning_document_close(zc_tuning_document *);
/* A process/backend-wide immutable tuning reservation, acquired BEFORE camera
 * discovery/open. Equal byte snapshots share; conflicting/default live managers
 * reject BUSY. Retain across worker reopens. Untuned opens inherit the manager's
 * policy. Only the Raspberry Pi IPA consumes this file; synthetic tests lifecycle.
 * Close may fail on cleanup and then retains the handle for retry. */
typedef struct zc_tuning_session zc_tuning_session;
typedef struct {
    uint32_t struct_size,backend,custom,manager_users,session_users,environment_active,cleanup_pending,external_change;
    int32_t last_error;
    uint32_t reserved;
    uint64_t generation,bytes;
} zc_tuning_state;
int zc_tuning_session_open(const uint8_t *json,uint64_t length,uint32_t backend,zc_tuning_session **out);
int zc_tuning_session_close(zc_tuning_session *);
int zc_get_tuning_state(uint32_t backend,zc_tuning_state *out);
int zc_tuning_cleanup(uint32_t backend);
int zc_open_id_pipeline(const zc_config *, const zc_pipeline_options *, const uint8_t *id, uint32_t length, zc_camera **out);
int zc_get_camera_id(zc_camera *, uint8_t *data, uint32_t capacity, uint32_t *length);
int zc_open_pipeline(const zc_config *,const zc_pipeline_options *,zc_camera **);
/* libcamera orientation values. Rotations are clockwise. Request rotation first,
 * then flips along output axes and optional final diagonal transposition with
 * zc_orientation_from_transform. Already
 * transformed pixels must not receive the orientation again as an EXIF tag. */
enum { ZC_ROTATE0=1,ZC_ROTATE0_MIRROR=2,ZC_ROTATE180=3,ZC_ROTATE180_MIRROR=4,
       ZC_ROTATE90_MIRROR=5,ZC_ROTATE270=6,ZC_ROTATE270_MIRROR=7,ZC_ROTATE90=8 };
typedef struct { uint32_t struct_size,requested,actual,adjusted; } zc_orientation_info;
int zc_orientation_from_transform(uint32_t rotation,uint32_t hflip,uint32_t vflip,uint32_t transpose,uint32_t *out);
/* strict is 0 (accept/report pipeline adjustments) or 1 (require exact orientation).
 * Existing config/stream layouts remain unchanged; width/height are requested
 * output dimensions. Sensor dimensions remain physical. Raw CFA order and raw
 * geometry are negotiated and reported by get_info, never assumed from input. */
int zc_open_oriented_pipeline(const zc_config *,const zc_pipeline_options *,uint32_t orientation,uint32_t strict,zc_camera **out);
int zc_open_id_oriented_pipeline(const zc_config *,const zc_pipeline_options *,uint32_t orientation,uint32_t strict,const uint8_t *id,uint32_t length,zc_camera **out);
/* Main format is one of the ZC_YUV420..ZC_VYUY processed formats. RGB24 is
 * the legacy default. 4:2:0 requires even dimensions; packed 4:2:2 requires
 * even width, with odd height permitted; negotiated format/stride must remain supported.
 * RGB and 4:2:0 plane descriptors share the existing ABI v1 layouts. Color space
 * is negotiated and queried with zc_get_stream_color_space, never guessed. */
int zc_open_formatted_pipeline(const zc_config *,const zc_pipeline_options *,uint32_t main_format,uint32_t orientation,uint32_t strict,zc_camera **out);
int zc_open_id_formatted_pipeline(const zc_config *,const zc_pipeline_options *,uint32_t main_format,uint32_t orientation,uint32_t strict,const uint8_t *id,uint32_t length,zc_camera **out);
int zc_get_orientation(zc_camera *,zc_orientation_info *out);
int zc_get_pipeline_info(zc_camera *,zc_pipeline_info *);
/* Cached discovery: no reconfiguration or capture interruption. Query with
 * NULL/0 first. count is total; insufficient capacity returns INVALID. Formats
 * advertise raw outputs, not measured FPS, exposure or optical guarantees. */
int zc_get_sensor_modes(zc_camera *,zc_sensor_mode *,uint32_t capacity,uint32_t *count);
/* Borrowed descriptor valid only for this lease. Disabled stream: UNSUPPORTED. */
int zc_get_stream(zc_camera *,uint64_t token,uint32_t stream,zc_stream *);
/* Opt in before the first start. DMA CPU access uses READ|WRITE for this whole
 * handle and every mapping must permit writes. Default handles remain READ-only.
 * Failure preserves read capture; never silently substitutes read-only access. */
int zc_enable_writable(zc_camera *);
int zc_frame_readable(zc_camera *,uint64_t token);
int zc_copy_frame_rgb(zc_camera *,uint64_t token,uint8_t *out,uint64_t length);
/* Packed RGB/BGR/RGBX/BGRX main/lores or planar/semi-planar 4:2:0 or packed 4:2:2 converted into tight RGB24.
 * All planes and destination are validated before writing; raw is unsupported. */
int zc_copy_stream_rgb(zc_camera *,uint64_t token,uint32_t stream,uint8_t *out,uint64_t length);
/* Scoped maps retain their own generation-checked frame reference. Read maps
 * share; write maps require writable mode and exactly one external owner. A
 * writer excludes stream reads and retention until close. Metadata remains usable.
 * Map count shares the existing bounded reference pool/producer reservation.
 * Returned stream pointers are borrowed until map close, which consumes even on
 * DMA/requeue failure. Never access escaped views after close or race CPU access. */
typedef struct zc_frame_map zc_frame_map;
int zc_frame_map_open(zc_camera *,uint64_t token,uint32_t stream,uint32_t write,zc_frame_map **out);
int zc_frame_map_stream(const zc_frame_map *,zc_stream *out);
/* Other streams under the same scoped access gate. No additional lease/writer. */
int zc_frame_map_get_stream(const zc_frame_map *,uint32_t stream,zc_stream *out);
int zc_frame_map_close(zc_frame_map *);
/* Tight owned copies preserve byte layout (RGB/BGR/RGBX/BGRX); YUV420/YVU420/NV12/NV21 preserve plane order; Bayer => unchanged
 * unpacked samples, CSI-2 packed rows or PiSP COMP1 blocks, with row padding removed.
 * Raw packing and monochrome/Bayer order remain unchanged. The size query never dereferences plane pointers. */
int zc_stream_copy_size(const zc_stream *,uint64_t *bytes);
int zc_copy_stream(const zc_stream *,uint8_t *out,uint64_t length);
typedef struct {
    uint32_t valid; /* bit 0 black levels, bit 1 CCM, bit 2 white balance */
    float black_levels[4]; /* R, Gr, Gb, B; normalized to a 16-bit range */
    float camera_to_srgb[9]; /* libcamera ColourCorrectionMatrix; WB is separate */
    char model[128];
} zc_raw_metadata;
/* IMX708 sensor HDR is a pre-open layout control, distinct from runtime HdrMode.
 * Exact ID and index selection are mutually exclusive; UINT32_MAX means automatic
 * first matching IMX708. Explicit synthetic backend models ownership only.
 * At most 16 helpers may own descriptors. Mutations require every camera,
 * discovery scope and manager watch in this process to have closed; BUSY never
 * resets an active manager. Later camera opens obtain a fresh mode catalog.
 * Flags preserve observations even on failed/partially applied writes. Unknown
 * current/previous values remain absent. Close does not reset the sensor mode.
 * Per-helper operations require caller serialization; close returns BUSY while
 * an operation is entered. No HDR quality or hardware acceptance is implied. */
/* Logical-client scopes protect sensor layouts across native close/reopen jobs.
 * Native sessions and Bun Camera owners retain these automatically. Up to 64
 * additional explicit scopes may be retained; close each exactly once. */
typedef struct zc_sensor_layout_scope zc_sensor_layout_scope;
int zc_sensor_layout_scope_open(uint32_t backend,zc_sensor_layout_scope **out);
int zc_sensor_layout_scope_close(zc_sensor_layout_scope *);
int zc_sensor_layout_users_get(uint32_t backend,uint32_t *count);
typedef struct zc_imx708 zc_imx708;
enum { ZC_SENSOR_HDR_CURRENT=1,ZC_SENSOR_HDR_PREVIOUS=2,ZC_SENSOR_HDR_CHANGED=4,ZC_SENSOR_HDR_WRITE_ATTEMPTED=8,ZC_SENSOR_HDR_WRITE_SUCCEEDED=16,ZC_SENSOR_HDR_CATALOG_INVALIDATED=32,ZC_SENSOR_HDR_SYNTHETIC=64 };
typedef struct {uint32_t struct_size,backend,flags;int32_t system_errno;uint64_t manager_generation;uint32_t enabled,previous_enabled;} zc_sensor_hdr_state;
int zc_imx708_open(uint32_t backend,uint32_t index,const uint8_t *id,uint32_t id_length,zc_imx708 **out);
int zc_imx708_camera_id(zc_imx708 *,uint8_t *,uint64_t capacity,uint64_t *length);
int zc_imx708_get_hdr_mode(zc_imx708 *,zc_sensor_hdr_state *);
int zc_imx708_set_hdr_mode(zc_imx708 *,uint32_t enabled,zc_sensor_hdr_state *);
int zc_imx708_close(zc_imx708 *);

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
 ZC_COLOUR_TEMPERATURE,ZC_AE_FLICKER_MODE,ZC_AE_FLICKER_PERIOD,ZC_HDR_MODE,ZC_CONTROL_COUNT };
enum { ZC_HDR_OFF=0,ZC_HDR_SINGLE_EXPOSURE=1,ZC_HDR_MULTI_EXPOSURE=2,ZC_HDR_NIGHT=3,ZC_HDR_MULTI_EXPOSURE_UNMERGED=4 };
typedef struct {uint32_t id,type,count,reserved;double values[16];} zc_control;
typedef struct {
 uint32_t id,type,min_count,max_count;
 double min[4],max[4],def[4]; uint64_t enum_mask;
} zc_control_info;
typedef struct {
 uint32_t struct_size,valid; /* AF=1, lens=2, duration=4, crop=8, capture-clock timestamp=16, AF pause=32, exposure=64 */
 uint64_t event_id,sequence,timestamp_ns,control_revision;
 uint32_t exposure_us; int32_t af_state,af_pause_state; uint32_t reserved;
 float analogue_gain,lens_position,red_gain,blue_gain;
 uint64_t frame_duration_us; int32_t crop[4];
} zc_metadata;
/* Tight multi-stream request snapshot. Layouts are in caller-selected order;
 * offsets/lengths index one caller-owned byte buffer. No camera pointers escape.
 * 1..3 distinct enabled main/raw/lores IDs are required. All sources and output
 * capacity are validated under the request lock before any pixel is copied.
 * data=NULL/capacity=0 queries size and layouts; other insufficient capacity
 * returns INVALID. On failure only *size becomes zero; other outputs stay intact.
 * The caller owns the lease across query/copy and provides disjoint output
 * buffers which do not alias source pixels, IDs or each other. */
typedef struct {
    uint32_t stream,width,height,row_bytes; char format[32];
    uint64_t offset,length;
} zc_packed_stream;
int zc_copy_frame_streams(zc_camera *,uint64_t token,const uint32_t *streams,uint32_t count,
    zc_packed_stream *layouts,uint32_t layout_capacity,uint8_t *data,uint64_t capacity,
    uint64_t *size,zc_metadata *metadata);

/* Consumer-owned bounded selection state; initialize once, serialize access and
 * use within one camera completion timeline. Never edits/recycles a request.
 * Timestamp is inclusive; EXPOSURE_GUARD subtracts exposure_us*1000, saturating
 * at zero. Required timing must be explicitly valid, otherwise UNSUPPORTED.
 * Repeated/out-of-order completion events do not consume more drops.
 * SYNC_READY also requires explicitly true per-request SyncReady; false/absent
 * waits. Backend/query errors preserve filter state. Acceptance is terminal. */
enum { ZC_CAPTURE_TIMESTAMP=1, ZC_CAPTURE_EXPOSURE_GUARD=2, ZC_CAPTURE_SYNC_READY=4 };
/* Exact request-local software-sync metadata. valid: ready=1, timer=2.
 * Missing values stay absent; timer is signed microseconds to the ready time.
 * Failure clears out. This reads the backend algorithm's status; it does not
 * synchronize cameras or infer readiness from host timestamps. */
typedef struct { uint32_t struct_size,valid,ready,reserved; int64_t timer_us; } zc_frame_sync_state;
int zc_get_frame_sync_state(zc_camera *,uint64_t token,zc_frame_sync_state *out);
typedef struct {
 uint32_t struct_size,remaining,flags,observed;
 uint64_t after_ns,last_event;
} zc_capture_filter;
int zc_capture_filter_init(zc_capture_filter *,uint32_t drop_frames,uint32_t flags,uint64_t after_ns);
/* Linux BOOTTIME, Darwin virtual-camera MONOTONIC; never wall-clock time. */
int zc_capture_clock_ns(uint64_t *out);
/* Relative idle delay in one caller-supplied monotonic ns domain. Queries update
 * the last observation; regression/overflow preserve state. Caller serializes.
 * Initialize before use. Remaining is zeroed on failure; reserved must be zero. */
typedef struct { uint64_t started_ns,last_ns,deadline_ns; uint32_t armed,reserved; } zc_capture_delay;
void zc_default_capture_delay(zc_capture_delay *);
int zc_capture_delay_arm(zc_capture_delay *,uint64_t now_ns,uint64_t duration_ns);
int zc_capture_delay_remaining(zc_capture_delay *,uint64_t now_ns,uint64_t *remaining_ns);

int zc_capture_filter_accept(zc_camera *,uint64_t token,zc_capture_filter *);
/* Releases every rejected frame; success transfers one owner. timeout=0 tries
 * one frame. Filter progress is retained on TIMEOUT; out stays untouched. */
int zc_acquire_filtered(zc_camera *,zc_capture_filter *,uint32_t timeout_ms,zc_frame *out);
int zc_get_control_info(zc_camera *,uint32_t id,zc_control_info *);
/* Copied, sorted persistent requests (AF trigger/pause excluded). Null/zero queries
 * count/revision. Small buffers reject without copying. Revisions are logical
 * request submissions, not physical application acknowledgements. */
int zc_get_controls(zc_camera *,zc_control *,uint32_t capacity,uint32_t *count,uint64_t *revision);
/* Replay atomically before the FIRST start on a fresh handle, once only. Rejects
 * one-shot controls. The base carries revision continuity across reopened modes.
 * Invalid/unsupported replay leaves the fresh handle retryable. Empty replay
 * seeds the base without issuing controls. Never mutates an already-used handle. */
int zc_restore_controls(zc_camera *,const zc_control *,uint32_t count,uint64_t base_revision,uint64_t *revision);
int zc_set_controls(zc_camera *,const zc_control *,uint32_t count,uint64_t *revision);
int zc_get_frame_metadata(zc_camera *,uint64_t token,zc_metadata *);
/* Observer only: consumes no frame. event_id is monotonic across restart.
 * Wait/AF wait must have returned before close; stop wakes all observers. */
int zc_wait_metadata(zc_camera *,uint64_t after_event,uint32_t timeout_ms,zc_metadata *);
enum { ZC_AF_PENDING=1,ZC_AF_SCANNING=2,ZC_AF_SUCCEEDED=3,ZC_AF_FAILED=4,
 ZC_AF_CANCELLED=5,ZC_AF_STOPPED=6 };
/* Continuous AF requires an explicit accepted AfMode=2 setting. Pause commands:
 * immediate=0, deferred=1, resume=2. Wait/cancel use the same AF ID namespace.
 * Pause success acknowledges Paused, resume success acknowledges Running, at or
 * after the submitted revision. Cancellation restores the prior accepted intent.
 * Restore supersedes this owned pause with a fresh job for its previous intent.
 * One-shot pause intent is not included in persistent mode replay. */
enum { ZC_AF_PAUSE_IMMEDIATE=0,ZC_AF_PAUSE_DEFERRED=1,ZC_AF_PAUSE_RESUME=2 };
int zc_autofocus_pause_start(zc_camera *,uint32_t command,uint64_t *job_id);
int zc_autofocus_pause_restore(zc_camera *,uint64_t job_id,uint64_t *restore_job_id);
/* Requires a successful pause job. Filters stale/unpaused frames and releases
 * every rejection. require_focused=1 also requires AF metadata reporting Focused;
 * paused scanning/failed => STATE, absent AF metadata => UNSUPPORTED.
 * Later focus controls/resume invalidate the token.
 * Validate an existing lease with the same predicate; TIMEOUT means this frame
 * is older/unpaused. Does not acquire, release or mutate the frame. */
int zc_focus_locked_validate(zc_camera *,uint64_t job_id,uint64_t token,uint32_t require_focused);
/* Acquire variant releases all rejected frames. timeout=0 tries one frame. */
int zc_acquire_focus_locked(zc_camera *,uint64_t job_id,uint32_t require_focused,uint32_t timeout_ms,zc_frame *);
int zc_autofocus_start(zc_camera *,uint64_t *job_id);
int zc_autofocus_cancel(zc_camera *,uint64_t job_id);
int zc_autofocus_wait(zc_camera *,uint64_t job_id,uint32_t timeout_ms,uint32_t *state);
/* Owned immutable HCAT v1 snapshots, bounded to 4 MiB. Query/copy is atomic:
 * null/zero obtains size; too-small destinations remain untouched. Close after
 * use; snapshots outlive camera/frame close. Unknown backend types retain bytes.
 * backend: ZC_LIBCAMERA=1 or ZC_SYNTHETIC=0, never implicit fallback. */
enum { ZC_CATALOG_DISCOVERY=1, ZC_CATALOG_PROPERTIES=2, ZC_CATALOG_CONTROLS=3, ZC_CATALOG_METADATA=4, ZC_CATALOG_CONTROL_STATE=5, ZC_CATALOG_CONTROL_UPDATE=6, ZC_CATALOG_CONFIGURATION=7 };
enum { ZC_CATALOG_INPUT=1, ZC_CATALOG_OUTPUT=2, ZC_CATALOG_ARRAY=4,
       ZC_CATALOG_DIRECTION_KNOWN=8, ZC_CATALOG_EXTENT_KNOWN=16,
       ZC_CATALOG_VENDOR_KNOWN=32, ZC_CATALOG_ENUMERATORS_KNOWN=64 };
enum { ZC_CONTROL_NO_REPLAY=128, ZC_MAX_NATIVE_CONTROLS=256 };
enum { ZC_CATALOG_CURRENT=0, ZC_CATALOG_MINIMUM=1, ZC_CATALOG_MAXIMUM=2,
       ZC_CATALOG_DEFAULT=3, ZC_CATALOG_CHOICE=4, ZC_CATALOG_ENUMERATOR=5 };
typedef struct zc_catalog zc_catalog;
int zc_discover(uint32_t backend, zc_catalog **out);
/* HCAT control-update (6) inputs, control-state (5) snapshots. One current value
 * per record, native IDs, <=256 records / 4 MiB. Flag 128 excludes replay. Native
 * and convenience controls share revisions; typed state is owned by Zig. Restore
 * is pre-start only; optional convenience restore must precede typed restore. */
int zc_set_native_controls(zc_camera *,const uint8_t *,uint64_t,uint64_t *revision);
int zc_get_native_controls(zc_camera *,zc_catalog **out,uint64_t *revision);
int zc_restore_native_controls(zc_camera *,const uint8_t *,uint64_t,uint64_t base,uint64_t *revision);
int zc_camera_properties(zc_camera *, zc_catalog **out);
int zc_camera_controls(zc_camera *, zc_catalog **out);
int zc_frame_metadata_catalog(zc_camera *, uint64_t token, zc_catalog **out);
/* Owned request-time recipe/negotiated configuration, <=64 KiB, HCAT kind 7.
 * Full metadata additionally carries these reserved groups, vendor zig-camera.
 * Startup hints are distinct from per-frame applied controls/metadata. */
#define ZC_CONFIGURATION_GROUP_BASE 0x5a430000u
int zc_frame_configuration_catalog(zc_camera *,uint64_t token,zc_catalog **out);
/* Session properties are snapshotted lazily once per camera owner, independent
 * of runtime controls. Returned catalogs own exact backend bytes after close. */
int zc_frame_properties_catalog(zc_camera *,uint64_t token,zc_catalog **out);
int zc_catalog_copy(const zc_catalog *, uint8_t *data, uint64_t capacity, uint64_t *length);
void zc_catalog_close(zc_catalog *);
/* Low-level process handoff owner. Hold until every consumer has unmapped and
 * acknowledged completion or its process has verifiably exited. Duplication of
 * an fd does not extend the camera lease. This API does not supervise children.
 * Caller serializes get/copy/close; close consumes even on DMA/requeue errors.
 * Real DMA descriptors are duplicated (no pixel copy). fd-less sources stage
 * bytes_used into zero-initialized anonymous shared memory; writable staging
 * copies used bytes back before retiring the exclusive native map.
 * Export info contains no pointers. fd fields are borrowed from this owner:
 * never close them or access buffers after export close. CLOEXEC on every fd.
 * At most 32 exports and 512 MiB declared plane bytes+catalog are admitted. */
#define ZC_MAX_EXPORT_PLANES 12
enum { ZC_EXPORT_WRITABLE=1, ZC_EXPORT_STAGED=2 };
typedef struct zc_frame_export zc_frame_export;
typedef struct { uint32_t stream,width,height,stride,plane_count,first_plane; char format[32]; } zc_export_stream;
typedef struct { int32_t fd; uint32_t flags; uint64_t offset,length,bytes_used; } zc_export_plane;
typedef struct {
    uint32_t struct_size,stream_count,plane_count,flags;
    zc_metadata metadata;
    zc_color_space colors[3];
    zc_export_stream streams[3];
    zc_export_plane planes[ZC_MAX_EXPORT_PLANES];
} zc_export_info;
/* streams is a nonempty mask of (1u<<ZC_MAIN/RAW/LORES); flags only WRITABLE.
 * Each export's declared planes are capped at 256 MiB, metadata at 4 MiB. */
int zc_frame_export_open(zc_camera *,uint64_t token,uint32_t streams,uint32_t flags,zc_frame_export **out);
int zc_frame_export_info(const zc_frame_export *,zc_export_info *out);
int zc_frame_export_catalog_copy(const zc_frame_export *,uint8_t *,uint64_t capacity,uint64_t *length);
/* Immutable request-time configuration projected from the retained full catalog. */
int zc_frame_export_configuration_copy(const zc_frame_export *,uint8_t *,uint64_t capacity,uint64_t *length);
/* Properties embedded in this export's existing full metadata. Legacy absence
 * => UNSUPPORTED/length=0. Copies reject malformed, short or overlapping output. */
int zc_frame_export_properties_copy(const zc_frame_export *,uint8_t *,uint64_t capacity,uint64_t *length);
/* Immutable request-time calibration; validity bits preserve unavailable fields. */
int zc_frame_export_raw_metadata(const zc_frame_export *,zc_raw_metadata *out);
int zc_frame_export_close(zc_frame_export *);

/* Local Linux/Darwin 64-bit little-endian descriptor channel, no process
 * supervision. Pair/duplicate return owned CLOEXEC descriptors; close once.
 * All I/O is nonblocking: TIMEOUT means empty/full queue, no partial send.
 * Hold the sending export until remote maps are closed and ACK or peer exit
 * verified. ACK cookies must be unique among live sends. Sending does not
 * transfer/retire the export owner. Calls on each owner must be serialized. */
typedef struct zc_remote_frame zc_remote_frame;
typedef struct zc_image_blob zc_image_blob;
int zc_frame_channel_pair(int32_t out[2]);
int zc_frame_channel_duplicate(int32_t borrowed,int32_t *out);
int zc_frame_channel_close(int32_t owned);
int zc_frame_channel_send(int32_t channel,const zc_frame_export *,uint64_t cookie);
int zc_frame_channel_receive(int32_t channel,zc_remote_frame **out,uint64_t *cookie);
/* Send ACK only AFTER closing the remote frame and its borrowed views.
 * These primitives do not associate acknowledgements with sender owners. */
int zc_frame_channel_ack(int32_t channel,uint64_t cookie);
int zc_frame_channel_receive_ack(int32_t channel,uint64_t *cookie);
int zc_remote_frame_info(const zc_remote_frame *,zc_export_info *out);
int zc_remote_frame_catalog_copy(const zc_remote_frame *,uint8_t *,uint64_t capacity,uint64_t *length);
/* Borrowed mapped planes; const/read-only unless export is WRITABLE. Mapping
 * does not extend sender camera ownership. Close views before remote close. */
int zc_remote_frame_stream(const zc_remote_frame *,uint32_t stream,zc_stream *out);
/* Independent tight RGB8/RGB16 copies through Home conversions. Query with
 * data=NULL,capacity=0; raw is unsupported. No borrowed pixels escape. */
int zc_remote_frame_copy_rgb(const zc_remote_frame *,uint32_t stream,uint32_t bits,uint8_t *data,uint64_t capacity,uint64_t *length);
/* Missing configuration namespace => UNSUPPORTED, zero length; pixels remain usable. */
int zc_remote_frame_configuration_copy(const zc_remote_frame *,uint8_t *,uint64_t capacity,uint64_t *length);
int zc_remote_frame_properties_copy(const zc_remote_frame *,uint8_t *,uint64_t capacity,uint64_t *length);
/* Exact calibration from the sender. Legacy v1 records return zero validity. */
int zc_remote_frame_raw_metadata(const zc_remote_frame *,zc_raw_metadata *out);
/* Tight owned bundle in caller order, removing padding but preserving format/
 * plane order/packing. Query data=NULL,capacity=0. No output prefix on failure. */
int zc_remote_frame_copy_streams(const zc_remote_frame *,const uint32_t *ids,uint32_t count,zc_packed_stream *layouts,uint32_t layout_capacity,uint8_t *data,uint64_t capacity,uint64_t *size);
/* Concatenate physical bytes_used in plane order, preserving used padding. */
int zc_remote_frame_copy_buffer(const zc_remote_frame *,uint32_t stream,uint8_t *data,uint64_t capacity,uint64_t *length);
/* Home raw decoder, tight LE u16 without scaling or demosaicing; <=256 MiB. */
int zc_remote_frame_copy_raw16(const zc_remote_frame *,uint8_t *data,uint64_t capacity,uint64_t *length);
/* Existing calibrated DNG writer; no inferred calibration. Owned encoded blob
 * <=256 MiB, or streaming atomic file (including used rows, no full pixel copy).
 * Calls are synchronous; process cancellation does not roll back a saved file. */
int zc_remote_frame_encode_dng(const zc_remote_frame *,zc_image_blob **out);
int zc_remote_frame_save_dng(const zc_remote_frame *,const char *path);
int zc_remote_frame_close(zc_remote_frame *);

/* Supervised processing ownership. Up to 8 sessions, 8 workers/session and 32
 * tasks/session; args <=16 MiB, reserved results <=256 MiB and aggregate <=512 MiB. Native owns
 * exports and argument bytes after successful submit; failure consumes neither.
 * Workers have monotonic generations. ACK is read from the selected channel.
 * stop_worker quarantines only; it never permits retiring sent tasks. The host
 * MUST await verified child exit before worker_joined. No OS process is spawned
 * or joined by these C primitives. Each session's calls must be serialized. */
typedef struct zc_process_session zc_process_session;
typedef struct {uint32_t struct_size,workers,pending,queued,active,retired,live_workers,reserved;uint64_t bytes,issued,released;} zc_process_state;
typedef struct {uint32_t pending,accepting,joined,reserved;uint64_t generation,active;} zc_process_worker_state;
int zc_process_open(uint32_t workers,uint32_t items,uint64_t bytes,zc_process_session **out);
/* BUSY retains session until all tasks released and all peers verified joined. */
int zc_process_close(zc_process_session *);
/* Non-reserving preflight; submit revalidates atomically after source export. */
int zc_process_can_submit(zc_process_session *,uint64_t args_bytes,uint64_t reserved_result_bytes);
int zc_process_submit(zc_process_session *,zc_frame_export *owned,const uint8_t *args,uint64_t length,uint64_t reserved_result_bytes,uint64_t *cookie,uint32_t *worker,uint64_t *generation);
int zc_process_next(zc_process_session *,uint32_t worker,uint64_t generation,uint64_t *cookie);
int zc_process_send(zc_process_session *,uint64_t cookie,int32_t channel);
int zc_process_payload_copy(zc_process_session *,uint64_t cookie,uint8_t *,uint64_t capacity,uint64_t *length);
int zc_process_receive_ack(zc_process_session *,uint32_t worker,uint64_t generation,int32_t channel,uint64_t *cookie);
int zc_process_stop_worker(zc_process_session *,uint32_t worker,uint64_t generation);
int zc_process_worker_joined(zc_process_session *,uint32_t worker,uint64_t generation);
int zc_process_restart_worker(zc_process_session *,uint32_t worker,uint64_t generation,uint64_t *next_generation);
/* Retire closes the export/args but retains admission for completion callbacks.
 * Sent tasks return BUSY until ACK or verified join. A permitted retire consumes
 * resources even on I/O error. Release requires retired; frees the task slot. */
int zc_process_retire(zc_process_session *,uint64_t cookie);
int zc_process_release(zc_process_session *,uint64_t cookie);
int zc_process_get_state(zc_process_session *,zc_process_state *out);
int zc_process_get_worker_state(zc_process_session *,uint32_t worker,zc_process_worker_state *out);
int zc_process_pending_through(zc_process_session *,uint64_t target,uint32_t *pending);

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
/* Acquire one owned request and stop the camera without copying pixels.
 * Success leaves a readable lease; release it before restart/close/reconfigure.
 * Failure clears out and releases a private acquired candidate before returning;
 * a cleanup error takes precedence over the stop error. Lifecycle is serialized
 * by the caller as for acquire/stop. No request callbacks run in this C helper. */
int zc_acquire_and_stop(zc_camera *,uint32_t timeout_ms,zc_frame *out);
/* Distinct token for the same completed request, without copying pixels.
 * Release each token once. Final release ends DMA access and recycles.
 * Stats.leased counts pinned buffers, not references. Capacity is reserved for
 * primary references of unleased buffers. Retains survive stop; close/restart
 * reject any outstanding reference. Tokens are scoped to the issuing camera. */
int zc_retain(zc_camera *,uint64_t token,zc_frame *out);
int zc_frame_references(zc_camera *,uint64_t token,uint32_t *out);
int zc_release(zc_camera *, uint64_t token);
int zc_stop(zc_camera *);
int zc_close(zc_camera *);
/* Terminal device loss is separate from stop and generic errors. Existing
 * completed leases/maps retain ownership and may still be read/released. No
 * restart/requeue is allowed on a lost handle. Fence errors remain observable.
 * Waiters require caller coordination with close. Synthetic injection is never
 * available on a real-backend build. This does not reconnect/replace a camera. */
typedef struct {
    uint32_t struct_size,connected,running,leased;
    int32_t status;
    uint32_t ready;
    uint64_t disconnect_event;
} zc_device_state;
int zc_get_device_state(zc_camera *,zc_device_state *out);
int zc_wait_disconnected(zc_camera *,uint32_t timeout_ms,zc_device_state *out);
int zc_simulate_disconnect(zc_camera *);
/* Same close ownership contract; successful close copies final state AFTER
 * callback retirement and before freeing the handle. Failure leaves out intact. */
int zc_close_with_device_state(zc_camera *,zc_device_state *out);
int zc_get_stats(zc_camera *, zc_stats *out);
/* quality 1..100, 4:4:4 sampling; operates on an outstanding lease, no RGB copy. */
int zc_save_jpeg(zc_camera *, uint64_t token, const char *path, uint32_t quality);
/* GIF uses an adaptive <=256-color palette. RGB16 reduces to high bytes. */
enum { ZC_IMAGE_JPEG=1,ZC_IMAGE_PNG=2,ZC_IMAGE_BMP=3,ZC_IMAGE_TIFF=4,ZC_IMAGE_PPM=5,ZC_IMAGE_DNG=6,ZC_IMAGE_GIF=7 };
enum { ZC_PNG_ADAPTIVE=0,ZC_PNG_NONE=1,ZC_PNG_SUB=2,ZC_PNG_UP=3,ZC_PNG_AVERAGE=4,ZC_PNG_PAETH=5 };
typedef struct { uint32_t struct_size,format,quality,png_compression,png_filter; } zc_image_options;
enum { ZC_IMAGE_PROFILE_SRGB=1 };
/* Bytes remain immutable/live for each synchronous call. flags=0 supplies RGB ICC bytes (<=16MiB);
 * SRGB requires null data/zero length and an actual Rec709/sRGB source.
 * Embedding describes samples; it never transforms their gamut or transfer. */
typedef struct { uint32_t struct_size,flags; const uint8_t *data; uint64_t length; } zc_image_profile;
int zc_check_image_profile(const zc_image_options *,const zc_image_profile *);
/* Exif payload is borrowed, immutable classic TIFF (optional Exif prefix).
 * CAPTURE fills missing fields from this request; raw caller fields win.
 * Null/empty flags=0 disables Exif. JPEG defaults can be requested independently
 * of custom bytes. Old image/profile APIs keep their existing behavior. */
enum { ZC_IMAGE_EXIF_CAPTURE=1 };
typedef struct { uint32_t struct_size,flags; const uint8_t *data; uint64_t length; } zc_image_exif;
enum { ZC_EXIF_IMAGE=0,ZC_EXIF_PHOTO=1,ZC_EXIF_GPS=2,ZC_EXIF_INTEROP=3,ZC_EXIF_THUMBNAIL=4 };
/* TIFF types 1..12 accept little-endian field bytes. Application value types
 * GPS_DECIMAL (f64; GPS tags 2,4,6) and ISO (u32; photo tag 0x8833) expand
 * through Home's shared typed builders. Reserved fields must be zero. */
enum { ZC_EXIF_GPS_DECIMAL=256,ZC_EXIF_ISO=257 };
typedef struct {
 uint16_t group,tag,field_type,reserved_a; uint32_t count,reserved_b;
 const uint8_t *data; uint64_t length;
} zc_exif_field;
void zc_default_image_exif(zc_image_exif *);
int zc_check_image_metadata(const zc_image_options *,const zc_image_profile *,const zc_image_exif *);

void zc_default_image_options(zc_image_options *);
/* Owned bare TIFF blob from typed fields. Does not read a camera, retain input
 * pointers or add capture defaults. Thumbnail bytes, if present, are copied. */
int zc_exif_build(const zc_exif_field *,uint32_t count,const uint8_t *thumbnail,uint64_t thumbnail_length,zc_image_blob **out);
/* Synchronous encode of an owned readable lease. Blob owns its encoded bytes,
 * survives frame/camera release and keeps no native buffer. Caller serializes
 * blob operations and closes exactly once. Output is null on encode failure. */
int zc_encode_image(zc_camera *,uint64_t token,const zc_image_options *,zc_image_blob **out);
/* Explicit source. Processed formats accept main/lores, DNG accepts raw only.
 * Disabled streams reject. Existing image option layouts remain unchanged. */
int zc_encode_stream_image(zc_camera *,uint64_t token,uint32_t stream,const zc_image_options *,zc_image_blob **out);
int zc_encode_stream_image_profile(zc_camera *,uint64_t token,uint32_t stream,const zc_image_options *,const zc_image_profile *,zc_image_blob **out);
int zc_encode_stream_image_metadata(zc_camera *,uint64_t token,uint32_t stream,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,zc_image_blob **out);
/* Remote request encoding: same Home options/profile/Exif policy, using owned
 * request metadata. JPEG capture defaults require an enabled capture descriptor.
 * Pixel conversion and encoded blobs are each <=256 MiB. Calls are serialized
 * with remote close/write access. Saves atomically replace a path; child job
 * cancellation does not undo publication or clean crash-orphan temporaries. */
int zc_remote_frame_encode_image_metadata(const zc_remote_frame *,uint32_t stream,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,zc_image_blob **out);
int zc_remote_frame_save_image_metadata(const zc_remote_frame *,uint32_t stream,const char *path,const zc_image_options *,const zc_image_profile *,const zc_image_exif *);
int zc_image_blob_copy(const zc_image_blob *,uint8_t *data,uint64_t capacity,uint64_t *length);
void zc_image_blob_close(zc_image_blob *);
/* Atomic file replacement; explicit format does not depend on path extension.
 * JPEG quality 1..100; PNG zlib level 0..9 and one of the filter policies above.
 * DNG requires a supported raw stream and complete calibration. */
int zc_save_image(zc_camera *,uint64_t token,const char *path,const zc_image_options *);
int zc_save_stream_image(zc_camera *,uint64_t token,uint32_t stream,const char *path,const zc_image_options *);
int zc_save_stream_image_profile(zc_camera *,uint64_t token,uint32_t stream,const char *path,const zc_image_options *,const zc_image_profile *);
int zc_save_stream_image_metadata(zc_camera *,uint64_t token,uint32_t stream,const char *path,const zc_image_options *,const zc_image_profile *,const zc_image_exif *);
/* Staged atomic still-file output. Create copies the path and reserves an I/O
 * thread without file I/O. Every created object needs finish (even if unused).
 * Prepare runs synchronously on the capture owner and retains no frame. Retire
 * that owner before finish/close. cancel/state may run concurrently with prepare.
 * finish(1) irrevocably claims publication; finish(0) discards. Both start native
 * I/O jobs. Poll finished before close, which joins and releases exactly once.
 * Error/cleanup codes remain observable even if publication was already claimed.
 * No durability/fsync guarantee. Crash cleanup of orphan temporaries is external. */
typedef struct zc_image_file zc_image_file;
typedef struct { uint32_t struct_size,phase,preparing,released,finished,committed; int32_t result,cleanup_code; } zc_image_file_state;
/* Bounded owned still encoding. Copies selected physical pixels, ICC/Exif and
 * needed metadata at admission; no remote owner/lease/fd survives that call.
 * Codec conversion/encoding and optional file staging run on a joined worker.
 * Limits are per-job: input includes copied metadata, working includes ALL
 * allocator-routed codec allocations and the encoded result, output caps bytes.
 * Four live jobs share a 512 MiB input+working reservation, held until close.
 * Cancel is cooperative at codec boundaries; close BUSY means join by polling.
 * File publication remains explicit through image_file_finish AFTER completion;
 * retain that file owner until the job closes. Null limits uses defaults. */
typedef struct zc_image_job zc_image_job;
typedef struct {uint32_t struct_size,reserved;uint64_t max_input_bytes,max_output_bytes,max_working_bytes;} zc_image_job_limits;
typedef struct {uint32_t struct_size,phase,finished;int32_t result;uint64_t input_bytes,output_bytes,working_peak,budget_denials;} zc_image_job_state;
void zc_default_image_job_limits(zc_image_job_limits *);
int zc_remote_frame_encode_async(const zc_remote_frame *,uint32_t stream,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,const zc_image_job_limits *,zc_image_file *,zc_image_job **out);
/* Copies the selected request under its read gate, including local Exif
 * provenance. The request/camera may be released immediately on success. */
int zc_encode_stream_image_async(zc_camera *,uint64_t token,uint32_t stream,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,const zc_image_job_limits *,zc_image_file *,zc_image_job **out);
int zc_image_job_state_get(zc_image_job *,zc_image_job_state *);
int zc_image_job_cancel(zc_image_job *);
int zc_image_job_take_blob(zc_image_job *,zc_image_blob **out);
int zc_image_job_close(zc_image_job *);

/* Factory admission is globally bounded to 32 retained handles, including ready
 * and finished handles. BUSY preserves a null output; close releases the slot
 * after joining. This also bounds threads for rejected async file submissions. */
int zc_image_file_create(const char *,zc_image_file **);
int zc_image_file_prepare(zc_image_file *,zc_camera *,uint64_t token,uint32_t stream,const zc_image_options *,const zc_image_profile *);
int zc_image_file_prepare_metadata(zc_image_file *,zc_camera *,uint64_t token,uint32_t stream,const zc_image_options *,const zc_image_profile *,const zc_image_exif *);
int zc_image_file_cancel(zc_image_file *); /* 1 accepted, 0 too late/already cancelled */
/* Copy 1..256 MiB of encoded bytes, stage on the reserved I/O worker, then
 * query preparation_result before finish. No source pointer survives admission.
 * Shared 512 MiB reservation stays charged until close, even after completion.
 * preparation_result returns TIMEOUT while pending, STATE after release; otherwise
 * writes the staging result code. Failed preparation still needs discard/close. */
int zc_image_file_prepare_bytes(zc_image_file *,const uint8_t *,uint64_t length);
int zc_image_file_preparation_result(zc_image_file *,int32_t *out);
int zc_image_file_finish(zc_image_file *,uint32_t publish);
int zc_image_file_state_get(zc_image_file *,zc_image_file_state *);
int zc_image_file_close(zc_image_file *); /* BUSY until owner/job retired */
/* Borrowed input descriptors. data must be readable for the submit call only;
 * submission copies active rows, never retains a camera/lease or row padding. */
enum { ZC_APNG_GRAY=0, ZC_APNG_RGB=1, ZC_APNG_RGBA=2 };
enum { ZC_APNG_DISPOSE_NONE=0, ZC_APNG_DISPOSE_BACKGROUND=1, ZC_APNG_DISPOSE_PREVIOUS=2 };
enum { ZC_APNG_BLEND_SOURCE=0, ZC_APNG_BLEND_OVER=1 };
typedef struct {
    uint32_t struct_size,width,height,format,bits,big_endian;
    uint64_t stride,length;
    const uint8_t *data;
} zc_apng_raster;
/* General borrowed gray/RGB/RGBA8/16 raster. All calls below consume pointers
 * synchronously and retain none. Active pixels/output are limited to 256 MiB.
 * Conversion/crop query with data=NULL,capacity=0; failures never copy prefixes.
 * Source/target overlap rejects, except identical no-op copies. Native endian
 * is explicit; 8->16 replicates bytes and 16->8 selects high bytes. */
typedef zc_apng_raster zc_raster;
/* Strict 8-bit Huffman JPEG loading through Home. Sequential/progressive,
 * component sampling, restarts and owned source ICC/Exif; no implicit ICC/Exif
 * orientation conversion. Result pixels are gray8 or RGB8 (CMYK converted).
 * Upsampling: 0 centered bilinear, 1 nearest. Unsupported coding returns UNSUPPORTED.
 * Jobs copy input before return; cancellation joins checkpoints and native close.
 * Result and job share the existing image admission; take transfers once. */
typedef struct zc_jpeg_image zc_jpeg_image;
typedef struct zc_jpeg_job zc_jpeg_job;
typedef struct {uint32_t struct_size,max_scans,max_markers,upsampling;uint64_t max_input_bytes,max_output_bytes,max_working_bytes,max_metadata_bytes,max_work_units;} zc_jpeg_limits;
typedef struct {uint32_t struct_size,width,height,components,progressive,scans,color_model,upsampling,sampling[4],metadata_flags,adobe_transform,reserved[2];uint64_t stride,length,working_peak,work_units;} zc_jpeg_info;
void zc_default_jpeg_limits(zc_jpeg_limits *);
int zc_jpeg_decode(const uint8_t *,uint64_t,const zc_jpeg_limits *,zc_jpeg_image **out);
int zc_jpeg_decode_async(const uint8_t *,uint64_t,const zc_jpeg_limits *,zc_jpeg_job **out);
int zc_jpeg_info_get(zc_jpeg_image *,zc_jpeg_info *);
int zc_jpeg_pixels_copy(zc_jpeg_image *,uint8_t *,uint64_t,uint64_t *);
/* metadata kind: 1 source ICC profile, 2 source Exif TIFF bytes. */
int zc_jpeg_metadata_copy(zc_jpeg_image *,uint32_t,uint8_t *,uint64_t,uint64_t *);
void zc_jpeg_close(zc_jpeg_image *);
int zc_jpeg_job_state_get(zc_jpeg_job *,zc_image_job_state *);
int zc_jpeg_job_cancel(zc_jpeg_job *);
int zc_jpeg_job_take_image(zc_jpeg_job *,zc_jpeg_image **out);
int zc_jpeg_job_close(zc_jpeg_job *);

/* Strict PNG/APNG loading. All pixel words are little endian and straight alpha.
 * Default image slot is 0; animation rectangles are slots 1..frame_count.
 * Scalar metadata flags: ICC=1, Exif=2, sRGB=4, gamma=8, cHRM=16, cICP=32.
 * No gamma conversion, animation compositing or Exif orientation is applied.
 * Owners/jobs share the image encoder's four-owner, 512 MiB admission ceiling.
 * An async result retains its reservation after take and job close until its
 * own close. Cancellation never publishes a partial result; join before close.
 * Owner operations require caller serialization. Metadata copies: ICC=1,
 * Exif=2, RGBA palette=3. A null destination queries required bytes. */
typedef struct zc_png_image zc_png_image;
typedef struct zc_png_job zc_png_job;
typedef struct {uint32_t struct_size,max_frames,max_chunks,reserved;uint64_t max_input_bytes,max_output_bytes,max_working_bytes,max_metadata_bytes;} zc_png_limits;
typedef struct {uint32_t struct_size,frame_count,default_is_frame,plays,source_depth,source_color,interlaced,palette_count;uint32_t metadata_flags,srgb,gamma,chromaticities[8],cicp[4],reserved;} zc_png_info;
typedef struct {uint32_t struct_size,width,height,format,bits,x,y,delay_num,delay_den,dispose,blend,reserved;uint64_t stride,length;} zc_png_frame_info;
void zc_default_png_limits(zc_png_limits *);
int zc_png_decode(const uint8_t *,uint64_t,const zc_png_limits *,zc_png_image **out);
int zc_png_decode_async(const uint8_t *,uint64_t,const zc_png_limits *,zc_png_job **out);
int zc_png_info_get(zc_png_image *,zc_png_info *);
int zc_png_frame_get(zc_png_image *,uint32_t slot,zc_png_frame_info *);
int zc_png_frame_copy(zc_png_image *,uint32_t slot,uint8_t *,uint64_t capacity,uint64_t *length);
int zc_png_metadata_copy(zc_png_image *,uint32_t kind,uint8_t *,uint64_t capacity,uint64_t *length);
void zc_png_close(zc_png_image *);
int zc_png_job_state_get(zc_png_job *,zc_image_job_state *);
int zc_png_job_cancel(zc_png_job *);
int zc_png_job_take_image(zc_png_job *,zc_png_image **out);
int zc_png_job_close(zc_png_job *);

/* APNG display canvas: exact RGBA8/16, little endian, straight alpha. External
 * serialization required. push borrows a checked raster of matching bit depth
 * for this call only. The canvas starts/reset to transparent black; disposal
 * applies before the next valid push. Invalid pushes leave all state unchanged.
 * Working limit (1..256 MiB) covers two full RGBA canvases. Global image admission
 * is shared with PNG/image jobs. No transfers, gamma conversion or timer implied.
 * copy queries with NULL,0; insufficient capacity writes nothing. close(NULL) OK. */
typedef struct zc_apng_compositor zc_apng_compositor;
int zc_apng_compositor_open(uint32_t width,uint32_t height,uint32_t bits,uint64_t max_working_bytes,zc_apng_compositor **out);
int zc_apng_compositor_push(zc_apng_compositor *,const zc_raster *,uint32_t x,uint32_t y,uint32_t dispose,uint32_t blend);
int zc_apng_compositor_copy(zc_apng_compositor *,uint8_t *,uint64_t capacity,uint64_t *length);
void zc_apng_compositor_reset(zc_apng_compositor *);
void zc_apng_compositor_close(zc_apng_compositor *);

int zc_raster_convert(const zc_raster *,uint32_t format,uint32_t bits,uint32_t big_endian,uint8_t *data,uint64_t capacity,uint64_t *length);
int zc_raster_crop(const zc_raster *,uint32_t x,uint32_t y,uint32_t width,uint32_t height,uint8_t *data,uint64_t capacity,uint64_t *length);
int zc_raster_pixel16(const zc_raster *,uint32_t x,uint32_t y,uint16_t rgba[4]);
enum { ZC_RESAMPLE_NEAREST=0, ZC_RESAMPLE_BILINEAR=1, ZC_RESAMPLE_BICUBIC=2, ZC_RESAMPLE_LANCZOS2=3, ZC_RESAMPLE_LANCZOS3=4 };
/* Compact same-format/depth/endian resize; NULL/0 queries size and heap limits.
 * Pixel-center sampling, normalized widened reduction kernels, premultiplied
 * filtering of straight RGBA. BICUBIC uses Home Mitchell-Netravali B=C=1/3.
 * Working heap is capped at 64 MiB in addition to the 256 MiB output bound.
 * No transfer/gamut conversion; synchronous borrowed pointers, no retained input.
 * Failures never write output prefixes. Same-size copies preserve all bits. */
int zc_raster_resize(const zc_raster *,uint32_t width,uint32_t height,uint32_t algorithm,uint8_t *data,uint64_t capacity,uint64_t *length);
/* Exact orthogonal pixel copy using orientation 1..8 (zc_orientation_from_transform).
 * Orientations 5..8 exchange width/height. Preserves format, depth, endian and
 * alpha. Tight result <=256 MiB, borrowed source only, rejects all overlap and
 * short/invalid spans before any prefix write. Query with NULL/0; length is zero
 * on invalid input, required byte count on a valid query or short destination. */
int zc_raster_transform(const zc_raster *,uint32_t orientation,uint8_t *data,uint64_t capacity,uint64_t *length);
/* Raw pixels have no request-derived Exif. Pass raw/typed Exif without CAPTURE;
 * JPEG defaults are chosen by the binding. RGB ICC requires non-gray pixels;
 * built-in sRGB additionally requires the supplied matching color description. */
int zc_raster_encode(const zc_raster *,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,const zc_color_space *,zc_image_blob **out);
/* Copies tight logical rows (padding excluded), ICC and explicit Exif before
 * returning. Shares the image-job quota, workspace budget and joined lifecycle. */
int zc_raster_encode_async(const zc_raster *,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,const zc_color_space *,const zc_image_job_limits *,zc_image_file *,zc_image_job **out);
int zc_raster_save(const zc_raster *,const char *path,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,const zc_color_space *);
int zc_image_file_prepare_raster(zc_image_file *,const zc_raster *,const zc_image_options *,const zc_image_profile *,const zc_image_exif *,const zc_color_space *);
typedef struct {
    zc_apng_raster raster;
    uint32_t x,y,delay_num,delay_den,dispose,blend;
} zc_apng_frame;
typedef struct {
    uint32_t struct_size,width,height,plays,png_compression,png_filter;
    uint64_t max_input_bytes,max_output_bytes;
} zc_apng_config;
typedef struct zc_apng_job zc_apng_job;
/* phase uses ZC_PREPARATION_*; file publication is observed on its separate
 * image_file owner. finished reports encoding completion; close still joins. */
typedef struct { uint32_t struct_size,phase,finished; int32_t result; uint64_t input_bytes,output_bytes; } zc_apng_job_state;
void zc_default_apng_config(zc_apng_config *);
/* 1..256 frames; optional full-canvas poster is excluded from playback. Each
 * payload cap is 1..256 MiB. Global admission retains four jobs / 512 MiB of
 * input/output reservations and owner descriptors until close, including completed jobs.
 * A file handle, when supplied, must stay alive through job close. It is staged
 * privately; only zc_image_file_finish(file,1) publishes it. Submit never opens
 * or replaces a destination. Output is null on failure. */
int zc_apng_encode_async(const zc_apng_config *,const zc_apng_frame *,uint32_t count,const zc_apng_raster *poster,zc_image_file *,zc_apng_job **);
int zc_apng_job_state_get(zc_apng_job *,zc_apng_job_state *);
int zc_apng_job_cancel(zc_apng_job *); /* 1 accepted, 0 already cancelled/published/failed */
/* Byte jobs publish once; the blob then survives job close. File jobs return
 * UNSUPPORTED here and publish through their separate staged file owner. */
int zc_apng_job_take_blob(zc_apng_job *,zc_image_blob **);
int zc_apng_job_close(zc_apng_job *); /* null OK; BUSY while worker is active; joins before release */
const char *zc_status_string(int status);
/* Optional SDL preview. Create/show/close on the same main/UI thread. show returns
 * 1 for a window-close request, 0 success, negative status for errors. */
typedef struct zc_preview zc_preview;
typedef struct zc_preview_overlay zc_preview_overlay;
/* Linux atomic scanout on an unused non-cursor plane of an already active CRTC.
 * card is NUL-terminated (empty selects discovery); zero connector/plane selects
 * automatically. Set dimensions/processed format, timeout 1..60000 ms, reserved=0.
 * Requires DRM master and linear DMABUF import. Never modesets or takes an occupied
 * plane. All calls are caller-serialized; no native display worker is created. */
typedef struct {uint32_t struct_size,connector_id,plane_id,format,width,height,timeout_ms,reserved;char card[64];} zc_drm_preview_config;
typedef struct {uint32_t struct_size,retained_frames,uncertain,poisoned,device_closed;int32_t last_error,last_error_number;uint32_t connector_id,plane_id,crtc_id;} zc_drm_preview_state;
void zc_default_drm_preview_config(zc_drm_preview_config *);
int zc_preview_open_drm(const zc_drm_preview_config *,zc_preview **);
int zc_drm_preview_state_get(zc_preview *,zc_drm_preview_state *);
/* Explicit RGB16/BGR16 -> opaque BGRX8 CPU copy policy. Normal open stays direct.
 * Requires driver dumb allocation and PRIME export. Source words are high-byte
 * reduced without transfer/gamut conversion; scanout owns two reusable buffers. */
int zc_preview_open_drm_rgb16(const zc_drm_preview_config *,zc_preview **);
typedef struct {uint32_t struct_size,input_format,scanout_format,copy_policy,buffers,cpu_active,reserved[2];uint64_t copied_frames,storage_bytes;} zc_drm_preview_storage_state;
int zc_drm_preview_storage_state_get(zc_preview *,zc_drm_preview_storage_state *);
/* One unused ARGB overlay plane shares the preview master/event FD. Inputs are
 * immutable retained snapshots; queued cancellation joins their native release. */
typedef struct {uint32_t struct_size,plane_id,configured,visible,blend_mode,buffers,uncertain,cpu_active,poisoned,reserved;uint64_t storage_bytes,updates;} zc_drm_preview_overlay_state;
int zc_drm_preview_overlay_state_get(zc_preview *,zc_drm_preview_overlay_state *);
int zc_drm_preview_overlay_seed(zc_preview *,const zc_preview_overlay *);
/* Optional native serial worker; 1..8 outstanding operations, active included.
 * Synchronous mutation returns BUSY while work executes. State is the last
 * completed operation snapshot. Queued frame jobs retain exports before return.
 * Poll/close jobs before closing the preview; close is BUSY with live job handles.
 * finish returns TIMEOUT until callback cleanup completes, then OK with result.
 * Queued cancellation joins cleanup; active work cannot be cancelled. */
typedef struct zc_drm_preview_job zc_drm_preview_job;
typedef struct {uint32_t struct_size,capacity,outstanding,queued,active,live_jobs,retiring,reserved;uint64_t issued,completed,rejected;} zc_drm_preview_queue_state;
int zc_drm_preview_enable_async(zc_preview *,uint32_t capacity);
int zc_drm_preview_overlay_async(zc_preview *,const zc_preview_overlay *,zc_drm_preview_job **);
int zc_drm_preview_queue_state_get(zc_preview *,zc_drm_preview_queue_state *);
int zc_drm_preview_show_async(zc_preview *,zc_camera *,uint64_t token,uint32_t stream,zc_drm_preview_job **);
/* command: 0 cleanup fence, 1 background/detach, 2 copied view, 3 close device.
 * Close stops new admission; failure retains the preview for retry. After a
 * successful close-device job, close that job and call zc_preview_close to join
 * the worker and consume the preview. Fence completion is not GPU retirement. */
int zc_drm_preview_command_async(zc_preview *,uint32_t command,const void *view,zc_drm_preview_job **);
int zc_drm_preview_job_finish(zc_drm_preview_job *,int32_t *result);
int zc_drm_preview_job_cancel(zc_drm_preview_job *);
int zc_drm_preview_job_close(zc_drm_preview_job *);
/* Read-only Linux KMS discovery. Fixed limits: 64 cards, 256 displays, 64
 * connectors, 32 CRTCs, 128 encoders/planes/modes and 256 union formats. NULL
 * card scans /dev/dri/card0..63; exact paths have 1..63 non-NUL bytes. Missing
 * automatic nodes are normal; other failures are explicit issues. Per-card
 * failures discard that card's records. Resource ID lists are rechecked, but
 * this is not an atomic hardware snapshot. No master, modeset or buffer import.
 * Four snapshot owners sharing an 8-MiB budget, no queue. Temporary FDs close before
 * return. Unsupported platforms return ZC_UNSUPPORTED and NULL. Serialize
 * access/close. Unknown FOURCC values survive; processed format UINT32_MAX means
 * no recognized camera format. Formats advertise compatibility, not ownership,
 * modifier/color/stride acceptance or proof of scanout. close(NULL) is safe. */
typedef struct zc_drm_discovery zc_drm_discovery;
enum { ZC_DRM_CONNECTED=1,ZC_DRM_DISCONNECTED=2,ZC_DRM_UNKNOWN=3 };
enum { ZC_DRM_ATOMIC=1,ZC_DRM_UNIVERSAL_PLANES=2 };
enum { ZC_DRM_OPEN=1,ZC_DRM_RESOURCES=2,ZC_DRM_ENCODER=3,ZC_DRM_CRTC=4,ZC_DRM_PLANES=5,ZC_DRM_PLANE=6,ZC_DRM_CONNECTOR=7,ZC_DRM_RECHECK=8 };
enum { ZC_DRM_SYSTEM=1,ZC_DRM_LIMIT=2,ZC_DRM_RACE=3,ZC_DRM_INVALID_TOPOLOGY=4 };
typedef struct { uint32_t struct_size,display_count,issue_count,cards_tried,cards_opened,reserved[3]; } zc_drm_discovery_info;
typedef struct {
    uint32_t struct_size,connector_id,connector_type,connector_type_id,status,current_crtc_id;
    uint32_t active_width,active_height,default_width,default_height,physical_width_mm,physical_height_mm;
    uint32_t flags,crtc_count,format_count,reserved;
    char card[64],name[32];uint32_t crtcs[32],formats[256],processed_formats[256];
} zc_drm_display_info;
typedef struct { uint32_t struct_size,stage;int32_t error_number;uint32_t reason;char card[64]; } zc_drm_discovery_issue;
int zc_drm_discover(const char *card,zc_drm_discovery **out);
int zc_drm_discovery_info_get(zc_drm_discovery *,zc_drm_discovery_info *);
int zc_drm_discovery_display_get(zc_drm_discovery *,uint32_t index,zc_drm_display_info *);
int zc_drm_discovery_issue_get(zc_drm_discovery *,uint32_t index,zc_drm_discovery_issue *);
void zc_drm_discovery_close(zc_drm_discovery *);
/* Copy active RGB pixels into an owned tightly packed buffer; caller keeps lease. */
/* RGB16 copies normalize to little-endian R,G,B words; other source formats reject. */
int zc_copy_rgb16(const zc_frame *,uint8_t *,uint64_t);
/* Tight LE u16 sensor samples, with CSI-2/driver-standard PiSP COMP1 decoded. */
int zc_copy_raw16(zc_camera *,uint64_t token,uint8_t *,uint64_t);
int zc_copy_stream_rgb16(zc_camera *,uint64_t token,uint32_t stream,uint8_t *,uint64_t);
int zc_copy_rgb(const zc_frame *,uint8_t *out,uint64_t length);
int zc_preview_open(const char *title, uint32_t width, uint32_t height, zc_preview **);
/* Display with no image texture allocation; logical dimensions place overlays. */
int zc_preview_open_background(const char *title,uint32_t width,uint32_t height,zc_preview **);
int zc_preview_show(zc_preview *, const zc_frame *);
/* Main/lores packed RGB/BGR/RGBX/BGRX or YUV from the leased frame. YUV requires a
 * present negotiated matrix/range; conversion writes directly into SDL's locked
 * RGB texture, without a temporary RGB image. RGB ignores optional color data.
 * No plane or frame pointer survives this call for SDL. Borrowed show/show_input
 * reject DRM; use show_stream with a live camera token for retained scanout. */
int zc_preview_check_color(uint32_t input_format,const zc_color_space *);
/* Explicit borrowed input uses frame.main for either selected stream. */
int zc_preview_show_input(zc_preview *,const zc_frame *,const zc_color_space *);
/* Select from a live camera token under a scoped native read, using negotiated
 * color data. SDL uses a scoped read. DRM retains exported read owners (at most
 * two, buffer_count >=2), admitting no new input after an uncertain flip. A
 * matching flip event retires the old owner. Actual fd-backed input is imported
 * without an application image copy; synthetic fd-less input stages in memfd.
 * Event waits obey configured timeout; kernel ioctls themselves may block. */
int zc_preview_show_stream(zc_preview *,zc_camera *,uint64_t token,uint32_t stream);
/* Draw background/overlay without reading image planes; still polls UI close. */
int zc_preview_show_background(zc_preview *);
/* DRM close must confirm detach before releasing sources. Nonzero retains the
 * handle for retry, including a closed-device acknowledgement owner after a
 * cleanup IO error; query drm state. Only OK consumes the handle. */
int zc_preview_close(zc_preview *);
/* Display-only view. Orientations use zc_orientation_from_transform, not EXIF.
 * flags: keep aspect=1, request window size=2, request window position=4,
 * explicit overlay rectangle=8. Unused window/rectangle fields must be zero.
 * Rectangle units are pixels in the post-transform logical camera image. */
typedef struct {
    uint32_t struct_size,flags,image_orientation,overlay_orientation;
    int32_t window_x,window_y;
    uint32_t window_width,window_height;
    uint32_t overlay_x,overlay_y,overlay_width,overlay_height;
} zc_preview_view;
void zc_default_preview_view(zc_preview_view *);
/* Pure validation is available without SDL. Window size is 1..16384 per axis,
 * requested positions -1000000..1000000. Reject before any view/window changes. */
int zc_preview_check_view(uint32_t source_width,uint32_t source_height,const zc_preview_view *);
/* Same UI thread as open/show/close; copies scalars, retains no input pointer.
 * Window geometry is requested; the window manager can adjust it. */
int zc_preview_set_view(zc_preview *,const zc_preview_view *);
/* Immutable owned straight-alpha RGBA8, max 4096x4096 (64 MiB compact).
 * create copies active bytes synchronously; padding is excluded. Caller owns the
 * overlay independently of previews. Serialize use/close; NULL close is safe. */

int zc_preview_overlay_create(const uint8_t *data,uint64_t length,uint32_t width,uint32_t height,uint32_t stride,zc_preview_overlay **out);
/* Independent owned compact snapshot. Source remains valid and may be closed
 * after success. Serialize with source close; failed clone clears *out. */
int zc_preview_overlay_clone(const zc_preview_overlay *,zc_preview_overlay **out);
void zc_preview_overlay_close(zc_preview_overlay *);
/* Upload synchronously on the preview UI thread. NULL clears. Failure preserves
 * the old texture. No overlay pointer is retained; caller can immediately close.
 * By default overlay fills the logical image excluding window bars; set_view
 * can place/transform it independently. Existing image pixels are unchanged.
 * Captured/encoded camera pixels are never modified. */
int zc_preview_set_overlay(zc_preview *,const zc_preview_overlay *);
enum { ZC_H264=1, ZC_HEVC=2, ZC_MJPEG=3, ZC_FFV1=4 };
typedef struct {
    uint32_t width, height, fps_num, fps_den, codec, bitrate, quality, gop;
} zc_video_config;
typedef struct zc_recorder zc_recorder;
/* Caller-serialized, bounded fan-out admission; no camera/recorder/frame pointers
 * are retained. IDs/tickets never repeat. Retiring an in-flight consumer keeps
 * its slot until that exact claim completes. Close rejects nonempty registries. */
typedef struct zc_fanout zc_fanout;
typedef struct {
    uint64_t id,submitted,completed,skipped,failures,cancelled,last_frame,ticket;
    uint32_t flags,reserved; /* active=1,busy=2,failed=4,retiring=8,drop=16 */
} zc_fanout_state;
int zc_fanout_open(zc_fanout **);
int zc_fanout_close(zc_fanout *);
int zc_fanout_add(zc_fanout *,uint32_t policy /* wait=0,drop=1 */,uint64_t *id);
int zc_fanout_ready(zc_fanout *); /* boolean; wait consumers gate capture */
int zc_fanout_offer(zc_fanout *,uint64_t *frame_index);
int zc_fanout_claim(zc_fanout *,uint64_t id,uint64_t frame_index,uint64_t *ticket); /* TIMEOUT=skipped */
int zc_fanout_state_get(zc_fanout *,uint64_t id,zc_fanout_state *);
int zc_fanout_finish(zc_fanout *,uint64_t id,uint64_t ticket,uint32_t outcome /* completed=0,failed=1,cancelled=2 */,zc_fanout_state *);
int zc_fanout_fail(zc_fanout *fanout, uint64_t id, zc_fanout_state *state);
int zc_fanout_retire(zc_fanout *,uint64_t id,zc_fanout_state *);
/* Named software capture quality: JPEG 25/35/50/65/80; AVC reference rates
 * 3/4/7/10/14 Mbps at 1080p30, scaled by sqrt(pixel-rate ratio). HEVC uses the
 * same Home heuristic. Target rates floor to 1000 bit/sec units, min 1000;
 * overflow/invalid shape rejects without mutation. Explicit tier replaces AVC/
 * HEVC bitrate; MJPEG bitrate/GOP remain unsupported. No SDK or I/O is opened.
 * Existing numeric defaults are unchanged. Validate codec options/limits after
 * applying a tier; fixed QP conflicts with a derived nonzero target bitrate. */
enum {ZC_QUALITY_VERY_LOW=0,ZC_QUALITY_LOW=1,ZC_QUALITY_MEDIUM=2,ZC_QUALITY_HIGH=3,ZC_QUALITY_VERY_HIGH=4};
int zc_video_apply_quality_tier(zc_video_config *,uint32_t tier);
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
/* Selected packed RGB/BGR/RGBX/BGRX/YUV input; caller retains its source lease.
 * Input primaries/transfer must match the recording profile. RGB/YUV matrix
 * and range convert to that profile; no gamut/transfer conversion is implied.
 * Legacy zc_video_write assumes Rec.709 primaries/sRGB RGB input. */
int zc_video_write_input(zc_recorder *,const zc_frame *,const zc_color_space *,uint64_t timestamp_ns);
int zc_video_check_input_color(const zc_color_space *,uint32_t format /* ZC_YUV420..ZC_VYUY */);
/* Target-aware admission. Null target uses legacy output defaults. Unknown input
 * metadata or mismatched primaries/transfer reject before media/PCM mutation. */
int zc_video_check_input_color_for(const zc_color_space *,uint32_t format,const zc_color_space *target);
/* Default output is Rec.709 primaries, sRGB transfer, limited BT.601. Explicit
 * profiles require processed YCbCr and AVC/HEVC. These do not convert gamut/gamma.
 * Set only before frames/audio, outputs or producer allocation; BUSY otherwise.
 * Construction is transactional. Null color restores legacy defaults. */
void zc_default_video_color(zc_color_space *);
int zc_video_check_color(const zc_video_config *,const zc_color_space *);
int zc_video_set_color(zc_recorder *,const zc_color_space *);
int zc_video_get_color(zc_recorder *,zc_color_space *);
/* Additive copied codec policy. profile: 0 default, 1 AVC baseline,
 * 2 AVC/HEVC main, 3 AVC high, 4 AVC constrained baseline. Compatibility
 * ceilings; simpler encoded streams may signal a lower profile.
 * preset: 0 veryfast, 1 ultrafast, 2 superfast, 3 faster, 4 fast, 5 medium,
 * 6 slow, 7 slower, 8 veryslow, 9 placebo. qp: 0 quality/ABR, 1..51 CQP.
 * Nonzero qp requires bitrate=0. MJPEG permits only the all-default policy.
 * No B frames/lookahead; thread/CTU ownership stays bounded. */
typedef struct { uint32_t struct_size,profile,preset,qp; } zc_codec_options;
void zc_default_codec_options(zc_codec_options *);
int zc_video_check_codec_options(const zc_video_config *,const zc_codec_options *);
/* Only untouched/unattached recorders. Failure preserves encoder and headers.
 * NULL restores defaults. Query copies state; serialize recorder calls. */
int zc_video_set_codec_options(zc_recorder *,const zc_codec_options *);
int zc_video_get_codec_options(zc_recorder *,zc_codec_options *);
/* Copied decoder-level ceiling (level*10, 0 auto) and optional VBV limits.
 * HEVC Main tier. max_bitrate (bits/sec) and buffer_bits must be both zero or
 * positive multiples of 1000. VBV requires qp=0 and target <= max_bitrate.
 * Nominal geometry/rate and actual emitted SPS level are checked on construct.
 * Buffer covers at least one nominal frame. HEVC explicit level rejects CQP;
 * shared CTU32 supports tiny padded inputs and larger HEVC pictures; see geometry docs.
 * Level/VBV is not a per-packet network cap or complete conformance guarantee.
 * Existing codec-options/video layouts remain unchanged. */
typedef struct { uint32_t struct_size,level,max_bitrate,buffer_bits; } zc_codec_limits;
void zc_default_codec_limits(zc_codec_limits *);
int zc_video_check_codec_limits(const zc_video_config *,const zc_codec_options *,const zc_codec_limits *);
/* Pristine/unattached only. NULL restores defaults; failure preserves state. */
int zc_video_set_codec_limits(zc_recorder *,const zc_codec_limits *);
int zc_video_get_codec_limits(zc_recorder *,zc_codec_limits *);
/* Packet outputs prepend full cached headers once, and by default prepend only
 * parameter sets again at each keyframe (AVC SPS/PPS, HEVC VPS/SPS/PPS).
 * Disable for first-only behavior. MJPEG and MP4/MKV sample data are unchanged.
 * Set only on pristine/unattached recorders; query is caller-serialized. This
 * copied session policy survives snapshots/splits/recovery. enabled is 0 or 1. */
int zc_video_set_repeat_headers(zc_recorder *,uint32_t enabled);
int zc_video_get_repeat_headers(zc_recorder *,uint32_t *enabled);
/* Counted public keyframe intent: each accepted request applies to one subsequent
 * accepted video input, including an input that already starts a GOP. AVC/HEVC
 * request an IDR; MJPEG is inherently key. Input acceptance can precede delayed
 * packet output. No output acknowledgment is implied. Pending capacity UINT32_MAX,
 * counters never wrap. New recorder sessions reset state only on publication.
 * Sync request is BUSY while any copied producer/control job remains retained.
 * Query is BUSY during active producer ownership; otherwise copies 24 bytes. */
typedef struct {uint64_t requested,applied;uint32_t pending,reserved;} zc_keyframe_state;
int zc_video_request_keyframe(zc_recorder *);
int zc_video_keyframe_state(zc_recorder *,zc_keyframe_state *);
/* Admit a zero-payload control job in the same bounded producer pool. Caller
 * determines start order as for copied frames. Cancellation before commit leaves
 * intent unchanged; cancellation after commit returns STATE. Completion means
 * request admission, not an encoded frame or delivered output. Validity is checked
 * at execution, so a request following a terminal flush reports STATE. */
typedef struct zc_producer_job zc_producer_job;
int zc_video_producer_keyframe(zc_recorder *,zc_producer_job **);
/* Finishes the stream. Always consumes the handle,
 * including on failure. Recorder calls require caller serialization. */
int zc_video_close(zc_recorder *);
/* Encoded circular history, fixed byte arena + frame slots. Duration is an upper
 * bound; eviction drops through the next keyframe. Serialize recorder calls. */
typedef struct { uint32_t struct_size,max_frames; uint64_t max_bytes,duration_us; } zc_buffer_config;
typedef struct {
    uint64_t frames,bytes,evicted,skipped,first_ns,last_ns,segments;
    uint32_t split_pending,output_open;
} zc_buffer_stats;
void zc_default_buffer_config(zc_buffer_config *);
int zc_video_open_circular(const zc_video_config *,const zc_buffer_config *,zc_recorder **);
int zc_video_buffer_stats(zc_recorder *,zc_buffer_stats *);
/* Snapshot/open includes retained pre-roll, starting at a key with fresh headers.
 * Snapshot preserves history and live encoding; output errors do not poison it.
 * Snapshot may omit an input still buffered inside the codec. */
int zc_video_save_buffer(zc_recorder *,const char *path);
/* Freeze copies only the selected encoded/PCM window and reserves an untruncated
 * destination fd. At most two handles per recorder. Input may resume immediately.
 * A worker may write/close the snapshot after recorder close. Serialize each
 * snapshot's calls; write is single-use. Close always frees owned storage/fd.
 * Cancellation before write leaves existing contents intact (new paths empty).
 * Active/pending/reserved file identities, including hardlinks, cannot collide. */
typedef struct zc_snapshot zc_snapshot;
int zc_video_freeze_buffer(zc_recorder *,const char *path,zc_snapshot **);
int zc_snapshot_write(zc_snapshot *);
void zc_snapshot_close(zc_snapshot *);
int zc_video_open_output(zc_recorder *,const char *path);
int zc_video_close_output(zc_recorder *);
/* Convert circular history to bounded delayed FIFO before input/output starts.
 * Delay may later change; it applies on the next encoded packet. Zero forwards
 * immediately. open_output attaches without pre-roll replay, close_output drops
 * the queued tail from that file, recorder close flushes the remaining queue.
 * Video/sample descriptors and bytes must cover the delay. Overflow fails.
 * Path outputs and the additive callback protocol below are supported. */
int zc_video_set_delay(zc_recorder *,uint64_t delay_ns);
/* Synchronous consumer-thread output protocol. Borrowed packet bytes expire
 * at callback return; copy to retain. Never re-enter camera/recorder APIs from
 * callbacks. Return ZC_OK only on complete acceptance; errors follow the selected policy.
 * PACKETS delivers Annex B AVC/HEVC (fresh headers on first key), JPEG or S16LE.
 * Mux modes use Home containers and deliver video metadata (data=NULL) to packet.
 * AAC_PACKETS delivers Annex B video and raw AAC-LC AUs (-Daac=true).
 * FMP4 uses forward-only Home AVC/HEVC + optional AAC fragments; no patch.
 * AAC waits in a fixed 16 MiB arena for the first PCM clock (or final flush).
 * Overflow fails the output. Unknown header durations remain zero; readers
 * must honor both audio edits and the final trimmed sample duration.
 * AAC priming retains negative relative presentation time.
 * Timestamps are rebased ns; key=1, audio=2, AnnexB=4 flags. Flag 8 means
 * timestamp_ns is a signed int64 two-s-complement presentation value.
 * Mailbox flag 16 similarly marks a negative signed source-clock offset. */
enum { ZC_OUTPUT_PACKETS=0,ZC_OUTPUT_MP4=1,ZC_OUTPUT_MKV=2,ZC_OUTPUT_AAC_PACKETS=3,ZC_OUTPUT_FMP4=4 };
enum { ZC_PCM_S16LE=4,ZC_AAC_LC=5 };
typedef struct {const uint8_t *data;uint64_t length,timestamp_ns;uint32_t codec,flags;} zc_output_packet;
typedef int (*zc_output_packet_fn)(void *,const zc_output_packet *);
typedef int (*zc_output_write_fn)(void *,const uint8_t *,uint64_t);
typedef int (*zc_output_patch_fn)(void *,uint64_t,const uint8_t *,uint64_t);
typedef struct {
    uint32_t struct_size,format;void *context;
    zc_output_packet_fn packet;zc_output_write_fn write;zc_output_patch_fn patch;
    int32_t file_fd,pts_fd,secondary_pts_fd;uint32_t reserved;
} zc_output_callbacks;
/* Descriptors are borrowed identity guards, -1 when absent. They must stay open
 * through detach/close. Distinct media/PTS/snapshot files must never alias.
 * A split may share the identical secondary_pts_fd for a circular observer.
 * AAC MP4 requires patch. No callback data/context is retained after close.
 * Direct, circular and delayed recorders support callbacks. */
int zc_video_open_callbacks(zc_recorder *,const zc_output_callbacks *);
/* Prepare borrowed callbacks, switch after old output finalization at next key.
 * Retain BOTH contexts until stats.split_pending clears, cancellation or close.
 * A pending split accepts no packets until commit; initialization can write headers. */
int zc_video_split_callbacks(zc_recorder *,const zc_output_callbacks *);
/* Up to 8 simultaneous outputs, one shared video encoder. Additions start on
 * the next forwarded key (no history replay), each with its own PCM cursor and
 * container/AAC state. Stable IDs >0 identify additions; 0 is the primary.
 * Removal finishes that output through the emitted timeline; delayed tail is
 * excluded. Fail-fast is default; opt-in isolation quarantines failed sinks.
 * Keep callbacks alive until removal consumes the ID or recorder close. */
typedef struct {uint64_t id,frames,bytes,first_ns,audio_frames;uint32_t waiting_key,reserved;} zc_output_stats;
int zc_video_add_callbacks(zc_recorder *,const zc_output_callbacks *,uint64_t *id);
int zc_video_add_output(zc_recorder *,const char *path,uint64_t *id);
int zc_video_remove_output(zc_recorder *,uint64_t id);
int zc_video_output_stats(zc_recorder *,uint64_t id,zc_output_stats *);
/* Additive state for stable attachment IDs. Failure isolation is opt-in and must
 * be selected before the first input. Quarantined sinks receive no more writes
 * and do not pin PCM; their descriptors/contexts remain borrowed until detach.
 * Shared encoder, input and history allocation failures remain recorder-fatal. */
enum { ZC_SPLIT_IDLE=0,ZC_SPLIT_PENDING=1,ZC_SPLIT_COMMITTED=2,ZC_SPLIT_FAILED=3,ZC_SPLIT_CANCELLED=4 };
typedef struct {uint64_t generation;int32_t error_code;uint32_t split_state,pending,reserved;} zc_output_state;
typedef struct {uint64_t id;zc_output_state state;} zc_output_result;
int zc_video_set_failure_isolation(zc_recorder *,uint32_t enabled);
int zc_video_output_state(zc_recorder *,uint64_t id,zc_output_state *);
/* Supply exactly one of path or callbacks. One pending split per attachment;
 * IDs survive commit, generation increments, and other outputs are unaffected. */
int zc_video_split_output(zc_recorder *,uint64_t id,const char *path,const zc_output_callbacks *);
int zc_video_cancel_output_split(zc_recorder *,uint64_t id);
/* capacity>=8; invalid capacity leaves the recorder live. Otherwise consumes it
 * exactly like close, but returns all per-output states after finalization. */
int zc_video_close_outputs(zc_recorder *,zc_output_result *,uint32_t capacity,uint32_t *count);


int zc_video_get_headers(zc_recorder *,uint8_t *,uint64_t capacity,uint64_t *length);
/* Exact Picamera2-style milliseconds with 3 decimals/LF, from microsecond PTS. */
int zc_format_pts(uint64_t timestamp_us,uint8_t *,uint32_t capacity,uint32_t *length);
/* Caller-owned, serial progress for raw UDP (whole chunks) or TCP (prefixes).
 * No socket/byte ownership. chunk_bytes: 1..65507 UDP, 1..1048576 TCP.
 * next returns offset/size, size=0 at EOF. accept(0) means backpressure.
 * Invalid advances preserve state. Init failure zeroes state; next failure
 * zeroes results. Do not alias result pointers with state or each other. */
typedef struct { uint32_t struct_size,datagram,chunk_bytes,reserved;uint64_t total,offset; } zc_socket_write_cursor;
int zc_socket_write_init(uint64_t total,uint32_t chunk_bytes,uint32_t datagram,zc_socket_write_cursor *);
int zc_socket_write_next(const zc_socket_write_cursor *,uint64_t *offset,uint32_t *size);
int zc_socket_write_accept(zc_socket_write_cursor *,uint32_t accepted);
/* Caller-owned fixed diagnostic tail; arena length must equal capacity and
 * remains borrowed. Max capacity 1 MiB, input chunks 16 MiB. No overlapping
 * input/arena/output. Query copy with NULL/0, short/error copies do not write.
 * Caller serializes; init failure zeroes state. Counts include discarded bytes. */
typedef struct { uint32_t struct_size,reserved;uint64_t capacity,head,length,total; } zc_byte_tail_state;
int zc_byte_tail_init(uint64_t capacity,zc_byte_tail_state *);
int zc_byte_tail_append(zc_byte_tail_state *,uint8_t *arena,uint64_t arena_length,const uint8_t *,uint64_t length);
int zc_byte_tail_copy(const zc_byte_tail_state *,const uint8_t *arena,uint64_t arena_length,uint8_t *,uint64_t capacity,uint64_t *length);
enum { ZC_PROCESS_OUTPUT_READY=1,ZC_PROCESS_OUTPUT_RESULT=2,ZC_PROCESS_OUTPUT_PROBLEM=3 };
typedef struct { uint32_t struct_size,kind,status,reserved;uint64_t supervisor_pid,consumer_pid; } zc_process_output_message;
int zc_process_output_decode(const uint8_t *,uint32_t length,zc_process_output_message *);
/* Prepare a fresh file, force a keyframe, move at the next encoded key. No input
 * duplication/loss across a successful split. stats.split_pending tracks commit. */
int zc_video_split(zc_recorder *,const char *path);
int zc_video_cancel_split(zc_recorder *);
/* Explicit S16LE input. Synthetic backend is deterministic and unpaced; real
 * ALSA input is optional (-Daudio=true), clocked in Linux CLOCK_BOOTTIME ns. */
enum { ZC_AUDIO_SYNTHETIC=0,ZC_AUDIO_ALSA=1 };
typedef struct { uint32_t struct_size,backend,sample_rate,channels,block_frames,reserved;uint64_t start_ns; } zc_audio_config;
typedef struct { uint64_t timestamp_ns;int64_t clock_error_ns;uint32_t frames,reserved; } zc_audio_block;
typedef struct zc_audio zc_audio;
void zc_default_audio_config(zc_audio_config *);
int zc_audio_open(const zc_audio_config *,const char *device,zc_audio **);
int zc_audio_read(zc_audio *,uint8_t *output,uint64_t capacity,uint32_t timeout_ms,zc_audio_block *);
int zc_audio_close(zc_audio *);
int zc_audio_can_share(zc_audio *); /* nonmutating source claim check */
/* One serialized fan-out owner claims the capture cursor. Raw read/close then
 * return BUSY until all consumers retire and the fan-out closes. No extra device
 * opens. Batches borrow bounded shared PCM until exact finish or retirement;
 * the accepting codec producer must own a copy before finish(accepted=1). */
typedef struct zc_audio_fanout zc_audio_fanout;
typedef struct { uint32_t struct_size,max_frames,max_blocks,reserved; } zc_audio_fanout_config;
typedef struct { const uint8_t *data;uint64_t length,timestamp_ns; } zc_pcm_span;
typedef struct { uint64_t ticket,frames,next_ns;uint32_t blocks,reserved; } zc_pcm_batch;
typedef struct { uint64_t id,next_ns,ticket,frames,overruns,cancelled;uint32_t flags,reserved; } zc_pcm_consumer_state;
typedef struct {
    uint64_t frames,blocks,max_frames,max_blocks,high_frames,high_blocks,pushed_frames,evicted_frames;
    uint32_t sample_rate,channels;int64_t clock_error_ns;uint64_t reads;
    uint32_t pending_future;int32_t error_code;
} zc_pcm_fanout_stats;
int zc_audio_fanout_open(zc_audio *,const zc_audio_fanout_config *,zc_audio_fanout **);
int zc_audio_fanout_close(zc_audio_fanout *);
/* Bounded stable holds keep capture/history alive while consumers are replaced.
 * Close remains BUSY until every hold is released; stale hold IDs never match. */
int zc_audio_fanout_hold(zc_audio_fanout *,uint64_t *id);
int zc_audio_fanout_release_hold(zc_audio_fanout *,uint64_t id);
int zc_audio_fanout_add(zc_audio_fanout *,uint64_t *id);
/* Bounded nonblocking reads through cut; one future block remains owned in the
 * source scratch. A read-budget exhaustion is a terminal source error. */
int zc_audio_fanout_fill(zc_audio_fanout *,uint64_t cut,uint32_t max_reads);
int zc_audio_fanout_prepare(zc_audio_fanout *,uint64_t id,uint64_t minimum,uint64_t cut,zc_pcm_span *,uint32_t capacity,zc_pcm_batch *);
int zc_audio_fanout_finish(zc_audio_fanout *,uint64_t id,uint64_t ticket,uint32_t accepted,zc_pcm_consumer_state *);
int zc_audio_fanout_check(zc_audio_fanout *,uint64_t id); /* IO quarantines history overrun */
int zc_audio_fanout_state(zc_audio_fanout *,uint64_t id,zc_pcm_consumer_state *);
int zc_audio_fanout_retire(zc_audio_fanout *,uint64_t id,zc_pcm_consumer_state *);
int zc_audio_fanout_stats(zc_audio_fanout *,zc_pcm_fanout_stats *);
/* Additive recording options. sample_rate=0 disables audio; .mkv uses PCM, .mp4 requires -Daac=true.
 * Existing video-only .mp4/.mkv APIs keep their layouts and behavior. */
typedef struct {uint32_t struct_size,sample_rate,channels,buffer_frames,max_blocks,exclusive;} zc_recording_options;
typedef struct {uint64_t segments,output_bytes,output_frames,output_duration_ns,audio_frames,audio_written_frames,audio_queued_frames,audio_trimmed_frames;uint32_t rotation_due,audio_enabled;} zc_recording_stats;
void zc_default_recording_options(zc_recording_options *);
/* Output-less direct recorder. Attach callbacks or a path to record.
 * bitrate=0 uses the selected output's default; no circular history allocated. */
int zc_video_create(const zc_video_config *,const zc_recording_options *,uint32_t bitrate,zc_recorder **);
int zc_video_open_ex(const char *,const zc_video_config *,const zc_recording_options *,zc_recorder **);
/* AAC-LC bitrate in bits/s; requires -Daac=true, audio sample_rate and .mp4. */
int zc_video_open_aac(const char *,const zc_video_config *,const zc_recording_options *,uint32_t bitrate,zc_recorder **);
/* Circular PCM history is bounded by buffer_frames and max_blocks (<=10 seconds).
 * Old blocks are evicted; snapshots select the first key after an evicted prefix.
 * MP4 re-encodes retained PCM to AAC with fresh priming; video is remuxed.
 * bitrate=0 selects the AAC default. .mkv uses PCM, .mp4 uses AAC.
 * Audio timestamps/stats use the shared absolute capture clock.
 * An active output fails explicitly if eviction overtakes unwritten audio. */
int zc_video_open_circular_av(const zc_video_config *,const zc_buffer_config *,const zc_recording_options *,uint32_t bitrate,zc_recorder **);
typedef struct {uint64_t frames,bytes,evicted_frames,first_ns,last_ns;} zc_audio_buffer_stats;
int zc_video_audio_buffer_stats(zc_recorder *,zc_audio_buffer_stats *);
int zc_video_write_audio(zc_recorder *,const uint8_t *s16le,uint64_t length,uint64_t timestamp_ns);
/* Soft policy only; caller reads rotation_due and stages zc_video_split.
 * PCM timestamps and frame timestamps must share one nanosecond epoch. */
int zc_video_set_rotation(zc_recorder *,uint64_t duration_ns,uint64_t max_bytes);
int zc_video_recording_stats(zc_recorder *,zc_recording_stats *);
/* Independent additive delay after any recorder-wide CircularOutput2 delay.
 * Fixed queue bounds; overflow is a sink failure. Stop flushes queued tails;
 * detach discards them. Delay changes take effect on the next encoded packet.
 * Resizing a nonempty queue is busy. All attachment settings survive splits. */
typedef struct {uint64_t delay_ns,queued_frames,queued_bytes;uint32_t max_frames,reserved;uint64_t max_bytes;} zc_output_delay;
int zc_video_set_output_delay(zc_recorder *,uint64_t id,uint64_t delay_ns,uint64_t max_bytes,uint32_t max_frames);
int zc_video_output_delay(zc_recorder *,uint64_t id,zc_output_delay *);
/* Retry claims use the last accepted video timestamp. Polling consumes one
 * attempt only when due, with capped exponential backoff and a lifetime budget.
 * Requires failure isolation. Configure resets the budget; limit=0 disables.
 * Recovery replaces a quarantined sink with a FRESH target, preserves its ID,
 * increments generation, drops its stale queue, and requests a new keyframe.
 * Caller retains old callbacks until successful replacement. No failed sink
 * is retried in place. Supply exactly one of path/callbacks. */
typedef struct {uint32_t limit,attempts,exhausted,pending;uint64_t deadline_ns;} zc_output_recovery_state;
int zc_video_set_output_recovery(zc_recorder *,uint64_t id,uint32_t limit,uint64_t initial_ns,uint64_t maximum_ns);
int zc_video_output_retry_due(zc_recorder *,uint64_t id,uint32_t *due);
int zc_video_output_recovery(zc_recorder *,uint64_t id,zc_output_recovery_state *);
int zc_video_recover_output(zc_recorder *,uint64_t id,const char *path,const zc_output_callbacks *);

/* Opt-in asynchronous sink I/O. Bounds include the in-flight operation. No
 * encoded bytes are dropped: queue overflow quarantines the sink under isolate.
 * wait_ns=0 fails immediately; otherwise producer waits at most that duration.
 * Enable once per sink at a serialized call boundary, before staging its split.
 * Callbacks run on a native worker and must not re-enter the recorder.
 * Explicit drain/close wait for callbacks; callbacks must eventually return.
 * Split commit can enqueue a new epoch while the old worker drains. */
typedef struct {uint64_t queued_bytes,queued_ops,accepted_ops,completed_ops,rejected_ops,high_bytes,high_ops,max_bytes,wait_ns;uint32_t max_ops,running;int32_t error_code,split_error;} zc_output_io_stats;
int zc_video_set_output_io(zc_recorder *,uint64_t id,uint64_t max_bytes,uint32_t max_ops,uint64_t wait_ns);
int zc_video_output_io_stats(zc_recorder *,uint64_t id,zc_output_io_stats *);
int zc_video_drain_output_io(zc_recorder *,uint64_t id);
/* Fixed admitted prefix; independent of recorder lifetime. At most 32 live jobs
 * per worker epoch. wait returns TIMEOUT while pending; close releases a job,
 * never cancels I/O. Serialize job close against wait on the same job. */
typedef struct zc_output_job zc_output_job;
int zc_video_drain_output_async(zc_recorder *,uint64_t id,zc_output_job **);
int zc_output_job_wait(zc_output_job *,uint32_t timeout_ms);
void zc_output_job_close(zc_output_job *);
/* Caller-serialized cooperative preparation state, no allocation. step returns
 * 1 for an accepted transition, 0 for rejection, INVALID for malformed input.
 * Cancellation after claim needs cleanup before CLEANED makes it terminal. */
typedef struct {uint32_t phase,cancel_requested;} zc_preparation_state;
enum {ZC_PREPARATION_QUEUED=0,ZC_PREPARATION_PREPARING=1,ZC_PREPARATION_READY=2,ZC_PREPARATION_PUBLISHED=3,ZC_PREPARATION_CANCELLED=4,ZC_PREPARATION_FAILED=5};
enum {ZC_PREP_CLAIM=1,ZC_PREP_READY=2,ZC_PREP_PUBLISH=3,ZC_PREP_CANCEL=4,ZC_PREP_CLEANED=5,ZC_PREP_FAIL=6};
void zc_default_preparation_state(zc_preparation_state *);
int zc_preparation_step(zc_preparation_state *,uint32_t action);
/* Begin/commit/close serialize with recorder calls. build owns immutable copied
 * configuration and may run independently of recording. One preparation per
 * output, eight total. Recorder close is BUSY until preparations are released.
 * Callback contexts remain borrowed through prepared_output_close/commit. */
typedef struct zc_prepared_output zc_prepared_output;
int zc_video_prepare_split(zc_recorder *,uint64_t id,const char *path,const zc_output_callbacks *,zc_prepared_output **);
int zc_prepared_output_build(zc_prepared_output *);
int zc_video_commit_split(zc_recorder *,zc_prepared_output *);
void zc_prepared_output_close(zc_prepared_output *);

/* Native bounded preparation workers. All recorder/job calls are serialized by
 * the owner. File jobs exclusively create fresh paths on the worker, including
 * open/header/AAC/I/O allocation. poll never waits for preparation I/O. It stages
 * ready output and reports success only after keyframe commit and retirement.
 * write polls automatically. Cancellation succeeds only before staging; STALE
 * in a terminal job means cancellation. Keep callback contexts until terminal.
 * At most 8 live job handles (including completed unreleased jobs). Close cancels
 * preparation, joins workers and removes only files with the created identity.
 * Job status/close remain valid after recorder close. No callback reentry. */
typedef struct zc_preparation_job zc_preparation_job;
typedef struct {uint64_t id,generation;uint32_t phase,staged,done;int32_t error_code;} zc_preparation_job_state;
typedef struct {uint64_t next_index;int32_t error_code;uint32_t pending;} zc_automatic_state;
int zc_video_prepare_recovery(zc_recorder *,uint64_t id,const char *,const zc_output_callbacks *,zc_prepared_output **);
/* commit_split accepts either split or recovery recipes. Recovery retains the
 * quarantined output until fresh publication, then frees it on recipe close. */
int zc_video_prepare_async(zc_recorder *,uint64_t id,const char *,const zc_output_callbacks *,uint32_t recovery,zc_preparation_job **);
int zc_video_poll_preparations(zc_recorder *);
int zc_preparation_job_state_get(zc_preparation_job *,zc_preparation_job_state *);
int zc_preparation_job_cancel(zc_preparation_job *);
int zc_preparation_job_close(zc_preparation_job *);
/* Exactly one automation per ID: recovery or primary rotation. pattern has one
 * {index} or {index:06} field (width 1..128). next_index is the first replacement.
 * NULL disables when idle. Rotation is soft, key aligned; construction failure
 * latches an observable error and leaves current output live. Recovery uses the
 * separately configured lifetime retry budget/media-clock backoff and advances
 * the filename on EVERY attempt. No overwriting or retention deletion. */
int zc_video_set_automatic(zc_recorder *,uint64_t id,const char *pattern,uint64_t next_index,uint32_t recovery,uint64_t duration_ns,uint64_t max_bytes);
int zc_video_automatic_state(zc_recorder *,uint64_t id,zc_automatic_state *);

/* Bounded owned producer-to-host mailbox. Native callbacks only enqueue. One
 * host consumer copies/acknowledges in FIFO order; in-flight bytes stay charged.
 * Prefix polls survive later admissions/failures. Destroy ONLY after all native
 * callback contexts and host hooks have retired. No runtime callbacks on C threads. */
typedef struct zc_output_mailbox zc_output_mailbox;
typedef struct {uint64_t sequence,offset,timestamp_ns,length;uint32_t kind,codec,flags,reserved;} zc_output_event;
int zc_output_mailbox_open(uint64_t max_bytes,uint32_t max_operations,zc_output_mailbox **);
int zc_output_mailbox_callbacks(zc_output_mailbox *,uint32_t format,zc_output_callbacks *);
int zc_output_mailbox_peek(zc_output_mailbox *,zc_output_event *);
int zc_output_mailbox_copy(zc_output_mailbox *,uint64_t sequence,uint8_t *,uint64_t capacity);
int zc_output_mailbox_ack(zc_output_mailbox *,uint64_t sequence);
int zc_output_mailbox_fail(zc_output_mailbox *,int code);
int zc_output_mailbox_prefix(zc_output_mailbox *,uint64_t *);
int zc_output_mailbox_poll(zc_output_mailbox *,uint64_t target);
/* Capacity is observed, never reserved. No call sleeps or blocks a producer.
 * Wait tickets (16 per mailbox) use a monotonic native deadline; poll observes
 * capacity, release cancels pending waits. Retire closes pending waits before
 * destroying storage; terminal outcomes remain stable until release. */
typedef struct {
    uint64_t queued_bytes,queued_ops,accepted_ops,completed_ops,rejected_ops;
    uint64_t high_bytes,high_ops,max_bytes,max_ops,accepted_bytes,completed_bytes;
    uint64_t wait_requests,blocked_waits,satisfied_waits,timed_out_waits;
    uint64_t cancelled_waits,closed_waits,pending_waits,total_wait_ns,high_wait_ns;
    int32_t error_code;uint32_t reserved;
} zc_output_mailbox_stats;
typedef struct {uint64_t remaining_ns;int32_t code;uint32_t done;} zc_output_wait_state;
int zc_output_mailbox_stats_get(zc_output_mailbox *,zc_output_mailbox_stats *);
int zc_output_mailbox_wait_open(zc_output_mailbox *,uint64_t bytes,uint32_t operations,uint64_t timeout_ns,uint64_t *ticket);
int zc_output_mailbox_wait_poll(zc_output_mailbox *,uint64_t ticket,zc_output_wait_state *);
int zc_output_mailbox_wait_close(zc_output_mailbox *,uint64_t ticket);
void zc_output_mailbox_retire(zc_output_mailbox *);
/* Timed sends apply ONLY in the native async producer scope. Synchronous
 * callbacks stay fail-fast. Per-operation deadline, maximum 60 seconds. */
int zc_output_mailbox_backpressure(zc_output_mailbox *,uint64_t wait_ns);
void zc_output_mailbox_close(zc_output_mailbox *);
/* Held preparation exposes READY but cannot stage until release. Host drains
 * header delivery before publication. Cancellation/close still owns cleanup. */
int zc_video_prepare_held(zc_recorder *,uint64_t id,const char *,const zc_output_callbacks *,uint32_t recovery,zc_preparation_job **);
int zc_preparation_job_publish(zc_preparation_job *);
/* Teardown only: cancel staged, uncommitted replacement; TIMEOUT means cleanup
 * worker is not yet done. A committed generation returns STATE. No waiting. */
int zc_preparation_job_abort_pending(zc_preparation_job *);
/* Serialized host-consumer failure notification, normal isolation policy. */
int zc_video_fail_output(zc_recorder *,uint64_t id,int code);
/* Initial attachment only, before its first frame; held sinks receive no media
 * and retain no PCM. Release requests a fresh keyframe. */
int zc_video_hold_output(zc_recorder *,uint64_t id,uint32_t held);
/* Held primary attachment owns a frozen GOP/PCM pre-roll and bounded live FIFO.
 * Step at most one video interval, drain host delivery, repeat while TIMEOUT.
 * Publish is atomic only when replay/live backlog is empty, else TIMEOUT.
 * Discard retires an unpublished target without finalization or source failure. */
int zc_video_open_held_callbacks(zc_recorder *,const zc_output_callbacks *);
int zc_video_step_held_output(zc_recorder *);
int zc_video_publish_held_output(zc_recorder *);
int zc_video_discard_held_output(zc_recorder *);
/* Mailbox packet event.offset is the unre-based recorder source timestamp, ns.
 * Write/patch offsets retain their existing byte-offset interpretation. */
typedef struct {uint64_t first_ns,last_ns;uint32_t initialized,reserved;} zc_pts_clock;
void zc_default_pts_clock(zc_pts_clock *);
int zc_pts_clock_accept(zc_pts_clock *,uint64_t source_ns,uint64_t *timestamp_us);
/* Owned custom snapshots share the two-window limit with file snapshots.
 * Freeze before async hooks. Bind is serialized with the live source, or pass
 * NULL only after source close and its callback owners have fully retired.
 * Step one video interval, drain host writes; final OK includes tail/patches.
 * Close always consumes the snapshot, even after failed binding/cancellation. */
int zc_video_freeze_callbacks(zc_recorder *,zc_snapshot **);
int zc_snapshot_open_callbacks(zc_snapshot *,zc_recorder *live,const zc_output_callbacks *);
int zc_snapshot_step(zc_snapshot *);
/* Native media-clock policy; Bun owns the asynchronous factory/hook invocation.
 * mode 1=rotation, 2=recovery. NULL disables an idle factory. Claims reserve
 * preparation admission; ticket-matched finish releases it after cleanup. */
typedef struct {uint32_t struct_size,mode,max_attempts,reserved;uint64_t next_index,duration_ns,max_bytes,initial_ns,maximum_ns;} zc_factory_config;
typedef struct {uint64_t next_index,ticket,index,generation,deadline_ns;int32_t error_code;uint32_t mode,pending,attempts,limit,exhausted,retry_pending,reserved;} zc_factory_state;
int zc_video_set_factory(zc_recorder *,uint64_t id,const zc_factory_config *);
int zc_video_factory_state(zc_recorder *,uint64_t id,zc_factory_state *);
int zc_video_claim_factory(zc_recorder *,uint64_t id,zc_factory_state *);
int zc_video_prepare_factory(zc_recorder *,uint64_t id,uint64_t ticket,const zc_output_callbacks *,zc_preparation_job **);
int zc_video_finish_factory(zc_recorder *,uint64_t id,uint64_t ticket,int code);
/* Copied RGB/PCM producer jobs. Admission includes completed retained handles.
 * start gives the persistent worker exclusive recorder access. Finish polls
 * completion and releases that turn; close then consumes the job. A queued
 * job may be closed without starting. Cancellation never rolls back/retries data.
 * All ordinary recorder ABI calls return BUSY during an active producer turn.
 * Creator/caller serializes admission and lifecycle; callbacks remain native. */

typedef struct {uint64_t id,generation;} zc_producer_handoff;
typedef struct {const uint8_t *data;uint64_t length,timestamp_ns;} zc_producer_audio_input;
typedef struct {uint64_t owned_bytes,owned_jobs,high_bytes,high_jobs,max_bytes,max_jobs,admitted,released,rejected,completed,failed,cancelled;uint32_t running,reserved;} zc_producer_stats;
int zc_video_set_producer_limits(zc_recorder *,uint64_t bytes,uint32_t jobs);
int zc_video_producer_stats(zc_recorder *,zc_producer_stats *);
int zc_video_producer_frame(zc_recorder *,const zc_frame *,uint64_t timestamp_ns,zc_producer_job **);
int zc_video_producer_audio(zc_recorder *,const uint8_t *,uint64_t length,uint64_t timestamp_ns,zc_producer_job **);
int zc_video_producer_av(zc_recorder *,const zc_frame *,uint64_t timestamp_ns,const zc_producer_audio_input *,uint32_t count,zc_producer_job **);
/* Same format/color contract; owns tight pixel/color/PCM copies on success.
 * Queue accounting uses actual packed RGB/BGR/RGBX/BGRX or 4:2:0 input bytes, not expanded RGB. */
int zc_video_producer_input_av(zc_recorder *,const zc_frame *,const zc_color_space *,uint64_t timestamp_ns,const zc_producer_audio_input *,uint32_t count,zc_producer_job **);
int zc_producer_job_start(zc_producer_job *);
/* Bounded FIFO control jobs on the same worker. flush=0 captures all native sink
 * prefixes; flush=1 first terminally flushes video/AAC/container tails. Caller
 * orders starts after earlier writes. Entered flush cannot be cancelled.
 * finish releases the native turn; output polling fences delivery separately.
 * Retained jobs (including controls) keep recorder close BUSY until job_close. */
int zc_video_producer_barrier(zc_recorder *,uint32_t flush,zc_producer_job **);
int zc_producer_job_drain_outputs(zc_producer_job *);
/* Session phases: 0=open, 1=flushing, 2=flushed, 3=failed. */
typedef struct {uint64_t session;uint32_t phase;int32_t error_code;} zc_session_state;
int zc_video_session_state(zc_recorder *,zc_session_state *);
/* Resolve copied media settings against negotiated capture geometry. exact bits
 * 0/1 require the proposed width/height. Invalid settings preserve *config. */
int zc_video_resolve_session_config(zc_video_config *,const zc_recording_options *,uint32_t audio_bitrate,uint32_t width,uint32_t height,uint32_t exact);
int zc_video_session_config(zc_recorder *,zc_video_config *,zc_recording_options *,uint32_t *audio_bitrate);
/* Restart kinds: 0=unattached, 1=fresh exclusive path, 2=callbacks bound later.
 * Requires terminal flush and released producer/preparation/snapshot handles.
 * Stage 1 exposes new codec headers; bind callbacks, then stage 2 means the
 * output is ready. Acknowledge headers externally before publish. Cancellation
 * before publish discards only the candidate; publication is irreversible. */
int zc_video_producer_restart(zc_recorder *,uint32_t kind,const char *path,zc_producer_job **);
/* Optional session replacement, before start. Copies settings by value. Invalid
 * settings preserve any previous recipe and the terminal source configuration.
 * Queue budgets, output policies and circular capacities remain recorder-owned. */
int zc_producer_job_restart_configure(zc_producer_job *,const zc_video_config *,const zc_recording_options *,uint32_t audio_bitrate);
/* Copied before start; null selects defaults, omission retains current profile.
 * Final codec/profile compatibility is checked before candidate construction. */
int zc_producer_job_restart_color(zc_producer_job *,const zc_color_space *);
/* Copied before start, NULL resets defaults; omission retains prior policy.
 * Final codec/rate compatibility is checked before candidate output creation. */
int zc_producer_job_restart_codec_options(zc_producer_job *,const zc_codec_options *);
/* Copied before start, enabled strictly 0/1; omission retains prior policy. */
int zc_producer_job_restart_repeat_headers(zc_producer_job *,uint32_t enabled);
int zc_producer_job_restart_codec_limits(zc_producer_job *,const zc_codec_limits *);
int zc_producer_job_restart_io(zc_producer_job *,uint64_t bytes,uint32_t operations,uint64_t wait_ns);
int zc_producer_job_restart_stage(zc_producer_job *,uint32_t *stage);
int zc_producer_job_restart_headers(zc_producer_job *,uint8_t *,uint32_t capacity,uint32_t *size);
int zc_producer_job_restart_bind(zc_producer_job *,const zc_output_callbacks *);
int zc_producer_job_restart_publish(zc_producer_job *);
/* One all-or-none publication decision for 1..8 prepared jobs from distinct
 * recorders. Locks follow stable owner order; cancelled/unready members reject
 * before any commit flag changes. No callbacks under group locks. After success
 * every job is uncancellable; finish/join all jobs before accessing media state.
 * This commits media sessions, not external file/hook side effects. */
int zc_producer_jobs_restart_publish(zc_producer_job *const *jobs,uint32_t count);
/* Cancellation is cooperative between PCM blocks/frames. An operation already
 * entered finishes; accepted bytes are not rolled back. Always finish+close.
 * Returns STATE after completion or a previous request. A real operation failure
 * takes precedence over CANCELLED in finish's result. */
int zc_producer_job_cancel(zc_producer_job *);
typedef struct zc_producer_drain zc_producer_drain;
/* Captures admitted input ownership, including queued and retained handles.
 * Completion means cleanup, regardless of individual write success. Later inputs
 * do not extend the prefix. At most 32 retained drains; safe after recorder close. */
int zc_video_producer_drain(zc_recorder *,zc_producer_drain **);
int zc_producer_drain_poll(zc_producer_drain *);
void zc_producer_drain_close(zc_producer_drain *);
int zc_producer_job_finish(zc_producer_job *,int *result);
int zc_producer_job_close(zc_producer_job *);
/* Immutable host epoch handoffs: retiring hooks may drain/stop while the worker
 * continues writing the new epoch, releasing shared PTS predecessor fences. */
int zc_producer_job_handoffs(zc_producer_job *,zc_producer_handoff *out,uint32_t capacity,uint32_t *count);
/* Worker-only finalization; async host backpressure applies to EOF tails. */
int zc_video_close_outputs_async(zc_recorder *,zc_output_result *,uint32_t capacity,uint32_t *count);

/* Owned RTP access-unit cursors: copied input, 16 owners / 64 MiB combined,
 * max 16 MiB per AU, 4096 NALs / 65536 packets. MTU includes the RTP header.
 * Serialise each handle; short buffers and size queries never advance it.
 * Codec 1 AVC, 2 HEVC, 3 raw AAC; format 0 Annex B, 1 four-byte lengths, 2 raw.
 * Closing retires copied input before releasing admission; BUSY retains owner. */
typedef struct zc_rtp_packetizer zc_rtp_packetizer;
typedef struct {uint32_t struct_size,codec,format,mtu,payload_type,sequence,timestamp,ssrc;} zc_rtp_config;
typedef struct {uint32_t struct_size,total,emitted,next_sequence,timestamp,next_bytes;} zc_rtp_state;
typedef struct {uint32_t struct_size,ssrc,rtp_timestamp,packets,octets,bye;uint64_t unix_ns;} zc_rtcp_report;
typedef struct {uint32_t struct_size,space,tier,profile_id,compatibility,level;uint64_t constraints;} zc_rtp_hevc_profile_info;
int zc_rtp_hevc_profile(const uint8_t *nal,uint32_t length,zc_rtp_hevc_profile_info *out);
void zc_default_rtp_config(zc_rtp_config *);
int zc_rtp_packetizer_open(const zc_rtp_config *,const uint8_t *,uint64_t length,zc_rtp_packetizer **out);
int zc_rtp_packetizer_next(zc_rtp_packetizer *,uint8_t *out,uint32_t capacity,uint32_t *length);
int zc_rtp_packetizer_state(zc_rtp_packetizer *,zc_rtp_state *);
int zc_rtp_packetizer_close(zc_rtp_packetizer *);
int zc_rtp_timestamp_signed(int64_t ns,uint32_t rate,uint32_t origin,uint32_t *out);
int zc_rtp_timestamp(uint64_t ns,uint32_t rate,uint32_t origin,uint32_t *out);
/* unix_ns and RTP timestamp must describe the same instant. Size query is
 * out=NULL/capacity=0; malformed CNAME or short output writes no prefix. */
int zc_rtcp_sender_report(const zc_rtcp_report *,const uint8_t *cname,uint32_t cname_length,uint8_t *out,uint32_t capacity,uint32_t *length);

#ifdef __cplusplus
}
#endif
#endif
