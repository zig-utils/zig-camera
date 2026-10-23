# Supervised frame processing

Version 0.89 adds `ProcessPool` for actual Bun child processes. One worker gives
the single-process capability; several workers use Home's least-pending dispatch
with rotating ties. C/Zig expose the native ownership/session layer independently.
No Python or FFmpeg is used. This adds supervised processing, not full Picamera2
remote convenience, allocator, hardware or overall capability parity.

Create a local module exporting `run` (or a default function), with optional
`init` and `close` exports:

```ts
import type { ProcessModule } from '@zig-utils/camera'

export const init: ProcessModule['init'] = context => ({ calls: 0 })
export const run: ProcessModule['run'] = (request, data, context) => {
  using image = request.makeImage('lores')
  return {
    sequence: request.info().metadata.sequence,
    width: image.width,
    height: image.height,
    rgb: image.copyPixels(), // independent owned return data
  }
}
```

```ts
import { Camera, ProcessPool } from '@zig-utils/camera'

const camera = new Camera({
  width: 1920, height: 1080,
  lores: { width: 320, height: 240, format: 'BGR888' },
})
let pool: ProcessPool | undefined
try {
  pool = await ProcessPool.open({
    module: new URL('./processor.ts', import.meta.url),
    workers: 2,
    camera, // optional initial properties/options/info/orientation snapshot
    context: { purpose: 'trail processing' },
  })
  camera.start()
  using frame = camera.acquire()
  const job = pool.submit(frame, { label: 'sample' }, {
    streams: ['main', 'lores'], timeoutMs: 30_000,
  })
  frame.release() // successful submit moved a separate export into native ownership
  const result = await job
  await pool.drain()
} finally {
  try { await pool?.close({ drain: false }) }
  finally { await camera.close() }
}
```

`init` runs once per worker generation, and its return value becomes child-local
`context.state`. The copied startup input is `context.initial`, with worker index
and generation alongside it. When `camera` is supplied, initial input has
`{ context, camera: { id, options, properties, info, orientation } }`; otherwise it
is the supplied context directly. Those snapshots are owned, subject to clone
limits, and do not track later camera changes. Per-request negotiated geometry,
formats, color and scalar/full typed metadata come from the remote frame.

Native code owns queued exports and argument bytes. A successful submit moves
the export; failure consumes neither caller-owned input nor an unaccepted job.
Ordinary queue capacity is preflighted before allocating/staging a source export,
then revalidated atomically on submission. One frame is sent per worker at a time
through actual SCM_RIGHTS; no parent pointer crosses the process boundary.
The original request may release or the camera may stop while processing. Its
buffers cannot be recycled/destroyed while the native export remains retained.

The child serializes an independent result while its remote owner is live,
closes all maps/descriptors, queues the result and sends an ACK. The parent routes
both messages by monotonic cookie and worker generation, accepting either arrival
order. It retires camera/argument ownership before publishing the job result.
Readonly Bun access explicitly copies pixels; native C/Zig const maps and opt-in
synchronous writable plane scopes retain the underlying borrowed-map contract.
Borrowed views/fds must not be forwarded to other workers or descendants. These
are cooperating-process APIs, not an adversarial sandbox.

Queued cancellation retires an unsent export directly. Active cancellation,
missing/bad transport, unexpected exit and startup failure quarantine the affected
worker. Sending a signal, disconnecting IPC or setting a stopped flag is not exit
proof: the parent awaits `child.exited` before marking native sent tasks joined.
Assigned queued work fails; healthy workers continue. Worker errors use
`ProcessWorkerError`, with actual exit code when known and original details;
handler/serialization failures use `ProcessRemoteError` and preserve the worker.
An error-order race between socket closure and exit notifications is normalized
without dropping its underlying cause. Cleanup/DMA errors remain observable.

`restart(index)` joins that generation, waits its native/callback cleanup prefix,
prepares new endpoints and advances to a fresh generation/PID. Stale messages
cannot satisfy replacement jobs. Init runs again. A failed worker is not silently
respawned; callers choose when to restart. No mapping cache uses fd integers as
buffer identities.

`drainAsync`/`drain` observe a fixed native admission prefix, including slow
completion callbacks; later submissions do not extend it. Cancellation of a drain
stops the observer, not the processors. Source owners retire before callbacks,
but native task/result reservations remain charged until callback cleanup.
Inspect `job.callbackError` separately from its operation result. Calls to drain,
restart or close from the pool's own completion callback reject with BUSY to
avoid self-waiting. `job.operationDone` and `job.cleanupDone` retain the shared
Bun job semantics.

`close()` drains and runs module close hooks, then joins every peer.
`close({drain:false})` cancels queued/active work and joins it; it can also escalate
an already draining close while returning the same close promise. Native close
refuses outstanding tasks or unjoined workers. Module close failures/nonzero exit
and bounded shutdown timeout are reported after cleanup, including when the pool
is already closed. Unverifiable exit must not be treated as permission to recycle
a source. Callers must still join their own outstanding native API calls.

Defaults and limits are independent of device/OS storage:

| Resource | Default | Maximum |
| --- | --- | --- |
| Native sessions per library/process | — | 8 |
| Workers per pool | 1 | 8 |
| Pending tasks, including callbacks | 16 | 32, subject to byte admission |
| Argument bytes per task | 1 MiB | 16 MiB |
| Successful result bytes per task | 4 MiB | 256 MiB |
| Aggregate argument + reserved result cost | 128 MiB | 512 MiB |
| Initial context | — | 4 MiB |
| Drain observers | — | 32 |
| Startup / shutdown intervals | 30 s / 5 s | finite nonnegative milliseconds |
| Job interval | 30 s | finite nonnegative milliseconds or null (disabled) |

Admission reserves arguments plus the larger of the configured result ceiling
and the 64 KiB error-envelope ceiling **before dispatch**. It stays charged
through completion cleanup, bounding returned data as well as input. Raise the
result and aggregate limits explicitly for large image results. This is declared
payload accounting, not an RSS ceiling: serialization/deserialization copies,
graphs, kernel/socket/device storage, worker heaps and process overhead are extra.
Caller-retained completed values are independently owned. Zero job intervals and
already-aborted signals reject before source acquisition; other admission errors
can reject synchronously. Accepted jobs settle after joined native retirement.

The bounded snapshot format supports plain graphs/cycles, arrays, dates, maps,
sets, ArrayBuffers and numeric views. It preserves buffer/view aliases and
evaluates application getters once on accepted snapshots. Graphs have at most
4096 visited nodes/edges, depth 64 and 4096-bit bigints. Full backing buffers count
toward the limit. Functions, symbols, custom/native owner instances and shared
memory reject. Return owned pixels/encoded bytes rather than a live CapturedImage
or mapped view. The framework queues at most one argument/result envelope per
worker; arbitrary user code's own IPC/allocations are outside that contract.

Home's portable dispatch policy is reused verbatim, with existing reservation,
completion, descriptor, metadata and Home image paths. Home OS kernel wait/stdio
scaffolding does not replace hosted process joining; see the reuse audits.
Validation includes 420 native tests, independent C exec ACK/SIGKILL ownership
and ABI checks, all 1240 Bun media tests with independent decoders/SDL, and 30
worker-failure diagnostic repetitions. Main/lores precision across all 14
processed formats, source release/stop, actual CPU-bound cancellation, fair
dispatch, worker isolation/restart, result reservations, callback
drains and a multi-MiB image result are exercised. The seven portable helper tests
pass pinned/development Zig in Debug/ReleaseSafe and cross-link Linux ARM/x86.
The normal local build runner still fails macOS SDK/libSystem linkage before
compilation; direct native builds pass. Consumer platform/real-backend CI remains
a publication gate. No physical Pi DMA, camera latency/FPS or speedup is inferred.

Remaining work includes complete remote tight-array/buffer/save/DNG conveniences,
per-request configuration/property semantics, richer cloneable values, automatic
recovery policy and persistent allocator/GPU integration, plus the other parity
families and hardware acceptance in parity-plan.md. This does not complete the goal.
