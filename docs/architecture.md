# Architecture

libcamera owns requests and ISP processing. A system-C++ bridge keeps its STL ABI
matched to the distribution. Zig owns bounded ready queues, DMA coherency and
linear reference tokens and bounded shared request ownership. Leases protect mappings across stop; destruction/restart
reject outstanding leases. Capture-manager callbacks never perform consumer I/O.

Home supplies owned packet/PCM rings, streaming containers, JPEG, x264/x265/FDK
adapters, retry policy and preparation gates. The video consumer encodes once;
each stable output ID owns its container, PCM cursor, delay and I/O epoch.
Eight bounded preparation workers copy immutable recipes, create exclusive paths,
build headers/AAC/I/O, then wait for serialized owner publication or cancellation.
No worker accesses mutable recorder fields. Registry reservations protect aliases
through owned cleanup. Retired failed outputs are never reused.

TypeScript/Bun wraps the C ABI with checked structure offsets, linear frame
reference objects and a bounded shared capture pump. Close/drain/snapshot run on Bun workers.
The ABI's existing layouts remain unchanged; preparation APIs are additive.
Encoding and short synchronous FFI calls still occupy the calling Bun thread.
No Python runtime or FFmpeg path is part of the project.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
