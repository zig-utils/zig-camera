# Manager hotplug watches

Version 0.67 adds manager-wide added/removed observation through Zig/C and Bun.
The watch owns a shared libcamera manager lease without acquiring a camera. It
stays alive through camera close/reopen and mode-switch gaps, retaining the
existing tuning profile/file/environment policy until its manager lease ends.

```ts
import { Camera, TuningSession } from '@zig-utils/camera'

// Optional: reserve the profile before starting any default manager/watch.
using profile = Camera.loadTuningFile('imx708.json', { platform: 'pisp' })
using tuning = TuningSession.open(profile)
await using watch = Camera.watchCameras({ capacity: 32 })
let cameras = watch.discover()
let missed = 0n
while (true) {
  const event = await watch.next({ timeoutMs: 60000 })
  console.log(event.kind, event.id, event.sequence)
  // Events invalidate the snapshot. A changed missed counter or rescan marker
  // explicitly requires discovery again, even if the matching event was lost.
  cameras = watch.discover()
  missed = event.missed
  console.log(cameras, missed)
}
```

An event contains `backend`, `kind` (`added`, `removed`, `rescan`), an exact `id`
for added/removed, a per-watch `sequence`, and cumulative `missed`. Sequence starts
at one. Full IDs up to 4096 UTF-8 bytes are copied without normalization, borrowed
pointers or truncation. SDK IDs that cannot be represented become an ID-less
rescan marker and increment missed. Sequence and missed saturate rather than
wrap; sequence exhaustion forces rescan markers for all further notifications.

The libcamera manager signals used are documented in its
[CameraManager header](https://github.com/raspberrypi/libcamera/blob/main/include/libcamera/camera_manager.h).
Member slots are retired under a relay mutex, joined before freeing the Zig
context, then disconnected while the watch still owns the manager. This follows
libcamera's [concurrent signal connection/disconnection contract](https://github.com/libcamera-org/libcamera/blob/master/src/libcamera/base/signal.cpp).
Callbacks copy into preallocated Home FIFO storage and wake native waiters. They
perform no catalog serialization, heap allocation, output I/O or application work.
SDK internals and signal invocation machinery are outside that allocation claim.

## Bounds and snapshot semantics

Capacity is 1..64 events, default 32 in Bun; at most 32 native watches per backend
may be live. Each preallocates capacity times 4096 payload bytes plus entry and
owner storage. A full queue evicts its oldest event and increments missed. That
counter is copied at consumption, so even the first surviving event exposes loss.
Different watches own separate queues; events within one watch are consumed once.
Multiple `next()` calls are competing consumers, not broadcast subscriptions.

Open the watch before discovering. Opening does not synthesize initial added
events, and discovery is not atomic with the event stream. Events arriving after
subscription invalidate discovery snapshots, including an event queued while a
snapshot is copied. Rescan on events or a change in missed rather than treating a
snapshot as a permanent topology. This is observation of SDK notifications, not a
guarantee that a removed camera has physically stopped DMA or a new camera is
ready to open. A disconnected native camera remains terminal; reappearance must
use a fresh Camera instance and negotiate again. Version 0.68's
[reconnect job](reconnection.md) automates bounded discovery/open/settings replay
into a fresh owner. Continuous background supervision, transactional recorder
restart after device replacement, and physical hotplug acceptance remain parity work.

Bun queues at most 32 `next()` jobs, with one 2 ms idle poll per watch and no timer
when no jobs are pending. Jobs support cancellation, deadline and signalFunction.
Cancelled waits do not consume an event. A consumed event is sealed in the same
JavaScript turn, so later cancellation cannot revoke delivery. Values are frozen,
owned snapshots. A watch remains responsible for its native manager lease until
`stop()` or `close()`; use `await using` or a finally block.

Version 0.67.1 rechecks admission after job construction,
including reentry through customized AbortSignal methods: stopped/closing or full
watches return a cancelled unclaimed job without adding a waiter or poll timer.

`stop()` synchronously retires native subscription and cancels Bun waits. Bun
rejects new waits/discovery after stop; state remains queryable until close.
`close()` joins operation cleanup and frees the watch, is idempotent, and supports
reentry from abort/completion callbacks. It does not await user completion hooks,
which may themselves call close. Wait/close failures use existing CameraError
codes. Native C/Zig can drain queued events after stop, then receive
`ZC_CANCELLED` / `error.Cancelled`. Native close first stops and returns BUSY if
blocking native waiters have not yet exited; join them and retry. Other entries
must be synchronized with close; a freed pointer must never be reused.

## Zig and C

Zig `CameraWatch.init(backend, capacity)` supplies `wait(timeout_ms)`, `state()`,
`stop()` and retryable `close()`. `CameraEvent` and `CameraWatchState` alias the
additive C structures. `zc_camera_watch_open/wait/get_state/stop/close` are the C
entry points. Failed waits preserve the output bytes, and failed opens clear the
output handle. Existing ABI layouts/status values remain unchanged.

Synthetic `simulateEvent` / `zc_camera_watch_simulate_event` injects into just the
specified synthetic watch. It is a queue/ownership diagnostic, not a synthetic
USB topology implementation: discovery and camera capture availability stay
unchanged. Real watches reject injection with UNSUPPORTED.

Validation includes full-length IDs, owned copies, queue wrap/eviction, invalid
SDK ID rescan, sequence saturation, cancellation/deadline, coalesced bounded jobs,
stop wakeups, reentrant close, tuning lease retention, and C/Zig/Bun API tests.
Linux x86/ARM CI compiles the real system-STL bridge, exercises relay retirement
and starts/stops actual no-camera manager watches. No camera is attached here;
physical removal/addition, reconnect timing, IPA initialization after hotplug and
Pi sustained capture are not established by these tests.
