# Camera orientation

```ts
const camera = new Camera({
  width: 1920, height: 1080,
  transform: { rotation: 180, hflip: true, strict: true },
})
console.log(camera.orientation()) // requested, actual, adjusted
await camera.switchMode({ width: 4056, height: 3040 }) // inherits transform
await camera.switchMode({ width: 1920, height: 1080, transform: {} }) // resets it
```

`rotation` is clockwise and must be 0, 90, 180 or 270. Horizontal/vertical flips
then apply along the rotated output axes. Optional `transpose` applies a final
diagonal transpose. Without rotation, `hflip`, `vflip`, `transpose` therefore
follow Picamera2/libcamera Transform's flip-first/transpose-last ordering.
All flags are booleans. Configuration snapshots copy the transform at admission;
later edits to an options object or `camera.options` do not change the camera.

The native pipeline applies orientation before allocating camera buffers.
Recording, preview, maps, callback views, copies and image encoders therefore
consume the same transformed pixels. This path introduces no software rotation
copy or per-frame orientation worker. Default negotiation accepts and reports
libcamera adjustments. `strict: true` rejects a different negotiated orientation
with UNSUPPORTED before camera configure/allocation. Check `orientation()` before
depending on the result; Raspberry Pi sensor pipelines can adjust unsupported
90/270/transposed requests. Synthetic support for all eight orientations proves
geometry, ownership and negotiation logic, not physical sensor support.

Requested `width`/`height` describe output stream dimensions; rotation does not
silently swap these configuration fields. Explicit sensor mode dimensions remain
physical. Raw geometry and Bayer CFA order are negotiated independently and must
be read from the returned stream descriptor. With a nonidentity orientation,
explicit `rawFormat` retains exact depth/packing while accepting a changed Bayer
order caused by sensor flips. Existing identity requests retain their previous
exact-format validation. Unsupported packing/compressed raw still rejects.
DNG writes the negotiated CFA and transformed samples with TIFF Orientation=1,
so readers do not apply the transform a second time.

`orientation()` returns the libcamera Orientation numeric values:

| Value | Name |
| --- | --- |
| 1 | Rotate0 |
| 2 | Rotate0Mirror |
| 3 | Rotate180 |
| 4 | Rotate180Mirror |
| 5 | Rotate90Mirror |
| 6 | Rotate270 |
| 7 | Rotate270Mirror |
| 8 | Rotate90 |

Do not infer angles from this numeric ordering or reuse it as an EXIF tag on
already transformed pixels. Ordinary, temporary, autofocus and coordinated
recording mode jobs carry requested orientation and strict policy into the
target and rollback opens. Omitted `transform` inherits the admitted source
configuration; a provided object replaces it. Temporary captures restore the
prior transform before publication. Outstanding leases still prevent reopening.

C callers use `zc_orientation_from_transform`, `zc_open_oriented_pipeline`,
`zc_open_id_oriented_pipeline` and `zc_get_orientation`. Existing ABI v1 layouts
and open functions remain unchanged. Zig exposes `ImageTransform`,
`Camera.initOrientedPipeline`, `initOrientedPipelineId` and `orientation`.
The CLI accepts `--rotation`, `--hflip`, `--vflip`, `--transpose` and
`--strict-transform`; `info` reports requested/actual orientation.

Home's allocation-free `image/ops/orientation.zig` supplies admission conversion,
inverse pixel coordinates, dimensions and Bayer tile phase. Regression tests use
explicit rectangular pixel matrices, independently captured reference images,
I420 chroma planes, mapped rows, CFA/strip TIFF inspection, mode failures and
recording/preview coexistence. The real C++ bridge tests named libcamera enum
round-trips and strict/adjusted negotiation without requiring a camera.

For hardware acceptance, capture an asymmetric labelled chart in all supported
orientations. Retain requested/actual stream descriptors, compare main/lores/raw
corners and CFA, and independently decode JPEG/DNG and recorded video. Confirm
mode rollback/preview still match those pixels. Physical validation is pending.

Primary references: [libcamera orientation](https://github.com/libcamera-org/libcamera/blob/v0.2.0/src/libcamera/orientation.cpp),
[transform ordering](https://github.com/libcamera-org/libcamera/blob/v0.2.0/src/libcamera/transform.cpp),
[RPi negotiation and CFA adjustment](https://github.com/raspberrypi/libcamera/blob/main/src/libcamera/pipeline/rpi/common/pipeline_base.cpp),
[pinned Picamera2 conversion](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/utils.py).
