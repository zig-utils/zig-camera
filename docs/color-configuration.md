# Color-space requests and negotiation

CameraOptions.colorSpace accepts srgb, sycc, smpte170m, rec709 or rec2020 presets,
or an explicit primaries/transfer/ycbcrEncoding/range description. The request is
shared by processed main/lores streams, with format-specific normalization. Raw
keeps its own raw/linear metadata. The default recipe remains an sYCC request;
actual negotiated metadata is always queried from the backend.

```ts
const camera = new Camera({
  width: 1920, height: 1080, format: 'YUV420',
  colorSpace: {
    primaries: 'rec709', transfer: 'srgb',
    ycbcrEncoding: 'rec709', range: 'limited',
  },
  strictColorSpace: true,
  lores: { width: 640, height: 360, rgb: true },
})
console.log(camera.colorSpace()) // actual main metadata
console.log(camera.colorNegotiation('lores'))
await camera.switchMode({
  width: 1280, height: 720, format: 'YUV420',
  colorSpace: 'sycc', strictColorSpace: true,
})
```

Each description has four independent components. Primaries are smpte170m,
rec709 or rec2020; transfer is linear, srgb or rec709; matrix is none, rec601,
rec709 or rec2020; range is full or limited. Unknown codes, raw primaries and
incomplete descriptions reject. A YUV stream requires a matrix. An srgb preset
therefore requires every enabled processed stream to be RGB. Disabled lores does
not constrain the request. Custom combinations are requests, not promises of
hardware support. Preset Rec.709 and Rec.2020 use the Rec.709 transfer function;
sYCC uses Rec.709 primaries, sRGB transfer, BT.601 YCbCr and full range.

RGB keeps requested primaries/transfer but normalizes matrix/range to none/full,
like upstream format normalization. No request object is changed. colorNegotiation
returns independent copied observations: configured, strict, normalized, adjusted,
format, requested, effective and actual. Requested/effective are omitted when no
explicit color request was made. Actual includes the present flag, including when
metadata is absent or enums are unknown. Native negotiation preserves those actual
fields; no actual profile is inferred from the requested one.

normalized identifies requested-to-effective RGB changes. adjusted identifies a
backend mismatch against that effective request, including unknown/absent actual
metadata. strictColorSpace defaults false. True requires an explicit request and
rejects backend adjustments at open/reopen, before publishing the camera owner.
Normalization itself is accepted by strict mode. Metadata queries remain observable
and report adjustments; strict mode is an opening policy, not a background monitor.
Physical sensor/color chart acceptance is still required.

## Mode jobs, image consumers and recording

Options and custom descriptions are snapshotted before admission. Ordinary,
temporary, cancelled, single-recorder and recorder-group modes carry requested
colors through worker opening and joined rollback. Failed target recording color
validation restores the prior camera recipe through the existing transaction
rules. Already-flushed recorder sessions retain their existing failure semantics.
Control/CAF restoration and preview recreation continue to use the same mode jobs.
A mode target with omitted color options uses the default recipe.

Copy/preview/still-image methods convert negotiated YCbCr matrix/range into encoded
RGB. They do not transform gamma/primaries or insert an ICC profile. RGB copies
and image encoders preserve supplied RGB code values. SDL is not a color-managed
display path. Temporary byte/image capture returns its existing value type; use a
strict target request when that result must follow a known requested profile.
The configuration/negotiation API does not establish optical color accuracy.

Current Home AVC/HEVC output tags describe Rec.709 primaries, sRGB transfer and
limited BT.601 YCbCr. Compatible I420 source matrices/ranges are remapped directly
with Home yuv_remap; incompatible primaries/transfer or unknown metadata reject
before frame/PCM admission. Standard rec709/smpte170m/rec2020 preset transfers are
not silently relabeled as sRGB. A custom Rec.709-primaries/sRGB-transfer description
can select another supported YCbCr matrix/range while retaining compatible gamut
and gamma. General gamut/transfer conversion and configurable encoder tags remain
parity work. CLI recording preflights color before constructing an output file.

RGB main recording verifies actual signal metadata once per adopted camera handle,
then uses the existing legacy path only when compatible. Handle assignment clears
that cache, even if an allocator reuses the same numeric address after a mode job.
No per-frame string decoding or color-query allocation is added to that path.
Other inputs use the checked colored-descriptor API before producer mutation.

## Native API, CLI and validation

The additive 36-byte zc_processed_options carries main format, strict color and a
zc_color_space. Initialize with zc_default_processed_options, optionally select a
preset with zc_color_space_preset, and check color/format policy with
zc_check_processed_options. Geometry and capture options still validate at open.
Use zc_open_processed_pipeline or zc_open_id_processed_pipeline with existing
orientation/selector parameters. Existing ABI v1 config/pipeline/stream/frame
layouts and open calls are unchanged.

zc_get_color_negotiation returns an 88-byte snapshot for main/lores. Flags are
configured=1, strict=2, normalized=4, adjusted=8; requested/effective/actual remain
separate 24-byte descriptions. Raw negotiation is unsupported. Disabled streams
and invalid selectors reject without modifying the destination. Pure preset
validation is available without a camera/backend, and unknown presets leave the
output untouched. Zig provides ProcessedOptions/defaultProcessedOptions,
colorSpacePreset, Camera.initProcessedPipeline/Id and colorNegotiation.

```sh
zig-camera info --main-format YUV420 --color-space rec709 --strict-color-space
zig-camera preview --color-space rec2020
zig-camera record --main-format YUV420 --color-space sycc --output trails.mp4
```

Info prints request/effective/actual component codes and normalization/adjustment
flags per active processed stream. These portable IDs are not ISO codec tag IDs.

Home's standalone policy tests pass pinned/development Zig Debug/ReleaseSafe.
Camera native tests cover each preset across paired RGB/I420 formats, strict
adjustment/unknown policy, copied metadata and late synthetic metadata drift.
C ABI tests cover layouts, pure validation, exact IDs and failure preservation;
real-bridge tests cover native color mapping. SDL readback checks all six matrix/
range combinations using configured leased input and an independent floating
reference. Bun tests cover copies, conversion, admission rejection, legacy query
caching, mode/CAF/control/preview restoration and direct I420 recording. Linux
independently decodes AVC/HEVC color planes. Synthetic fixtures do not substitute
for physical Pi ISP negotiation, gamut/gamma validation or throughput measurements.
