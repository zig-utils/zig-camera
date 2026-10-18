# Picamera2 coverage in 0.2

This is a native capture API plus an explicit Python compatibility subset, not
a replacement `picamera2` package. Unsupported formats/controls fail explicitly.
The original C ABI v1 layouts remain unchanged; new functions/structures are additive.

| Capability | Current implementation | Remaining gap |
| --- | --- | --- |
| Single-camera RGB capture | Zig/C/Python frame leases, owned buffers/NumPy arrays | Additional processed pixel formats |
| Configuration roles | Still, video and viewfinder roles; role-specific ISP noise reduction | General sensor mode selection and low-resolution stream |
| Preview | SDL2 streaming texture, aspect-preserving resize, Escape/window close; optional during recording | Qt/DRM zero-copy preview, overlays; asynchronous Picamera2 preview API |
| Video encoding | Home native JPEG encoder, reusable output capacity, MJPEG/4:4:4 in streaming Matroska | Production H.264/HEVC/AV1, MP4, audio, hardware encoders |
| Recording control | CLI finite frame count, Python Recorder and background start/stop | Circular outputs, split recordings, general encoder/output classes |
| Native raw | Paired raw planes, layout/metadata access | Raw processing arrays in compatibility facade |
| DNG | Uncompressed 16-bit TIFF storage; Bayer 8/10/12/14/16 input, CSI-2 10/12/14 unpacking; per-frame black levels, WB, CCM-derived colour matrix, EXIF exposure | PiSP compressed-raw decompression, dual-illuminant/lab profiles, lens correction/opcodes, thumbnail |
| Familiar Python capture | create_preview/still/video_configuration, configure, start/stop, capture_request/captured_request, capture_array/buffer/metadata/file | Picamera2's complete signatures, jobs/signals/events, request acquire/refcounts |
| Controls | Configuration-time exposure/gain, focus, frame duration, noise reduction; continuous AF when supported | General runtime set_controls, autofocus jobs, AF windows, HDR modes |
| Multiple cameras | Independent camera indices | Synchronization/stereo capture and tuning |

## Python subset example

```python
from zigcamera import Picamera2, MJPEGEncoder

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
    camera.start_recording(MJPEGEncoder(quality=90), "trail.mkv", fps=30)
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

Synthetic tests exercise ownership, role/options validation, native JPEG scan
coding, DNG samples/tags, Matroska demux, frame decode, SDL dummy rendering and
thread ownership, recording shutdown and API compatibility. LibRaw independently
opens/develops generated DNG files. These do not establish physical camera
behaviour, optical quality or Pi frame rates. Pi camera/display validation remains
required. See [performance and hardware acceptance](performance.md).
