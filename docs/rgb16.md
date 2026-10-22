# RGB16 processed streams

Version 0.79 accepts BGR161616 and RGB161616 main/lores formats. Both contain
three little-endian unsigned 16-bit words per pixel. Width and height may be odd
for capture/stills/preview; existing even-size/minimum recording rules remain.
Libcamera must negotiate the requested name; an older SDK without that format
returns unsupported. Physical Pi format/bit-depth acceptance remains unmeasured.

| Libcamera name | C selector | Memory word order | Raw lores suffix |
| --- | --- | --- | --- |
| BGR161616 | ZC_RGB48 = 12 | R16 G16 B16 LE | .lores.rgb48le |
| RGB161616 | ZC_BGR48 = 13 | B16 G16 R16 LE | .lores.bgr48le |

The apparent name reversal follows libcamera's little-endian FourCC convention.
The [current Raspberry Pi libcamera mapping](https://github.com/raspberrypi/libcamera/blob/c682979b50695b93526adb1e66db33743484b63b/src/libcamera/formats.cpp)
and [DRM definitions](https://github.com/raspberrypi/libcamera/blob/c682979b50695b93526adb1e66db33743484b63b/include/linux/drm_fourcc.h)
were checked at the linked revision. No byte-order guess derives from a label.

Mapped `row(y)` returns width times six active bytes in physical order;
`copyStream`, capture bundles and async producer jobs retain those words exactly.
Use DataView with explicit little endian when mapping. Ownership, writable-map
exclusion, detached views and DMA synchronization follow existing frame rules.
Padded/unaligned pitches and an absent final row's padding are checked safely.

`Frame.copyRGB16(stream?)` returns owned canonical RGB Uint16Array words.
`Camera.captureRGB16` and `captureRGB16Async` provide capture jobs with the same
copy; non-RGB16 input rejects rather than inventing precision. C callers use
`zc_copy_rgb16` for a caller-owned external descriptor or lease-checked
`zc_copy_stream_rgb16` for main/lores; outputs are tight RGB16 LE bytes.
The Zig frame exposes `copyStreamRgb16`. Buffers remain valid after source release.
All C structure sizes, existing selectors and existing function signatures stay
stable. Canonical identity copying is a no-op; other overlap rejects before writes.

PNG and TIFF preserve every sample through Home's existing raster encoder,
including ICC/Exif insertion. PPM emits maxval 65535 and big-endian words.
JPEG, BMP, `copyRGB`, SDL preview and current MJPEG/AVC/HEVC recording deliberately
select each sample's high byte (sample >> 8). No dithering, gamma transform,
10/12/16-bit video codec or gamut conversion is implied. HDR/raw Bayer remains
separate from these processed RGB streams, as does DNG calibration.

RGB16 recording reuses the existing codec worker RGB8 scratch; bounded producer
queues charge six physical bytes per pixel and retain all low bits until the
worker consumes them. No camera lease is held during queued output I/O. Temporary
modes, coordinated recording modes and fresh-camera recovery retain formats.
PiSP/VC4 planning uses the existing wide-format alignment recipe, with actual
negotiation reported separately.

`--main-format` and `--lores-format` accept both names. Existing image, preview
and recording stream selectors remain independent. CLI JSON records format and
stride, and raw lores sidecars retain physical word order.

`src/home/rgb16_view.zig` is the verbatim checked Home image helper. It handles
word/layout conversion and explicit reduction with complete source/destination
preflight and no allocation. Home OS's framebuffer RGB565 and VideoCore gamma
paths have different sample layouts and ownership, so they are not copied here.

Tests vary low and high bits independently; verify all word/endian pairs,
unaligned/truncated/overlapping spans, mapped/owned lifetime, metadata, files,
preview texture pixels, physical queue bytes after source overwrite, all three
codecs, modes and recovery. Linux CI adds independent libpng/libtiff raw16 and
OpenH264/libde265 decoding plus real libcamera compile/load/no-camera cleanup on
x86 and ARM. Synthetic generated gradients expand an 8-bit pattern; precision
tests replace those words with deliberate full-range values. No sensor precision,
optical quality, hardware acceleration or performance result is inferred.
