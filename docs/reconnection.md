# Bounded camera reconnection jobs

Version 0.68 adds `Camera.reconnect()`, which returns a `ReconnectJob<Camera>`.
The source must be disconnected. A successful job publishes a **fresh Camera**
with the same exact backend ID, configuration and persistent runtime-control
snapshot. The lost source remains the owner of its existing frames/maps; it is
never reset, reassigned or silently closed. This permits replacement capture
while those old retained buffers are still being read or released.

```ts
import { Camera, CameraCleanupError } from '@zig-utils/camera'

let camera = new Camera({ width: 1920, height: 1080 })
camera.start()
await camera.waitDisconnected({ timeoutMs: 60000 })
const lost = camera
try {
  camera = await lost.reconnect({
    maxAttempts: 8,
    initialDelayMs: 50,
    maximumDelayMs: 1000,
    pollMs: 250,
    timeoutMs: 30000,
  })
  // Release old retained frames/maps before closing their original owner.
  await lost.close()
  using frame = await camera.captureRequest()
  console.log(frame.metadata())
} catch (error) {
  if (error instanceof CameraCleanupError) await error.cleanup()
  throw error
} finally {
  await camera.close()
  await lost.close()
}
```

## Admission, retries and publication

One outstanding reconnect job is allowed per source. Source mode/coordinated
transactions and file series must retire first. Connected or closed cameras reject
admission. Application options are copied before reservation and rechecked after
BunJob construction, including registration reentry through customized AbortSignal
methods. Pre-abort and timeout zero never open a camera.

The private manager watch opens before discovery. Only an exact ID match permits
an open attempt; other cameras, removal/addition wakeups, rescan markers and
absence waits do not spend the attempt budget. Every wakeup is followed by a new
snapshot, and pollMs bounds discovery refresh even if SDK events are missed.
The native watch queue retains its own bounds and overflow reporting. There is no
index fallback, path normalization, prefix matching or reuse of the old native
handle.

Home video's existing retry policy supplies allocation-free admission arithmetic
on a private monotonic nanosecond epoch. The first admission waits initialDelayMs;
failed admissions back off exponentially to maximumDelayMs. Completion arms the
next deadline once, without moving it on each discovery poll. Successful opens
clear the pending deadline and preserve the lifetime attempt count. maxAttempts
is 1..1024, delays are integer 0..60000 ms with maximum >= initial, and pollMs is
1..60000 ms. Defaults are 8 attempts, 50/1000 ms delays and 250 ms refresh.
The overall job deadline defaults to 30 seconds and uses Bun's monotonic deadline
helper. Absence may spend the deadline without consuming a single open attempt.

The existing worker performs native open, configuration, control replay, optional
capture drops/AF and failed-candidate disposal. Fresh attempts never use the mode
worker's old-mode rollback: one admitted attempt cannot hide a second reopen.
Device-level errors (-9/-11), including loss during replay, and busy acquisition
(-4) may retry; control validation/replay policy errors,
unsupported configuration, allocation, I/O and cleanup failures stop recovery.
A generic device error does not prove whether a physical failure is transient.
Worker construction/runtime errors are surfaced, not blindly retried. Arbitrary
worker/process death cannot establish SDK ownership; this feature does not claim
safe recovery from native crashes or forced worker termination.

`job.cameraId`, `job.recoveryState` and `job.lastOpenError` expose exact identity,
attempt count/limit, exhaustion, pending relative deadline, and the last rejected
open. State is copied/frozen; it is not a sensor clock or hardware measurement.
Exhaustion means no further claims, even if the final admitted attempt succeeded.

Cancellation of an active worker joins its response and candidate cleanup before
rejection. No candidate escapes after cancellation. Before success, the watch is
closed, cancellation is rechecked, and publication is sealed in the same main
thread turn. Source stop/close cancels and joins unpublished recovery. A published
replacement is independent: closing the old source does not stop it. Completion
callbacks may close the source and use the replacement; source close waits for
operation cleanup rather than waiting on the callback that invoked it.

## Restored camera and preview state

Admission snapshots main/raw/lores, role/sensor selection, writable policy,
orientation, processed color request and tuning JSON, plus exact legacy/native
persistent control payloads and revision. Controls are revalidated against the
replacement device. One-shot commands and in-flight AF jobs are not replayed.
Configuration and request callbacks are copied at admission; subsequent source
changes are not applied to an already admitted job. Source callbacks receive
replacement-owned request scopes after publication.

`start` defaults to the source's admitted running intent; it can be explicitly
true or false. A stopped replacement cannot request nonzero dropFrames or AF.
`autofocus: true` requires a fresh successful scan and focused-frame observation
before publication. The worker then reapplies the original persistent control
recipe, including CAF/manual intent, without replaying triggers. CAF may perform
new scans after resumption; this is not a permanent focus lock or physical focus
quality result. With no explicit AF mode, configuration's automatic/manual focus
intent is restored. Hardware/ISP initialization still needs physical acceptance.

Tuning manager/file/environment ownership is pinned by the watch through failed
opens and hotplug gaps. The replacement takes its own tuning reservation and
manager lease before the watch retires, so it can outlive the source. Existing
profile conflicts or external environment changes remain errors.

Version 0.69 restores the admitted preview recipe by default: backend, selected
main/lores/background source, window options, view transforms, aspect policy and
overlay placement. The owned RGBA overlay is cloned at admission using Home's
checked compact RGBA copy. Caller byte mutation or explicit source preview close
cannot invalidate it. Native device loss suspends the old display while retaining
its recipe; explicit `stopPreview()` clears that intent. A replacement creates its
own preview and overlay owner. Failed preparation closes the candidate, preserves
the old suspended recipe and permits an explicit retry. Pass `preview: false` to
omit the display. A preserved preview requires `start: true`.

Plain `reconnect()` leaves recorder/output/microphone objects with their source.
Use the coordinated operation below to recover those sessions together. Failed
source jobs and frame leases always remain with their original owner. Continuous
background reconnect supervision remains required parity work. Synthetic tests
inject absence/open failures and ownership races; synthetic discovery is not USB topology.
No physical removal/readdition, DMA quiescence, Pi timing or image-quality claim
is established here.

## Coordinated recording recovery

`Camera.reconnectRecordingsAsync(members, options)` returns a
`BunJob<RecoveredRecordingSession>`, containing a fresh `camera` and ordered
`recordings`. Supply every attached active/failed Recording exactly once, with
one to eight distinct Recorders. Existing old frame/maps need not be released
before recovery; they never move into the replacement. The operation requires a
lost camera and a started replacement.

```ts
const lost = camera
const recovered = await lost.reconnectRecordingsAsync([
  { recording: archive, output: 'archive-recovered.mp4',
    settings: { codec: 'hevc', fps: 25 } },
  { recording: monitor, output: monitorOutput,
    settings: { stream: 'lores', fps: 25 }, backpressure: 'drop' },
], { timeoutMs: 30000 })
camera = recovered.camera
;[archive, monitor] = recovered.recordings
// Release original frame/maps before closing their original owner.
await lost.close()
```

Member settings and audio/output selection follow
[recording group mode jobs](recording-groups.md). Omitted audio preserves the old
microphone if the new settings enable it; null detaches it. Omitted/null output
creates no primary output. Supply a fresh path or custom output explicitly;
finalized files are never appended implicitly. All consumers of a microphone must
use the same FPS. Explicit geometry must match the selected negotiated stream.
Paths, formats, member uniqueness and shared cadence are checked before flushing.

The job reserves all recorders and native microphone holds, stops source
production, joins copied producers, then admits every terminal codec flush before
detaching any old Recording. It joins those drains before opening one replacement
camera. Every candidate encoder/container/header/custom start hook and capture
consumer must be ready before the existing native shared publication gate commits
all sessions. The replacement pump starts only after installation, old output
retirement and coordinator release. Preview preparation is reversible; creating
display windows is not an atomic multi-window operation.

Home's bounded PCM history and timeline retain the shared microphone cursor,
fractional block phase and future block through old-consumer retirement. New
consumers receive fresh IDs, and a changed FPS rebases the offered-frame epoch at
the completed sample cut. The replacement owns reused microphone groups after
publication. Closing the source or its old Recording descriptors cannot detach
new consumers or close the replacement microphone. This preserves logical sample
continuity; it does not calibrate physical clock drift, ALSA overrun or unplug gaps.

Cancellation before publication joins child camera/codec/output preparation and
discards candidates, including exclusively created files. Accepted flush tails
cannot be undone: once flushing starts the old sessions remain stopped with their
reusable Recorders. After failed preparation, pass those retained old Recording
descriptors to an explicit retry; held PCM history stays with the source until
retry or source stop/close. No retry automatically reuses a finalized output path.
Cancellation after shared publication returns false. A later retirement or
recorder-close error exposes `published: true` and `session` on the rejection;
that session retains the committed camera/recordings for explicit cleanup or use
of healthy peers. `CameraCleanupError` still owns any failed disposal resources.

Validation includes eight simultaneous encoders, source close on both sides of
publication, held host hooks, discarded files, explicit retry, old live frames,
preview pumping/overlays, 44.1 kHz fractional history, and AVC/HEVC/AAC MP4 recovery
with changed FPS. Independent audio decoding checks sample phase; independent
video decoding runs where the CI decoder is installed. Hardware reconnect, focus,
preview timing and continuous unattended supervision remain unverified.

## Failure ownership and native policy API

If construction or cancellation cleanup cannot dispose a candidate, the error is
`CameraCleanupError`. Its owned `owners` array and retryable `cleanup()` retain
failed resources instead of dropping their handles. Nested cleanup failures keep
all owners. Do not discard this error before cleanup succeeds. Underlying errors
remain in `errors`. A failed native worker cleanup whose ownership cannot be
established is quarantined rather than reusing an uncertain pointer.

The additive C `zc_recovery_retry` is 40 bytes. Init/poll/observe supply the same
Home arithmetic to Zig/C callers, with a caller-owned serialized state and clock;
poll returns 1 for a claim, 0 when not due/exhausted, or a negative validation error.
Failed validation preserves output/state. It performs no allocation, sleeping or
I/O. The camera ABI remains pinned to Zig 0.15.2; Home's portable policy is tested
separately on development Zig as well as the pinned compiler.

Validation includes old map/lease independence, exact vendor i64 controls, CAF
restoration, transient attempts/exhaustion, absent/different IDs, fail-fast replay,
pre-abort/deadline, active cancellation after a worker has opened its candidate,
source close/reentry, retained constructor cleanup owners, profile lifetime and
completion callbacks. A delayed native-task result also verifies that Bun workers
return ownership without the unsupported WorkerGlobalScope.close call. Linux
x86/ARM real-backend smoke tests validate fresh absent-ID failure without rollback
or manager leakage, not physical reconnect behavior.
