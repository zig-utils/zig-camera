# Picamera2 coverage in 0.3

This is a native capture API plus an explicit Python compatibility subset, not
a replacement `picamera2` package. Unsupported formats/controls fail explicitly.
The original C ABI v1 layouts remain unchanged; new functions/structures are additive.

| Capability | Current implementation | Remaining gap |
| --- | --- | --- |
| Single-camera RGB capture | Zig/C/Python frame leases, owned buffers/NumPy arrays | Additional processed pixel formats |
| Configuration roles | Still, video and viewfinder roles; role-specific ISP noise reduction | General sensor mode selection and low-resolution stream |
| Preview | SDL2 streaming texture, aspect-preserving resize, Escape/window close; optional during recording | Qt/DRM zero-copy preview, overlays; asynchronous Picamera2 preview API |
| Video encoding | Home MJPEG/4:4:4 in Matroska; optional header-checked x264 H.264 / x265 HEVC in Home fragmented MP4, ABR/CRF and GOP controls | AV1, audio, hardware encoders, general profile/preset selection |
| Recording control | CLI finite frame count, Python Recorder and background start/stop | Circular outputs, split recordings, general encoder/output classes |
| Native raw | Paired raw planes, layout/metadata access | Raw processing arrays in compatibility facade |
| DNG | Uncompressed 16-bit TIFF storage; Bayer 8/10/12/14/16 input, CSI-2 10/12/14 unpacking; per-frame black levels, WB, CCM-derived colour matrix, EXIF exposure | PiSP compressed-raw decompression, dual-illuminant/lab profiles, lens correction/opcodes, thumbnail |
| Familiar Python capture | create_preview/still/video_configuration, configure, start/stop, capture_request/captured_request, capture_array/buffer/metadata/file | Picamera2's complete signatures, jobs/signals/events, request acquire/refcounts |
| Controls | Configuration-time exposure/gain, focus, frame duration, noise reduction; continuous AF when supported | General runtime set_controls, autofocus jobs, AF windows, HDR modes |
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

`capture_array` requires NumPy and returns owned HxWx3 RGB bytes. BGR888 is the
libcamera format name for RGB byte order. The facade's raw stream requests
uncompressed Bayer for DNG; a camera that cannot negotiate it reports an error.
Its metadata dictionary exposes the implemented timestamp/exposure/gain/WB/sequence
fields, not every libcamera metadata item. Active capture must be stopped before
reconfiguration; outstanding leases prevent camera destruction.

Preview is a blocking main/UI-thread loop (`camera.preview(frames=300)`), not
Picamera2's asynchronous `start_preview`. The lower-level `Preview.show(frame)`
can be integrated into an application UI loop. Recording uses its own worker;
stop it before competing capture consumers if every recorded frame matters.
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
