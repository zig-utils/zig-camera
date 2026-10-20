# Capture pipeline

Camera options select still/video/preview role, exact sensor width/height/depth
and optional paired lores size/format. sensorModes lists cached advertised raw
formats, not measured sensor FPS. Frame.copyStream returns owned RGB or I420;
all stream descriptors share one completed request. Each retained owner has a
distinct linear token; only final release recycles its mappings. JPEG/DNG methods require a live
frame. with-style descriptor ownership is expressed as using in TypeScript.

capture, captureRGB and captureMetadata share a FIFO queue of at most 32 jobs.
Each supports a wall-clock deadline and AbortSignal. stop rejects pending jobs.
The same capture pump serves recording, preview and autofocus. acquire is a
low-level synchronous call; do not compete with the pump for arbitrary requests.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).

See [retained requests and capture jobs](requests.md) for owned request returns,
same-request stream bundles, raw buffers and asynchronous processing.
