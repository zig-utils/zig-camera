# Owned PNG/APNG loading

Version 0.100 adds `decodePng(bytes, limits)`, `decodePngAsync(bytes, options)` and
`loadPngAsync(path, options)`. Results own a default `CapturedImage`, a frozen
array of independent raw animation rectangles, source color/depth/interlace
information, play count and copied validated metadata. Closing a result closes
all of its images. Individual clones/transforms and returned pixel copies remain
independent. Camera request provenance is absent for loaded files.

```ts
import { decodePngAsync, loadPngAsync } from '@zig-utils/camera'
using decoded = await decodePngAsync(encodedBytes)
using rotated = decoded.image.rotate(90)
await rotated.saveAsync('rotated.png')
using fromDisk = await loadPngAsync('source.png', { maxInputBytes: 8 * 1024 * 1024 })
```

The decoder reuses Home's strict PNG/APNG core and caller-owned zlib workspace.
It reconstructs every legal color/depth combination, all PNG filters and Adam7.
Gray/RGB/RGBA16 retain every sample bit in little-endian output. Packed grayscale
expands to gray8; palette indices expand to RGBA8, with original RGBA palette
entries retained in metadata. Transparency keys compare full original samples.
Alpha remains unassociated. The source is immutable during synchronous native
calls and never retained; asynchronous calls copy encoded input before returning.
SharedArrayBuffer encoded input is rejected by Bun.

`frames` contains raw frame rectangles, offsets, exact delay numerator and
raw denominator (zero means 100), dispose and blend controls. `defaultIsFrame`
distinguishes a separate poster from an included first animation frame; included
frame zero and the default image still have separate pixel owners. The decoder
does not composite frames, apply Exif orientation, convert gamma/gamut or invent
a source color-space declaration. ICC, Exif, sRGB intent, gamma, chromaticities
and cICP metadata are copied separately. Gamma and chromaticities retain their
PNG integer units (divide by 100000); cICP retains raw code values. Re-embedding
metadata is explicit through
the existing image encoder options; RGB ICC validation/gray restrictions remain.
Changing an Exif orientation tag does not rotate pixels automatically.

Defaults: 64 MiB encoded input, 64 MiB aggregate default/frame pixels, 128 MiB
working allocations, 16 MiB aggregate ICC/Exif, 256 frames and 16384 chunks.
Input/output/working limits can be raised to 256 MiB each; metadata/frame/chunk
limits can only be reduced. All options are snapshotted before native admission.
The native encoder and decoder share four reservations with a 512 MiB total
ceiling, charged for input, configured workspace and owners. Starting in
0.100.1, the job and its transferred result jointly retain that reservation until
both close, in either order. Closing an image first cannot uncharge copied input
still held by its job; closing a job first cannot uncharge the live result. Bun copies all result pixels/metadata into
caller-owned images and closes the native result before returning. Caller-retained
Bun images use ordinary application memory, as with captured image objects.

Async decoding uses a native thread, Home preparation gates and an allocation
budget that includes native zlib allocations. Cancellation is checked during
parsing, reconstructed rows and frames; workers are joined before their storage
is retired. Nothing partial is published on parse, checksum, limit, allocation or
cancellation failure. The default deadline is 30 seconds; callbacks use existing
`BunJob` semantics. File loading bounds the actual read to input limit plus one,
so a concurrent file growth cannot cause an unbounded read. Reads also have a
separate four-reader, 512 MiB encoded-input admission limit and no waiting queue;
their reservations last through native completion. Cancellation waits for an
already started bounded file read, then joins native work if admitted.

C callers use `zc_png_decode`/`zc_png_decode_async`, copy-info/frame/metadata APIs,
`zc_png_job_take_image` exactly once, and explicit close functions. Frame slot 0
is the default image; animation slots start at 1. `zc_png_job_close` returns BUSY
until finished and joins on successful close; a transferred image outlives it.
Owner operations are serialized by the caller. Zig exposes the same checked
shared `PngDecoder` and native `png_image` API.

Validation includes independent libpng source generation and sample comparisons
for 936 color/depth/filter/transparency/interlace/geometry combinations, exact
Home animation controls, malformed checksummed chunks, allocation failures,
input retirement, async cancellation/admission and native/Bun ownership tests.
This is PNG/APNG loading support; JPEG/TIFF/GIF/general decoded formats,
compositing and full Picamera2 image-object parity remain open. No physical Pi
image quality or performance improvement is claimed by synthetic media tests.
