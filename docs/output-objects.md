# Outputs, jobs and PTS

The native callback protocol supports packets, Home MP4/MKV byte sinks and exact
PTS formatting. Callback contexts/descriptors are borrowed through terminal
cleanup; callbacks must not re-enter recorder/camera APIs. Bound asynchronous I/O
copies data into owned queues before returning. File identity guards reject
active, pending, prepared, snapshot and retired aliases before truncation.

Bun currently exposes path outputs with stable IDs, independent delayed delivery,
per-output async splits/recovery and failure isolation. Custom JS output objects,
file-like sinks, lifecycle hooks and shared CircularOutput2 PTS observers from the
retired wrapper have not been ported. Native C capabilities remain available.

See native-jobs.md for preparation workers, await/cancel/close semantics, automatic
recovery and soft rotation limits. Never recycle a failed sink in place.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
