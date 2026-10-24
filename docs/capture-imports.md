# Caller-provided capture storage

Version 0.118 adds [explicit multi-object planes](capture-planes.md) for linear
YUV420/YVU420/NV12/NV21, with shared-object alias normalization and exact factory
loan reservation. Existing single-window entry points remain available.

Version 0.116 adds Linux imports through CaptureAllocator.importBuffers in
Bun/Zig and zc_capture_allocator_open_imported/zc_capture_allocator_import in C.
These explicitly provision storage for exact negotiated configurations. They
extend persistent allocator ownership. Version 0.117 adds
[automatic negotiated-layout factories](capture-factories.md); multi-object
frames and GPU-specific preparation remain future work.

Query Camera.captureLayout() on a configured camera before capture/start. Its
owned immutable snapshot contains the full camera ID and ordered stream width,
height, stride, frameBytes, bufferCount, format and modifier. These are actual
SDK frameSize/configuration values, including padding. Do not derive them from
requested dimensions or assume frame size equals stride times height.

```ts
import { Camera, CaptureAllocator, type CaptureLayout, type CaptureImportBuffer } from '@zig-utils/camera'
import { closeSync } from 'node:fs'

async function openWithStorage(
  allocator: CaptureAllocator,
  createBuffers: (layout: CaptureLayout) => Promise<readonly (readonly CaptureImportBuffer[])[]>,
) {
  const options = { width: 1920, height: 1080, buffers: 4 }
  const probe = new Camera(options)
  let layout: CaptureLayout
  try { layout = probe.captureLayout() } finally { await probe.close() }
  // Application provider: one distinct DMA-BUF fd per frame, stream-major.
  const buffers = await createBuffers(layout)
  try {
    allocator.importBuffers(layout, buffers)
  } finally {
    for (const fd of new Set(buffers.flat().map(buffer => buffer.fd))) closeSync(fd)
  }
  return new Camera({ ...options, allocator })
}

// Caller keeps this owner through camera teardown and cleanup retries.
const allocator = new CaptureAllocator({ imported: true })
```

The callback in this example belongs to the application. It is not invoked by
the camera library. The application owns input descriptors and must close them
on both success and failure; import never consumes them. Successful imports own
close-on-exec duplicates. Keep each input FD stable/inactive throughout the
synchronous import, then relinquish external CPU/device access until the imported
resources retire. Do not share active storage through another allocator or owner.

Each stream needs exactly bufferCount descriptors. Each descriptor has fd and an
optional offset (default zero). It must expose read/write access, a positive
stable extent, and enough bytes for offset + frameBytes. Offset and frame end
must fit the SDK's uint32 range. Aliases of the same device/inode are rejected
even for disjoint ranges, because separate frame gates cannot coordinate one
shared DMA object. The entire backing extent, including prefix/suffix/padding,
counts against maxBytes. Admission happens before duplication or mapping.

Real camera storage must support DMA_BUF_IOCTL_SYNC; failed START or END rejects
the import and retains cleanup if necessary. Existing camera CPU fences still
govern every access. The import probe is not proof of device/heap compatibility,
physical coherency or a usable sensor pipeline. DMA synchronization errors can
also affect the caller's original object; the caller owns its recovery/disposal.
The [Linux DMA-BUF contract](https://www.kernel.org/doc/html/v6.15/driver-api/dma-buf.html)
defines this CPU synchronization and descriptor ownership boundary.

For tests, set simulate:true on both camera and imported allocator. Inputs must
be Linux memfds sealed with F_SEAL_SHRINK and F_SEAL_GROW, so another descriptor
cannot truncate a live mapping. Mutable files and POSIX shared-memory objects
are rejected. There is no RAM fallback for real imports. Non-Linux imported open
returns UNSUPPORTED; layout snapshots remain available for synthetic cameras.

RO maps and separate lazy RW maps preserve exact unaligned page windows. SDK
FrameBuffers receive owned duplicates and the supplied offsets. Synthetic FD
planes and exports also carry the offset; FD-backed exports avoid staging copies.
Original ABI v1 layouts and allocator config/state layouts are unchanged. The
new C layout snapshot/input structs are 4304/16 bytes; the private SDK buffer
view grows to 40 bytes for its offset and must be rebuilt with the library.

Provision every source/target/rollback mode before switching. Multiple distinct
sets may use the same layout for retained old cameras and reconnect replacements.
Imported pools borrow idle matching sets only: unavailable layouts return
UNSUPPORTED, occupied/retiring matches return BUSY, and no replacement buffers
are silently allocated. trim removes idle sets and retries pending retirement;
future reuse then needs another import. Avoid trimming profiles needed by active
mode workflows. Existing native pins protect workers through camera gaps.

Failed imports can leave a charged retiring entry. Preserve the allocator owner,
inspect state, and retry trim/close. Close remains BUSY with camera loans/pins;
cleanup errors retain the closing owner. Discard after a coherency/device error
never returns that backing to reuse. Source FDs can close after successful import,
but mapped requests/exports continue to own the camera loan until joined.

Zig exposes CaptureImportLayout/Stream/Buffer, Camera.captureLayout,
CaptureAllocator.initImported and importBuffers. C provides
zc_camera_capture_layout_get. Bun snapshots survive camera close and are deeply
frozen. Existing camera, recorder and group mode workers inherit the same pinned
native allocator; users provide the sets rather than synchronous JS callbacks
from native worker threads.

The shared Home owner tests cover full charges, aliases, independent loans and
allocation/cleanup faults. Independent Linux C/SDK peers cover real memfd maps,
offsets and CLOEXEC imports, partial preparation, DMA START/END rejection,
recycled FD close errors and no-fallback discard. Bun tests cover actual layout
snapshots, imports, source descriptor retirement, mode rollback and overlapping
retained cameras. CI runs system libcamera on x86_64/ARM with expected no-camera
smokes. Physical Pi import/capture and matched performance acceptance remain open.
