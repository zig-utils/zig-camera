# Capture Exif

Bun and CLI JPEG captures default to request-derived Exif. PNG/TIFF opt in;
BMP/PPM/DNG reject enabled Exif (DNG retains its existing raw metadata). Existing
C/Zig image/profile APIs keep their prior behavior; their additive metadata APIs
explicitly accept Exif. No existing options/profile/frame ABI layout changes.

```ts
await camera.captureFile('trail.jpg')
await camera.captureFile('plain.jpg', { exif: false })
const png = await camera.captureEncodedImage({
  format: 'png', stream: 'lores', iccProfile: 'srgb',
  exif: {
    artist: 'Chris', copyright: '(c) Chris',
    gps: { latitude: 45.5, longitude: -122.5, altitude: 800 },
  },
})
await camera.switchModeAndCaptureFile({ width: 4056, height: 3040 }, 'detail.jpg', {
  exif: { fNumber: [28, 10], exposureBias: [-1, 3] },
})
```

`ImageExif` accepts true, false, owned-snapshot `Uint8Array` TIFF/Exif bytes, or
`ExifOptions`. A raw byte argument embeds exactly that metadata without automatic
capture defaults. `{ raw, captureMetadata: true }` fills missing defaults.
`captureMetadata` defaults true for an options object. False allows only selected
typed fields. Raw cannot combine with typed fields or thumbnail bytes. User
fields override defaults, including explicit empty/zero values; duplicate supplied
tags reject. Input buffers, nested typed fields and thumbnails are copied before
job admission and mode-worker transfer. Documented option properties are read
once. Async/focus jobs and direct leased-frame methods share the same preparation.

Automatic metadata uses selected stream dimensions, actual exposure in seconds,
software `zig-camera`, backend model/identity when ASCII, ExifVersion 0232 and
Orientation 1 because encoded pixels already reflect camera orientation. It does
not invent a manufacturer, aperture, focal length, GPS location or calibrated
sensor sensitivity. Gain-derived ISO is floor(AnalogueGain * DigitalGain * 100),
using finite positive metadata gains; missing gains omit it. It emits SHORT
PhotographicSensitivity plus SensitivityType 3 and LONG ISOSpeed. Any explicit
sensitivity-family tag suppresses this generated bundle to avoid conflict.

DateTime is UTC at encoding; DateTimeOriginal uses the request's FrameWallClock
when present. Older backends correlate known SensorTimestamp CLOCK_BOOTTIME with
CLOCK_REALTIME (virtual backend uses its known monotonic domain). A sampled
backward clock step, excessive sampling interval or future sensor stamp omits the
correlation. OffsetTime/OffsetTimeOriginal explicitly say +00:00, with nine-digit
subseconds. These record the software clock, not GPS time or certified capture
latency. Any supplied date, offset or subsecond tag suppresses that automatic time
family: a user date without a zone never gains an invented UTC zone. Explicit
options can still supply dates/offsets independently. Host clock corrections
outside the short correlation sample cannot be detected.

Typed options include make/model/software/artist/copyright/description, lens
make/model, dates/offsets, orientation 1..8, rational exposure/f-number/focal
length, signed exposure bias, ISO, GPS decimal coordinates/altitude/date/time,
and JPEG thumbnail bytes. Generic tags select image/exif/gps/interoperability/
thumbnail and TIFF types 1..12. Strings are ASCII without embedded NUL. Generic
numeric bytes are little-endian; numeric arrays and numerator/denominator pairs
are packed before Home serialization. No implicit Unicode/UserComment conversion.
GPS is bounded and preserves south/west/negative altitude; timestamp domains and
version shapes are validated. A missing GPS version becomes 2.3.0.0. Date strings
remain caller text; no geographical location or timezone is inferred.

`zc_exif_build` accepts bounded 32-byte field descriptors and returns an owned
image blob containing bare TIFF. Field values are little-endian; special ISO and
GPS-decimal field types reuse Home's representation helpers. Close the blob after
copying. `zc_default_image_exif` prepares a 24-byte capture-default descriptor.
`zc_check_image_metadata`, `zc_encode_stream_image_metadata`,
`zc_save_stream_image_metadata` and `zc_image_file_prepare_metadata` accept profile
and Exif descriptors together. Borrowed C/Zig input must remain immutable for the
synchronous call. Zig exposes `Exif.Builder`, `defaultImageExif`, `customImageExif`,
`checkImageMetadata` and Frame's `encodeStreamImageMetadata` /
`saveStreamImageMetadata` methods. CLI `--exif auto|none|PATH` is capture-only;
PATH embeds copied raw TIFF or Exif-prefixed bytes, capped at 16 MiB.

Home checks classic TIFF directory graphs, field geometry and rational bounds.
Limits: 16 MiB metadata, 32 directories, 4,096 serialized entries, JPEG bare TIFF
65,527 bytes. Generated defaults can exceed JPEG's limit even when a raw input
fits; encoding then fails without publishing the destination and releases the
request. Enabled Exif is checked before pixel conversion. JPEG markers are
written during Home encoding; owned output transfers the encoder allocation.
The optional system JPEG main-file path receives the same validated markers and
keeps descriptor-based atomic output. PNG/TIFF use Home's combined ICC/Exif
embedding. Existing color/profile checks still apply.

File staging retains the existing publication barrier after callbacks and mode/
preview restoration. Cancellation or failed restoration discards prepared bytes;
ordinary completed saves retain their documented irrevocable publication point.
No extra frame reference escapes encoding. See [staged files](staged-files.md).

Independent libexif/JPEG/PNG readers check actual files and owned results, selected
lores dimensions, ISO/fractions, UTC presence, typed precedence, GPS and thumbnail
bytes, both byte orders, disabled/default behavior and copied queued/focus/mode
inputs. Allocation-failure tests cover shared merging and capture policy. These
software tests do not establish Pi metadata accuracy, optical quality, performance,
full Exif conformance or full Picamera2 parity. Thumbnail bytes are delimited and
owned but not decoded; MakerNote internal offsets remain caller-owned. TIFF
append/replacement is not privacy erasure. Full tag semantics, decoded thumbnail
acceptance and physical results remain in the parity worklist.

References: [libcamera metadata clocks](https://docs.libcamera.org/master/internal-api/namespacelibcamera_1_1controls.html),
[Home Exif](https://github.com/home-lang/home/blob/d0abb3777b6255843ffe2364f1bd09e660c36ced/packages/image/docs/exif.md).
