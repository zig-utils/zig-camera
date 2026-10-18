# Runtime controls, focus jobs and async preview (0.4)

Runtime controls are available through Zig, C and Python. Original ABI v1 layouts
remain unchanged. New structs/functions are additive; Python 0.4 requires the
matching native library. No FFmpeg dependency is introduced.

## Controls

```python
from zigcamera import Picamera2

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1280, 720)}))
    print(camera.camera_controls)  # This camera's supported min/max/default values.
    camera.start()
    revision = camera.set_controls({"AeEnable": False, "ExposureTime": 10000, "AnalogueGain": 2.0})
    camera.set_controls({"AwbEnable": False, "ColourGains": (1.8, 1.5)})
    # Capture metadata to observe actual exposure/WB; pipeline delay is natural.
    print(camera.capture_metadata())
    camera.set_controls({"AeEnable": True, "AwbEnable": True})
```

`Camera.control_info` provides supported types, shapes, ranges and enum masks.
The Picamera2 facade provides the familiar `camera_controls` tuple mapping.
The catalog covers AeEnable, ExposureTime, AnalogueGain, ExposureValue, AwbEnable,
ColourGains, Brightness, Contrast, Saturation, Sharpness, FrameDurationLimits,
LensPosition, AfMode, AfTrigger, AfRange, AfSpeed, AfMetering, AfWindows, ScalerCrop,
NoiseReductionMode, AeMeteringMode, AeExposureMode, AwbMode, ExposureTimeMode,
AnalogueGainMode, AfPause, AeConstraintMode, ColourTemperature, AeFlickerMode and
AeFlickerPeriod. A control appears only when the configured camera advertises it.
This is an extensible supported catalog, not every vendor-specific libcamera ID.

Batches contain up to 32 unique controls and are validated completely before
staging. Invalid ranges, discrete enum values, types, shapes, nonfinite/fractional
integers, duplicate IDs and inverted frame-duration limits are rejected. Unsupported
controls fail explicitly. Rectangles use sensor pixels; each must fit the camera's
advertised maximum rectangle. AfWindows supports up to four rectangles. Do not use
normalised screen coordinates. FrameDurationLimits accepts (minimum, maximum).

A successful update returns a monotonic submission revision. Pending updates merge
by ID until a request is recycled, with later values replacing earlier ones.
Queued/leased frames retain their original metadata. `ControlRevision` means the
latest submitted control revision associated with that request; it is not proof
that the sensor/ISP has already applied every setting. Sensor pipeline delay and
libcamera clamping remain. Inspect actual per-frame metadata for application.
`EventId` orders completion notifications across stop/restart independently of
sensor sequence numbering. `Camera.wait_metadata(after_event, timeout_ms)` observes
completion without consuming/recycling a frame.

Changes may be staged before start. Persistent controls are retained for restart;
one-shot AF trigger/pause actions are discarded on stop. AeEnable updates the newer
exposure/gain mode controls when available; explicit modes in the same batch take
precedence. Manual exposure/gain values require manual modes or AeEnable=False.
AF mode/lens/range/speed/windows changes are rejected while a managed AF job is
active; cancel the job before changing its focus configuration. Unknown metadata
fields are omitted rather than invented. Synthetic control behaviour is a test
model, not a simulation of optical focus or auto-exposure algorithms.

## Autofocus jobs

```python
camera.start()
job = camera.autofocus_cycle(wait=False, timeout=5)
# Other application work; recording and preview may continue.
focused = job.result(timeout=6)
# Or inside an asyncio coroutine: focused = await job
# job.cancel() requests cancellation; a terminal result is never overwritten.
```

Default `autofocus_cycle()` waits and returns bool. `wait=False`, or a supplied
`signal_function` with default wait, returns a job. The completion callback receives
the job on a separate callback thread, outside the capture worker. Callbacks may
outlive camera close; lifecycle shutdown joins the monitor without waiting for
application callback code. Callback exceptions are
available through `job.callback_error`. `camera.wait(job, timeout)` is also supported.

The native job sets AfMode=Auto and AfTrigger=Start, then requires a Scanning
metadata state at/after the trigger's submission revision before accepting Focused,
Failed or Idle. Old focused frames cannot complete a new job. This follows
[Picamera2's two-phase AF behaviour](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/picamera2.py).
A camera that never reports Scanning will time out instead of claiming success.
Only one current AF job is retained in the native session; old IDs become stale
when a new job starts. The Python job caches its own result before reuse.

Focused returns True; failed/idle after scanning returns False. Cancellation raises
`concurrent.futures.CancelledError`; camera stop raises RuntimeError. The scan's
`timeout` cancels the hardware trigger and raises TimeoutError. `job.result(timeout)`
only limits the caller's wait and does not cancel the underlying scan. Cancelling
an asyncio await requests cancellation of the native job. A single capture worker
recycles requests; a job monitor observes native state without stealing frames.
No camera-manager callback runs user code or performs image work.

## Async preview

```python
from zigcamera import Picamera2, H264Encoder

def main():
    with Picamera2() as camera:
        camera.configure(camera.create_video_configuration(main={"size": (1280, 720)}))
        preview = camera.start_preview()  # Returns after display startup; capture can start later.
        camera.start()
        camera.start_recording(H264Encoder(bitrate=12000000), "trail.mp4")
        print(camera.autofocus_cycle())
        print(preview.stats)
        # Run the application's event loop/work here.
        camera.stop_recording()
        camera.stop_preview()

if __name__ == "__main__":  # Required when using multiprocessing spawn from scripts.
    main()
```

Build with `-Dpreview=true` and SDL2. AVC/HEVC additionally needs `-Dcodecs=true`.
The display process creates/shows/closes SDL on its own main thread, including on
macOS. It never receives a camera handle, lease or DMA-BUF descriptor. Recording,
AF and preview share one capture worker. Preview uses one preallocated shared RGB
slot and an SDL texture upload. Publication uses a nonblocking lock; busy display
work causes preview drops rather than blocking capture/recording. Active RGB rows
are copied by checked native code, respecting camera stride. It is not zero-copy.

Window close/Escape exits the display process; `stop_preview()` closes parent
resources. Preview can be restarted. Startup errors, abnormal display exit and
copy errors are surfaced; shutdown uses a lock-free stop flag and bounded joins,
with terminate/kill fallback for an unresponsive child. A stopped worker is joined
before a replacement is created. Stop/close joins all internally owned workers and
releases their leases before destroying the camera. Serialize public lifecycle
calls; external acquire/metadata-observer threads must be joined before close.

The original `preview()` remains a blocking same-thread SDL loop. This is not Qt,
DRM, an overlay API, or Picamera2's complete preview backend interface. Direct
capture calls during background recording still compete for requests and can
introduce recorded gaps; this is not full request fanout to arbitrary consumers.

## Acceptance

Synthetic tests cover transaction atomicity, queued/leased metadata, typed range
checks, observer stop wakeups, scan gating, timeout/cancel/stop, callbacks/await,
rapid worker handoff, preview-before-start, simultaneous preview/recording/AF,
display crashes, cleanup and restart. SDL tests use the dummy driver. The real
libcamera bridge compiles/loads on Linux x86 and ARM. Optical focus, real displays,
latency and long-run stability still require Pi/camera acceptance testing.
