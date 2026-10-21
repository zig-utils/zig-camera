# Headless preview lifecycle

`Camera.startPreview({ backend: 'headless' })` starts the shared request pump
without a window, SDL, a display texture or a pixel-copy queue. It works with the
baseline native build. The existing string argument and default startPreview()
continue to select SDL; an options object can also select `backend: 'sdl'`.

```ts
await using camera = new Camera({ width: 1920, height: 1080 })
camera.startPreview({ backend: 'headless', title: 'Trail capture' })
camera.preCallback = (request) => {
  const metadata = request.metadata()
  // Synchronous callback; retain explicitly if keeping a request.
}
console.log(camera.previewInfo()) // { backend: 'headless', title: ..., suspended: false }
const metadata = await camera.captureMetadata()
camera.stopPreview()
```

Headless preview consumes/releases the same bounded native requests used by SDL,
recordings, controls/autofocus and capture jobs. It does not render or implicitly
copy RGB. Callback dispatch remains on Bun's thread; camera manager callbacks keep
the existing queue-only ownership boundary. Callback scopes, explicit retained
leases, producer backpressure and mapping rules are unchanged. A failing request
callback is quarantined under the existing policy; the headless consumer continues
unless a camera/ownership failure requires suspension or close.

## Ownership and state

Only one preview owner may be configured per Camera. Starting either backend while
one is configured rejects. Stop the current preview before selecting another.
Input options are copied before reservation, and invalid or reentrant options
cannot overwrite an admitted owner. Failed camera/SDL startup discards its
candidate so a later headless start can proceed.

`previewInfo()` returns an owned observation or undefined after explicit stop
or camera close. It includes backend, title (empty is valid) and suspended. A mode
job preserves the immutable descriptor while it temporarily stops display/capture
processing; coordinated recorder reservations also report suspension until the
whole job releases ownership. If restoration cannot recreate a display, the
configured suspended owner remains observable and can be explicitly stopped.
The observation performs no FFI and is not a promise of a delivered frame.

Camera mode changes, temporary captures, controls/CAF restoration and single/group
recording mode jobs preserve the selected preview backend. Cancellation joins
camera rollback and output cleanup before the pump resumes. Calling preview
start/update/stop during active ownership transitions follows the existing job
guards. Camera stop/close cancels and joins mode work before retiring the preview,
recorders and native camera. Close remains repeatable, including suspended owners.

`stopPreview()` removes that preview's demand for frames; it does not stop the
camera or disable request callbacks, recordings or captures. Those consumers may
continue to drive the shared pump. A headless preview with no other consumers
stops acquiring requests after stopPreview. Explicit camera stop pauses everything;
a later startPreview creates a fresh session with no stale descriptor or overlay.

Headless `setOverlay` retains the public RGBA geometry/extent validation but
otherwise ignores valid input, like upstream NullPreview. It creates no native
image or texture, retains no source bytes and does not turn headless processing
into CPU compositing. Title is retained metadata with no window side effect. [Display view settings](preview-views.md)
are also snapshotted/validated and preserved, including target rectangle checks
during mode changes; headless processing performs no window or transform operation.

## Reuse and validation

No new queue, lease type, thread or native ABI layout is needed. Native camera
start/acquire/release and Home lease/access helpers remain the ownership source;
mode jobs retain Home preparation_gate cancellation/publication semantics. C/Zig
callers can consume and release requests without opening an SDL preview as before.
Home OS's framebuffer/display compositor is a kernel rendering path, not a hosted
headless request dispatcher, so it is not imported or executed.

Tests run without SDL and cover frame draining without callbacks/pixel copies,
callback/retained request sharing, callback failure and reentry, overlay no-op,
CAF and controls, ordinary/temporary/single/group modes, held output preparation,
joined cancellation and stop, failed preparation rollback, repeated close and
immutable options/observations. Optional SDL tests alternate backends and exercise
failed display setup recovery. Linux x86/ARM CI also retains real libcamera
build/load/no-camera checks. No physical Pi scheduling/throughput claim follows.

Headless lifecycle and [display view controls](preview-views.md) are implemented.
Additional display stream/format selection, DRM/KMS, GPU/GUI buffer sharing and
physical display acceptance stay in the full parity worklist.
