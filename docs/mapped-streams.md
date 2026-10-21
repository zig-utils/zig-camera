# Scoped mapped streams

Frame.mapStream exposes an owned zero-copy view of main/raw/lores buffers.
Enable writable:true when creating the camera. Default capture retains its
existing READ-only mappings and DMA fences. Opt-in buffers permit writes and use
READ|WRITE fences for the entire CPU lease, from first acquire to final release.
There is no fence-mode transition while references are live. Permission failure
rejects writable setup; it cannot silently produce a read-only write view.

```ts
await using camera = new Camera({ width: 1280, height: 720, writable: true })
using request = await camera.captureRequest()
request.withMappedStream(mapped => {
  mapped.row(0).fill(0) // tight RGB row, excludes padding
})
const edited = request.copyRGB()

using mapped = request.mapStream('main')
request.release()
await processPixels(mapped.planes[0].bytes) // mapped owns its own native reference
mapped.close()
```

Each map retains a distinct Home generation-checked lease and reserves producer
capacity. It keeps its physical buffer pinned even if the original request is
released or the camera stops. Close/restart/mode changes reject outstanding map
owners as they reject retained frames. stats.leased counts physical buffers;
Frame.referenceCount includes map owners. The same bounded 256-reference table
limits all owners. A failed map admission preserves the original reference and
access state; no hidden unbounded map registry is created.

Bun maps take exclusive write access, including for inspection. Start with exactly
one external reference to that request: close other maps or release siblings
first. During the map, Frame.copyRGB/copyStream/saveJPEG/saveDNG, new retention,
other maps and safe recorder frame inputs reject BUSY. Stored metadata remains
readable, and the original owner may release. Once the map closes, remaining
owners can read/copy/encode the edited pixels. Existing native descriptor-based
low-level APIs still require the caller to serialize all borrowed pixel access.

MappedStream has width, height, stride, format and planes. Each plane exposes
bytesUsed, allocated length, DMA offset, borrowed fd, and bytes covering only the
valid payload. Bytes include row padding; never close the borrowed fd. row(y)
returns a tight RGB or supported Bayer row without padding. I420 logical
components use row(y, 0), row(y, 1), row(y, 2) for Y/U/V, handling one contiguous
plane or three physical planes. Unknown formats still expose raw planes;
unsupported row layouts reject rather than inventing a shape. Packed Bayer stays
packed. PiSP compressed raw and general pixel-format conversions remain separate
parity work.

map.close and Symbol.dispose detach every ordinary Bun ArrayBuffer alias before
retiring the native owner. Escaped rows, subarrays and DataViews become detached;
they cannot keep accessing a requeued buffer. Mapping methods reject after close.
Use bytes.slice() for owned data. Do not transfer mapped ArrayBuffers or send
their pointers/views to another thread. Detachment is a scoped lifetime rule, not
a general sandbox for arbitrary FFI or intentional buffer-ownership tampering.
A detachment failure preserves the native owner for retry. A native retirement
error consumes the mapping, leaves its views detached and reports the error;
close never retries a consumed handle. DMA failure prevents camera requeue.

withMappedStream closes on return or throw and rejects thenables. It is for
synchronous work; use a using-bound map for operations crossing await. Returning
a view from the scoped callback yields an already detached view; return a copy if
needed. Explicit map objects must be disposed. Callback/close errors follow Bun's
standard using/SuppressedError behavior. Edits are in-place and are not rolled back
if an edit callback throws.

Writable policy is captured once at camera admission and inherited by mode jobs
unless writable:false explicitly opts out. Permanent switches, temporary captures,
coordinated recorder mode switches and rollback configure permissions before the
replacement starts. Read-only temporary targets restore the old writable policy.
Version 0.40 adds [pre/post request callbacks](request-callbacks.md). The pump now
orders pre edits, capture/copy, post edits, recording input and preview. Post edits
affect encoded/displayed pixels and retained requests, while an earlier owned copy
preserves its pre-stage pixels. Hook scopes automatically close their mappings.

Native zc_enable_writable is allowed before the first start. zc_frame_map_open
takes a frame token, stream and write flag; native read maps may share READ access,
while write maps enforce exclusive ownership. zc_frame_map_stream copies borrowed
plane descriptors; zc_frame_map_close consumes the map even on retirement error.
Native/Zig borrowed views expire on map close and must not be used concurrently
with a writer. zc_frame_readable and the additive zc_copy_frame_rgb validate
pixel access by live token. Original ABI layouts and functions are unchanged.
Zig Camera.enableWritable and Frame.mapStream return FrameMapping, with const
plane and checked writablePlane methods and an idempotent deinit.

Home frame_access supplies the allocation-free reader/writer policy; lease_pool
owns generations, reference bounds and producer reservation. Tests cover alias
exclusion, parent release, stop/close, capacity, generation exhaustion, DMA failure,
RGB/chroma/Bayer edits, detached views, thenables, recorder guards and mode policy.
Linux bridge tests check real mmap write permissions and DMA flag/cleanup calls
without hardware. Actual Pi DMA coherence and optical results still require
hardware acceptance under the [kernel CPU-access contract](https://docs.kernel.org/driver-api/dma-buf.html).
