# Preview display views

Preview view controls change display only. Camera streams, still images, raw/DNG,
recording inputs, camera orientation and request metadata are unchanged.

```ts
camera.startPreview({
  backend: 'sdl', title: 'Trail camera',
  window: { x: 20, y: 40, width: 960, height: 540 },
  transform: { hflip: true }, keepAspect: true,
  overlay: { rectangle: { x: 0, y: 0, width: 320, height: 120 } },
})
camera.setOverlay({ data: rgbaPixels, width: 320, height: 120 })
// Replace view settings without uploading the existing overlay again.
camera.setPreviewView({ transform: { rotation: 90 }, keepAspect: false })
console.log(camera.previewInfo())
```

The optional window rectangle requests SDL window size and position. Width/height
must be 1..16384. Coordinates may be negative for other monitors but must be
integers in -1000000..1000000. Supplying only one position axis defaults the other
to zero. The window manager may adjust the request; previewInfo reports requested
settings, not measured screen geometry. With no window option, initial SDL sizing
retains its prior default; live updates leave the current OS window size/position
in place. Explicit window settings are reapplied on mode recreation.

Image transforms accept clockwise rotation 0/90/180/270, hflip/vflip along output
axes, and final diagonal transpose, like camera transforms. They are independent
of camera pipeline orientation. All eight orthogonal mappings are supported.
There is no display strict-negotiation flag. keepAspect defaults true: Home fits
the transformed logical image into the actual renderer output and centers its
black bars. False stretches it to the output. Integer fitting rounds down with a
one-pixel minimum. Resizes/HiDPI output use fresh renderer dimensions each draw.

Overlays default to the full fitted image and remain screen-oriented, regardless
of image rotation/flip. Set overlay.transform independently to rotate/flip overlay
content. An optional overlay.rectangle must fit entirely inside the post-display-
transform logical image. Its x/y/width/height are integer logical pixels, not
screen/window coordinates. The image's quarter-turn can exchange those logical
axes; source RGBA dimensions remain independent and scale to the destination.
Invalid/empty/out-of-bounds rectangles reject without clipping. Half-open edges
map with consistent floor rounding; a rectangle smaller than a display pixel may
become invisible and is skipped. Window bars remain outside the overlay.

## Updates, ownership and mode jobs

setPreviewView replaces view options; omitted transforms/aspect/overlay settings
reset to identity, aspect preservation and full-image overlay. Omitted window
settings leave the OS window in place as above. View settings persist across
setOverlay updates/clear and across ordinary, temporary and recorder-group mode
jobs. Returned previewInfo observations deeply copy every nested setting.

Input accessors are snapshotted before admission. Reentry that changes the active
preview owner rejects the outer update. Validation precedes changing the native
view or requesting window changes; an invalid or failed native update preserves
the old descriptor/view. Start failure closes the candidate preview. Target mode
geometry validates existing rectangles before attaching the recreated display;
an incompatible target triggers the existing joined camera rollback. Pending mode,
request/output callback and ownership guards apply to live view updates.

Headless preview snapshots and validates these same settings, including rectangle
bounds against target modes, but does not open/move/resize a window, upload pixels
or execute transforms. This supports one checked configuration surface without
adding a hidden software compositor.

## Native implementation and validation

The additive 48-byte zc_preview_view holds copied scalars. Initialize it with
zc_default_preview_view, validate source geometry with zc_preview_check_view
(available without SDL), and apply with zc_preview_set_view on the UI thread.
Flags select aspect preservation, explicit window size/position and overlay
rectangle; unused fields must be zero. Native orientation numbers come from
zc_orientation_from_transform and must not be replaced with EXIF numbers. Existing
ABI v1 layouts are unchanged.

Home viewport/region/orientation modules calculate fitting, bounds and independent
texture coordinates in Zig. The C SDL bridge applies those coordinates through
copy/rotate operations; camera-owned pixels are never rotated or rewritten. SDL's
[software geometry optimization](https://github.com/libsdl-org/SDL/blob/release-2.32.10/src/render/SDL_render.c)
can reinterpret quads as rectangle copies; pixel tests exposed incorrect transpose
results on that path. The bridge uses SDL_RenderCopyExF with an integer corner
pivot, preserving odd rectangular transforms and alpha without triangle seams.
SDL may accelerate these operations or perform/allocate software transforms in its
fallback; this is not a zero-copy or physical throughput claim.

Native software-renderer readback tests cover all eight image and overlay mappings,
odd rectangular source pixels, alpha, placement, invalid-update preservation,
subpixel rectangles, aspect/stretch behavior, resizing and window/thread isolation.
Bun tests cover copied settings, live failure/reentry, unchanged capture pixels,
headless validation and camera/recorder mode restoration. Home helpers pass pinned
and development Zig Debug/ReleaseSafe tests. DRM/KMS, GPU/GUI buffer sharing,
additional display formats and physical Pi acceptance remain parity work. Main/lores
and background-only selection are covered by [preview streams](preview-streams.md).
