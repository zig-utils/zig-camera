# Device disconnection and retained ownership

Version 0.66 handles libcamera's per-camera disconnected signal. Reported device
loss is terminal for that native handle, distinct from stop or a generic device
error. It never resets on start. Reconnection needs a new native camera instance;
[manager hotplug watches](hotplug.md) are available in 0.67 and bounded
[fresh-owner reconnect jobs](reconnection.md) in 0.68. Version 0.69 adds coordinated
recorder/preview recovery; background supervision and physical acceptance remain
parity work.

```ts
import { Camera } from '@zig-utils/camera'

const camera = new Camera({ width: 1920, height: 1080 })
const lost = camera.waitDisconnected({ timeoutMs: 60000 })
try {
  camera.start()
  const state = await lost
  console.log(state.disconnectEvent, state.status) // -11
} finally {
  await camera.close()
}
```

`deviceState()` is a copied, frozen current-handle observation: connected,
running, leased, ready, status and disconnectEvent. The event is the native
completion event counter when the first loss was accepted, not a wall-clock
timestamp. It can be zero. Leased counts buffers rather than individual retained
references; running describes native capture admission, not a hardware DMA probe.
Ready frames are discarded and pending capture and
metadata waits wake with ZC_DISCONNECTED (-11). Later completions are ignored;
no new lease or requeue is admitted on the removed handle. Controls and new AF
commands reject. Pending AF waits fail; local cancellation retires their control
job without sending commands to removed hardware. Completed AF history remains
readable. CameraDisconnectedError extends CameraError with code -11.

Already acquired completed frame leases keep their storage, metadata and access
gates. Main/raw/lores copies, retained references and mappings remain owned until
explicit release/close. Camera close stays BUSY while owners remain. Every final
release still attempts its DMA END fence, and failures are reported, including
if loss happens during the BEGIN fence before publication. A failed END is never
treated as success or followed by a requeue. A consumed token/map may report a
fence error; existing Frame/Map closed-state rules still apply. Never continue
using a released token or a detached mapping.

`waitDisconnected` is a cancellable BunJob, with a 30-second default deadline.
Up to 32 jobs share one native zero-time poll per camera turn and one scratch
descriptor. Cancellation/deadline is independent per subscriber. Stop/start does
not cancel observers; camera close cancels and joins them before freeing its
handle. Observation suspends native pointer access during mode-worker ownership.
Workers preserve reported loss before close and return final state after callback
retirement, so rollback to a healthy source does not erase an observed target
loss. An open explicitly rejected as disconnected records a zero-event loss.

The first observed loss is latched for this Bun Camera's lifecycle observers;
later waits return that owned observation. `deviceState()` still describes the
current native handle, which may be healthy after mode rollback. Lease/ready
counts in a latched result describe its observation time. This is not a global
device-event journal: removal while no handle is open requires manager hotplug
observation, which remains in scope. `deviceError` records a capture-pump loss;
preview/encoder producers stop and pending capture jobs fail, while joined close
preserves their reported errors. A healthy replacement handle can resume work.

Zig exposes Camera.deviceState, waitDisconnected and error.Disconnected. C adds
a 32-byte zc_device_state, query/wait and zc_close_with_device_state. The latter
copies final state after callback retirement, then frees the handle on success;
failure preserves both the handle and caller output. C wait callers must
coordinate close with every waiter. Existing ABI layouts remain unchanged.

The C++ bridge uses a shared callback relay: execution retains its relay and
serializes owner access; destruction retires the owner before disconnecting
signals and freeing request/map storage. The SDK signal callback publishes one
fixed-size terminal notice to Zig; no consumer callback, file I/O, new event queue
or pixel copying runs there. New start/queue ENODEV results also report loss.
Stop accepts the SDK's known disconnected cleanup result, while other stop
failures retain the owner for retry. Tuning reservations remain pinned through
loss until camera teardown.

`simulateDisconnect()`/zc_simulate_disconnect are synthetic diagnostics, rejected
on a real-backend build. Tests inject loss before start, during a begin fence,
with retained/mapped frames, while native waits block, in AF/capture/recording and
mode hooks. The C++ catalogue test exercises concurrent callback retirement and
late delivery through the actual relay after owner retirement. Linux real-backend build/load coverage requires
no camera. Physical removal, late-driver DMA and reconnect acceptance still
require Pi hardware; synthetic behavior is not a physical unplug result.

Upstream references: [camera API](https://github.com/raspberrypi/libcamera/blob/main/include/libcamera/camera.h),
[camera lifecycle](https://github.com/raspberrypi/libcamera/blob/main/src/libcamera/camera.cpp),
[signal threading](https://github.com/libcamera-org/libcamera/blob/master/src/libcamera/base/signal.cpp).
