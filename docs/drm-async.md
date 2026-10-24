# Independent native asynchronous DRM preview

```ts
import {Camera,DrmPreview} from '@zig-utils/camera'

await using camera=new Camera({width:1280,height:720,format:'NV12'})
await using preview=new DrmPreview({width:1280,height:720,format:'NV12',operations:4})
for(let i=0;i<100;i++){
  const frame=await camera.captureRequest()
  const job=preview.showAsync(frame)
  frame.release() // Successful native admission already retained its own export.
  await job
}
await preview.backgroundAsync()
```

This is an independent preview consumer, with a native serial worker per preview.
Camera can also own this worker through the explicit `drm-async` backend; see
[camera-drm-worker.md](camera-drm-worker.md). The independent class remains
application-owned: close or background it before reconfiguring its source camera.
Its current scanout exports still block camera reconfiguration.

All existing DRM plane, format, color and device requirements in drm-preview.md
apply. Device discovery/open and source-export admission remain synchronous.
Actual fd-backed camera inputs retain exported read owners without an application
image copy. Synthetic fd-less input stages in memfd. Worker callbacks perform
imports, atomic commits, flip waits, view changes, detach and device cleanup;
they never call Bun/application functions or camera-manager callbacks.

`showAsync` returns a BunJob after synchronous native export admission, before
waiting for the display. It rejects full admission without retaining the frame.
`setViewAsync` copies and validates scalar view options before waiting for queue
capacity. `setOverlayAsync` uploads an immutable RGBA snapshot to a separate alpha plane;
see [DRM overlays](drm-overlays.md). `backgroundAsync` detaches the camera image
with matching event proof and releases source owners; an independently configured
overlay stays visible. `drainAsync` joins the accepted callback prefix; a displayed or uncertain
source remains retained. A drain is not a GPU-retirement or operation-success
watermark. Inspect individual jobs for their outcomes.

Capacity is 1..8 operations per preview (default 4), including the executing
operation. There are at most four native preview owners and 32 live native job
handles globally, with existing export limits applying independently. Queued
jobs retain exports until their callbacks have completed cleanup. Queue state
reports outstanding/queued/active/live-job counts, issued/completed tickets,
retirement state and rejected admission attempts. `state` is a snapshot of the
last completed worker operation, not a live ownership inventory during work.
Neither state snapshot nor queue idleness authorizes releasing a source lease.

Queued cancellation is linearized against native claim and waits for cleanup.
Active native operations cannot be cancelled: `job.cancel()` returns false after
claim, including deadline cancellation. Configured device event timeouts still
apply, but kernel ioctls themselves are not wall-clock bounded. No worker is
forcibly terminated. A cleanup IO error takes precedence over cancellation.

`close()` fences new class admission, cancels queued jobs, joins entered jobs,
submits device close on the worker and finally joins/consumes the native owner.
It remains asynchronous while a worker waits for flip/detach events. User
completion callbacks can call close without waiting on themselves. Missing flip
or detach proof retains possible scanout owners and close rejects for explicit
retry. A consumed-device cleanup error retains an acknowledgement owner; a
second close acknowledges it. Constructor cleanup failure throws
`DrmPreviewCleanupError` with `cleanup`, an owned preview to retain and close.

The C API enables a worker on an existing DRM preview, then submits exported
frames or copied commands (fence/background/view/close-device). Poll each job's
finish, close the job, then close the preview. Preview close returns BUSY while
live job handles or callbacks remain. Synchronous mutations return BUSY while
the executor owns work. Callers serialize public calls on a preview/job.

The shared Home serial executor allocates stable private state and reuses the
owned-admission registry for active-inclusive bounds and exact cleanup fences.
Its predicate and condition wait share a lock; shutdown drains accepted callbacks
and joins the real worker. It rejects callback self-wait/self-join. The historical
unwired Home thread pool is not reused as a working backend.

Independent Linux C UAPI tests deliver actual completion packets over real FDs,
with synchronized peer state for native worker threads. Coverage includes all
12 supported formats, named Rec2020 matrix admission, immediate public frame
release, copied views, a held flip with continued Bun heartbeat, capacity rejection,
queued cancellation, active cancellation rejection, drain versus scanout ownership,
joined close, missing-event quarantine and consumed-device acknowledgement retry.
These are software protocol/lifetime checks, not physical Pi scanout, color
accuracy, performance measurements or full Picamera2 parity.
