# Runtime controls, autofocus and preview

The Zig/C ABI exports typed control discovery and atomic batches. Bun exposes
Control IDs and setControls with bool/int/float/rect values. A metadata control
revision means request submission; sensor pipeline latency remains. Unsupported
vendor controls fail explicitly. autofocus returns a Promise driven by native
metadata jobs and the shared capture pump; timeout/AbortSignal cancels the job.
startPreview/stopPreview create/show/close SDL on the same Bun UI thread and use
that pump alongside capture and recording. There is no Qt/DRM backend or overlay.
Physical focus, display and exposure validation remains required.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
