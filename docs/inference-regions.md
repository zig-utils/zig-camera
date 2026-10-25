# Request-local inference geometry and KPI

`Frame.inferenceProjection({ stream, fullSensor, roi })` creates a copied plan
from the retained request's raw/processed stream sizes and applied `ScalerCrop`.
The default stream is `main`; `lores` uses its own negotiated output size.
The full sensor size defaults to the exact `PixelArraySize` property. Missing or
ambiguous properties, disabled raw/output streams, missing applied crop metadata
and degenerate geometry fail explicitly. `fullSensor` allows an explicit known
pixel-array size. Synthetic properties advertise a virtual physical array;
tests explicitly provide synthetic crop geometry rather than claim sensor proof.

```ts
// Enable raw when configuring the camera; no raw pixels are copied here.
const frame = camera.acquire()
if (frame) {
  try {
    const plan = frame.inferenceProjection({ roi: appliedInferenceRoi })
    const box = plan.convert([y0, x0, y1, x1])
    const visibleRoi = plan.roiScaled()
    const kpi = frame.cnnKpi()
  } finally { frame.release() }
}
```

Plans own integer geometry and copied capture metadata and remain usable after
release, camera closure and later camera configurations. `project(rectangle)`
accepts absolute full-sensor pixels. `convert(yxyx)` accepts four normalized
numbers, including Float32/64 views; the coordinates use Picamera2's
`(y0,x0,y1,x1)` convention. `roiScaled()` projects the full inference ROI.
Construct `new InferenceProjection({ fullSensor, sensorOutput, output,
scalerCrop, roi })` for already-owned request/image descriptions.
`inferenceAspectCrop(fullSensor, aspect)` produces the centered sensor crop.
These functions calculate geometry; they do not apply a sensor ROI control.

Projection first intersects the configured inference ROI, scales to raw output,
clips to the separately scaled applied scaler crop, translates that crop to
zero, then scales to ISP output. Each origin and extent rounds separately at
each stage, matching libcamera `Rectangle` semantics. A fused transform can
change small boxes. Negative normalized origins and derived widths/heights are
clamped individually before pixel truncation, matching the pinned Picamera2
sequence. Reversed or disjoint rectangles may be empty; their anchors can lie
outside the canvas. Draw only rectangles with positive width and height.
This is the sensor/ISP convention used by the upstream helper; an additional
preview/display rotation belongs to that display's coordinate transform.

All sizes must be positive and at most `INT32_MAX`; rectangle origins are signed
and extents unsigned. Applied scaler crops must be nonempty and inside the full
sensor, and remain nonempty after raw scaling. Nonfinite or overflowing input
coordinates fail before conversion. Endpoint arithmetic is widened. A zero ROI
tuple disables the extra crop. Centered aspect crops use libcamera's independent
integer half sizes, including odd-width crops, and reject subpixel dimensions.
The C API exposes a 64-byte `zc_inference_geometry`, 16-byte rectangle values and
the four `zc_inference_*` functions. Inputs are snapshotted before publication;
in-place value projection succeeds and errors preserve output storage.

`Frame.cnnKpi()` returns `null` when `CnnKpiInfo` is absent. A selective native
snapshot accepts only the exact output namespace/int32[2] value and skips large
input/output tensor payloads before visiting them. Temporary storage is bounded
to 4 KiB with an eight-byte value ceiling. The returned frozen object contains
`dnnRaw`, `dspRaw`, and `picameraMilliseconds: { dnn, dsp }`. The latter divides
the signed values by 1000, exactly as the pinned Picamera2 helper does. The raw
counters are retained because the control YAML describes milliseconds while the
helper applies `/1000`; no independent timing calibration is implied. Signed
extremes are preserved because the IPA casts uint32 counters to int32 controls.
`decodeCnnKpi(bytes, 'little' | 'big')` decodes an owned eight-byte export; shared,
detached, proxy and wrong-length inputs are rejected. The C API's 32-byte
`zc_cnn_kpi_info` has matching raw and converted fields, with guarded raw/catalog
and request readers. Errors preserve caller outputs; an absent request value
publishes `present=0`.

The coordinate sequence follows pinned
[Picamera2 IMX500](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/devices/imx500/imx500.py),
with [libcamera geometry](https://github.com/raspberrypi/libcamera/blob/c682979b50695b93526adb1e66db33743484b63b/src/libcamera/geometry.cpp)
and [the IPA counter export](https://github.com/raspberrypi/libcamera/blob/c682979b50695b93526adb1e66db33743484b63b/src/ipa/rpi/common/ipa_base.cpp)
as primary references. Tests include staged rounding, negative/empty/odd geometry,
actual system-libcamera rectangle comparisons, C output guards, both counter
byte orders, provenance, source retirement and Bun admission failures. Shared
helpers/public exports run on both selected compilers and all optimization modes;
actual normalized/aspect/KPI code links for freestanding ARM64 without libc/heap.

Firmware/network loading, model intrinsics, hardware ROI updates/restoration,
input tensor export/injection, model postprocessing and physical IMX500
geometry/timing acceptance remain required for full parity. No Python or FFmpeg
dependency is introduced.
