# Direct Linux DRM preview

```ts
camera.startPreview({
  backend: 'drm',
  drm: { card: '/dev/dri/card1', timeoutMs: 1000 },
  stream: 'lores',
  window: { x: 0, y: 0, width: 1280, height: 720 },
})
```

The shared Home renderer acquires DRM master on a private card FD, selects an
unused non-cursor plane on a connected, already active CRTC, imports linear
DMABUFs and submits atomic updates. Optional connectorId/planeId select exact
objects; omitted card uses discovery. It never takes an occupied plane or sets a
display mode. This targets a console display with an available plane; desktop
compositor/DRM leases and coordination between independent master FDs remain open.

Supported processed inputs are RGB/BGR24, RGBX/BGRX32, YUV/YVU420, NV12/NV21 and
the four packed 422 orders. RGB161616/BGR161616 additionally support an explicit
[high-byte display-copy policy](drm-rgb16.md) through driver-owned storage. Layouts preserve physical offsets and padded strides.
YUV requires named driver COLOR_ENCODING/COLOR_RANGE properties and negotiated
601/709/2020 matrix/range. No gamut, transfer or HDR conversion is implied. Camera
configuration rejects nonlinear processed modifiers. Other formats/modifiers,
overlay planes, Qt integration and mode setting remain open. Non-null overlays
and overlay transforms/rectangles reject explicitly. Aspect fitting, placement,
scaling and orthogonal image transforms use existing Home viewport policy.

Actual fd-backed camera inputs retain existing exported read owners and import
their FDs without an application image copy. Synthetic fd-less inputs use the
existing export staging memfd; real DRM may reject those allocations. Driver
internal copies and physical Pi display behavior have not been measured.

At least two camera buffers are required. The renderer retains the displayed
source and a possible replacement. TEST_ONLY rejection can retire the candidate;
an actual submit failure or missing completion retains both possible sources.
Only a matching private cookie/CRTC flip event proves retirement. PRIME handle
aliases share an explicit reference table so one framebuffer cannot close a
handle still owned by another. Detach restores the original plane properties
and waits for completion before sources return to the camera.

The legacy `backend: 'drm'` Camera pump uses synchronous native display calls,
outside camera-manager callbacks. Each event wait has a configured timeout
(1..60000 ms) and 64-event budget; kernel ioctls themselves are not wall-clock
bounded. For a Camera-owned native worker, select `backend: 'drm-async'`; see
[camera-drm-worker.md](camera-drm-worker.md) for bounded frame offers, async view,
source, drain and stop jobs and joined lifecycle/mode ownership. The independent
[DrmPreview](drm-async.md) consumer remains application-owned. Preview failure
suspends feed; independent recording can continue when sufficient unleased
camera buffers remain.

Mode admission detaches the preview's retained source before checking camera
leases. It still rejects caller-held frames, including a caller retaining the
same buffer as the preview. The display owner keeps its view and resumes normal
feed if admission rejects. Awaited autofocus may feed another frame, so mode
execution repeats the retirement check before changing camera configuration.

Inspect `previewError`, `previewCleanupPending`, and `previewInfo()?.drmState`.
A failed detach preserves the handle and leases for an explicit `stopPreview()`
or `close()` retry. After confirmed detach, cleanup IO errors are still reported;
if the private device is already consumed, a registered acknowledgement owner
remains until the next close. Failed candidate preparation has the same retained
cleanup policy, even when the Camera's native camera handle has already closed.
C callers must serialize calls and retain any preview handle whose close returns
nonzero. Raw borrowed show/show_input cannot provide this lifetime and reject DRM.

Software coverage includes a separate Linux C UAPI peer using system headers:
format imports, aliased GEM handles, atomic flags/events, geometry, original
property restoration, main/lores/background, mode jobs, recording isolation,
uncertain submits and cleanup retries. Portable Home tests cover bounded layouts
and ownership policy. C/Bun ABI tests cover admission on non-KMS hosts. These
checks establish protocol and ownership behavior, not real scanout, optical
quality, performance improvements or full Picamera2 parity. Physical acceptance
on both Linux architectures and the Pi 5 remains required.

The renderer also exposed an export-admission cleanup bug: concurrent primary
release could hide a final DMA retirement failure behind STALE. The regression
now checks that IO takes precedence while all leases still retire.
