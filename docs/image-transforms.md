# Exact owned-image transforms

Version 0.99 adds `CapturedImage.transform`, `rotate`, `flip` and `transpose`, the
borrowed C `zc_raster_transform` operation, and Zig `ImageOrthogonal`. They reuse
Home's checked orthogonal pixel copies and its existing orientation geometry.
These are physical pixel permutations. No sample interpolation, byte-depth
conversion, gamut/transfer change, alpha compositing or guessed camera rotation
is performed.

```ts
using photo = await camera.captureImage()
using portrait = photo.rotate(90) // clockwise
using mirrored = portrait.flip('horizontal') // also 'vertical' or 'both'
using transposed = mirrored.transpose() // main diagonal
using combined = photo.transform({
  rotation: 270, hflip: true, vflip: false, transpose: true,
})
await combined.saveAsync('portrait.tiff')
```

`transform` rotates clockwise, applies flips in the rotated output axes, then
optionally transposes. It supports rotation 0/90/180/270 and boolean flags. The
same native Home geometry already used by preview resolves all combinations.
Options are read once before checking that the source remains open; getters
cannot close an image and leave a stale pointer in use. Malformed values reject
without numeric/boolean coercion. `rotate` requires an angle; `flip` defaults to
horizontal. `transform()` returns an independent identity copy, including for
single-pixel images. All methods leave the original owner intact.

Gray/RGB/RGBA, 8/16-bit samples, either word order and straight alpha are retained
byte-exactly. Results have compact rows; transposed operations exchange width and
height. Colors, low words and alpha are not routed through an eight-bit accessor.
Source color interpretation and immutable original request metadata remain as
provenance; transforming pixels does not rewrite sensor/crop/focus controls or
pretend a different negotiated camera orientation occurred. Encode/save use the
new pixel dimensions. Explicit Exif remains caller-selected; orientation numbers
must not be applied again to already transformed pixels.

Images from local/retained/scoped captures, remote/process frames and ordinary,
focus-locked or temporary-mode image jobs expose the same owned operations. A
result survives source/camera closure and can be cropped, resized, encoded, saved
or delivered through existing async image outputs. Transform copies themselves
are synchronous and retain no request, camera, DMA buffer or borrowed native
pointer. Each result is limited to the existing 256 MiB raster bound and disposed
by its caller, like clone/crop/convert results. General-angle rotation, affine
resampling, compositing and decoded image formats remain separate parity work.

C accepts orientation 1..8 from `zc_orientation_from_transform`; 5..8 exchange
width/height. Query with NULL/0 to obtain the compact byte count, then provide a
disjoint destination. Invalid geometry/orientation leaves length zero; valid
queries or short destinations report the required count. Short, invalid and
all overlapping spans reject before any prefix write. The source is borrowed
only during the call. No public struct layout or descriptor wire version changes.
Zig callers can use `ImageOrthogonal.info/into/copy` over `ImagePixels.View` and
`ImageTransform`; the low-level allocator API leaves application limits to callers.

Home's existing Image rotate/flip methods are improved too: allocating transforms
now deep-copy indexed palettes and animation frames, move frame rectangles with
the canvas, and retain timing/disposal/blend/loop state. In-place flips preserve
native words and check all frame geometry before mutation. Dedicated test roots
exercise these APIs rather than silently skipping lazy module tests.

Validation covers all eight transformations and all composed option combinations,
odd/rectangular/singleton geometry, padding/unaligned/endian/native word/alpha
samples, failure-before-write, source disposal, capture-mode and actual process
ownership, independent C coordinate/sample references, and RGB16 PNG/TIFF decoding.
Home's portable tests run both Zig compilers/modes; the consumer matrix also checks
out the exact upstream Home commit to run its Image/palette/animation tests on the
development compiler across Linux ARM64/x86-64 and macOS. Physical camera quality,
performance, complete image semantics and full Picamera2 parity remain open.

Local 0.99 validation passes 475 ReleaseSafe native tests, all 1,602 Bun tests with
Home codecs/containers, SDL dummy preview and independent media readers, and all
six C ABI/ownership executables (including 96 direct transform cases). Formatting,
TypeScript and workflow YAML checks pass. The independent local RGB16 decoder's
missing libpng runtime path was corrected before the complete passing run; the
initial diagnostic log is retained. Home's standalone portable, public Image,
animation/allocator and independent 480-case reference checks pass locally.
The normal local Zig build runner still fails before project compilation at
macOS SDK/libSystem linkage; target-qualified direct native builds pass. Platform
CI remains separate evidence, including the exact upstream Home Image tests.
