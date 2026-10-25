# Owned image compositing

Version 0.119 adds `CapturedImage.composite` and `compositeAsync`, backed by the
shared Home integer raster compositor. Both create an independent straight RGBA
image with the background's dimensions. Inputs remain unchanged and may be the
same image. Native 16-bit low samples and explicit endian survive composition;
8-bit expansion preserves samples without inventing additional precision.

```ts
using background = await camera.captureImage()
using mark = CapturedImage.fromRaster({
  data: watermarkRgba, width: watermarkWidth, height: watermarkHeight,
  format: 'rgba', colorSpace: background.colorSpace,
})
using result = await background.compositeAsync(mark, {
  x: 12, y: 12, opacity: 0.75, signal,
})
await result.saveAsync('marked.png', { format: 'png' })
```

Signed 32-bit `x`/`y` offsets clip the overlay, including negative positions and
fully outside rectangles. `blend: 'over'` is straight-alpha source-over. `source`
replaces the clipped region; source RGB survives even at zero alpha. Opacity is
0..1, rounded once to a 0..65535 coverage multiplier. Color and alpha each round
only at their final integer result, rather than rounding effective alpha first.
A zero-coverage OVER source preserves the destination, including hidden RGB.

Output `bits` defaults to the greater input depth; explicit 16-to-8 reduction
keeps high bytes. `endian` defaults to the background's order. The result retains
its background's declared color description and capture provenance; provenance
identifies that source capture, not an unmodified sensor image. Overlay metadata
is not merged into it. PNG preserves RGBA/native words; other encoders keep their
existing format/alpha policies.

Samples blend in their encoded space. This operation does not apply ICC,
transfer or gamut conversion. `colorPolicy: 'requireSame'` compares the images'
declared `colorSpace` fields, including known vs unknown; mismatches reject.
`assumeSame` explicitly lets callers establish a common interpretation outside
this operation. ICC bytes held separately by decoded containers are not converted
or inferred as declarations on an image. Unspecified descriptions stay unknown.

The synchronous C API borrows both inputs and validates options, full spans,
output capacity, output/source overlap and its 256 MiB result ceiling before
pixel writes. It queries size with NULL/0. The Home kernel allocates nothing;
Bun allocates one result. Signed offsets and AUTO/8/16-bit selection are explicit
in the additive 32-byte `zc_raster_composite_options` ABI.

Async admission copies both tight logical rasters before returning; padding is
excluded. Closing either source or the source camera immediately is safe. The
operation uses existing image jobs, four-owner/512 MiB shared admission and
input/output/working limits (defaults 64/64/128 MiB, each at most 256 MiB).
Composition workspace contains only its result. Native cancellation checks occur
at most 1024 pixels apart and at every row; the job joins its worker before
retiring copied inputs/reservations. Cancelled partial results never publish.
Bun deadlines, pre-abort, completion callbacks and cleanup use `BunJob` semantics.

Zig callers can use `ImageComposite.copied` directly or
`compositeImageAsync(base, overlay, options, limits)`. The latter returns the
existing image-job owner; `takeBlob` contains tight raw RGBA, not encoded image
bytes. C callers use `zc_raster_composite[_async]` and the same shared job API.

Validation includes independent exact u256 rational source-over equations,
every 8-bit alpha pair, sampled word/opacity boundaries, APNG disposal regression,
allocation failure, signed clipping, endian/low bits, invalid late spans,
output quarantine, copied two-input jobs, cross-operation admission, cancellation,
parent closure/provenance and PNG roundtrips. Software composition does not prove
physical Pi performance, GPU composition or full image/Picamera2 parity.
