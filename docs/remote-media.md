# Remote request arrays and calibrated media

Version 0.90 extends `RemoteFrame` and supervised `ProcessPool` handlers with
owned stream/array/raw copies and calibrated DNG. All pixel processing reuses
Home; there is no Python or FFmpeg execution. These operations do not complete
remote configuration, image metadata, allocator or overall Picamera2 parity.

```ts
// A ProcessModule handler in a local TypeScript file:
import type { ProcessModule } from '@zig-utils/camera'
export const run: ProcessModule['run'] = (request) => {
  const streams = request.copyStreams(['lores', 'raw'])
  const array = request.makeArray('lores')
  const samples = request.copyRaw16()
  const dng = request.encodeDng()
  return { streams, array, samples, dng, calibration: request.rawMetadata() }
}
```

Configure the pool's `maxResultBytes` and aggregate reservation for the maximum
returned values; the default is 4 MiB per result, not an unlimited image queue.
Results are independent copies made while the remote request is live. The
supervisor closes its maps before ACK and retires the source before publishing
results; see [process-pools.md](process-pools.md). No copy extends a camera lease.

## Copies and array layouts

| Bun method | Representation |
| --- | --- |
| `copyPlanes(name)` | Existing owned physical planes, each including its used padding |
| `makeBuffer(name)` | One flat owned allocation of physical `bytes_used`, in plane order, including used padding; one native pixel copy |
| `copyStream(name)` | Tight `PackedStream`: width, height, format, rowBytes and owned u8 data |
| `copyStreams(names)` | Tight streams in caller order in one owned compact backing, plus copied request metadata |
| `makeArray(name)` | Tight owned typed array plus immutable shape, format and rowBytes; no channel or color conversion |
| `copyRaw16()` | Home-decoded LE u16 raw samples, without scaling, demosaicing or color conversion |
| `makeImage(name, bits?)` | Existing independent Home RGB8/RGB16 image with request provenance |

`names` must contain 1..3 distinct main/raw/lores entries. Indexed names are
snapshotted once; caller iterators are not invoked. The owner is rechecked after
getters. Missing streams and unknown conversion layouts reject. All copies and
saves reject during a remote writable context; metadata remains readable.
Permission checks and native image copies use private descriptor reads, so an
overridden public `info()` cannot substitute write permission or close an owner
between an internal descriptor read and its native use.

`makeArray` returns `{data, shape, format, rowBytes}`. Data is row-major:

| Stored format | Type | Shape |
| --- | --- | --- |
| BGR888 / RGB888 | u8 | height, width, 3 |
| XBGR8888 / XRGB8888 | u8 | height, width, 4 |
| BGR161616 / RGB161616 | u16 | height, width, 3 |
| YUV420 / YVU420 / NV12 / NV21 | u8 | height * 3/2, width |
| YUYV / YVYU / UYVY / VYUY | u8 | height, width, 2 |
| Supported Bayer/mono raw | u8 | height, physical active rowBytes |

Raw arrays preserve unpacked words, CSI-2 packed groups and PiSP COMP1 blocks;
`copyRaw16` explicitly decodes them. COMP1 reconstruction uses the standard
2048 offset and cannot restore lost ADC precision. YUV arrays concatenate stored
planes and omit padding; there is no implicit RGB conversion or U/V reordering.
The API uses typed arrays, not NumPy/Pillow classes or identical Python layouts.
The local channel supports 64-bit little-endian Linux/Darwin executables.

Native local and remote bundles share `stream_bundle.Plan`, which reuses Home's
allocation-free `plane_pack` and the existing checked stream layouts. All source
planes, geometry, total size and destination capacity are checked before any
output byte or layout is changed. Short destinations and a late invalid plane
cannot leave a copied prefix. Native destinations must be valid, non-overlapping
owned storage; callers serialize source access. Remote compact bundles, physical
buffers and decoded raw copies are capped at 256 MiB per call. Query/copy C
functions use `data=NULL,capacity=0` for size queries.

## Calibration and DNG

The export now snapshots `zc_raw_metadata` from the same retained request slot
as its pixels and scalar metadata. This 184-byte value contains validity bits,
four black levels in R/Gr/Gb/B order normalized to the 16-bit range, the nine
camera-to-sRGB coefficients and the camera model. Exposure and white-balance
gains come from that request's existing scalar metadata. An initial pool camera
snapshot is not substituted for request-time calibration.

C exposes `zc_frame_export_raw_metadata` and `zc_remote_frame_raw_metadata`;
Bun exports/remotes and Zig exports/remotes provide `rawMetadata()`. Returned
values are owned snapshots; unavailable fields stay unavailable. Bun's nested
calibration arrays are frozen. Calibration remains readable after the original
request reference is released or the camera stops, while the export/remote
owners remain live.

The private ZCFD frame record now uses version 2: the existing 32-byte header,
unchanged 736-byte descriptor ABI and 184-byte calibration suffix (952 total).
New receivers also accept exact 768-byte version-1 records with zero calibration
validity. They can copy pixels but cannot invent DNG calibration. New senders
require a version-2-capable receiver. ACK records remain version 1, 32 bytes.
Unknown versions/validity bits, unterminated models and inconsistent record
lengths reject while cleaning every received descriptor. This is a cooperating
local ABI, not an external network or hostile-peer schema.

`encodeDng()` returns owned bytes through the existing native blob and Home raw
writer. Its decoded image plus header must fit the 256 MiB encoded-byte ceiling.
`saveDng(path)` streams decoded rows through one scratch row into the existing
atomic-file writer. It avoids a full raw pixel copy; the existing classic-TIFF
size/geometry and calibration checks apply. A failed save leaves an existing
final file unchanged. Bayer requires black levels, CCM and WB; mono requires
black levels and emits no invented CFA or color matrix. Malformed samples,
singular/non-finite calibration and unsupported formats reject.

`save(path, options, stream = 'main')` creates an independent processed image and
uses its existing atomic save/explicit ICC/Exif path. It does not synthesize
request-derived Exif; use explicit fields or source-request encoding for that.
General file-like outputs, request-derived remote Exif, compression choices and
asynchronous remote save/publication jobs remain work.

These remote operations are synchronous on the invoking thread or process.
A successful save performed inside a child is an external side effect: subsequent
job cancellation, deadline or worker loss does not roll it back. Use returned
owned bytes and a separate parent publication policy when that distinction
matters. Low-level callers must still close all remote maps before ACK, or join
a lost peer before source retirement. Copies do not replace that ownership rule.

## Validation and limits of the evidence

The native suite covers shared bundle atomicity, late invalid layouts, raw short
outputs, malformed v2 suffixes/versions/lengths, unchanged descriptor counts and
public Zig result ownership. An independent C wire/CMSG implementation sends
legacy and new records into native receivers and receives native v2 records
across exec, with read/write, ACK and abrupt-exit retirement.

Bun checks all 14 processed main/lores layouts, all 46 Bayer/mono/raw packing
formats, exact local/remote DNG bytes and samples, writable exclusion, failed-file
preservation, getter/override reentry, and actual process result ownership and
DNG saves. Independent libtiff reads every remote raw-format DNG in Linux CI and
in the configured local run. The broader media suite retains independent image,
AVC/HEVC/AAC decoders and SDL tests. The 120-frame VBV conformance case has an
explicit bounded 30-second framework budget after a local run exceeded the
implicit five-second guard; its frame/bitrate/level/decoder assertions and product
deadlines are unchanged. This is not a codec speed guarantee.

The normal local build runner still fails macOS SDK/libSystem linkage before
project compilation; target-qualified native builds/tests pass. Exact-commit
platform CI and real-backend load/no-camera tests remain publication gates.
There is no attached Pi/camera: physical DMA coherency, raw calibration, sustained
throughput, optical quality and matched Picamera2 performance remain unverified.

Final local evidence: 421 ReleaseSafe native tests, 1,307 Bun tests with media,
SDL and independent decoders enabled, and independent C ABI/export/channel/
process checks pass. The final Bun run uses normal runner settings with the
explicit per-case VBV budget above. Raw-format libtiff readback and the public
info-override regression are included. Abrupt termination during a child file
save can also leave its private atomic temporary file; automatic cleanup or
parent-coordinated publication after peer loss remains work.
