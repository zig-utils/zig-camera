# Packed processed RGB streams

Version 0.76 accepts these formats for main and lores, using libcamera names:

| Name | C selector | Memory bytes per pixel |
| --- | --- | --- |
| BGR888 (default main) | ZC_RGB24 = 1 | R G B |
| RGB888 | ZC_BGR24 = 2 | B G R |
| XBGR8888 | ZC_RGBX32 = 3 | R G B X |
| XRGB8888 | ZC_BGRX32 = 4 | B G R X |
| YUV420 (default lores) | ZC_YUV420 = 0 | I420 planes |

These names follow libcamera's little-endian FourCC convention. X is unused
padding, not alpha. Captures converted to RGB, stills and preview ignore X;
PNG never gains transparency from an uninitialized camera padding byte.
Actual hardware must negotiate the requested format or open fails as unsupported.
The Linux bridge supports these requests; a no-camera CI host cannot establish
which formats a particular Pi pipeline/sensor accepts.

```ts
const camera = new Camera({
  width: 1920, height: 1080, format: 'XBGR8888',
  lores: { width: 640, height: 360, format: 'XRGB8888' },
})
const pixels = await camera.captureRGB() // owned tight RGB24
```

`lores.rgb` remains a compatibility alias for BGR888/true or YUV420/false.
A supplied format that conflicts with an explicitly supplied alias rejects
before opening the backend. Unknown format names reject. Default C structure
sizes, enum values 0/1 and existing RGB24 fast paths are unchanged.

`Frame.copyStream` and `copyStreams` preserve the selected raw byte layout and
omit pitch padding. Mapped rows have width times three/four bytes; mapped views
retain existing exclusive fences and detach on close. `copyRGB` returns tight
RGB bytes for every processed format. The Zig borrowed `Frame.rgb()` convenience
continues to require canonical BGR888; use `copyStreamRgb` for converted ownership.
The C external-frame `zc_copy_rgb` now converts all four packed layouts and
rejects truncated input, output and non-identity overlap before writing.

Still capture, Exif/ICC and temporary-mode capture use a checked canonical RGB
selection. BGR888 rows are borrowed; the other layouts allocate one explicit RGB
buffer for the duration of conversion/encoding. Existing I420 conversion is
unchanged. The Home `packed_rgb` helper validates strided spans without assuming
final-row padding; no camera/platform ownership is copied into that helper.

Recording accepts main or lores through MJPEG, AVC and HEVC. Async producers copy
the actual tight source layout, so bounded admission and high-water accounting
charge RGBX/BGRX at four bytes per pixel. Workers convert through a reused
per-recorder RGB scratch buffer before codec input. Synchronous writes convert
while the caller retains its lease. Color admission still requires matching
primaries/transfer and full-range RGB; a byte-layout conversion is not gamut or
gamma conversion. Encoding, output and cancellation ownership rules are unchanged.

SDL converts packed sources directly into the locked RGB texture with checked
pitch and joined unlock on error. The BGR888 path continues borrowing native RGB
rows. Headless/SDL selected-source state, async mode workers, coordinated recording
mode changes and fresh-camera recording recovery retain the requested format.
PiSP/VC4 configuration alignment selects the existing wide-pixel recipe for
four-byte layouts. Odd RGB extents are supported; video codec dimensions keep
their existing even/minimum restrictions.

CLI `--main-format` and `--lores-format` accept the five names in the table.
Capture lores sidecars use `.lores.rgb`, `.lores.bgr`, `.lores.rgbx`,
`.lores.bgrx` or `.lores.i420` according to actual layout, and JSON records the
negotiated name and stride. Images and recording sources are independently
selected with `--image-stream` and `--record-stream`.

Tests cover independent still decoding, byte-for-byte canonical encoder input,
zero X, padded/unaligned/truncated spans, overlap, exclusive mapped ownership,
source mutation/release after producer submission, actual queue bytes, mixed
codec input layouts, exact-color SDL readback, odd/oriented extents, strict color,
mode restoration, coordinated sessions, fresh recovery, C ABI and CLI sidecars.
Linux CI additionally decodes AVC/HEVC through independent decoders and builds and
loads the real backend on x86/ARM. These are software/ownership results; physical
Pi format acceptance, DMA stride/color, latency and throughput remain unmeasured.
