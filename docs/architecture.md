# Architecture and invariants

`libcamera -> C++ completion callback -> Zig descriptor queue -> frame lease -> consumer`

The C++ boundary discovers/configures a camera, allocates DMA-BUFs with
FrameBufferAllocator, creates a request for each slot, maps every plane once,
and copies only fixed-size metadata into the Zig callback. It does not encode,
copy images or wait for consumers in the camera manager's callback thread.
Zig owns lifecycle, queue policy, bounded descriptors, tokens and API errors.

Each of at most 32 slots is `idle`, `queued`, `ready`, or `leased`. A request is
requeued only after its previous frame is no longer leased. A monotonically
increasing 64-bit token identifies each acquisition; copying a descriptor does
not acquire another reference. Release scans at most 32 slots, rejects stale
and duplicate tokens, and never frees a frame currently in use by the camera.

An operation mutex serializes start/stop, acquisition finalization, DMA sync,
JPEG reads and recycling. A short queue mutex protects callback publication,
ready indices, token changes and statistics. Condition waits release the queue
mutex; stop broadcasts to wake waiters. The operation mutex is never acquired
by the completion callback, and the queue mutex is never held while stopping
libcamera or submitting a request. This avoids callback/stop lock inversion.

Latest-ready policy chooses the newest queued completion at acquisition and
recycles older ready slots. It never recycles an outstanding lease. FIFO takes
the oldest completion. Both queues are bounded by the negotiated buffer count.
A stalled consumer eventually exhausts the available buffers and stalls the
pipeline. This intentionally trades throughput under overload for bounded
memory; it is not an always-running overwrite queue. No automatic dropping
happens until a consumer acquires another frame.

Mapped views account for each plane's fd, page alignment, byte offset, length
and bytes used. CPU access begins with DMA_BUF_IOCTL_SYNC START|READ for each
unique DMA-BUF fd in the request, and ends with END|READ before recycling.
Synchronization errors are surfaced and poison capture. Unsupported ioctls
are not silently ignored, because that would hide coherency bugs on ARM.
Consumers importing fds into GPU/device pipelines must finish their work and
fences before releasing the lease; no external fence integration is supplied.

Stop cancels queued requests and discards ready descriptors. Leased mappings
and metadata remain valid. Restart/close reject outstanding leases. Requests
are destroyed before their buffers, mappings before camera manager teardown.
Callers must serialize lifecycle calls and must ensure no other thread is
accessing a camera during close. The ABI assumes non-null, valid pointers;
raw C callers own that obligation.

The synthetic device supplies deterministic, padded RGB planes and immediate
completions. It exercises the same Zig state machine and C ABI, including
synchronous completion during request submission. It does not emulate sensor
pacing, ISP algorithms, kernel DMA coherency or real libcamera cancellation.
Those require the Pi acceptance procedure in performance.md.

The library allocates descriptors, image buffers and mappings at open. Its
queue/lease path adds no heap allocation or pixel copy after start. libcamera
internals can still allocate on request reuse; JPEG and Python wrappers also
allocate. No lock-free or global zero-allocation claim is made.
