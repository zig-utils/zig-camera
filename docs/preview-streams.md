# Preview streams

Preview can display main or paired lores independently of still capture and
recording input. Omitted stream defaults to main. A null stream keeps the request
pump, window background and overlay active without reading source pixels or
allocating an image texture. Headless uses the same checked configuration and
negotiated observations without opening SDL or displaying pixels.

```ts
const camera = new Camera({
  width: 1920, height: 1080,
  lores: { width: 640, height: 360 }, // planar I420; rgb:true selects RGB
})
camera.startPreview({ stream: 'lores', title: 'Trails' })
console.log(camera.previewStreamInfo())
camera.setPreviewStream(null) // background/overlay only
camera.setPreviewStream('main', { keepAspect: true })
// Camera.startRecording and captureRGB still choose their own input.
```

previewInfo includes an explicitly configured stream. previewStreamInfo returns a
fresh copy of stream, negotiated width/height, pixel format and color space, plus
suspension state. Null uses main dimensions as the logical overlay viewport and
omits image format/color. Changing returned objects cannot change the live owner.
Stop clears the selection. Internal mode suspension retains its immutable recipe.

setPreviewStream(stream, optionalView) prepares a replacement display before
retiring the previous one. Omitting optionalView preserves view settings and the
owned overlay. Supplying it replaces view settings, like setPreviewView. This lets
an overlay rectangle change atomically when switching to a smaller source. Invalid
streams, disabled lores, incompatible rectangles and failed preparation/old-close
leave the old owner intact. A source change may recreate the SDL window; default
window placement/sizing follows SDL unless the recipe explicitly requests it.

Camera, temporary capture, single-recorder and recorder-group mode jobs recreate
the selected display using fresh negotiated geometry/format/color. A mode that
cannot supply the selected lores source triggers the existing joined rollback.
Pending jobs and request/output callback guards apply to live updates. Capture
callbacks close their mapped scopes before display reads post edits.

## Color, ownership and failures

Supported image sources are libcamera BGR888 (RGB byte order) and planar YUV420
(I420). I420 accepts packed or three-plane input with validated strides and spans.
It requires a present negotiated BT.601/709/2020 non-constant-luminance matrix and
full/limited range. Unknown metadata is rejected instead of guessed. Conversion
produces encoded RGB; it does not change transfer function or primaries, apply an
ICC profile, or establish calibrated display color. Capture metadata is unchanged.
Additional packed/YUV formats and color management remain parity work.

The additive native zc_preview_show_stream(preview,camera,token,MAIN|LORES) holds
an allocation-free scoped reader while SDL copies/converts. Final release and
writers return BUSY during the call. Other owners may retire their references;
the last physical buffer stays pinned until the scoped reader ends. The camera
operation mutex is released before SDL runs. No frame pointer survives the call.
There is no new reference-token allocation or per-frame Bun pixel copy.

RGB rows copy into SDL's streaming texture. I420 uses Home's checked decode420
directly into the locked RGB texture, without a temporary RGB image. Validation
finishes before locking/writing. Home reuses chroma contributions across each 2x2
block and preserves legacy fixed-point output exactly. Shared-host benchmarks are
mixed under ReleaseSafe; see the [Home reuse audit](home-reuse.md). This is not a
zero-copy, GPU conversion, Pi FPS or Picamera2 performance claim.

Native callers can use zc_preview_check_color without SDL. zc_preview_show_input
accepts an explicitly borrowed descriptor in frame.main for either selected
source; its caller must retain/synchronize that storage through the call. The
camera-token API handles read exclusion itself. zc_preview_open_background and
zc_preview_show_background do not create/use an image texture. Existing ABI v1
frame layouts are unchanged; there is no lores field added to zc_frame.

An asynchronous display failure is exposed through camera.previewError and stops
that preview; healthy recording/capture consumers continue. A new successful
preview start/live source replacement clears the diagnostic. Window close is a
normal stop. Cleanup ownership failures still propagate to shared pump handling.
Synchronous configuration failures and mode job failures throw/reject normally.

## CLI and validation

```sh
zig-camera preview --lores-width 640 --lores-height 360 --preview-stream lores
zig-camera record --preview --preview-stream lores --lores-width 640 --lores-height 360 --record-stream main --output trails.mp4
zig-camera preview --preview-stream none
```

Native SDL software-renderer readback compares every matrix/range against an
independent floating reference, including padded/truncated inputs, packed I420,
actual leased lores, stale tokens and writer exclusion. Background constructors
are checked for no image texture. Existing image/overlay transform/alpha tests
remain. Bun tests cover selected geometry, deep copies, reentry, live failure
preservation, mode restoration, source-independent capture/recording and isolated
runtime display errors. Linux CI runs both architectures and real backend loading;
physical Pi display/latency/camera acceptance remains outstanding.
