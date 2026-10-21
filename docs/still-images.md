# Still files and owned encoded images

```ts
await camera.captureFile('trail.png', { compressLevel: 1, pngFilter: 'adaptive' })
await camera.captureFile('trail.tif')
await camera.captureFile('trail.bmp')
const png = await camera.captureEncodedImage({ format: 'png', stream: 'lores' })
const rgb = await camera.captureRGB({ stream: 'lores' })
const color = camera.colorSpace('lores') // negotiated matrix/range, transfer and primaries
const focused = await camera.captureFocusLockedEncodedImage({ format: 'JPEG' })
const fullSize = await camera.switchModeAndCaptureEncodedImage(
  { width: 4056, height: 3040 }, { format: 'png', dropFrames: 4 },
)
using request = await camera.captureRequest()
request.saveFile('image.data', { format: 'PNG' })
const bytes = request.encodeImage({ format: 'tiff' })
```

File helpers infer JPEG/JPG, PNG, BMP, TIFF/TIF, PPM or DNG from a case-insensitive
extension. Explicit `format` overrides the extension and allows extensionless
destinations. Options are copied/validated at job admission. JPEG `quality` is
1..100, default 98. PNG `compressLevel` is a genuine zlib level 0..9, default 1;
`pngFilter` is adaptive (default), none, sub, up, average or paeth. JPEG/PNG settings
are ignored by the other formats after validation. Unsupported formats reject
before camera work; there is no filename-based fallback to a different encoder.

`Frame.saveFile` and `encodeImage` work on the leased request. Encoded results are
owned `Uint8Array` values, independent of the camera buffers and valid after frame
release, mode restoration or camera close. `captureEncodedImageAsync` returns a
`BunJob`; `captureEncodedImage` is its Promise facade. Focus-locked and temporary
mode variants share the existing cancellation, restoration, revision and request
callback contracts. Encoded-byte APIs return file bytes, not a decoded image
object. They perform synchronous native encoding on the consuming thread; ordinary
capture admission is asynchronous, and mode captures encode on their worker.

The `stream` option defaults to main for processed images and raw for DNG.
Processed encoders accept main or lores. RGB8 is read directly from leased rows;
I420 lores is converted using negotiated BT.601/709/2020 YCbCr and full/limited
range. The conversion uses one explicit temporary RGB24 buffer for encoding;
`Frame.copyRGB('lores')` and the RGB capture helpers write directly to their
owned destination. Main RGB copies retain the existing direct path. PNG/BMP/TIFF/
PPM store the resulting RGB8 values losslessly, omitting row padding. Chroma
upsampling uses nearest sampling; it does not recover discarded chroma detail.
Transfer functions and primaries are reported but not transformed. Unknown YCbCr
encoding/range rejects conversion instead of guessing. Disabled streams reject.
DNG accepts only raw; processed raw capture requires a future demosaic path.
Incompatible format/source combinations reject before capture admission.

JPEG is lossy Home baseline 4:4:4; optional system JPEG acceleration remains the
existing main-file save path; lores JPEG uses Home. Owned JPEG always uses Home.
PNG filters and container layout are Home Zig code; Home's streaming compression
adapter uses system libz.
PNG encoding retains two row buffers and encoded output rather than a full
filtered image plus a duplicate compressed buffer. BMP uses padded bottom-up RGB24
rows. TIFF is uncompressed RGB, with per-component depth, planar/orientation and
resolution tags. No encoder rotates pixels again: it consumes the negotiated
camera orientation. All formats are also available from scoped request callbacks.

DNG uses the existing Bayer/calibration implementation through a shared row
writer for both file and byte output. Normal/focus-locked captures require a
configured supported raw stream; temporary DNG mode helpers request unpacked raw
automatically and restore the prior configuration. Missing/unsupported raw or
calibration rejects. Packed raw supported by the DNG row unpacker retains its
existing behavior; PiSP compressed raw remains unsupported.

All image reads reject while an exclusive mapping owns the request. Encoding
pins no additional camera reference: the caller's lease protects the input for
the synchronous call. File saves use atomic replacement; failure leaves no
partial destination. A completed file write or callback side effect is not rolled
back by a later cancellation, callback error or mode-restoration failure.
Cancellation of an entered encoder is cooperative at the existing operation
boundaries; `operationDone` joins ownership cleanup before camera teardown.

The C ABI adds a 20-byte `zc_image_options`, `zc_encode_image`, immutable owned
`zc_image_blob` copy/close functions, and `zc_save_image`. Existing ABI v1 structs
and JPEG/DNG calls are unchanged. Blob copy queries the required size, rejects
short buffers without writing a prefix, and remains valid after camera close.
C callers serialize and close each blob once. Zig exposes `defaultImageOptions`,
`Frame.encodeImage(allocator, options)` and `saveImage(path, options)`. Additive
`zc_encode_stream_image`/`zc_save_stream_image` select an explicit stream without
changing the 20-byte options. `zc_copy_stream_rgb` writes checked tight RGB24.
`zc_get_stream_color_space` returns a separate 24-byte negotiated descriptor with
explicit portable enums (zero means unknown). Zig exposes `encodeStreamImage`,
`saveStreamImage`, `copyStreamRgb` and `colorSpace`; Bun exposes camera/request
`colorSpace(stream)` and carries `stream` through every image and RGB job.

The CLI accepts `.png`, `.bmp`, `.tif`/`.tiff` in addition to existing still formats,
plus `--image-format`, `--image-stream`, `--png-compression`, and `--png-filter`.
Capture sidecars
include image source/dimensions and its negotiated color metadata as well as the
actual request and stream configuration.

Tests decode exact RGB pixels using independent ImageIO on macOS and
libpng/libtiff/SDL on Linux, including all filter policies, compression levels
0/1/6/9, multiple IDAT/deflate blocks and edited padded rows. Native/C/Bun tests
also cover blob ownership, short-copy failure, stale leases, mappings, failed
paths, option snapshots, callbacks, focus restoration and mode rollback. Home's
Image suite additionally checks 16-bit sample order, palette alpha and decoder
regressions. Named-stream tests include edited RGB/I420 lores, independent color
vectors, padding, source immutability, native allocation failures, callback access,
recording coexistence and failed-target mode restoration.

GIF/APNG, additional pixel formats and demosaicing, decoded image-object
conveniences, user Exif/ICC metadata, advanced TIFF options and advanced DNG remain
on the parity worklist. Hardware throughput and optical quality are unmeasured.

References: [PNG specification](https://www.w3.org/TR/png-3/),
[TIFF coverage and tags](https://libtiff.gitlab.io/libtiff/specification/coverage.html),
[pinned Picamera2 save behavior](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/request.py).
