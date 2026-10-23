# Camera capture outputs

Version 0.96 adds Bun camera jobs for caller-owned sequential still outputs:

| API | Result and completion |
| --- | --- |
| `captureToAsync(output, options)` | `BunJob<Metadata>` for ordinary capture |
| `captureTo(output, options)` | Promise for the same metadata |
| `captureFocusLockedToAsync(output, options)` | Joined CAF-lock/output job |
| `captureFocusLockedTo(output, options)` | Promise for the locked request metadata |
| `switchModeAndCaptureTo(cameraOptions, output, jobOptions)` | `BunJob<Metadata>` after temporary target capture, source restoration and output |

They use the 0.95 `ImageOutput` contract: a caller-owned `write(bytes)` accepting a
positive prefix count or all bytes, and optional `flush()`. Awaited writes provide
backpressure. Chunks are independent copies at most 64 KiB, one write per active
destination; the caller owns `close`/`end`. See `image-outputs.md` for partial
progress, byte limits, retained chunks, cancellation and non-atomic prefix rules.

```ts
const writer = Bun.file('lake.jpeg').writer()
try {
  const job = camera.switchModeAndCaptureTo(
    { width: 4056, height: 3040 },
    writer,
    { format: 'jpeg', quality: 98, autofocus: true, dropFrames: 2 },
  )
  const metadata = await job
  await job.cleanupDone
  // metadata describes the target request; the camera has its original mode.
} finally {
  await writer.end()
}
```

The sample target geometry is a requested configuration, not a hardware promise.
Output has no filename inference; specify `format`, otherwise JPEG is the default.
Home codecs supply JPEG/PNG/TIFF/BMP/PPM/GIF, and raw requests supply calibrated
DNG. Ordinary/focus DNG needs an existing raw stream. A temporary DNG job enables
raw in its target using the existing raw configuration recipe and restores the
original recipe afterward. Main/lores selection, RGB16 precision, ICC and request
Exif follow ordinary encoding. Metadata/ICC options are copied at job admission.

## Source ownership and visibility

The selected request first passes the existing flush/drop/synchronization and
focus selection policy. The parent synchronously admits a bounded native image
job, which copies selected physical pixels, calibration and metadata before
returning. Conversion/compression then runs on the existing joined native Home
worker. The parent owns its handle throughout camera work and sink delivery.

For ordinary capture, the selected request's post callback and source release
must finish before any sink call. A focus-locked job additionally acknowledges
restoration of the previous continuous-AF running/paused intent. A temporary-mode
job additionally restores the previous camera recipe, runtime/native controls,
CAF state and preview using the existing mode transaction. Returned metadata and
encoded Exif/ICC describe the target request rather than the restored camera.

The existing mode-worker request handshake gains an internal capture phase. It
hands a live target descriptor to the parent only while the worker waits for
retirement of that phase. The parent copies native input; it never holds the
source across an await. Unclaimed cancelled phases are retired without invoking
late messages. The internal phase is separate from user pre/post callbacks and
does not add a public callback or transport encoded buffers through the worker.

Parent-owned encoding may finish while request callbacks or restoration are still
running. A joined barrier withholds its sink consumer until all prerequisites
succeed. Callback/restoration errors and early cancellation reject that barrier
and join native cleanup. Errors from encoding and camera cleanup are preserved
together when both occur. An I/O failure after prerequisites succeed reports the
failure; its accepted prefix remains visible and the restored camera stays usable.

## Bounds, deadlines and lifecycle

The existing native Home admission registry covers copied input/workspace through
sink writes and flush: four owners within 512 MiB, with configured byte limits
possibly admitting fewer. Slow outputs cannot release codec admission and build
an unbounded pending-result queue. Native saturation reports BUSY; no sink bytes
are emitted, and temporary capture still restores its source. The camera's
ordinary/focus output admission shares the existing 32-job staged-image bound,
including completion callbacks. Mode jobs share the existing bounded mode queue.

`maxInputBytes`, `maxOutputBytes` and `maxWorkingBytes` retain the 0.95 meanings and
limits. Native output is a complete bounded result, not an incremental codec
stream. Capture scheduling and output methods are snapshotted once before owner
revalidation. Ordinary/focus deadlines use the existing capture scheduling default
(5000 ms); mode jobs use their existing 5000 ms default. Set `timeoutMs` explicitly
for larger images or slower sinks. The single deadline includes selection,
encoding, restoration and output. Independent cleanup deadlines keep their
existing camera/CAF behavior.

Cancellation before the barrier prevents every sink call. Once writing starts,
accepted bytes are visible and cannot be rolled back. Cancellation and camera
stop/close wait for an accepted write/flush promise and native cleanup before
settling the operation. As with all custom sinks, an operation that never settles
cannot be forcibly joined. `cleanupDone` additionally includes completion
callbacks. Use staged file capture for atomic replacement of an existing path.

Still-output write/flush hooks now share the recording output's AsyncLocalStorage
reentrancy guard. Calling camera/recorder ownership operations from such hooks,
including after an await, fails with STATE instead of waiting on their own job.
Coordinate camera lifecycle from the caller outside those hooks. Completion
callbacks run after native/sink cleanup and can inspect or reuse the camera.

## Evidence and remaining parity

Coverage includes all 14 processed layouts on both main/lores sources, all seven
containers for ordinary/focus/mode jobs, independent raw/Exif/ICC readback,
selected-request callback errors, CAF running/paused acknowledgements, runtime
controls/preview restoration, callback and active-I/O cancellation, deadline and
pre-abort paths, late unclaimed internal hooks, worker construction/response
failure, mode/preview restoration failure, quota reuse through repeated errors,
shared slow-sink admission, source drop/timestamp barriers and bounded admission
through completion callbacks. Existing request hooks and staged-file jobs retain
their tests.

Local validation passes all 1549 Bun tests with Home AVC/HEVC/AAC, SDL dummy
preview and independent media readers, 450 target-qualified Zig 0.15.2 ReleaseSafe
tests, six independent C executables, TypeScript, pinned Zig formatting and
workflow YAML parsing. The normal local build runner still fails macOS
SDK/libSystem linkage before project compilation; target-qualified tests are
separate evidence. Linux real-backend build/load and no-camera discovery remain
CI gates. Neither synthetic tests nor an empty discovery result verifies sensors.

The reference remains Picamera2
5e2a35d3bb230825c98c56d98e01b41ddeb43e86, with capture-file/temporary-mode source
reviewed without running Python. Burst/series output convenience, additional
remote/allocator/property behavior, incremental encoding, richer still metadata,
camera-specific integrations and physical acceptance remain in `parity-plan.md`.
These are hosted software semantics, not full parity or measured Pi performance.
