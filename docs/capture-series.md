# Burst and paced file capture

`Camera.startAndCaptureFiles(targets, options)` implements Picamera2's
`start_and_capture_files` workflow through a cancellable Bun job. Targets are an
explicit array of paths or a lazy `{ pattern, count, startIndex?, padTo? }`.
`{index}` is replaced with the decimal counter (default start 0, padding 3).

```ts
const camera = new Camera({ role: 'preview' })
try {
  const job = camera.startAndCaptureFiles(
    { pattern: 'trail-{index}.jpg', count: 20 },
    {
      preview: { backend: 'headless' },
      previewMode: { role: 'preview', width: 1280, height: 720 },
      captureMode: { role: 'still', width: 4056, height: 3040 },
      initialDelayMs: 1000,
      intervalMs: 1500,
      autofocus: true,
      retainResults: 8,
      onFile: ({ path, metadata }) => console.log(path, metadata.sequence),
    },
  )
  const result = await job
  console.log(result.completed, result.recentFiles, result.stopped)
} finally {
  await camera.close()
}
```

Choose dimensions supported by the actual camera. A zero `intervalMs` opens the
capture mode once for the entire burst, focuses once when requested, and captures
serially without mode churn. Positive intervals warm up preview, temporarily
switch into capture mode for each file, and restore preview before publication
and `onFile`. The next interval starts after the preceding file and synchronous
progress callback complete. This is an idle gap, not an absolute cadence or a
sensor FPS promise. `dropFrames` applies independently to each selected request.
DNG targets enable unpacked raw in the capture configuration.

Defaults are 1000 ms initial delay, 1000 ms interval, 5000 ms per-file/mode
timeout, 64 retained results and preview enabled (SDL when no preview is already
configured). Use `preview: false` to avoid opening a display, or select the
headless backend. Existing preview configuration is reused. Preview runs during
warmup and paced gaps; the fast capture phase suspends it. Completion, cancellation
or failure stops the camera and retires preview. Fast capture leaves the capture
configuration installed; paced capture leaves the restored preview configuration.
Save `camera.options` and explicitly switch back to another configuration if
needed. Pre-aborted jobs do not begin the lifecycle or stop an already running
camera.

Only one file/request operation is in flight. Pattern paths are generated on
demand, without allocating an array proportional to count. Explicit arrays are
snapshotted by indexed access. Image options, metadata bytes, modes and preview
options are copied/validated before changing camera state. Image metadata is
owned once and reused across per-format templates; the JPEG default capture Exif
policy remains distinct from opt-in PNG/TIFF Exif. Structural camera validation
uses the same native preflight as open; hardware mode negotiation still happens
when each target opens. Path existence, permissions and disk space remain I/O
conditions.

The camera reserves its lifecycle for the series. Outstanding requests, capture
jobs, recording and conflicting mode/focus work must retire before admission.
Use `job.cancel(reason)` or its supplied AbortSignal to cancel. External
`camera.stop()` and `camera.close()` cancel and join it. The `onFile` callback is
synchronous and runs after the file's request/hooks and I/O have joined; lifecycle
calls from inside it reject BUSY. Cancel the parent there instead. Async callbacks
are rejected so the series cannot retain unbounded callback tasks. A parent
`timeoutMs` covers the entire series; `captureTimeoutMs` bounds each capture or
mode transition. Long job deadlines use bounded host timer chunks rather than
the platform's signed-32-bit timer overflow behavior.

`job.partial` is an immutable snapshot available after success or rejection:
`completed`, `recentFiles`, `stage`, `currentIndex`, `currentPath` and `stopped`.
The retained history is a bounded ring (`retainResults` 0..4096); each record has
its ordinal index, path and copied metadata. Earlier snapshots do not change.
Use `onFile` for an external full manifest. Repeated destinations intentionally
replace in order, so history entries need not name distinct existing files.

Completed files survive later failure/cancellation. Each file uses the existing
staged publication contract; a claimed publication is joined before cancellation
settles. `completed` counts successful joined operations, not every file which
could have reached disk before an exceptional cleanup failure. Known native
outcomes on owned publication/cleanup errors expose `imageFilePublished`,
`imageFileResultCode` and `imageFileCleanupCode`; aggregated cleanup errors keep
their underlying errors. Inspect the failing path when handling I/O failures.
Process crashes and a whole-burst atomic filesystem transaction are not covered.

Home async's allocation-free `RelativeDelay` supplies overflow-checked relative
intervals and rejects clock regression. The camera C ABI exposes its 32-byte
`zc_capture_delay` state with default/arm/remaining functions. Zig exports
`RelativeDelay`. Neither helper sleeps, owns requests or negotiates hardware;
Bun owns the cancellable waits and camera-specific serial workflow. The native
`zc_check_camera_configuration` function performs allocation-free structural
preflight shared with open. The complete burst orchestration is a Bun surface;
native callers compose existing camera/capture/image primitives.

Tests cover fast/paced mode counts, independently decoded files, lazy large
counts, bounded history, ownership snapshots, cancellation, partial I/O failure,
clock regression, admission and known publication/cleanup outcomes. These are
hosted synthetic results. Pi 5 capture cadence, display continuity, autofocus,
raw sensor output and optical quality still need physical acceptance.
