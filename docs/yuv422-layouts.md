# Packed YUV 4:2:2 streams

Version 0.78 accepts YUYV, YVYU, UYVY and VYUY main/lores streams. All require
positive even width and a YCbCr matrix. Capture, preview and still encoding accept
odd height; AVC/HEVC recorder geometry retains its even-height/minimum rules.
Libcamera must negotiate the requested format; physical Pi support is unmeasured.

| Name | C selector | Four bytes per horizontal pair |
| --- | --- | --- |
| YUYV | ZC_YUYV = 8 | Y0 U Y1 V |
| YVYU | ZC_YVYU = 9 | Y0 V Y1 U |
| UYVY | ZC_UYVY = 10 | U Y0 V Y1 |
| VYUY | ZC_VYUY = 11 | V Y0 U Y1 |

Each stream has one packed plane. Mapped `row(y)` returns width times two active
bytes without padding; nonzero components reject. `copyStream` and bundles retain
physical byte order, while `copyRGB` returns converted tight RGB24. Pitches may
be padded/unaligned and final row padding may be absent. Malformed spans and odd
width reject before output writes; size-query failures preserve the output count.
Mapped/retained ownership, DMA fences and detached-view rules are unchanged.

Home's checked packed-422 view decodes pair chroma once for its two luma samples.
RGB encoding averages both contributors before rounding chroma. Source/output
bounds and overlap are checked before writing; alpha from packed RGB output is
opaque. Still-image and temporary/focus capture paths borrow canonical RGB or
use one explicit conversion buffer. JPEG/PNG/BMP/TIFF/PPM, ICC and Exif continue
through the existing checked image admission and metadata paths.

Synchronous and bounded async recording accept packed 422 main or lores. Producer
jobs preserve packed bytes and charge two bytes per pixel, with no camera lease
held while output work waits. Workers decode MJPEG input to RGB, or remap directly
to planar codec I420 without RGB scratch storage. I420 chroma uses the average of
the two adjacent source rows, rounded half up, before matrix/range transformation.
Luma transformation uses each source row's own chroma. This is an explicit box
sampling policy; arbitrary resampling and gamut/transfer conversion remain work.

```ts
const camera = new Camera({
  width: 1920, height: 1080, format: 'YUYV',
  lores: { width: 640, height: 360, format: 'UYVY' },
})
const rgb = await camera.captureRGB()
```

Headless/SDL preview, async temporary modes, coordinated recording modes and
fresh-camera recording recovery preserve the selected layouts. SDL decodes into
its checked locked RGB texture, with joined unlock on failure. PiSP/VC4 planning
uses the base packed-pixel alignment recipe. Actual backend geometry and color
remain queried rather than inferred from planning labels.

CLI `--main-format` and `--lores-format` accept all four names; image, recording
and preview stream selections remain independent. Raw lores sidecars use
`.lores.yuyv`, `.lores.yvyu`, `.lores.uyvy` and `.lores.vyuy`. JSON records actual
format and stride. Existing C structure sizes and selectors 0..7 remain stable.

Home public packed output previously fell through without initializing bytes;
RGB-to-packed conversion now writes complete pairs. Shared Home paths cover
packed RGB encode/decode, byte repacking and packed-to-I420. Other Home conversion
routes retain their previous behavior; no universal conversion-matrix guarantee
is inferred from the corrected paths.

Tests use independent byte/color expectations, alternating chroma on adjacent
rows, odd-height raw/still captures, padding/truncation/overlap, source overwrite
after producer admission, queue bytes, all three codecs, mode/recovery, C ABI,
SDL matrix/range readback and CLI comparisons. Linux CI supplies independent
video decoding and real-backend compile/load/no-camera cleanup on ARM and x86.
Physical format acceptance, sensor color, Pi throughput and optical quality
still require attached-camera measurements.
