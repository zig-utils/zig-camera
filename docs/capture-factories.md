# Automatic capture buffer factories

Version 0.117 adds Linux imported-allocator factories in Bun and an additive C
notification protocol. They extend [explicit buffer imports](capture-imports.md)
and use the same whole-object budgets, FD identity/offset checks, DMA coherency
validation and retained cleanup. A factory runs after libcamera has negotiated
its actual configuration, before the SDK imports its buffers. Initial capture
needs no temporary probe camera.

```ts
const allocator = new CaptureAllocator({
  maxEntries: 4,
  maxBytes: 512 * 1024 ** 2,
  factory: async ({ layout, signal, restoring }) => {
    // Application code supplies separate supported Linux DMA-BUF FDs for each
    // frame, in layout.streams order. Synthetic tests use grow/shrink-sealed
    // memfds. Each object's extent must cover offset + stream.frameBytes.
    const inputs = await applicationStorage.prepare(layout, { signal, restoring })
    return {
      buffers: inputs.buffers,
      async release() { await inputs.closeOriginalDescriptors() },
    }
  },
})
const camera = await Camera.open({ allocator, width: 1920, height: 1080 })
try {
  camera.start()
  // The allocator follows mode, temporary capture, recorder and reconnect jobs.
  // An idle exact-layout profile is reused without invoking the factory.
} finally {
  await camera.close()
  allocator.close()
}
```

`factory` implies `imported: true`; `imported: false` conflicts. These imported
owners are Linux-only. Existing managed allocators and explicitly provisioned
imports keep their synchronous constructor path. A factory allocator requires
`await Camera.open(options, { signal?, timeoutMs? })`; the timeout defaults to
30 seconds. Its factory runs on the creating Bun thread, while configuration
runs in a worker. Calling the synchronous constructor with a factory fails
before acquiring camera ownership, even if a cached profile happens to exist.

The frozen context contains the actual full camera ID, stream geometry/format/
modifier, cooperative AbortSignal, `restoring`, and bigint request/operation IDs.
Each stream needs exactly its negotiated buffer count. The factory may be
called concurrently for independent cameras, including identical layouts while
another owner retains the first set. No physical frame backing may alias across
live profiles. An existing exact idle profile bypasses the callback; no implicit
fallback allocation or eviction occurs for imported storage. Applications may
trim idle profiles explicitly; budget or entry exhaustion otherwise rejects.

Input descriptors remain the application's property. Native import validates,
duplicates and reserves them under the allocator mutex; the factory's optional
`release` then runs exactly once, including on cancellation or import failure.
It may return a promise. Native publication waits for that cleanup to join.
The library never closes the caller's original descriptors or retries an
arbitrary application closer. An invalid/failed release reports a nested
`CaptureFactoryError` with `returnedInputs` for application recovery. Failed
unpublished native duplicates stay in bounded retirement ownership and are
retried before another factory import, without evicting idle rollback profiles.

Cancellation stops the waiting target cooperatively. A queued/claimed producer
still retires and its returned inputs still receive release before the job
settles. A producer that ignores cancellation keeps the operation and allocator
pin live until it returns; there is no forced promise abandonment. Mandatory
rollback has `restoring: true` and a fresh signal that ignores target cancellation
and deadline. A fatal worker failure cancels both target and restoration.

Factories must not await the operation currently waiting for their result.
Returned inputs with failed cleanup must be recovered by the application before
discarding their diagnostic error. Bun operations consume their scope's factory
errors into the returned failure; raw C scope users can collect diagnostics with
`allocator.takeFactoryErrors()`. Unconsumed diagnostics have 64 reserved slots;
new application factory work gets BUSY before creating input owners when full.

## Native ownership and C integration

The C functions are declared in zig_camera.h. Register a void notification with
`zc_capture_allocator_factory_set` before any scopes/cameras/pins. Notifications
may be marshalled asynchronously: their return value is never a result.
`factory_begin` claims a generation-specific ticket and copies a pointer-free
layout plus scope/restoration state. If `accepting` is zero, skip application
work and still call `factory_finish`. Otherwise supply an owned flat stream-major
FD list with `factory_supply`, finish caller-input cleanup, then call
`factory_finish(result)`. A success without supply is STATE and retains the
claim for a failure finish. Duplicate/late notifications do not acquire a new
request; consumed tickets return STALE.

A native opening scope pins the allocator and owns its original or newly opened
camera. Attach the opening thread, use the scoped open/start/stop/close calls,
and detach before transferring its camera with `scope_take`. There are 32 scopes
and 16 pending notifications per pool. The notification and waiting thread keep
separate references; cancellation cannot free a late callback's context.

Bun worker close is not native-thread retirement proof. Home's POSIX attachment
owner tracks explicit detach and actual pthread exit. The main-thread owner
joins pending factories and native thread detachment before taking camera
ownership and unpinning. BUSY or failed native disposal keeps an explicit cleanup
owner through CameraCleanupError. Initial factory open, mode changes and fresh
reconnects all use this same ownership path.

This is software allocation/ownership coverage. Physical Pi DMA-BUF capability,
cache coherency, multi-object/GPU layouts and matched Picamera2 throughput remain
acceptance work. Full Picamera2 parity is still in progress.
