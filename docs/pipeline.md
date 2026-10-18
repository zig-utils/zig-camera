# Sensor modes, lores and async capture

Mode discovery is cached when a camera opens. It enumerates advertised raw
formats and sizes without reconfiguring an active camera. Entries contain `size`,
`bit_depth` and `format`; they do not contain measured frame rates or exposure
limits. Some cameras advertise no Bayer modes. Opening still requires acquiring
and configuring the camera. There is no detached pre-open discovery API yet.

```python
from zigcamera import Picamera2

with Picamera2() as camera:
    modes = camera.sensor_modes
    mode = modes[0]  # Choose for your workload; ordering is not a quality ranking.
    camera.configure(camera.create_preview_configuration(
        main={"size": (1280, 720)},
        sensor={"output_size": mode["size"], "bit_depth": mode["bit_depth"]},
        lores={"size": (320, 180), "format": "YUV420"},
    ))
    camera.start()
    job = camera.capture_buffer("lores", wait=False)
    i420 = camera.wait(job, timeout=5)
    # main, lores and raw from one request share a sequence and native lease.
    with camera.capture_request(wait=False).result(5) as request:
        rgb = request.make_array("main")
        lores = request.make_array("lores")
        metadata = request.get_metadata()
```

Explicit sensor selection requires both dimensions and bit depth. An unsupported
or substituted sensor mode fails instead of silently selecting another. Auto
selection remains the default. `camera_configuration()` / `Camera.info` report
negotiated geometry; sensor values of zero mean the backend did not report them.
Raw output format/depth describes storage and can differ from sensor bit depth.

Lores supports `YUV420` (default) and `BGR888` (RGB byte order), subject to the
camera's ISP capabilities. It must not exceed main; YUV420 dimensions and stride
must be even. Read negotiated sizes because libcamera may adjust stream dimensions.
On hardware the ISP generates lores; synthetic fixtures use deterministic scaled
pixels and Home's RGB-to-I420 conversion. These fixtures establish API behavior,
not hardware performance. Main still uses RGB; raw remains optional.

`Frame.plane(name="lores", index=0)` borrows a physical plane with its native row
padding. Keep that view inside both its context and the frame lease. A YUV420
buffer can have one contiguous plane or three physical planes; inspect
`Frame.stream("lores")`. For three planes, U/V stride is half the Y stride under
the libcamera YUV420 layout. Tight `copy_buffer("lores")` omits padding and returns
Y then U then V. `numpy("lores")` returns owned I420 shape `(height*3//2,width)`;
it does not convert YUV into RGB. Bayer copies use the existing raw plane API.
Preview, JPEG and video recording currently consume main, not lores.

All capture helpers use one shared capture worker alongside preview, recording
and autofocus. No application callback runs in the native libcamera callback or
capture worker. Low-level `Camera.acquire()` remains an explicit competing
consumer; avoid mixing it with jobs unless that is intentional.

- `wait=True` blocks; `wait=False` returns a `CaptureJob`. The default blocks
  unless `signal_function` is supplied. Callbacks receive the completed job.
- `job.result(timeout)` / `camera.wait(job, timeout)` limits the caller's wait;
  it does not cancel a pending job. `await job` works with asyncio.
- `timeout_ms` is the deadline for waiting for a frame, checked at dispatch.
  It does not interrupt encoding, copying or filesystem work already running.
- `job.cancel()` succeeds only while queued. Stop cancels queued work, joins
  capture processing and preserves completed request leases. A running job
  finishes; it can fail if the camera/backend fails.
- Request results own a native lease. Use their context manager or `release()`;
  close/restart refuses outstanding leases. Owned array/buffer/metadata/file
  results release their frame before notifying the caller. An asyncio-cancelled
  request await discards/releases a result that was already being dispatched.
- At most 32 pending/running capture jobs or unreturned callbacks are accepted;
  new submissions fail at capacity. Callbacks run on separate bounded threads,
  can outlive camera close, and must avoid accessing a closed camera. Their errors
  appear in `job.callback_error`; capture failures appear in `job.result()`.
  User-held completed requests can exhaust the native buffer pool independently.

Sensor discovery and options are exposed through Zig/C as additive ABI v1 APIs:
`zc_get_sensor_modes`, `zc_open_pipeline`, `zc_get_pipeline_info`, `zc_get_stream`
and `zc_copy_stream`. Original public structure sizes are unchanged. Initialize
options with `zc_default_pipeline_options`. Descriptors remain borrowed until
release, including after stop; DMA synchronization includes all three streams.

```sh
zig-camera modes
zig-camera info --sensor-width 2028 --sensor-height 1520 --sensor-depth 12
zig-camera capture --width 1280 --height 720 --lores-width 320 --lores-height 180 --output trail.jpg
```

Select actual advertised sensor values for your camera. CLI capture writes a tight
`.lores.i420` or `.lores.rgb` sidecar when enabled, plus negotiated sensor/lores
geometry in the JSON sidecar. Use `--simulate` only with a synthetic build.
Physical Pi 5 negotiation, three-stream ISP throughput, DMA layout, and image
quality still require camera hardware testing.
