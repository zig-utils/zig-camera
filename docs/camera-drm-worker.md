# Camera-owned native DRM preview

Version 0.111 adds an explicit `drm-async` Camera preview backend. It uses the
same Home KMS implementation and bounded serial executor as `DrmPreview`.

```ts
camera.startPreview({
  backend: 'drm-async',
  stream: 'main',
  drm: { card: '/dev/dri/card1', timeoutMs: 1000 },
})
await camera.setPreviewViewAsync({ window: { width: 1280, height: 720 } })
await camera.setPreviewStreamAsync('lores')
await camera.drainPreviewAsync()
await camera.stopPreviewAsync()
```

Open and initial empty-plane view setup are synchronous. Subsequent frame,
view, background, drain and device-close operations run on the native worker.
The legacy `drm`, SDL and headless backends keep their existing behavior.
The new asynchronous Camera methods also serialize SDL/headless transitions;
they do not move SDL calls off the Bun thread.

Camera admits one outstanding native frame operation. A new pump frame is
skipped for display while that operation is pending; capture and recorder
consumers can progress using remaining camera buffers. `previewInfo()` includes
owned `workerFrames` offered/completed/skipped counters and native `drmQueue`
telemetry. These counters describe display admission, not sensor frame loss or
physical display FPS. Native DRM state remains a last-completed-operation
snapshot. Frame exports pin source owners before the pump releases its frame.

Camera view, stream, drain and stop jobs have a separate bounded FIFO of 32
unfinished operations. Admission is checked again after application signal-listener
registration, including stop, queue-fill and mode-reservation reentry. Options are
copied at admission; an omitted stream-change
view inherits the view in effect when that operation executes. Pending jobs
pause display feed while capture/recording continue. Queued jobs are cancellable.
View/drain cancellation forwards the original reason to the native child; once
its operation is claimed, cancellation can fail. Stream replacement and stop
become noncancellable after their lifecycle transaction starts. Timeouts therefore
do not promise an interruptible kernel ioctl. Use `operationDone` to join work;
completion hooks may call Camera close without joining their own hook promise.

Synchronous view/stream/stop calls reject this worker backend. Across all
backends, synchronous view/stream/stop calls also reject pending preview jobs,
so they cannot overtake queued asynchronous transitions. DRM overlays,
compositor sharing and desktop integration remain unsupported. Existing DRM
format, master/unused-plane, linear-layout and cleanup restrictions apply.

Mode jobs first suspend feed and join/close this owned worker, then strongly
check camera leases. They never subtract a preview lease count: application
owners of the same camera buffer must still block reconfiguration. Permanent,
temporary and recorder/group mode transactions restore the preview recipe.
Failed admission restores the old view when the camera remains healthy. Stop,
close, capture-series cleanup and reconnect join the worker before changing or
releasing camera ownership. Independent `DrmPreview` objects still require their
own explicit retirement before camera reconfiguration.

Display failures suspend only preview. Recording can continue if sufficient
buffers remain. An uncertain scanout retains its source exports until proven
detachment. `previewError` records display/cleanup failures; `previewCleanupPending`
includes failed preparation owners and retained display owners. Retry
`stopPreviewAsync()` or `close()` after resolving the display problem. A failed
close never makes an uncertain source safe to recycle. An already pending detach
with a lost completion proof can still fail after the external fault is resolved;
join that attempt, then issue a fresh cleanup retry.

Linux CI uses an independent C DRM UAPI peer, actual file descriptors and actual
poll/read flip packets. It covers all twelve formats, withheld flips, Bun
heartbeat and capture/recording progress, bounded admission, async UI jobs,
caller leases, mode/group restoration, reconnect and cleanup faults. This is
protocol and ownership evidence. Physical Pi display, modifier/color acceptance,
sensor throughput and matched Picamera2 performance remain unmeasured.
