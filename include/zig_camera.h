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
 uint32_t struct_size,valid; /* AF=1, lens=2, duration=4, crop=8, timestamp BOOTTIME=16 */
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
 * Timestamps are rebased ns; key=1, audio=2, AnnexB=4 flags. */
enum { ZC_OUTPUT_PACKETS=0,ZC_OUTPUT_MP4=1,ZC_OUTPUT_MKV=2,ZC_PCM_S16LE=4 };
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

#ifdef __cplusplus
}
#endif
#endif
