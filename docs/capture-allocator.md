# Persistent capture allocators

Version 0.117 adds [automatic negotiated-layout factories](capture-factories.md)
with async Bun Camera.open, joined caller-input release and native worker ownership.

Version 0.116 also supports [explicitly imported Linux buffers](capture-imports.md),
using the same camera/request/map/export and worker ownership. Query captureLayout
for exact actual geometry and provision independent FD sets before opening modes.

Version 0.115 adds `CaptureAllocator` in Zig/Bun and additive C allocator handles.
Pass one to Camera to retain bounded backing and mappings across compatible
reopens, temporary captures, permanent modes, recorder/group switches, rollback
and reconnect attempts. Cameras without one retain SDK allocation behavior.

```ts
import { Camera, CaptureAllocator } from '@zig-utils/camera'

const allocator = new CaptureAllocator({ maxEntries: 4, maxBytes: 512 * 1024 ** 2 })
const camera = new Camera({ allocator, width: 1920, height: 1080, buffers: 4 })
try {
  camera.start()
  const image = await camera.switchModeAndCaptureRGB({
    width: 4056, height: 3040, buffers: 2, role: 'still',
  })
  console.log(image.length, allocator.state)
} finally {
  await camera.close()
  allocator.close()
}
```

These sizes are application requests, not a sensor recommendation or guaranteed
negotiated mode. Use `simulate: true` on both objects for synthetic tests.
Allocators belong to the same loaded library/backend as their cameras. Several
active cameras can share one budget. Mode changes inherit the allocator and
cannot replace it. Copying camera options preserves the object; workers receive
native pointers protected by distinct native pins across camera gaps.

The Home provider owns Linux DMA heap FDs with close-on-exec and persistent
read-only maps. Writable cameras lazily prepare separate read/write maps before
publishing writable pointers. Original read maps remain immutable for later
read-only reopens. SDK imports own close-on-exec duplicates. Existing CPU
START/END fences and frame read/shared versus write/exclusive gates still govern
CPU access. Physical cameras never fall back to RAM. Synthetic backing uses
ordinary owned RAM, reports FD -1, and makes no physical-address/DMA claim.

Discovery tries `/dev/dma_heap/vidbuf_cached`, modern
`/dev/dma_heap/default_cma_region`, then legacy `/dev/dma_heap/linux,cma`.
Only absent/unavailable heaps advance discovery; other errors are reported.
`heapPath` selects a single explicit name under `/dev/dma_heap/`. The modern CMA
name is documented in the [Linux heap interface](https://docs.kernel.org/userspace-api/dma-buf-heaps.html).
Actual page size determines backing charges; 4K/16K/64K rounding and overflow
have dedicated tests.

Reuse requires full camera identity and exact actual stream order/count,
format/modifier, width, height, stride, frame size, rounded backing size and
buffer count. Keys own their bytes and never rely on labels, prefixes or hashes
alone. Each entry has one exclusive camera loan. A disconnected camera may keep
frames while its replacement obtains independent backing for the same layout,
within the same budget. Matching idle storage is preferred. Request, map,
export and remote ACK owners continue to prevent camera close and buffer reuse.

`maxEntries` defaults to 4 and accepts 1..16. `maxBytes` defaults to 512 MiB and
accepts 1 byte..8 GiB. The bound includes page rounding and every preparing,
borrowed, idle or retiring entry. Fixed policy/descriptor overhead is additional;
this is not a total RSS bound. Full admission evicts only oldest idle entries.
An oversized target rejects before eviction, permitting cached-source rollback.
A one-entry cache can evict the old idle mode to switch; rollback after eviction
may require a new allocation and can fail under resource pressure. Existing
mode-job error/cleanup owners retain failed restoration state.

`state` reports entries, borrowed loans, worker pins, retirement/closing state,
current/high backing bytes, preparations/reuses/retirements, prepared buffers,
additional write maps, cleanup errors and last provider errno. These counters
do not establish camera FPS or a speedup. `trim()` frees idle entries and retries
pending cleanup while preserving active loans. `close()` returns BUSY while
cameras or pins survive. Workers retire pins through completion, restoration,
queued/active cancellation, construction failure and dispatch failure.

Failed unmap retains its map and FD; successful earlier destruction stays cleared.
Linux late-close/EINTR consumes FD ownership and is reported once, so retry never
closes a recycled number. Full entry charges survive until every resource is gone.
Failed close retains the owner in `closing` state, blocks new opens/pins and
permits state/trim/close for retry. Keep the owner reference, retire frame/map/
export owners, join camera jobs, then retry. Bun close is idempotent after success.

Zig exposes `defaultCaptureAllocatorConfig`, `CaptureAllocator` state/pin/unpin/
trim/close, `Camera.initAllocated` and `Camera.initAllocatedPipeline`. Do not copy
an owned allocator; passing it to Camera borrows its handle. C config/state are
24/112 bytes, preserving original ABI v1 layouts. C provides distinct pins,
`zc_open_allocated_pipeline` and a borrowed camera allocator getter. Serialize
final close with new calls; hold a pin across native worker/camera gaps.

Home 2f4a6a7ac3a8d229d5f7b16f91a69f33c69e8395 supplies the verbatim policy,
provider owner, synthetic provider and explicit Linux host entry. Portable tests
cover Zig 0.15.2 and Home development Zig in Debug/ReleaseSafe/ReleaseFast.
Native Linux UAPI translation uses Zig 0.15.2, matching the KMS boundary.
The independent C peer supplies actual memfd-backed shared mappings and injects
allocation/map/unmap/late-close faults. Thirteen scenarios also exercise system
libcamera FrameBuffer imports, duplicate FD lifetime and retryable native close.
They prove ownership against a Linux peer, not physical DMA/camera acceptance.

Local validation passes 592 native tests, the C ABI test with retained maps and
exports, and Bun tests for reuse, temporary/permanent modes, budget/rollback,
eviction, cancellation, worker failure, overlapping reconnect and coordinated
single/eight-encoder switches. CI retains Linux x86/ARM real-backend build/load/
no-camera smokes and macOS coverage. Physical Pi heap/import/coherency, sustained
capture and matched performance acceptance remain open. Arbitrary allocator
callbacks, GPU storage and the other families in parity-plan.md remain open.

A failed CPU START/END fence, invalid frame metadata, terminal device loss or
fatal camera state marks backing for retirement after every SDK/request owner has
joined. SDK destruction performs bookkeeping only; the entry never returns to
idle reuse. Its full charge survives until cleanup. Full-admission replacement
first joins pending retirement, then prepares fresh backing. Both failed START
and failed END have end-to-end native reopen tests; C++ tests also check sticky
failure marking and partial START rollback. The independent heap peer covers
explicit discard with independent replacement storage.
