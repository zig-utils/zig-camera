# Sensor HDR and runtime ISP HDR

IMX708 sensor HDR changes the sensor layout before opening cameras. Runtime
`HdrMode` is a separate libcamera ISP control; its availability and accepted
values depend on the selected camera, pipeline and SDK. Neither API promises an
HDR fusion implementation in the synthetic backend.

```ts
import { Camera, HdrMode, IMX708 } from '@zig-utils/camera'

// Close all cameras, manager watches and mode/recovery jobs first.
using sensor = new IMX708() // first discovered Model === "imx708"
// Or select one global discovery index / exact full cameraId, exclusively.
const outcome = sensor.setSensorHdrMode(true)
console.log(sensor.cameraId, outcome.enabled)
// Closing the helper keeps the selected sensor mode.
sensor.close()

await using camera = new Camera({ width: 1920, height: 1080 })
console.log(camera.sensorModes()) // fresh catalog after sensor layout change
// This is an independent runtime ISP setting, if advertised by this camera.
camera.setHdrMode(HdrMode.singleExposure)
await camera.captureMetadata({ dropFrames: 10 })
```

Pi 5's single-exposure ISP HDR accumulates frames using temporal processing;
it does not enable IMX708 sensor HDR. Allow settling frames after changing the
runtime setting. Multi-exposure modes need scene-specific evaluation, especially
for a moving dog, moving camera, foliage or water. Supported controls and metadata
must be queried on the actual device. No optical or HDR quality measurements have
been made on a physical Pi by this project.

`IMX708({ backend: 'synthetic' })` is explicit opt-in for tests. It models the
control, lifetime and catalog contracts only. Its HDR-on catalog has one existing
1920×1080 10-bit synthetic mode; HDR-off restores the three test modes. These are
fixtures, not IMX708 sensor specifications or an HDR image generator. Synthetic
state is shared within one native-library process and does not persist between
CLI invocations.

## Lifetime and failures

At most 16 helpers own pinned sensor descriptors. Exact camera ID is copied;
index means the global discovery index, not an IMX708-only index. Automatic
selection skips unrelated models. Linux scans the bounded sysfs node collection,
including indices above 15, and requires a unique exact driver/device-tree ID
association. Before IO it revalidates that association and the pinned character
node identity. It never accepts a caller-supplied device path.

Mutation returns BUSY while any native camera, Bun logical Camera, manager watch
or discovery manager scope remains live. Stopping capture is insufficient.
Logical Camera ownership also covers the native close/reopen gap in async mode
and recovery transactions. C callers managing their own close/reopen transactions
can retain a `zc_sensor_layout_scope` across that transaction (64 explicit scopes
maximum). Native sessions retain their own scope automatically. These scopes do
not increment public tuning manager-user counts or retain an environment lease.

On Linux an idle-only temporary libcamera manager checks the exact Model and
acquires the camera before the ioctl. It and its camera references retire before
the tuning environment guard. The next open constructs a fresh manager and mode
catalog. A concurrent external libcamera client can still prevent acquisition;
there is no process-wide lock against arbitrary external V4L2 writers.

Writes validate the boolean V4L2 control, read the current value, skip identical
writes, and read back after an attempted write, including failed writes. No
failed write is automatically retried. `SensorHdrError.state` preserves observed
`enabled`, `previousEnabled`, `changed`, write flags, catalog invalidation,
manager generation and native errno. Unknown booleans are `undefined`, not false.
`catalogInvalidated` means a write was attempted and subsequent opens must obtain
fresh modes; it does not claim that the write succeeded. The original write
failure takes precedence over a later readback failure. The C flags and Zig
out-state provide the same partial-outcome information.

Closing a helper preserves sensor mode. Closing it while its operation is active
returns BUSY and retains ownership. C handles require caller serialization and
exactly one successful close. Bun close is idempotent; explicit resource disposal
is supported. Tuning cleanup failures remain visible and retryable through the
existing tuning APIs.

## Runtime API and CLI

`HdrMode.off`, `singleExposure`, `multiExposure`, `night` and
`multiExposureUnmerged` map to integers 0–4. `Camera.setHdrMode()` is a convenience
for `Control.hdrMode` in the existing atomic staged control API. Successfully
accepted state is copied and replayed across mode switches and restarts. Real
backends resolve `HdrMode` by SDK control name; unsupported controls return the
existing Unsupported error. Synthetic request metadata reports the separate
`SyntheticHdrMode` marker for restoration tests, without claiming physical HDR
metadata or image fusion.

```sh
zig-camera sensor-hdr get
zig-camera sensor-hdr on --camera 0
zig-camera sensor-hdr off --camera-id /base/axi/pcie@1000120000/rp1/i2c@80000/imx708@1a
zig-camera capture --hdr-mode single-exposure --warmup 10 --output trail.jpg
```

Sensor commands print JSON observations and return a nonzero exit status on
failure. `--camera` and `--camera-id` are mutually exclusive; unknown actions,
duplicate selectors and invalid indices fail before mutation. `--simulate`
selects only the synthetic helper. The ordinary capture/preview/record commands
accept `--hdr-mode off|single-exposure|multi-exposure|night|multi-exposure-unmerged`.

The implementation follows the [official Picamera2 manual, sections 9.6–9.7](https://datasheets.raspberrypi.com/camera/picamera2-manual.pdf)
and the [Linux V4L2 control ABI](https://cdn.kernel.org/doc/html/latest/userspace-api/media/v4l/vidioc-g-ctrl.html).
Physical IMX708, Pi 5 ISP, cross-process contention and mode/HDR quality acceptance
remain required; Linux build/load and fake ioctl tests cannot establish them.

## Validation record for 0.101

Local pinned Zig ReleaseSafe passes 510 native tests. Eight C ABI programs,
1,630 Bun tests, TypeScript checking and the sensor-HDR CLI checks pass. Real
backend Zig sources compile to Linux x86_64 and aarch64 objects locally; actual
system-STL libcamera bridge compilation, load/no-camera smoke and the independent
Linux ioctl harness run in CI on both CPU families. The portable Home helpers
also have pinned/development compiler Debug/ReleaseSafe tests and exact upstream
public API checks. The local standard build runner still fails linking macOS
libSystem before project compilation; target-qualified direct builds provide the
local results, and the standard build is retained in CI.
