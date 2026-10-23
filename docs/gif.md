# GIF still capture

Version 0.83 adds `ZC_IMAGE_GIF`, case-insensitive `.gif` inference and Bun
`format: 'gif'`/`'GIF'` throughout retained-frame encoding/saving, owned-byte and
file captures, focus-locked capture, temporary modes and file series. CLI capture
accepts `.gif` or `--image-format gif`. The existing image-options ABI remains
20 bytes; GIF is an additive format value 7. ICC and Exif remain unsupported for
GIF and reject at admission. Raw streams require DNG rather than GIF.

All processed main/lores byte RGB, RGB16, planar/semi-planar YUV420 and packed
YUV422 inputs reuse the existing checked stream selection/conversion. RGB16 GIF
explicitly reduces to high bytes. GIF output is an adaptive palette of at most
256 colors: sparse inputs can be exact, while photographic colors are quantized.
There is no dithering, general color-space conversion or lossless photographic
quality claim. PNG/TIFF support higher precision. Physical camera formats, optics,
quality and throughput remain hardware validation work.

Public Zig `GifEncoder` also accepts checked borrowed `raster.View` gray/RGB/RGBA
rows, 8/16 bits, explicit endian and padding. Unassociated RGBA uses high-byte
alpha below 128 as transparent by default; `alpha_threshold=0` makes every pixel
opaque. Partial alpha cannot survive GIF. Transparent pixels do not bias the
opaque palette, and all-transparent images are supported. `max_colors=2..256`
includes a reserved transparent entry when needed.

Home's checked GIF encoder, weighted bounded palette and dictionary LZW are
reused verbatim. Preparation needs at most a 1 MiB histogram, 768 palette bytes,
one width-sized index row and bounded stack state, plus encoded output. Canonical
RGB rows need no additional full RGB/indexed copy; other capture layouts use the
existing selected-stream conversion owner. No source/sink pointer survives a Zig
encoding call. The streaming `write` entry observes optional row/palette-phase
sink checkpoints and leaves rollback to its caller; `encode` owns and publishes
only complete bytes. Existing camera still encoding remains synchronous on its
capture owner. Scheduled captures are asynchronous jobs; this is not a new
background GIF compression worker.

Ordinary and focus-locked file captures now stage through the existing native
file owner, correcting early publication discovered by GIF regression tests.
Post-callback failure, accepted cancellation, deadline expiry and CAF restoration
failure preserve the previous destination. Completion observes joined native
disposal, and stop/close wait through a claimed publication. Temporary-mode and
series files retain their existing staged restoration rules. Direct synchronous
frame saves still atomically replace during that explicit call. See
[staged-files.md](staged-files.md).

Test-only giflib independently checks 252 borrowed-raster fixtures per pinned/
development Zig Debug/ReleaseSafe build. It validates source retirement,
gray/RGB/RGBA, 8/16-bit endian/stride reduction, transparency, palette samples and
declared dense-cube quantization error. Bun checks every processed main/lores
format against copied request pixels after camera teardown; CLI checks cover
RGB8, RGB16, NV21 and packed422. Native and C tests check format dispatch and
owned blobs after request/camera release. Image-option metadata rejection and
ordinary/focus file rollback/reuse/deadline/late-claim tests cover admission and
publication. These are synthetic software results, not measured Pi performance.

Home's Image API additionally reuses the checked encoder, fixes the old
equal-luminance palette collision and 16-bit/alpha handling, and shares validated
indexed expansion with PNG. Nonempty Image animation frames explicitly reject
instead of being silently discarded. General Image animation/compositing,
decoded image-object equivalents, background GIF compression jobs and physical
acceptance remain open. The broader Picamera2 parity goal is not complete.
