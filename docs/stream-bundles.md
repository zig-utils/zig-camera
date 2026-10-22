# Owned request stream bundles

`Camera.switchModeAndCaptureStreams` switches to the target configuration,
selects one completed request, copies its selected streams and metadata, releases
the request, and restores the previous camera and preview before publishing.
This supplies the paired-array capability of Picamera2's
`switch_mode_and_capture_arrays` through owned Zig/Bun byte layouts.

```ts
const bundle = await camera.switchModeAndCaptureStreams(
  { width: 4056, height: 3040, raw: true, unpackedRaw: true,
    lores: { width: 640, height: 480 } },
  ['main', 'raw', 'lores'],
  { dropFrames: 4, autofocus: true },
)
console.log(bundle.metadata.sequence, bundle.streams.main?.rowBytes)
// The previous mode is restored; bundle pixels remain usable after camera close.
```

Names default to `['main']`. They must be an array of one to three distinct
`main`/`raw`/`lores` names. The indexed names are read once and copied before mode
admission; caller iterators are not executed. Sparse, duplicate, unknown and
non-array selections reject. Streams must be enabled by the target configuration;
an unavailable stream fails and restores the prior mode. The API does not enable
raw or lores implicitly or borrow them from the previous mode.

The returned `CapturedStreams` has a `streams` mapping in selection order and
request metadata. Each `PackedStream` reports width, height, format, rowBytes and
a `Uint8Array`. Main/lores BGR888 is tight RGB8; YUV420 is tight I420 with Y, U, V
planes in that order (`rowBytes` is the Y row width). Bayer rows preserve packed
CSI-2 bytes, unpacked little-endian samples or complete PiSP COMP1 blocks and
omit stride padding. Physical bundles do not demosaic or decode COMP1; explicit
copyRaw16/captureRaw16 jobs provide owned sensor samples, as described in
[sensor raw formats](sensor-raw.md). Selected streams share
one request, sequence and control revision; no sequence is fabricated from separate
acquisitions.

All stream ranges share one compact backing allocation. The mode worker transfers
that owned ArrayBuffer once at publication, preserving shared views without a
second structured-clone pixel copy. Each `data` view covers
only its stream range; writing through that view stays in that range. Expanding
a view to its full `.buffer` deliberately exposes the whole owned bundle. Streams
are byte ranges, so offsets need not align for a typed numeric-array constructor.
Use DataView or copy if aligned samples or independent ArrayBuffers are needed.
Ordinary `captureStreams`, focus-locked stream copies and Frame's `copyStream` /
`copyStreams` use the same native bundle path. Metadata and pixels retain no native
camera pointer or additional frame reference.

Mode options retain existing deadlines, frame dropping, autofocus policy,
cancellation and completion callbacks. Pre-request edits are copied; post edits
do not alter the owned result. Post callback failures, mode/preview restoration
failures, cancellation and deadline errors suppress publication. Native leases
retire before restoration. Restored running/stopped state and persistent controls
follow the existing mode transaction. A retained request-return/stop workflow is
separate work; this API returns owned copies rather than a live target request.

## Native and Zig ownership

`zc_copy_frame_streams` accepts a live camera/token, selected stream IDs, caller
layout storage and metadata output. `data=NULL, capacity=0` queries total bytes,
layouts and metadata. Supply caller-owned output for the second call while keeping
the same readable lease alive. Both calls validate every stream under the camera
request lock; the actual copy rechecks stale ownership and active writers.

The 64-byte `zc_packed_stream` layout reports stream ID, dimensions, active first
row bytes, format, byte offset and length in selection order. Capacity must cover
all layouts and all pixels. Every source plane and complete output capacity are
validated before copying. Failure sets only `*size=0`; pixel, layout and metadata
outputs remain untouched. Successful copy leaves extra destination suffix bytes
untouched. Caller output regions must not overlap source pixels, input IDs or
each other. Native caller serialization and existing DMA lease rules still apply.
No allocation happens in this C operation.

Zig `Frame.copyStreams(allocator, ids)` returns `StreamBundle`, which owns its
compact `data` and reports `layouts`, `count` and request `metadata`. `bytes(id)`
returns an optional borrowed view into that owned allocation. Call
`bundle.deinit(allocator)` after use. Bundle values are ownership objects: do not
copy and independently free them. They remain valid after request/camera disposal.

Home video's `Plane`, `packedSize` and `pack` provide shared checked arithmetic
and all-plane preflight; `rows` and `packI420` share that implementation. Camera
adapts its formats/leases to borrowed Home planes. Home does not know camera IDs,
libcamera requests, DMA state or Bun jobs. See
[Home's plane contract](https://github.com/home-lang/home/blob/44bf4e911437251479a4a535fc311e1471cc93d5/packages/video/docs/capture-planes.md).

Tests cover late invalid source geometry without prefix writes, short outputs,
selection order, metadata identity, writers/stale tokens, RGB/I420/Bayer packing,
custom selector getters, stopped/running mode restoration, callbacks, cancellation,
AF/preview restoration and owned results after camera destruction. Shared tests
include aggregate overflow without pixel reads and pinned/development Zig.
These hosted software checks do not establish physical multi-stream timing,
Pi DMA performance or complete Picamera2 parity.
