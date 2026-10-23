# Owned image objects

Version 0.84 adds Bun `Frame.makeImage`, `Camera.captureImageAsync`/`captureImage`
and `captureFocusLockedImageAsync`/`captureFocusLockedImage`. They produce
`CapturedImage` instances with independent compact pixels rather than retained
camera buffers. Main/lores RGB/BGR/RGBX/BGRX, planar/semi-planar YUV420, packed422
and RGB16 sources reuse the existing checked native copy/conversion paths.
Request callbacks also expose `makeImage`; their scoped request expires while
the copied image remains usable. Capture selection keeps existing flush/drop/
SyncReady and CAF restoration semantics.

Default precision follows the source: RGB16 remains sixteen bits; other inputs
produce RGB8. `bits: 8` explicitly reduces word sources, and `bits: 16` rejects
an eight-bit capture rather than inventing sensor precision. Each capture makes
one independent native copy into owned Bun bytes. Geometry comes from the native
stream descriptor. The scalar `sourceMetadata` snapshot, including its crop, is
frozen, as is the source color description. This is source provenance; cropping
an image does not change the recorded sensor ROI, and copied RGB bytes no longer
have the source stream's packed YUV layout. Full/vendor metadata catalogs remain
available from the original request.

```ts
using image = await camera.captureImage({ stream: 'main' })
await camera.close()
using crop = image.crop(10, 10, 320, 240)
using rgba16 = crop.convert({ format: 'rgba', bits: 16, endian: 'big' })
await rgba16.saveAsync('crop.png')
```

Images expose immutable geometry/format/stride information, `getPixel` (RGBA8),
`getPixel16` (RGBA16), `copyPixels`, `clone`, checked `crop`/`convert`, `encode`,
synchronous atomic `save`, joined staged `saveAsync`, `close` and `Symbol.dispose`.
Returned pixel copies are independent and writable. Closing an image releases
its private Bun reference; it does not invalidate other images or returned
copies. Already admitted save jobs retain their own input reference and can
complete after source closure. Standalone image jobs belong to their caller,
independently of the source camera's lifetime.

`CapturedImage.fromRaster` copies checked gray/RGB/RGBA8/16 data with explicit
endianness and optional row padding. Caller property accessors are consumed
before native access, and intrinsic typed-array properties detect detached or
misrepresented buffers. Conversion uses Home's new checked integer view:
8-to-16 byte replication, 16-to-8 high-byte reduction, native-precision integer
luma and explicit alpha dropping, without gamma/gamut conversion/compositing.
Identical formats copy active rows. Conversion has no hidden quality reduction. Version 0.85 adds explicit
[resizing](image-resizing.md) and optional capture-time dimensions. Converted/cropped/source pixels and encoded output are limited to
256 MiB by the raster API; allocator scratch is additional.

JPEG/PNG/BMP/TIFF/PPM/GIF reuse Home encoders. PNG/TIFF/PPM retain appropriate
word precision; JPEG/BMP/GIF reduce to their supported representation. JPEG and
PPM reject RGBA until an explicit RGB conversion is requested. GIF thresholds
alpha as documented in gif.md. Gray pixels reject RGB ICC profiles. Other RGB
ICC/explicit Exif options retain the existing validation; built-in sRGB requires
a matching source declaration. `fromRaster.colorSpace` declares interpretation
without converting pixels. The color values remain caller-owned assertions.

An image object has no live capture request. Its bare saves default to no Exif,
matching an independent image save; typed/raw caller Exif is supported without
automatic capture fields. `exif: true` or `captureMetadata: true` explicitly
reject. Request encoding/file APIs retain their existing request-derived Exif
defaults. Raw sensor output still requires the calibrated DNG/request APIs.

`saveAsync` reserves the existing bounded native file owner before yielding,
then stages privately and joins publication/disposal. The shared factory admits
at most 32 owners. Cancellation before publication preserves the destination;
the native publication claim rejects late cancellation. The 30-second default
deadline is rechecked after encoding. Encoding is synchronous on the Bun owner;
native file I/O is asynchronous. This is not a new background codec worker.

Zig exposes `Frame.makeImage(allocator, stream, bits)` returning
`ImagePixels.Owned`; `null` selects native precision. Deinitialize that independent
owner explicitly. `ImagePixels.View`/`Owned.copy` provide checked word conversion
and cropped copies; request metadata can be copied separately before release.
C uses borrowed `zc_raster` descriptors (the existing 48-byte raster layout),
`zc_raster_convert`/`crop` size queries and copies, `zc_raster_pixel16`, owned-blob
`zc_raster_encode`, atomic `zc_raster_save` and staged
`zc_image_file_prepare_raster`. Native calls consume pixel pointers synchronously
and retain none. The existing public ABI layouts and version remain unchanged.

Home's Image API additionally receives corrected deep frame/palette cloning,
Color16 access and transactional main/frame conversion, replacing uninitialized
sixteen-bit destinations and black source conversions. Indexed source expansion
is shared with PNG/GIF; indexed destinations explicitly reject. Home's portable
view and independent test fixtures are reused verbatim here.

The portable matrix checks 576 independent C-reference fixtures per pinned/
development Zig Debug/ReleaseSafe build. Bun tests cover all processed main/lores
sources, lifetime independence, conversion, source detachment/accessors, callback/
CAF images, explicit Exif/ICC, save cancellation/GC/late claims and bounded burst
admission/reuse. Independent libpng checks every encoded gray/RGB/RGBA8/16 byte,
word, alpha sample and byte order. C/Zig tests check bounds, overlap, no-prefix
copies, blob ownership and request/camera retirement. These tests are software
evidence, not physical sensor quality, format acceptance or camera performance.

Further image transforms, temporary-mode image conveniences, palette/
float/gamut conversion, general external image decoding and complete animation/
image-object semantics remain work. The full Picamera2 parity goal remains open.
