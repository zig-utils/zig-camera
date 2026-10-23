# Owned image resizing

Version 0.85 reuses Home's checked native-precision resampler. Bun images expose
`resize(width, height, { resample })`, producing independent compact pixels in
the same gray/RGB/RGBA format, depth and byte order. Source pixels, color
interpretation and provenance remain unchanged. A resized image retains the
original scalar `sourceMetadata`; its sensor crop describes the original
capture, while width/height describe the resized image.

```ts
using image = await camera.captureImage({ stream: 'main' })
await camera.close()
using thumbnail = image.resize(640, 360, { resample: 'lanczos3' })
await thumbnail.saveAsync('thumbnail.png')
```

`Frame.makeImage`, scoped request `makeImage`, `captureImage[Async]` and
`captureFocusLockedImage[Async]` also accept optional width, height and resample.
An omitted dimension keeps that source dimension. Dimensions are positive
integers; invalid dimensions/filter names reject explicitly. Properties are
snapshotted before request/native access; async jobs do not reread caller
getters. Explicit source-sized capture returns the first owned copy without a
redundant resize. Other sizes copy the request pixels and then resize them;
configuring main/lores at the required size avoids this software work. Resizing
is synchronous on the owner thread, including inside an async capture job; it
is not a background resampling worker. Existing selection, callback, cancellation,
deadline and focus-restoration/discard semantics still apply.

Filters are `nearest`, `bilinear`, `bicubic`, `lanczos2` and `lanczos3`. The default
is Home's Mitchell-Netravali bicubic (B=C=1/3), explicitly distinct from Pillow's
cubic kernel. All filters use pixel-center coordinates; filtered reductions
widen the window and normalize in-bounds weights. Nearest and unchanged geometry
preserve exact source samples. Filtered output rounds once at native 8/16-bit
precision and saturates; word sources do not pass through eight-bit storage.
RGBA filtering premultiplies during interpolation and returns straight alpha,
so hidden transparent RGB does not contaminate visible edges. Samples stay in
their declared transfer/color space; linear-light/gamut conversion is separate.
These are defined Home semantics, not Pillow-identical numerical output.

Precomputed separable tables and a direct-mapped cache of at most 64 horizontal
rows avoid a full floating-point intermediate image. The C/Bun API caps active
source and output pixels at 256 MiB each and working heap at 64 MiB. Wide windows
may recompute evicted rows. Geometry, spans, overlap, all scratch allocations and
limits are checked before destination writes; failed output buffers are not
partially filled. Same-size no-op aliasing is allowed; other overlap rejects.
No camera lease or caller pixel pointer is retained by the resampler.

C adds `ZC_RESAMPLE_*` and `zc_raster_resize` over the existing borrowed
`zc_raster`. A null/zero output queries the compact size and preflights heap
limits without allocation. Existing ABI layouts/version are unchanged. Zig adds
`ImageResample` with injected-allocator `resize`, `into`, `checkedSize`, algorithms
and configurable limits, directly over `ImagePixels.View`/`Owned`.

Home receives the portable algorithm and replaces the public Image API's
8-bit-only resize path. Gray/RGB/RGBA words, checked indexed palette expansion,
transactional mutating methods, explicit animated-resize rejection, checked fit
arithmetic and native-precision padding improve upstream too. Complete animation
compositing/fit semantics, external decoded image objects and additional
transforms remain work.

An independent long-double direct 2D C reference validates 660 fixtures in each
pinned/development Zig Debug/ReleaseSafe build. Nearest/identity are exact;
filtered comparison allows one native integer unit for floating-point rounding.
Cases include unaligned/padded/endian inputs, all six integer formats, alpha,
single-axis images and downscales wider than the cache. Allocation-failure tests
preserve original output and Image owners. Bun checks all processed main/lores
capture formats, partial dimensions, source retirement/GC, getters/closure,
limits and focus-locked async capture. Software checks do not establish physical
camera quality, Pi throughput or Picamera2 speedups.
