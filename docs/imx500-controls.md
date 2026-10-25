# IMX500 cached inference controls

`IMX500` owns a pinned sensor subdevice independently of a Camera. Opening it
selects an exact discovered `Model=imx500`, validates its sysfs association and
character-device identity, queries the real V4L2 control shape, and saves the
current cached inference window. Construction does not write controls, load a
network, power the camera or retain a camera manager. At most 16 descriptors
(including pending opens) are admitted; a backend/camera identity has one owner.
Caller-supplied device paths are not accepted.

```ts
import { IMX500 } from '@zig-utils/camera'

using sensor = new IMX500({ cameraId: '/base/axi/pcie@120000/rp1/i2c@88000/imx500@1a' })
const square = sensor.setInferenceAspectRatio({ width: 1, height: 1 })
console.log(square.currentRoi, sensor.getDeviceId())
// Only when explicitly needed, issue one write of the last successfully saved ROI.
sensor.restoreInferenceRoi()
```

Use an actual ID from camera discovery. Omitting both `cameraId` and `index`
selects the first supported sensor. Supplying both is invalid. The standalone
helper has no network-path constructor argument; firmware/model support remains
open. Build with `-Dlibcamera=true` on Linux for real device access.

The absolute ROI uses the 4056×3040 active sensor array. Signed origins are
clipped with widened arithmetic. Empty/disjoint crops are rejected. Both an
explicit `{x:0,y:0,width:0,height:0}` reset and the complete sensor rectangle
encode as `[0,0,0,0]`: the inspected driver interprets zero width **or** height
as full sensor. Its advertised scalar maximum is 4032, smaller than the active
width, so a partial-height full-width crop can be unrepresentable and returns
`ZC_UNSUPPORTED` before writing. Runtime minimum/maximum/step are always checked.
Aspect crops reuse Home's centered integer-half geometry.

`getInferenceRoi`, `setInferenceRoiAbs`, `setInferenceAspectRatio` and
`restoreInferenceRoi` return immutable owned observations. State includes raw
previous/current/saved values, separately valid effective rectangles, queried
bounds, write attempt/success, optional observed change, a descriptor-local
write-attempt revision, and the first system errno. A revision is not a camera
control revision or proof that any frame used that crop. On failure,
`Imx500Error.state` preserves available observations. A failed write never
replaces the saved value, even if readback observes a partial change. Successful
unchanged sets skip writing; explicit restore forces one write. After any
attempted write there is one readback transaction. Read/query syscalls retry
EINTR at most eight times; writes are never automatically retried, including
EINTR. The first write failure wins over a subsequent observation failure.

V4L2 readback reports the driver's cached control. Writes while powered down can
update only that cache; stream-start handler setup reapplies it. The pinned
helper stays alive across camera mode changes without reopening or duplicating
writes. Closing the helper preserves the kernel cache. External writers can
change it; `getInferenceRoi` observes them without changing the saved value.
Neither cached readback nor the synthetic restart test proves frame-level
application. Use request metadata and physical capture validation for that.

`getDeviceId` returns four U32 words as 32 uppercase hexadecimal digits. Its
read-only, volatile control may be marked inactive and may fail while unpowered;
the helper does not start a stream or upload firmware to obtain it. Synthetic
mode returns a clearly synthetic marker, preserves its process-local ROI cache
across helper closure, and exercises protocol/ownership only. It emulates no
sensor pixels, neural network or device serial number.

Close is idempotent in Bun. A busy native close retains ownership for retry;
failed identity adoption that also fails cleanup throws
`Imx500ConstructionError` with `cleanupOwner.close()`. Native callers serialize
handle lifetime and stop invoking it after successful close. C state is 160
bytes, capabilities 40 bytes; additive exports preserve ABI version 1.

Interface facts were checked against Raspberry Pi Linux
[`5bd564aaa8dc4b1b8ed11733c19ec8ece63a72cc`](https://github.com/raspberrypi/linux/blob/5bd564aaa8dc4b1b8ed11733c19ec8ece63a72cc/drivers/media/i2c/imx500.c)
and Picamera2 `5e2a35d3bb230825c98c56d98e01b41ddeb43e86`. The system-header
syscall peer checks shape, bounded retries, single writes, partial failures,
cache-versus-register semantics and guarded device-ID output. Firmware/network
loading, input tensors, intrinsics/model postprocessing and physical IMX500
acceptance remain open.
