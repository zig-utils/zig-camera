# Preview, Home video and DNG

## Preview

Build with `-Dpreview=true` and install `libsdl2-dev`. The SDL adapter uses one
streaming RGB texture and copies active pixels row-by-row while respecting both
camera and texture pitch. It releases the lease after uploading/rendering. All
SDL operations run on the creating main/UI thread; an alternate-thread call
returns a state error. The renderer prefers acceleration/vsync and falls back
to software. Preview therefore adds a texture upload; it is not a DMA-BUF import
or a zero-copy DRM implementation. Resize preserves aspect ratio. Escape or
window close exits the loop.

```sh
zig build -Dpreview=true -Doptimize=ReleaseSafe
./zig-out/bin/zig-camera preview --width 1280 --height 720 --frames 0
./zig-out/bin/zig-camera record --preview --output trail.mkv --frames 900 --fps 30
```

## Video

The default recorder uses Home code only: native baseline JPEG with a real DCT,
quality-scaled quantization, Huffman/RLE entropy scan and byte stuffing, followed
by a streaming Matroska writer adapted from Home's EBML/track layout. Every frame
is intra-coded 4:4:4 MJPEG. One JPEG encoder/output buffer is reused; clusters are
written directly to a file rather than retaining all recording packets. The
stream has an unknown segment length and no accumulated cue index; it can be
read sequentially without a final whole-file assembly.

Capture timestamps set cluster times relative to the first frame at 1ms precision;
gaps remain gaps. Track DefaultDuration records the nominal requested FPS. Out-of-order
or repeated nanosecond timestamps are rejected. Real sensor FPS can differ from
the request. Synthetic CLI recording supplies a deterministic nominal timeline.
There is no FFmpeg build or runtime dependency. `-Dvideo=false` can omit recording;
Home still JPEG/DNG remain available. `-Djpeg=true` is an optional pre-existing
system JPEG acceleration path for stills; native Home JPEG is the default.

```sh
./zig-out/bin/zig-camera record --width 1920 --height 1080 --fps 30 --quality 90 --frames 300 --output trail.mkv
```

This does not implement H.264/HEVC, rate-controlled bitrate, MP4 or audio. Asking
for those codecs/containers fails; it never silently changes the requested codec.
MJPEG bitrate and Pi CPU cost can be substantial. No sustained Pi 5 FPS claim is
made without real-camera measurements. Home's existing H.264/HEVC pure Zig paths
contain placeholder slice data, and its x264 wrapper hand-declares a version-sensitive
C structure. They were inspected but not advertised as production encoders.

## DNG

```sh
./zig-out/bin/zig-camera capture --output trail.dng --warmup 60
```

The CLI automatically adds raw capture and asks for uncompressed Bayer. DNG
requires all of libcamera's SensorBlackLevels, ColourGains and
ColourCorrectionMatrix metadata. Missing/singular/nonfinite calibration is an
error, not an invented identity camera profile. The per-frame colour transform
is `inverse(sRGB_to_XYZ * CCM * diag(WB))`, following the general approach in
[Raspberry Pi's DNG implementation](https://github.com/raspberrypi/rpicam-apps/blob/main/image/dng.cpp).
This is an ISP/CCM-derived single-illuminant rendering profile, not a laboratory
camera characterization or a promise of Adobe/rpicam visual equivalence.

Bayer samples are unpacked one row at a time to 16-bit little-endian TIFF storage.
White level retains the source depth; black levels are scaled from libcamera's
16-bit normalization and reordered into the actual CFA. DNG includes CFA pattern,
active area, camera model, as-shot neutral, colour matrix and exposure time. Only
row scratch space and a bounded directory are allocated. Files use atomic rename
so failed conversion preserves an existing destination. Classic TIFF is limited
to 4GiB. PiSP compressed formats are rejected; select uncompressed raw instead.

Independent tests use Pillow for JPEG, libmatroska/MKVToolNix for container demux,
TIFF readers for exact Bayer samples/tags, and LibRaw for DNG recognition/development.
Real camera calibration, autofocus, display backends and long recording runs
still need Pi acceptance testing.
