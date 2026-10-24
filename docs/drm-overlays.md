# DRM video and alpha planes

```ts
camera.startPreview({backend:'drm-async',drm:{card:'/dev/dri/card1'}})
await camera.setOverlayAsync({data:rgba,width:320,height:180,stride:1280})
await camera.setPreviewViewAsync({
  window:{width:1280,height:720},
  overlay:{rectangle:{x:0,y:0,width:320,height:180},transform:{hflip:true}},
})
await camera.setOverlayAsync(null)
```

RGBA input is straight alpha, at most 4096×4096 with a validated padded source
span. The job snapshots active pixels before returning. Immutable snapshots
share native references and are bounded globally to 32 images/256 MiB. A native
worker job retains its input through callback cleanup; cancelled/failed admission
releases its snapshot. Headless preview validates without allocating images.
Legacy DRM/SDL also support synchronous `setOverlay`; a native worker requires
`setOverlayAsync`. Independent `DrmPreview` offers the same asynchronous setter.

The shared Home KMS renderer borrows one primary master/event FD for a separate
unused non-cursor AR24 plane on the same active CRTC. It requires proven strictly
higher zpos and a named Coverage or Pre-multiplied blend mode. Coverage is
preferred. Pixels become BGRA, with rounded `(component * alpha + 127) / 255`
when premultiplication is required. Unknown/missing/unsuitable properties reject
explicitly. This requires a console/available plane; it does not cooperate with
a desktop compositor, take occupied planes or set display modes.

Each overlay uses two reusable driver CPU buffers. Uploads finish dma-buf CPU
writes before scanout. Unchanged overlays are not uploaded per video frame;
linear video inputs retain their existing direct-import path. Video and overlay
geometry/targets update in one two-object atomic transaction. TEST rejection
preserves the previous scene. Unknown actual submission or flip timeout retains
possible sources in both owners until explicit proved detach; active kernel
work cannot be cancelled. The shared cookie sequence distinguishes both planes.

Rectangles use the transformed image's logical coordinates, with Home's shared
half-open viewport rounding and independent image/overlay transforms. A region
that collapses below a display pixel hides the plane while keeping its logical
snapshot. Background selection hides video and releases camera sources while
the independent overlay can stay visible over the existing CRTC content; no
black underlay is promised. Clearing an overlay restores its original properties
and retires its buffers while keeping the primary master FD open.

Camera serializes overlay jobs with view/source/drain/stop transitions. Its
stored immutable recipe survives ordinary/temporary camera modes, coordinated
single/group recorder modes and fresh-camera recovery. Bootstrap uploads stay
hidden until the new scene starts. Capture and encoders never include overlay
pixels. Close joins accepted jobs and retires the child before the primary;
failed child cleanup retains both owners for retry.

`DrmPreview.overlayState` and `Camera.previewInfo().drmOverlay` report configured,
visible, named blend mode, plane, driver-buffer/byte counts, CPU access,
uncertainty, poison state and successful update count. Native worker observations
are snapshots of the last completed callback. Queue state remains live. C adds
an independent 56-byte overlay state and seed/async functions without changing
existing preview layouts.

The Linux system-header C peer checks actual memfd-backed driver-map bytes,
named enum values, strict stacking, one shared master, two-object properties,
DMA fences, bounded reuse, queued cancellation, held/dropped flips and cleanup
retry. These are simulated driver acceptance tests. Physical Pi scanout,
color/alpha output, latency and throughput still require attached hardware;
full Picamera2 capability parity remains ongoing work.
