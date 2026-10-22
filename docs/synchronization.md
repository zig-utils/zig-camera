# Software-sync request selection

`Camera.captureSyncRequestAsync(options)` and `captureSyncRequest(options)` select
the first qualifying request with explicitly true `SyncReady` metadata. They
provide Picamera2's `capture_sync_request` capability through the existing Bun
capture queue. A returned Frame is an ordinary retained owner; use `using` or
release it explicitly. All its main/raw/lores streams belong to that request.

```ts
import { Camera, Control } from '@zig-utils/camera'

const camera = new Camera({ role: 'video' })
try {
  camera.setControls([{
    id: Control.frameDurationLimits,
    type: 'int',
    values: [33333, 33333],
  }])
  camera.setSynchronization('server', { frames: 120 })
  using request = await camera.captureSyncRequest({ timeoutMs: 30000 })
  console.log(request.synchronization(), request.metadata())
  request.saveFile('synchronized.jpg')
} finally {
  await camera.close()
}
```

Set matching fixed frame rates on all participants and configure the deployed
libcamera Raspberry Pi sync algorithm/network appropriately. Select `client`
on each client camera. `setSynchronization('off')` disables it. These controls
configure the camera backend's algorithm; zig-camera does not create a separate
UDP synchronization protocol, estimate offsets from host timestamps, or generate
readiness itself for real cameras. The Raspberry Pi
[control specification](https://github.com/raspberrypi/libcamera/blob/main/src/libcamera/control_ids_rpi.yaml)
defines SyncMode, SyncFrames, SyncReady and the signed-microsecond SyncTimer.
The pinned [Picamera2 source](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/picamera2.py)
selects requests using SyncReady, rather than a timestamp proximity heuristic.

`setSynchronization(mode, { frames? })` resolves advertised scalar int32 controls
by exact name and backend vendor (`rpi`/`libcamera`, or unavailable provenance on
older headers). The mode values are off=0, server=1, client=2. A supplied positive
int32 `frames` is server-only and is committed atomically with the mode. Omission
keeps the backend's existing frame setting. Invalid, unavailable, ambiguous,
wrong-type or read-only controls reject without a partial update. Native range
validation remains authoritative. Settings participate in existing typed control
snapshots/replay across camera mode transactions; they do not transfer a previous
session's ready state into a newly started algorithm.

`Frame.synchronization()` returns an immutable owned observation:
`{ ready?: boolean, timerUs?: bigint }`. Missing fields remain absent, distinct
from false or zero. Timer values retain signed 64-bit precision, including
negative values after the ready time. Neither the timer nor matching host
timestamps substitute for true SyncReady. `metadataCatalog()` also retains the
backend's complete typed values. Pre/post request callback views expose the same
synchronization query for their scoped request.

The query reads the exact leased request, without serializing a full catalog,
copying pixels or allocating in the native path. A retained pending request does
not change when a later request becomes ready or controls change. Its metadata
remains readable after stop, until final release; stale queries fail. C ABI v1
layouts remain unchanged, with an additive 24-byte `zc_frame_sync_state` query.
`valid & 1` indicates ready and `valid & 2` indicates timer_us. Failure clears the
output. The libcamera bridge uses request-local names/types, supporting older
headers without references to missing rpi control constants. Malformed scalar
types/duplicate values report an error rather than guessing readiness.

All ordinary `CaptureOptions` additionally accept `syncReady: true`, including
owned RGB/stream/metadata/image and focus-locked captures. The existing native
filter combines readiness, distinct `dropFrames` and inclusive `flush` timing.
Its default path stays unchanged when no predicate is requested. The named sync
request helpers always require readiness, even if a caller passes syncReady=false.
False or absent readiness discards that candidate for this job and waits for a
later request; it does not prevent preview, recording or request hooks from using
the request. There is one bounded capture queue, with ordinary FIFO admission,
abort/deadline, callback and joined cleanup semantics. The normal 5000 ms default
capture timeout applies; use a longer timeout for delayed server startup. Stop
and close cancel/join pending jobs. Pre-aborted jobs start/acquire nothing.

Focus-locked captures additionally require the paused-focus revision and restore
CAF after readiness succeeds, times out or is cancelled. Waiting does not retain
a rejected frame. Home video's allocation-free frame_barrier Gate implements
the combined policy; Bun adds no second readiness counter or request pool.

Native callers initialize a fresh `zc_capture_filter` with
`ZC_CAPTURE_SYNC_READY` (4), optionally OR'd with timestamp/exposure flags, then
use `zc_acquire_filtered`. Acceptance is terminal: initialize a new filter for
each selection and keep it on one camera completion timeline. Rejected owners
are released; query/metadata errors leave filter state unchanged. Zig adds
`syncCaptureFilter`, `Camera.acquireSynced` and `Frame.synchronization` over those
same primitives.

The explicit virtual backend advertises rpi-named SyncMode/SyncFrames controls for
deterministic tests. A virtual server becomes ready after its configured number
of generated requests (default 3); its nominal timer derives from frame count and
configured duration. A virtual client receives no network server messages and
stays pending, with no fabricated timer. Stop preserves leased request snapshots;
restart after their final release resets the virtual readiness counter. This tests selection
and ownership, not a real network/clock synchronization algorithm.

Tests cover exact FIFO readiness, positive/zero/negative timers, missing metadata,
retained snapshots, stale/query failures, combined drops/timing/AF, pre-abort,
pending cancellation/stop/close, control admission/replay and simultaneous
recording/headless-preview delivery. Physical server/client synchronization,
network loss/startup, exposure alignment across sensors, cross-device clock
calibration and coordinated multi-camera bundles remain acceptance work. This
feature does not establish those hardware results or full Picamera2 parity.
