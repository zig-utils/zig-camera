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
RGB or configured RGB/I420 lores; raw buffer packing remains unsupported. File
capture accepts JPEG or DNG, returns frame metadata and uses Home image writers.
DNG requests unpacked Bayer automatically; unsupported raw modes still fail.
These methods use this project's typed options, not arbitrary Picamera2 configs.

Jobs are FIFO, with at most 32 admitted mode/capture operations. Recording,
autofocus, pending captures and outstanding frame leases prevent a mode change.
Checks run again when a queued job claims the camera. Release leases first;
never carry a frame descriptor across reconfiguration. Other camera operations
are rejected while a mode transaction owns its native handle. Start, preview,
autofocus, capture and recording also reject pending mode jobs.

Preview pauses while the worker owns the camera and is recreated on Bun's UI
thread. Temporary captures, cancellation and errors restore the previous mode.
Preview recreation failure also triggers rollback. Restoration failures are
reported alongside the original error; they cannot promise a working camera.
Runtime controls are not independently snapshotted/reapplied across reopen.

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
