# Processed-stream configuration alignment

`alignStream` and `alignConfiguration` expose Picamera2's processed geometry
planning through Bun exports and Camera static helpers. They return owned values
without changing their inputs, opening a camera, negotiating modes or touching
buffers. Alignment is opt-in; ordinary camera configuration stays unchanged.

```ts
import { Camera, alignConfiguration, alignStream } from '@zig-utils/camera'

const geometry = alignStream({ width: 1919, height: 1081, format: 'YUV420' })
// PiSP default: 1792x1080, widthAlignment=128, heightAlignment=2 (pixels).
const planned = alignConfiguration({
  width: 1919, height: 1081, format: 'YUV420',
  lores: { width: 641, height: 481 },
}, { platform: 'pisp', optimal: true })
// main 1792x1080; lores 640x480.
const camera = new Camera(planned)
try {
  console.log(camera.info()) // Actual negotiated geometry/stride remains authoritative.
  using request = await camera.captureRequest()
  console.log(request.copyStreams(['main', 'lores']))
} finally {
  await camera.close()
}
```

Profiles are explicit deployment recipes. `pisp` (default, for the Pi 5 target)
uses a base width quantum of 64 pixels; `vc4` uses 32. This selects a recipe,
without detecting the host/device or proving an optimal setting for every codec
or workload. `optimal: false` uses a width quantum of two for every layout.
Height always rounds down to a multiple of two.

| Processed format label | Optimal width quantum |
| --- | --- |
| YUV420 / YVU420 | Twice the base, retaining base alignment in half-width chroma planes |
| XBGR8888 / XRGB8888 / RGB161616 / BGR161616 | Half the base |
| Other labels, including RGB888 / BGR888 | The base |

The rules follow the pinned
[Picamera2 align_stream/align_configuration implementation](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/picamera2.py).
Stream format labels must be nonempty, well-formed UTF-8 without NUL, at most 31
bytes. A planning label does not add capture/encoding support for that format.
CameraOptions currently accepts BGR888 and YUV420 main streams, and RGB/I420
lores. Other stream formats remain in the broader parity worklist.

The operation rounds requested dimensions down; it can reduce requested output
resolution. Use the original requested geometry when that tradeoff is unwanted.
The backend remains responsible for image scaling/cropping, actual stride,
buffer size and supported mode negotiation. Planning alone does not guarantee
padding-free allocation, zero-copy behavior, performance, sensor FPS or quality.

`alignConfiguration` snapshots its configuration, including nested sensor,
lores, transform and color values. It aligns explicit main/lores dimensions and
preserves raw enable/format, unpacking, exact sensor mode and other settings.
Unspecified or explicit 0/0 main dimensions remain automatic; disabled 0/0 lores
stays disabled. Explicit lores can be planned while main remains automatic.
No guessed default dimensions are inserted. A positive extent which would round
to zero rejects rather than silently selecting backend defaults. Partial-zero
geometry, invalid policy and structurally invalid configurations reject.

Native planning validates both aligned streams and the remaining structural
configuration before publishing either output. Failure leaves all outputs
unchanged, including in-place source/output objects. A late lores or color error
cannot expose partially aligned main dimensions. This is structural preflight;
device availability, supported modes and negotiated geometry are still checked
when the camera opens. Any configuration consumer can use the returned plan,
including asynchronous permanent/temporary modes, retained capture-and-stop and
recording reconfiguration. The helper itself changes no active camera lifecycle.

The CLI accepts `--align pisp`, `--align vc4` or `--align minimum`. It applies the
same native configuration planner before opening the camera or creating output:

```sh
zig-camera capture --width 1919 --height 1081 --main-format YUV420 \
  --lores-width 641 --lores-height 481 --align pisp --output aligned.png
```

The additive C ABI exposes `zc_align_stream_geometry` (20-byte
`zc_stream_alignment`) with explicit layout/profile enums and
`zc_align_camera_configuration`. Native outputs must be disjoint from each
other; configuration outputs may replace their respective inputs in place.
Zig exports Home's `StreamAlignment` types plus `alignStream` and
`alignConfiguration`. The shared Home planner owns no camera, pixel or allocator.
Its subtraction/remainder arithmetic remains exact through maximum u32 extents.

Tests cover profile/layout recipes, chroma quanta, minimum/tiny geometry,
idempotence and unsigned limits; atomic C/in-place errors; copied inputs and
automatic/raw/sensor preservation; aligned native/Bun captures and temporary/
stopped request workflows; and independently decoded CLI/PNG dimensions. These
are hosted synthetic/software checks. Physical Pi ISP stride behavior and any
performance or quality benefit still require hardware acceptance.
