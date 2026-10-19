# zig-camera

A native Zig capture library and CLI for Raspberry Pi 5, backed by libcamera.
Designed to reduce application CPU overhead and frame copies while retaining
Raspberry Pi's ISP and camera tuning. Early development: hardware performance
and image quality have **not yet been measured**. This is not a drop-in Picamera2
replacement or a claim of feature parity.

- Reusable libcamera requests and persistently mapped DMA-BUF planes.
- Bounded FIFO/latest-ready queues with explicit, generation-checked frame leases.
- DMA-BUF CPU read synchronization; stop preserves outstanding leased mappings.
- Processed RGB, optional paired native raw stream, exposure/gain/focus controls.
- Lossless PPM and native JPEG with 4:4:4 sampling; capture metadata sidecars.
- Zig, C and Python interfaces; deterministic synthetic backend for development.
- Stride-aware portable SIMD luma adapted from Home, with MIT attribution.

New in 0.17: bounded async output lifecycle jobs, fixed-prefix drain jobs that
survive recorder shutdown, and close jobs that retain callbacks through cleanup.
Retired async outputs stop off the capture thread, and split jobs include their
hook completion. Reuses Home's FIFO completion watermark and existing media
codecs/containers. No FFmpeg.
[Output objects and PTS](docs/output-objects.md),
[async snapshots and delayed A/V](docs/async-delayed.md), [coverage and gaps](docs/parity.md).

## Build on Raspberry Pi OS (64-bit)

Install **Zig 0.15.2** and the system libraries matching your Raspberry Pi OS image:

```sh
sudo apt update
sudo apt install build-essential libcamera-dev libsdl2-dev libx264-dev libx265-dev pkg-config
zig build -Dpreview=true -Dcodecs=true -Doptimize=ReleaseSafe
./zig-out/bin/zig-camera info
./zig-out/bin/zig-camera capture --output photo.jpg --warmup 60
# Default size comes from libcamera's still configuration. Inspect `info` first.
./zig-out/bin/zig-camera capture --raw --output photo.ppm
./zig-out/bin/zig-camera capture --output photo.dng --warmup 60
./zig-out/bin/zig-camera preview --width 1280 --height 720 --frames 0
./zig-out/bin/zig-camera record --width 1280 --height 720 --fps 30 --frames 300 --output trail.mkv
./zig-out/bin/zig-camera record --codec h264 --width 1920 --height 1080 --fps 30 --bitrate 12000000 --gop 60 --output trail.mp4
./zig-out/bin/zig-camera record --codec hevc --width 1920 --height 1080 --fps 30 --quality 90 --gop 60 --output trail-hevc.mp4
```

JPEG defaults to quality 98 and no chroma subsampling. PPM is lossless 8-bit
processed RGB, not sensor raw. `--raw` writes paired native planes to
`photo.ppm.raw.N` and records their negotiated layout in `photo.ppm.json`.
Native raw plane dumps stay in their negotiated format. `.dng` output negotiates
uncompressed Bayer and writes calibrated metadata with streamed sample conversion.
When available, ISP noise reduction uses the HighQuality still-image policy;
this can limit frame rate and is matched in the Picamera2 comparison.
Manual exposure requires both `--exposure-us` and `--gain`. Autofocus runs
continuously when available; `--lens` requests manual focus in dioptres.
Configuration may be adjusted by libcamera; always inspect negotiated geometry.

## Develop without a camera

```sh
zig build test -Dlibcamera=false -Djpeg=false
zig build -Dlibcamera=false -Djpeg=false -Doptimize=ReleaseSafe
./zig-out/bin/zig-camera capture --simulate --width 640 --height 480 --output test.ppm
zig build bench -Dlibcamera=false -Djpeg=false -Doptimize=ReleaseFast
PYTHONPATH=python python3 -m unittest discover -s tests -v
```

Synthetic output requires explicit `--simulate`; synthetic timing is not camera
FPS. The Linux backend is selected by default on Linux, synthetic on macOS.
Home native JPEG and MJPEG recording build without external codec dependencies.
`-Djpeg=true` optionally selects system libjpeg for still-image acceleration.
`-Dpreview=true` enables SDL2 windowed preview; `-Dvideo=false` disables recording.
`-Dcodecs=true` enables Home’s AVC/HEVC adapter and links libx264/libx265 directly.
Without it those codecs fail explicitly. MP4 is streamed as fragments; bitrate
is bits/sec (0 selects CRF), and quality 1..100 maps to CRF 51..0 (AVC minimum 1). This currently
supports 8-bit SDR 4:2:0 software encoding. Optional ALSA PCM A/V uses Matroska;
Add `-Daac=true` for AAC MP4; Pi hardware encoding remains unsupported.
The real backend builds natively using the system C++ compiler (`CXX` may select
an alternate compatible compiler). Cross-compiling the synthetic core is supported;
real libcamera builds require the target system's matching headers and runtime.

## Ownership

```zig
const camera = @import("camera");
var config = camera.defaultConfig();
config.width = 1920;
config.height = 1080;
const cam = try camera.Camera.init(config);
defer cam.deinit() catch unreachable;
try cam.start();
defer cam.stop() catch unreachable;
var frame = try cam.acquire(5000);
defer frame.release() catch unreachable;
const rgb = try frame.rgb(); // borrowed RGB bytes, with row stride
_ = rgb;
```

A frame lease keeps its camera buffers out of circulation. Release it exactly
once, after every CPU/GPU/device user has finished. Views and borrowed file
descriptors expire on release. Stop preserves leases; close and restart refuse
outstanding leases. Holding every buffer stalls capture rather than allocating
more memory. `latest` drops older *ready* frames at acquisition, never a leased
frame; `--fifo` preserves ready order. Lifecycle calls/close require caller
serialization; frame acquisition/release/stats may run on separate threads.

## Python

```python
from zigcamera import Camera

with Camera(width=1920, height=1080) as camera:
    camera.start()
    for _ in range(30):
        with camera.acquire():
            pass  # Let exposure, white balance and autofocus settle.
    with camera.acquire() as frame:
        frame.save_jpeg("trail.jpg", quality=98)
        with frame.plane() as rgb_bytes:
            print(rgb_bytes[0])  # Read-only borrowed view, includes row padding.
        owned_rgb = frame.copy_rgb()  # Explicit tightly packed copy.
```

Install the Python wrapper with `python3 -m pip install .` after building the
shared library, or set `PYTHONPATH=python`. Set `ZIG_CAMERA_LIBRARY` to the
installed `libzigcamera.so` if it is outside the system library search path.
NumPy is optional: `frame.numpy()` returns an owned array and
`frame.mapped_array()` borrows one inside a context. Borrowed views must not
escape the frame lease. Use `Camera(simulate=True)` with synthetic builds.

See [C ABI](include/zig_camera.h), [architecture](docs/architecture.md),
[benchmarks](docs/performance.md), [Home reuse audit](docs/home-reuse.md), and
[Pi 5 camera selection](docs/hardware.md).

## Scope

Implemented: single-camera still/continuous capture, paired processed/raw streams,
frame leases, selected controls, metadata, JPEG/PPM/DNG, SDL preview, Home MJPEG/MKV,
optional Home AVC/HEVC/MP4 recording, typed runtime controls, autofocus jobs,
async preview, and a Picamera2-style Python subset.
Remaining: AV1, additional audio codecs, hardware encoding, overlays/DRM/Qt preview, complete
Picamera2 API signatures, stereo sync, HDR controls, and arbitrary vendor controls.
Keep Picamera2 for those features until equivalent paths are implemented and
validated. Sensor mode, lens, lighting and ISP tuning dominate image quality;
removing Python does not add sensor detail or raise sensor frame-rate limits.
