# Mode jobs and recording semantics

Bun mode jobs stop and reopen the same camera on a worker. They preserve the
selected backend/index and return negotiated information rather than assuming
libcamera accepted the requested geometry. Configurations are copied at
submission, including sensor and lores options.

```ts
const job = camera.switchModeAndDropFrames(
  { width: 1920, height: 1080, role: 'video', fifo: true },
  4,
  { timeoutMs: 10_000 },
)
const configuration = await job

// Temporarily use a still configuration, then restore the previous mode.
const rgb = await camera.switchModeAndCaptureRGB(
  { width: 4056, height: 3040, role: 'still' },
  { dropFrames: 4, timeoutMs: 15_000 },
)
```

`switchMode` keeps the replacement running. `switchModeAndCaptureRGB`,
`switchModeAndCaptureMetadata`, `switchModeAndCaptureBuffer` and
`switchModeAndCaptureFile` restore the previous constructor configuration and
running/stopped state before returning owned results. Buffer capture packs main
RGB, configured RGB/I420 lores or Bayer rows (packed CSI-2 or unpacked samples);
PiSP compressed raw remains unsupported. File
capture accepts JPEG or DNG, returns frame metadata and uses Home image writers.
DNG requests unpacked Bayer automatically; unsupported raw modes still fail.
These methods use this project's typed options, not arbitrary Picamera2 configs.

Ordinary mode jobs are FIFO, with at most 32 admitted mode/capture operations.
Recording, pending captures and outstanding frame leases prevent an
ordinary mode change. Use the coordinated recording API below for recording.
Locked capture transactions must finish before switching. Scan and continuous AF
pause/resume use the [mode coordination policy](controls.md#autofocus-coordination-across-mode-switches).
Checks run again when a queued job claims the camera. Release leases first;
never carry a frame descriptor across reconfiguration. Other camera operations
are rejected while a mode transaction owns its native handle. Start, preview,
autofocus, capture and recording also reject pending mode jobs.

Preview pauses while the worker owns the camera and is recreated on Bun's UI
thread. Temporary captures, cancellation and errors restore the previous mode.
Preview recreation failure also triggers rollback. Restoration failures are
reported alongside the original error; they cannot promise a working camera.
Accepted runtime settings are snapshotted at claim and atomically replayed before
stream start, including rollback. See [control restoration](controls.md#restoration-across-mode-switches).

Every method returns a `BunJob<T>`: `await job`, `job.wait()` and `job.result()`
read the same terminal result. `cancel()` or `AbortSignal` requests cooperative
cancellation; a queued cancellation touches no native state. A claimed operation
finishes rollback and lease cleanup before rejecting. Publication seals the job,
after which cancellation returns false. The default deadline is five seconds,
including queue time. Cleanup can extend past the deadline: native calls and
hooks cannot safely be forcibly interrupted. Stop/close cancel pending work and
wait for owned cleanup. An unexpected worker failure invalidates the instance's
handle because native ownership is then unknown.

`signalFunction(job)` runs once after the terminal result, may capture again or
close its owner, and records its own failure in `callbackError`. It cannot change
the result. `operationDone` fences native ownership; `cleanupDone` additionally
waits for the signal callback and admission-slot release. A callback that never
returns retains a bounded admission slot.

Recorder uses Home containers/codecs. `startRecording` shares the camera pump;
`Recording.close()` detaches first and asynchronously drains the native recorder.
Preparing replacements uses bounded native jobs. See [native jobs](native-jobs.md)
for splits/rotation/recovery. No frame is leased beyond encoding.

See [coverage](parity.md) and the [C ABI contract](../include/zig_camera.h).

## Coordinated camera and recorder switching

`Recording.switchModeAsync(cameraOptions, sessionSettings?, output?, jobOptions?)`
returns a BunJob<Recording> for the replacement recording. It automatically drains
and flushes the current pump, switches the camera and resumes the same recorder
with a fresh media session. The underlying
`Camera.switchRecordingModeAsync(recorder, cameraOptions, sessionSettings?, output?, jobOptions?)`
also works with an idle camera and a live or flushed recorder. A camera already
recording a different recorder rejects, as does a recorder attached elsewhere.

```ts
const previous = recording
recording = await previous.switchModeAsync(
  { width: 1920, height: 1080, role: 'video', fifo: true },
  { codec: 'hevc', fps: 30, bitrate: 8_000_000, gop: 30,
    audio: { sampleRate: 48000, channels: 2, bitrate: 128000 } },
  new MuxedOutput('trail-high.mp4'),
  { dropFrames: 4, timeoutMs: 15_000,
    audio: new AudioCapture({ sampleRate: 48000, channels: 2 }) },
)
await previous.close() // Its flushed recorder is now owned by the next session.
```

One admitted job reserves both Bun objects; new capture, focus, mode, producer and
output mutations fail fast until ownership settles. Already copied producers
finish before the flush on the same bounded worker FIFO. Release frame leases
first. Recorder preparation jobs, snapshots and automatic factories must settle;
stop factories before coordinated admission. The existing 32 camera-job and 16
recorder lifecycle limits still apply. A second coordinated switch rejects BUSY.
This surface coordinates the Bun facade; direct C callers must still serialize
their own native ownership.

Session settings follow reconfigureAsync: codec, FPS, bitrate, quality, GOP and
audio are copied at admission, omitted fields retain their values, codec changes
reset omitted bitrate/GOP, and audio:null disables audio. Omitted recorder width
and height adapt independently to the negotiated camera geometry. Explicit
recorder dimensions must match negotiation; mismatch rolls back before media
publication. Camera options are copied, including sensor and lores selection,
while backend and camera index remain fixed. Home session_config validates the
resulting codec geometry and preserves the proposed settings on failure.

The old recording is detached and its AudioCapture closed before flushing. Supply
a **new** matching AudioCapture through jobOptions.audio for the next pump. It
remains caller-owned until successful attachment; setup failure/cancellation does
not close it. Closing that source during preparation rejects before publication.
When omitted, the new pump has no audio input. The output can be a fresh exclusive
path, custom output or null for an unattached/circular session. Candidate hooks
receive the new negotiated metadata and headers. Preview is recreated on Bun's
UI thread before recorder publication; the camera pump remains paused throughout.

The publication boundary is the prepared recorder's native publish operation.
Before it, cancellation, worker/setup failure, unsupported media or preview
failure discards the candidate, joins its hooks and restores the old camera mode,
running/stopped state and preview. Queued cancellation and lease/preflight
rejection leave the live pump intact. Once flush has entered, the old recording
remains terminal even if later preparation fails: its file cannot be unflushed,
and the coordinator does not silently restart or append to it. The old session
ID/settings stay available; retry the camera API with a fresh output to resume.
Restoration failures are attached as restorationError/previewError. A worker
fault invalidates the camera handle rather than guessing ownership.

After publication, cancellation returns false and the matching camera mode stays
installed. Old output retirement errors still reject; the error.recording field
exposes the attached replacement pump for inspection or close. Camera/recorder
close joins publication and cleanup, then closes the relevant owner instead of
rolling back a published camera. An old Recording.close does not close the reused
recorder. Media clocks/history reset and new files start with fresh headers/IDRs;
reattach secondary outputs and automatic policies. Switching introduces a capture
gap and provides no continuous frame/audio guarantee.

Job deadlines default to ten seconds, including draining/setup time. Cancellation
and deadlines cannot interrupt an entered flush, native call or user hook; cleanup
can extend past the deadline. operationDone fences both owners before callbacks
run; cleanupDone also includes signalFunction and admission release. Physical Pi
A/V validation remains outstanding.
