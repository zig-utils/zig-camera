# Preview overlays

Start the existing asynchronous preview, then call `Camera.setOverlay` with
straight-alpha RGBA8 pixels or null to clear it. Dimensions need not match the
camera: SDL scales the overlay across the logical camera image, inside the
preview window's aspect-preserving letter/pillar boxes.

```ts
camera.startPreview('Trail camera')
camera.setOverlay({ data: rgbaPixels, width: 320, height: 180 })
// Source bytes may be changed or freed after setOverlay returns.
camera.setOverlay(null)
camera.stopPreview()
```

RGBA channel order is explicit, independent of native integer endianness. Alpha
zero leaves the image visible, 255 replaces it and intermediate alpha composites
source RGB over the displayed camera RGB. Supply straight, unpremultiplied color.
An optional stride describes padded source rows; only active width*4 bytes are
copied. Dimensions must each be 1..4096. One native immutable image owns at most
64 MiB; replacing it temporarily owns both old and candidate images, with separate
SDL texture resources. No pixel queue or unbounded retained update list is added.

Home image's checked RGBA view validates extent arithmetic, last-row truncation
and compact copying. Zig owns the immutable pixel allocation. SDL uploads it
synchronously once per update and renders a separate blend texture; zig-camera
does not blend a full camera frame on the CPU for each preview frame. SDL may use
its accelerated renderer or its existing software fallback. This is a display
operation: capture, still encoding, DNG and recording inputs are unchanged. Color
values blend in the display RGB space; this adds no linear-light or ICC conversion.

Uploads take effect on the next displayed frame. Invalid input or failed texture
preparation preserves the previous overlay. Source arrays must not be modified
concurrently during the synchronous copy. Updating overlays during request/output
callbacks or admitted mode jobs rejects to preserve ownership boundaries.

Camera mode, temporary capture, autofocus and single/group recording mode jobs
reapply the same native image when recreating preview. Failed reapplication closes
the candidate preview and uses the existing joined camera rollback; the old image
is retained for restoration. Camera stop/close, explicit stopPreview and preview
window closure release both texture and native image. A later explicit startPreview
starts without an overlay. Failed startup closes its candidate preview.

## Native C and Zig

`zc_preview_overlay_create` copies borrowed rows into a native immutable handle,
independent of the camera and SDL. Close it with `zc_preview_overlay_close`
(NULL is safe). `zc_preview_set_overlay(preview, image)` synchronously uploads
on the same UI thread as preview creation; NULL clears. The preview retains no
image pointer, so a C caller may immediately close an uploaded image. A caller
that needs recreation keeps the image and uploads it to each new preview. Serialize
use and close; ownership does not make a stale handle usable. ABI v1 layouts remain
unchanged. Overlay creation is available without SDL; applying one reports
UNSUPPORTED when the optional preview backend is absent.

Tests read back the actual SDL software render target before presentation for
transparent/half/opaque alpha, scaling, replacement, clearing, window independence
and resized-window black bars, and reject wrong-thread updates/close. SDL 2
[readback implementation](https://github.com/libsdl-org/SDL/blob/release-2.32.10/src/render/SDL_render.c)
clips to its current viewport; the test resets that viewport after drawing when
checking bars. Native tests verify copied padding/alpha and source independence;
Bun tests cover restoration, upload failure, cleanup and unchanged capture data.

[Headless preview](headless-preview.md) validates setOverlay input and ignores it,
without retaining or uploading pixels. Overlay rectangles/transforms, DRM/KMS, GPU sharing,
GUI integrations and physical Pi preview latency remain parity/acceptance work.
