# Audio, synchronization and automatic rotation (0.7)

Build on Linux with `libasound2-dev` and `zig build -Daudio=true`. Optional
`-Dcodecs=true` additionally enables H.264/HEVC through Home's checked x264/x265
adapter. No FFmpeg or Libav subprocess/library is used. Audio is explicit: opening
a camera never opens a microphone.

```python
import time
from zigcamera import Picamera2, H264Encoder, RotatingOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    output = RotatingOutput("trail-{index:06d}.mkv", duration_ms=60_000,
                            max_bytes=512 * 1024 * 1024)
    recording = camera.start_recording(
        H264Encoder(bitrate=16_000_000, iperiod=60), output, fps=30,
        audio={"device": "hw:1,0", "sample_rate": 48000, "channels": 2})
    time.sleep(10)
    print(output.current_path, recording.stats)
    camera.stop_recording()
```

Select an installed ALSA capture device and a rate/channel count it supports.
Device names are passed directly to ALSA; there is no shell command. `audio=True`
chooses ALSA `default`, 48kHz mono. An audio dictionary accepts `device`,
`sample_rate`, `channels`, `block_frames` (default 480, max 4096), and `backend`.
Synthetic tests use `backend="synthetic"` together with `simulate=True`; this is
an unpaced deterministic signed ramp, not a microphone or hardware timing test.
The recording owns the capture device and closes it on stop or startup failure.

Audio is lossless interleaved signed 16-bit little-endian PCM. Home's new streaming
Matroska writer combines it with MJPEG, H.264 or HEVC in `.mkv`. Video-only H.264/
HEVC `.mp4` remains supported. Version 0.8 adds optional Home AAC-LC audio in
MP4 with `-Daac=true`; see [AAC and MP4 timing](aac-mp4.md). **Circular A/V
snapshots and A/V close/reopen output remain unsupported** and fail explicitly.
The audited legacy Home AAC prototypes now reject encoding; the new checked
AAC adapter supplies real packets and codec delay.
Live A/V splits and automatic A/V rotation are implemented. These are explicit
zig-camera API extensions; Picamera2's complete audio/output signatures differ.
The native CLI's `record` command currently remains video-only; use Python or C
for A/V and automatic rotation.

## Synchronization and ownership

Real video requires libcamera `SensorTimestamp`, the exposure-start timestamp
in Linux `CLOCK_BOOTTIME`. Metadata validity bit 16 identifies that clock. The
ALSA adapter estimates the first returned sample time from the driver's monotonic
status timestamp and queued samples, converts to BOOTTIME, and advances from
that anchor by exact sample counts. It reports the difference from later ALSA
status measurements. Capture callback scheduling is not used as video time.
See libcamera's [SensorTimestamp definition](https://github.com/libcamera-org/libcamera/blob/master/src/libcamera/control_ids_core.yaml)
and ALSA's [status timestamps](https://www.alsa-project.org/alsa-doc/alsa-lib/group___p_c_m___status.html).

A dedicated audio reader uses a 128-block bounded queue; the capture consumer
waits at most one second for audio coverage through each video interval. Native
PCM ownership uses a separate fixed two-second arena and 256 block descriptors
by default. No consumer work runs in libcamera's completion callback. Queue
exhaustion, timeout, XRUN, disconnect or >100ms measured audio clock error stops
writing and surfaces on `stop_recording`; there is no silent sample drop/recovery.
Stats expose the latest and maximum measured clock errors. Native late/pre-video
samples may be trimmed; `audio_trimmed_frames` reports those. Audio accepted past
the last video interval is trimmed at close. No silence is invented for gaps.

Video and audio share the first video exposure as epoch. Home retains audio
until the corresponding encoded video packet is emitted, including delayed
encoder drain. On a split, samples strictly before the new keyframe go to the
old file; remaining samples go to the next file with a rebased timeline. A sample
cannot appear in both. Matroska timecodes round down to microseconds; split
sample alignment may leave less than one sample of offset in the new file.

This establishes a timestamped synchronized recording path, not calibrated
acoustic/exposure synchronization. Physical microphone latency, sensor exposure
center, driver timestamp accuracy, clock drift, suspend, long recordings and Pi
sustained throughput need hardware validation. There is no adaptive resampling
or drift correction. PCM stereo 48kHz costs 192,000 bytes/s before container overhead.
One Matroska cluster per packet avoids a file-sized buffer; duration/seek cues
are currently absent.

## Rotation semantics

`RotatingOutput` requires one `{index}` field (integer formatting such as
`{index:06d}` works) and a positive `duration_ms`, `max_bytes`, or both. Index
starts at zero. Native elapsed capture time and bytes written plus a staged
encoded packet trigger the next split; a threshold is soft, with overshoot until
the next encoded keyframe. Size includes headers/audio; exact maximum file size
is not promised. A delayed first encoded packet can also extend a segment.

Every generated file uses exclusive creation. Existing files, hard links and
symlinks are never truncated. A collision or I/O failure is surfaced while the
current completed output remains available. Only one next output is staged;
manual splits are disabled during automatic rotation. Stop cancels and removes
an unused staged output after checking its file identity, then drains the encoder
into the current file. Completed files are retained. Directory creation, maximum
file retention/deletion, crash recovery and restart index discovery are not included.
`current_path` identifies the last committed output; no unbounded path list is kept.

## Low-level APIs and validation

`AudioCapture.read(timeout_ms<=1000)` returns owned PCM bytes, frame count,
first-sample timestamp and clock error, or `None` on timeout. Read/close serialize.
`Recorder(..., audio={"sample_rate":48000,"channels":2})` accepts explicit
`write_audio(data,timestamp_ns=...)` before or between `write(frame,...)` calls.
Caller-supplied video and PCM timestamps must share one clock. `buffer_frames`
and `max_blocks` configure native PCM bounds; late audio for an already closed
segment cannot be restored. Queue-full rejection does not mutate history.

C ABI additions are in `include/zig_camera.h`: `zc_audio_*`, `zc_video_open_ex`,
`zc_video_write_audio`, `zc_video_recording_stats` and `zc_video_set_rotation`.
The C rotation policy reports `rotation_due`; the caller supplies the next path
with `zc_video_split`. Serialize handle access and close after readers return.
Original ABI v1 layouts are unchanged.

Synthetic tests verify exact stereo PCM content/counts, initial/tail clipping,
segment boundaries, exclusive collisions, byte/time policies, shutdown and queue
failures. Linux x86/ARM CI checks ALSA headers and an explicit `null` test device,
mkvtoolnix demux/WAV content and independent OpenH264/libde265 segment decoding.
These tests do not validate a physical camera or microphone.
