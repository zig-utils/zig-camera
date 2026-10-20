# Runtime controls, autofocus and preview

The Zig/C ABI exports typed control discovery and atomic batches. Bun exposes
Control IDs and setControls with bool/int/float/rect values. A metadata control
revision means request submission; sensor pipeline latency remains. Unsupported
vendor controls fail explicitly. autofocus returns a Promise driven by native
metadata jobs and the shared capture pump; timeout/AbortSignal cancels the job.
startPreview/stopPreview create/show/close SDL on the same Bun UI thread and use
that pump alongside capture and recording. There is no Qt/DRM backend or overlay.
Physical focus, display and exposure validation remains required.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).

## Restoration across mode switches

Every permanent switch, temporary RGB/metadata/lores/JPEG/DNG capture and
coordinated recording switch copies the native desired runtime state when the
job claims the camera. Queued jobs therefore include successful controls submitted
before claim, including pending settings not yet visible in sensor metadata.
The snapshot is replayed atomically after camera configuration and **before**
start, warmup, capture, preview recreation or recorder publication. Restoration
also runs on the previous mode after temporary capture, cancellation, worker
rollback or failed recorder/output preparation.

```ts
camera.setControls([
  { id: Control.aeEnable, type: 'bool', values: [0] },
  { id: Control.exposureTime, type: 'int', values: [2500] },
  { id: Control.analogueGain, type: 'float', values: [2] },
])
const snapshot = camera.controlSnapshot()
await camera.switchMode({ width: 1920, height: 1080, role: 'video' })
// Accepted exposure/gain settings were replayed before streaming starts.
```

The native journal retains only the latest accepted value for each ID, in sorted
order, within ZC_MAX_CONTROLS (32) slots. Invalid or unsupported batches and driver
failures preserve it. Returned snapshot arrays and scalar values are copies;
caller mutation cannot alter native state. This records explicit desired settings,
not inferred automatic exposure/white-balance/lens results. Constructor settings
and role defaults remain configuration policy unless overridden at runtime.

AF trigger and AF pause are one-shot commands and are never replayed. AF mode,
range, speed, metering, windows and explicitly requested lens position remain
persistent. Successful autofocus jobs update the persistent AF mode through the
same native path; reopening does not restart that job or trigger a new scan.
Mode changes coordinate live autofocus jobs as described below. Outstanding frame
leases still prevent ownership transfer.
A new AeEnable setting clears older ExposureTimeMode/AnalogueGainMode aliases;
explicit aliases in the same batch override it independently of argument order.

Every replay revalidates types, ranges, enum values and crop/window geometry
against the configured target. Unsupported or incompatible controls reject the
whole replay and cause normal mode rollback. Values are neither silently dropped
nor rescaled. Errors expose controlCode for target replay failure and
restoreControlCode/restoreCode for failure while restoring the previous camera.
Adjust incompatible controls to values accepted by both modes, or create a new
camera with a fresh desired state. Camera restoration failure cannot promise a
working stream. A completed recorder flush remains terminal on later failure.

Logical control revisions carry forward across reopened native handles. A
nonempty replay consumes a new revision; temporary/rollback replays advance it
again. Native frame and observer metadata and autofocus filtering use that same
logical revision. Empty snapshots only seed the previous base. Bun mode jobs
reserve revision headroom for target/rollback before consuming the old camera;
exhaustion rejects STATE without flushing the recorder or wrapping counters.
Revisions denote request submission, **not physical sensor application**. Queued
frames, sensor latency and automatic control behavior still require hardware
validation. Restoring a stopped camera stages the settings for its next start.

Frame.metadata and temporary metadata captures use the same decoder, including
exposureUs, analogueGain, redGain, blueGain, lensPosition, frameDurationUs, crop,
afState, afPauseState, controlRevision and validMask. Consult validMask for the
optional AF/lens/duration/crop fields supported by the native ABI.

For Zig callers, Camera.controlSnapshot returns an owned ControlSnapshot and
Camera.restoreControls(snapshot.controls(), snapshot.revision) replays onto a
fresh camera before first start. The additive C functions zc_get_controls and
zc_restore_controls provide the same behavior. A null/zero snapshot query returns
count/revision; insufficient capacity rejects without copying. Restore accepts a
complete persistent batch and revision base once on a fresh handle, before any
start or accepted runtime update. Rejected replay leaves it retryable; one-shot
commands reject. ABI v1 control and metadata layouts are unchanged. C/Zig callers
serialize ownership and carry the snapshot between camera handles explicitly.

## Autofocus coordination across mode switches

All Bun mode APIs accept ModeJobOptions, including temporary RGB/metadata/buffer/
JPEG/DNG capture and coordinated Recording.switchModeAsync. autofocusPolicy is
'cancel' by default: cancel the existing scan and join its operation before
closing its original native handle. The replaced AF job rejects JobCancelledError.
'wait' keeps recycling frames until that scan finishes successfully; a failed or
aborted scan fails the mode job before stop/reopen or recorder flush. 'reject'
preserves explicit BUSY behavior. Queued jobs use the AF owner present at claim.
Mode cancellation while waiting leaves the old AF job running, unless the mode
already requested its cancellation. A pre-cancelled mode never touches AF.

Camera.autofocusAsync returns BunJob<number>, with cancellation, deadlines,
operationDone and cleanupDone. autofocus remains its Promise facade; success is
state 3, failed scan is 4. Cancellation joins native command cleanup, and stop/
close join the AF operation before releasing the handle. User completion callbacks
are separate from native ownership and cannot hold the camera open. A cancelled
AF command failing at the backend fails coordination before ownership transfer.
A native stop can terminate any remaining scan. No old ID is polled on a reopened
handle.

Set autofocus: true to trigger a fresh AF scan after target start and dropFrames,
before capture, preview recreation or recorder output preparation/publication.
The worker requires scan success, then discards older ready frames using AF valid
metadata, focused state and the new logical revision, recycling a full buffer set
before publication. Temporary captures additionally validate the selected frame.
Every rejected frame is released. The shared mode deadline bounds warmup, scan,
frame filtering and output preparation. Cancellation or AF failure restores the
previous mode/settings; autofocusState is attached to errors when observed. An
unsupported AF camera rejects explicitly. No automatic fallback to an unfocused
capture is performed. Revision headroom includes fresh trigger/cancel operations.

```ts
const focus = camera.autofocusAsync()
await camera.switchModeAndCaptureFile(
  { role: 'still', width: 4056, height: 3040 },
  'focused.jpg',
  { autofocusPolicy: 'wait', autofocus: true, timeoutMs: 15_000 },
)
await focus
```

Coordinated recording reserves the camera/recorder while the old scan settles.
Its AF-only pump recycles frames without submitting new media or calling output
hooks. Already copied producers finish normally, then the existing flush and
session replacement transaction runs. Pre-publication failure restores the camera
but cannot undo an already completed codec flush. The usual fresh-output retry
rules apply. A failed candidate never replays AF trigger/pause commands on rollback.
Continuous AF and manual lens settings remain persistent controls; a fresh single
scan explicitly selects auto AF mode in the target. Temporary rollback restores
the previous requested settings, not a measured physical lens position.

The scan/terminal semantics follow the [libcamera control specification](https://docs.libcamera.org/master/internal-api/namespacelibcamera_1_1controls.html).
Tests use synthetic metadata and failure injection; actual lens settling and focus
quality on Raspberry Pi hardware remain unvalidated.
