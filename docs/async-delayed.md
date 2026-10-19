# Async snapshots and delayed output

snapshot(path) returns a Promise after freezing bounded native pre-roll ownership.
Capture continues while the worker writes. Native snapshot handles are single-use
and outlive their recorder. See native-jobs.md for bounded admission and close.

Circular recorder delayMs enables bounded FIFO delivery. setDelay sets per-output
A/V delay with explicit byte/frame capacity. Packets remain ordered; overflow
fails instead of dropping dependencies. Output detach excludes its queued tail;
recorder close flushes remaining mature/final tails. No arbitrary JS packet sink
or complete upstream CircularOutput2 class is currently exposed in Bun.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
