# Capture planes backed by multiple objects

Version 0.118 extends imported allocators and automatic factories to explicit
physical planes. Existing single-window imports remain supported. Linear YUV420
and YVU420 may use three planes; NV12 and NV21 may use two. Each plane has its
own descriptor, offset and declared length. Disjoint planes within one frame
may share the same underlying object, including through different FD aliases.

```ts
import { Camera, CaptureAllocator, type CaptureImportFrame } from '@zig-utils/camera'

const allocator = new CaptureAllocator({
  factory: async ({ layout, signal }) => {
    // Application-owned Linux DMA-BUF provider. Return stream-major frames,
    // each with exactly the negotiated buffer count. Synthetic tests use
    // grow/shrink-sealed memfds instead of claiming to emulate DMA hardware.
    const prepared = await applicationStorage.preparePlanes(layout, signal)
    const buffers: CaptureImportFrame[][] = prepared.frames
    return { buffers, release: () => prepared.closeOriginalDescriptors() }
  },
})
const camera = await Camera.open({ allocator, format: 'YUV420' })
try {
  camera.start()
  using frame = camera.acquire()
  // Recording, copied images, exported descriptors and remote workers retain
  // the existing whole-request access/ownership gates.
} finally {
  await camera.close()
  allocator.close()
}
```

A frame record is either the existing `{ fd, offset? }` form, representing one
complete contiguous frame, or `{ planes: [{ fd, offset?, length }, ...] }`.
Lengths/offsets accept exact safe integers or bigint. Descriptor records and
stream/plane lists are copied as bounded scalar snapshots before native import;
caller-owned iterators cannot create unbounded preparation. Manual provisioning
uses `allocator.importFrames(layout, streamMajorFrames)`; the existing
`importBuffers` entry point retains its original ABI and input type.

For planar 4:2:0 the Y plane covers at least `stride * height` and each chroma
plane at least `(stride / 2) * (height / 2)`. Semi-planar Y has the same minimum,
and UV/VU covers at least `stride * (height / 2)`. Width, height and stride must
be even. Plane order is physical order: Y/U/V for YUV420, Y/V/U for YVU420,
Y/UV for NV12 and Y/VU for NV21. Aggregate declared capacity must also cover the
actual negotiated frameBytes, including allocation padding. These minima do
not establish a particular device's accepted buffer layout.

One-plane imports continue to cover the configured frame size, including raw,
packed RGB and RGB16. The ABI has four plane slots, but this release supports
the above multi-plane formats. Other plane counts/layouts and nonzero modifiers
with multiple planes reject explicitly. Nonlinear and GPU-only storage, graphics
API integration and other per-plane stride conventions remain separate work.

The shared Home owner checks each descriptor's stable identity/extent, rejects
overlapping plane ranges and groups same-object aliases into one resource. It
duplicates and charges each whole object once, rather than charging it once per
plane. Each resource has one RO mapping and at most one lazy RW mapping; each
view retains its individual offset/length. Objects may not alias across separate
frames, streams or retained allocator entries, even for disjoint ranges.

The libcamera bridge adopts one SDK descriptor per physical object, shares that
SDK reference between its planes, and builds one CPU DMA fence list per frame.
A failed bind leaves the prior stream and fence table intact. Writable upgrades
prepare every plane before changing published descriptors. Synthetic setup writes
the supplied component windows directly through Home's existing planar encoders,
without adding a capture staging buffer. Its logical negotiated frame sizes
remain independent of the first physical plane's length.

Factories reserve the exact newly prepared loan. They cannot accidentally select
an older matching profile that became idle during asynchronous preparation.
Input release still runs once and joins before publication; cancellation and
failed release discard unpublished loans into retained cleanup ownership. Partial
map/unmap failures preserve the full object charge and remain retryable through
trim/close. Source profiles needed for rollback are preserved during pending-only
cleanup. Keep caller descriptors inactive/stable until synchronous import ends,
and close each original descriptor once through its application owner.

Zig exposes CaptureImportPlane/CaptureImportFrame and CaptureAllocator.importFrames.
C adds 24-byte plane and 104-byte frame records, import_frames and factory
supply_frames. Existing config/state, 16-byte buffer and 4304-byte layout records
are unchanged. The SDK's private frame descriptor is 168 bytes; both bridges and
all headers are built together, with explicit header dependencies.

Coverage includes independent kernel FD/map/extent and cleanup fault peers,
system SDK construction/binding, aliased descriptors, unique DMA probe/map
counts, planar pixel parity, writable views, non-staged export, producer snapshots,
SCM_RIGHTS processing and temporary mode restoration. Physical Pi allocation,
device layout acceptance, CPU/GPU coherency and throughput still require hardware.
This does not establish full Picamera2 parity or a measured speedup.
