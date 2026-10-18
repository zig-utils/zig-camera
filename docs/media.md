# Preview, Home video and DNG

## Preview

Build with `-Dpreview=true` and install `libsdl2-dev`. The SDL adapter uses one
streaming RGB texture and copies active pixels row-by-row while respecting both
camera and texture pitch. It releases the lease after uploading/rendering. All
SDL operations run on the creating main/UI thread; an alternate-thread call
returns a state error. The renderer prefers acceleration/vsync and falls back
to software. Preview therefore adds a texture upload; it is not a DMA-BUF import
or a zero-copy DRM implementation. Resize preserves aspect ratio. Escape or
window close exits the loop. The 0.4 `start_preview()` process wrapper provides
async display with a bounded shared slot and nonblocking publication; see
[controls/jobs/async preview](controls.md).

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
the request. Synthetic CLI/background recording supplies a deterministic nominal timeline.
There is no FFmpeg build or runtime dependency. `-Dvideo=false` can omit recording;
Home still JPEG/DNG remain available. `-Djpeg=true` is an optional pre-existing
system JPEG acceleration path for stills; native Home JPEG is the default.

```sh
./zig-out/bin/zig-camera record --width 1920 --height 1080 --fps 30 --quality 90 --frames 300 --output trail.mkv
```

### H.264 / HEVC / MP4 (0.3)

Build with `-Dcodecs=true`, using `libx264-dev` and `libx265-dev`. The reusable
Home `native_encoder` module wraps a small C adapter compiled against the actual
vendor headers. It replaces unsafe assumptions about x264/x265 structure layouts
in the legacy Home integrations. Neither the adapter nor the container calls
FFmpeg, Libav or an external encoder process. libx264/libx265 are direct optional
codec dependencies; their GPL/commercial licensing applies independently of the
MIT Home/zig-camera source.

Home's new `mp4_stream` writer adapts its existing MP4 box/fragment conventions,
with a complete video sample description, avcC/hvcC generated from real encoder
parameter sets, mvex/trex, accurate fragment sizes and data offsets, 64-bit tfdt,
and sync/non-sync sample flags. Each encoded access unit is a moof/mdat fragment.
No file-sized media buffer, growing sample table or final rewrite is needed.
There is no global seek index or audio track; compatibility is with fragmented
MP4 readers, not every older flat-MP4-only player.

```sh
zig build -Dpreview=true -Dcodecs=true -Doptimize=ReleaseSafe
./zig-out/bin/zig-camera record --codec h264 --width 1920 --height 1080 --fps 30 --bitrate 12000000 --gop 60 --output trail.mp4
./zig-out/bin/zig-camera record --codec hevc --width 1920 --height 1080 --fps 30 --quality 90 --output trail-hevc.mp4
```

Both codecs use 8-bit I420 software encoding, veryfast preset, one frame thread,
no B frames/lookahead, and closed GOPs. H.264 uses High profile; HEVC uses Main
with fixed CTU16 across instances. RGB byte order/row stride are respected. Home
converts to limited-range BT.601 I420 with actual 2x2 averaged chroma; VUI and
MP4 nclx signal sRGB transfer, BT.709 primaries and BT.601 matrix. This is an SDR
conversion, not HDR preservation. Dimensions must be even and at least 16.

`bitrate` is bits/sec, >=1000; nonzero selects average bitrate (not a hard CBR
ceiling). Zero selects CRF: quality 1..100 maps linearly to CRF 51..0 (AVC minimum 1). GOP zero
means 60; scene-cut keyframes are disabled to respect the configured interval.
This API does not expose general encoder preset/profile/level or 10-bit modes.

AVC's VFR path retains one input for rate control. The recorder retains one
encoded packet to derive duration from the next output timestamp. Encoder output
is drained on close; the last sample uses nominal duration. Input leases can be
released immediately after write. Capture timestamps become relative microseconds
(PTS=DTS); gaps remain gaps. Repeated/backward times, sub-microsecond advancement
and gaps beyond the 32-bit microsecond sample-duration limit are rejected. Empty
recordings contain an initialization segment with no media samples.

Home's legacy pure-Zig H.264/HEVC slice encoders still contain placeholders and
are not used here. No sustained Pi 5 FPS or compression-quality advantage over
Picamera2 is claimed without hardware measurements. Software HEVC can be costly.

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

0.7 adds optional lossless PCM audio capture and synchronized Matroska A/V;
see [audio, synchronization and rotation](audio-rotation.md). 0.8 adds [AAC-LC in MP4](aac-mp4.md).
