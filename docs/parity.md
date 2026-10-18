# Picamera2 coverage in 0.8

This is a native capture API plus an explicit Python compatibility subset, not
a replacement `picamera2` package. Unsupported formats/controls fail explicitly.
The original C ABI v1 layouts remain unchanged; new functions/structures are additive.

| Capability | Current implementation | Remaining gap |
| --- | --- | --- |
| Single-camera RGB capture | Zig/C/Python frame leases, owned buffers/NumPy arrays | Additional processed pixel formats |
| Configuration roles | Still/video/viewfinder roles; cached raw-mode discovery, exact sensor output size/bit depth; paired RGB/YUV420 lores | Per-mode measured FPS/exposure/crop catalog, arbitrary formats |
| Preview | Blocking SDL loop or async display process with a bounded shared RGB slot, aspect-preserving resize, Escape/window close; shared capture worker with recording/AF | Qt/DRM zero-copy preview, overlays; full Picamera2 backend signatures |
| Video encoding | Home MJPEG/4:4:4 in Matroska; optional header-checked x264 H.264 / x265 HEVC in Home fragmented MP4, ABR/CRF and GOP controls | AV1, additional audio codecs, hardware encoders, general profile/preset selection |
| Recording control | Background start/stop, encoded circular history/snapshots/pre-roll and keyframe-aligned async splits; duration/byte rotation with exclusive indexed outputs | Retention deletion, arbitrary output classes, crash recovery |
| Audio and synchronized A/V | Explicit ALSA S16LE capture; bounded PCM queue; BOOTTIME/sample-count synchronization, MJPEG/AVC/HEVC + PCM Matroska; Home AAC-LC + AVC/HEVC fragmented MP4 with priming/tail metadata; sample-clipped splits | Physical latency/drift calibration, adaptive resampling, other audio codecs/HE-AAC, circular A/V, other input platforms |
| Native raw | Paired raw planes, layout/metadata access | Raw processing arrays in compatibility facade |
| DNG | Uncompressed 16-bit TIFF storage; Bayer 8/10/12/14/16 input, CSI-2 10/12/14 unpacking; per-frame black levels, WB, CCM-derived colour matrix, EXIF exposure | PiSP compressed-raw decompression, dual-illuminant/lab profiles, lens correction/opcodes, thumbnail |
| Familiar Python capture | create_preview/still/video_configuration, configure, start/stop, capture_request/captured_request, capture_array/buffer/metadata/file | Picamera2's complete signatures, request acquire/refcounts |
| Async capture jobs | Bounded FIFO jobs for request/array/buffer/metadata/file; wait=False, callback, result/wait, asyncio await, queued cancel, frame deadline and stop cleanup | Event-loop integration, general signal classes |
| Mode jobs | Async mode switch/drop-frames and temporary array/buffer/metadata/file capture, previous-mode restoration, preview recreation, lease/recording guards | Old-mode request leases across reconfiguration, switching during encoding, complete signatures |
| Controls | Typed runtime set_controls, camera capabilities/ranges, atomic batches, 30-name catalog including focus windows and AE/AWB controls; per-frame metadata | Arbitrary vendor controls, HDR modes, full metadata catalog |
| Autofocus jobs | Auto/Start then revision-filtered Scanning -> Focused/Failed/Idle; cancel/timeout/stop, awaitable results and callback | Optical validation |
| Multiple cameras | Independent camera indices | Synchronization/stereo capture and tuning |

## Python subset example

```python
from zigcamera import Picamera2, H264Encoder

with Picamera2() as camera:
    camera.configure(camera.create_still_configuration())
    camera.start()
    for _ in range(60):
        with camera.captured_request():
            pass
    camera.capture_file("trail.jpg")
    camera.capture_file("trail.dng", name="raw")
    camera.stop()
    camera.configure(camera.create_video_configuration(main={"size": (1280, 720)}))
    camera.start_recording(H264Encoder(bitrate=12_000_000, iperiod=60), "trail.mp4", fps=30)
    # Application work happens here. stop_recording joins the worker and releases leases.
    camera.stop_recording()
```

`capture_array` requires NumPy and returns owned HxWx3 RGB or (H*3/2)xW I420 arrays. BGR888 is the
libcamera format name for RGB byte order. The facade's raw stream requests
uncompressed Bayer for DNG; a camera that cannot negotiate it reports an error.
Its metadata dictionary exposes the implemented timestamp/exposure/gain/WB/sequence
fields, not every libcamera metadata item. Active capture must be stopped before
reconfiguration; outstanding leases prevent camera destruction.

`camera.preview(frames=300)` remains a blocking UI-thread loop. `start_preview()`
starts an async display process; it can run alongside recording and autofocus
on one shared capture worker. Capture helpers also submit jobs to that worker;
only low-level `Camera.acquire` competes directly for requests. See [runtime controls, focus jobs and preview](controls.md) for
API semantics and process startup requirements. See [pipeline and capture jobs](pipeline.md)
for sensor, lores and capture cancellation/ownership details.
There is no object detector, tracking mount or autonomous navigation in this API.

## Acceptance status

Build with `-Dcodecs=true` and install libx264/libx265 for the example above.
`HEVCEncoder` selects HEVC; `MJPEGEncoder` with `.mkv` remains dependency-free.
These names are a subset of Picamera2 signatures, not drop-in encoder classes.

Synthetic tests exercise ownership, role/options validation, native JPEG scan
coding, DNG samples/tags, Matroska demux, frame decode, SDL dummy rendering and
thread ownership, recording shutdown and API compatibility. LibRaw independently
opens/develops generated DNG files. These do not establish physical camera
behaviour, optical quality or Pi frame rates. Pi camera/display validation remains
required. See [performance and hardware acceptance](performance.md).

AVC/HEVC acceptance includes independent OpenH264/libde265 decoding on Linux,
exact frame counts/order, regular and gapped capture timelines, GOP boundaries,
container parsing, final-frame drain, invalid inputs, and background restart.
Apple AVFoundation also decoded both MP4 fixtures locally. Pi sustained FPS,
long-run reliability, motion quality and bitrate behaviour remain unmeasured.


0.6 adds synthetic mode-change round trips, failure/deadline restoration,
callback/lifecycle locking, circular byte/frame/time limits, snapshot continuation,
file-identity checks, split cancellation and stop coverage. Optional codec CI
independently decodes AVC/HEVC split segments and circular snapshots, checks
frame order/counts, fresh keyframes, rebased timelines and capture gaps. See
[mode and recording semantics](mode-recording.md) for remaining limits.

0.7 adds [automatic rotation and PCM A/V](audio-rotation.md). Linux acceptance
includes ALSA null-device capture, independent Matroska identification/WAV
extraction and AVC/HEVC segment decoding. Physical A/V synchronization and
sustained Pi performance remain unmeasured.

0.8 adds [AAC-LC and synchronized MP4](aac-mp4.md), including fresh codec
state per segment, explicit decoder pre-roll, priming/tail trimming and independent
FAAD2/AVFoundation waveform/count validation.
