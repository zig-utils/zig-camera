# Explicit RGB16 DRM display copies

Version 0.112 adds RGB161616/BGR161616 display input to both Camera DRM backends
and independent DrmPreview sessions with an explicit copy policy:

```ts
camera.startPreview({
  backend: 'drm-async',
  stream: 'main',
  drm: { card: '/dev/dri/card1', rgb16: 'high-byte' },
})
console.log(camera.previewInfo()?.drmStorage)
await camera.stopPreviewAsync()
```

The permission applies when the selected stream contains words. Other supported
inputs keep their direct-import path, including across source and camera mode
changes. Omitting the permission keeps word-format open unsupported. Native C/Zig
callers select `zc_preview_open_drm_rgb16` with a word-format config; the existing
96-byte config, 40-byte state and normal open ABI remain unchanged.

Home's checked RGB16 view reads the declared RGB/BGR memory order and little
endian words. It explicitly takes each sample's high byte, writes opaque BGRX8
and preserves zeroed padded rows. This is an eight-bit display copy, without
transfer/gamut conversion, HDR display mapping or dithering. Captured and encoded
word data retain their existing precision and provenance.

The shared Home KMS helper requires DRM_CAP_DUMB_BUFFER and PRIME export. It
allocates at most two 32-bit driver buffers, exports their dma-bufs and maps those
actual device allocations. CPU writes are bracketed by DMA_BUF_IOCTL_SYNC START
and END; no coherency error is ignored. Buffers and framebuffer objects are reused
only after the existing matching flip/CRTC event proves retirement. Background
retains the idle pool for reuse; close detaches and frees it. Driver pitches and
full allocation lengths are checked before mapping; each allocation is capped at
256 MiB. Failure to allocate/export/map is reported rather than substituting an
ordinary shared file for real scanout storage.

Input admission reuses the existing native read-map/catalog owner without
creating process-export staging files. Async conversion runs on the existing
native serial worker. Once conversion and output END succeed, the source export
is closed before submitting/waiting for the display flip. A queued/cancelled
operation still retains its input until native cleanup completes. A displayed
copy can outlive its source camera; a pending unconverted input still blocks
source retirement. Camera-owned preview joins its worker during mode/recording,
stop, close and reconnect transitions as before.

`DrmPreview.storageState` and `Camera.previewInfo()?.drmStorage` expose the input
and scanout formats, direct/copied policy, completed conversion count, allocated
buffer bytes and active CPU accesses. For async previews this is the last
completed-operation snapshot. `retainedFrames` counts camera exports, so it can
be zero while converted GPU buffers remain owned. Use storage telemetry as well
as `previewCleanupPending` to observe retained cleanup resources.

An uncertain flip retains both possible output buffers. Driver/framebuffer,
CPU END, unmap and FD-close errors preserve cleanup ownership. A private card FD
may already be consumed while a dma-buf mapping/fence still needs cleanup; keep
the preview and retry close. Repeated close never retries a consumed FD. No buffer
is reused while its GPU or CPU ownership is uncertain.

Linux validation uses an independent C UAPI peer backed by real memfd mappings
for the virtual driver's allocations. It reads actual shared output bytes,
checks both word layouts, opaque/padded output, two-allocation reuse, queued
cancellation, input retirement before held flips, source-independent display,
capability/malformed-layout/allocation/export/framebuffer/coherency errors and
post-card-close cleanup retries. Camera tests cover main/lores/background and
wide/direct mode restoration. Physical Pi scanout, driver support, colors and
matched Picamera2 performance remain unmeasured.

The implementation follows the kernel's [dumb-buffer API](https://www.kernel.org/doc/html/latest/gpu/drm-uapi.html#drm-ioctl-mode-create-dumb)
and [dma-buf CPU-access contract](https://docs.kernel.org/driver-api/dma-buf.html).
