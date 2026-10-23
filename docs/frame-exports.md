# Retained descriptor exports

Version 0.87 adds the native ownership foundation for process handoff:
`Frame.exportFrame` in Zig/Bun and additive C `zc_frame_export_*` APIs. One
export owns one generation-checked map of the complete request, selected main/
raw/lores descriptors, owned fd duplicates and copied scalar/full typed metadata.
No native pointer is present in the 736-byte `zc_export_info` descriptor.

```ts
using frame = camera.acquire()
using loan = frame.exportFrame({ streams: ['main', 'raw', 'lores'] })
const info = loan.info()
frame.release()
await camera.stop()
// loan still pins the request; info.planes contains borrowed fd numbers.
const metadata = loan.metadataCatalog()
loan.close()
await camera.close()
```

Real fd-backed planes use F_DUPFD_CLOEXEC; pixel bytes are not copied in that
branch. Offsets, strides, lengths, bytes_used, physical plane order and negotiated
color descriptions are preserved. Source descriptors without fds, including the
synthetic backend, use zero-initialized anonymous POSIX shared-memory staging.
Only bytes_used are copied; unused staging bytes remain zero. Staging is marked
per plane and on the export and is not described as camera zero-copy evidence.
Names are exclusive, 0600 and immediately unlinked; all exported fds have
close-on-exec. Exported fd numbers are borrowed from the export owner. Never
close those numbers or treat an integer sent as JSON as an fd transfer. A peer
needs SCM_RIGHTS or an explicitly inherited duplicate.

The export remains live after original request release or camera stop. Camera
close/reconfiguration cannot destroy its buffers while its lease is retained.
Read exports share access; writable exports require writable camera mode and a
sole external frame owner. One whole-frame gate covers all selected streams,
including multi-stream writes. Readers/retention exclude a writer until close;
metadata remains readable. `zc_frame_map_get_stream` retrieves another stream
under that existing gate without creating another writer or reference.

A consumer must unmap and acknowledge completion, or its process must have
verifiably exited, before the caller closes the export. Duplicating an fd keeps
an OS object alive but does not extend the camera lease or prevent reuse.
Exports have no automatic GC finalizer that could retire a live peer's frame.
Writable staging is copied back before the native map retires. Every staging
extent is checked before any copyback; truncated data reports I/O failure and
skips all staged copyback. Direct shared writes are immediate and cannot be
rolled back. Close consumes the owner even on cleanup/DMA/requeue error; those
errors remain observable. Calls on one owner must be serialized.

Admission reuses Home's bounded reservation registry: at most 32 exports and
512 MiB declared plane/catalog payload across preparation and live exports.
Preparation reserves the maximum 4 MiB catalog allowance before allocation, then
reconciles exact cost without changing reservation identity. Each export's plane
bytes are limited to 256 MiB. Kernel page rounding, allocator/device storage and
owner overhead are additional to declared payload accounting. Failure unwinds
previous fd duplicates, mappings, catalog, access gate, reservation and reference.

Bun exposes immutable `info()` snapshots, copied `metadataCatalog()`, `close`,
`closed` and `Symbol.dispose`. Copied metadata can outlive the export; fd numbers
cannot. Zig `FrameExport` has `info`, allocator-owned `metadataCatalog` and
consuming `deinit`; owners must not be copied as independent handles. C layouts
and ABI version 1 remain additive and unchanged for earlier types.

The POSIX descriptor/region helpers and reservation resizing improve Home and
are reused verbatim. Home OS's kernel shared-memory object tables and placeholder
resize-copy code are not a hosted descriptor owner and are not copied here.

The independent C integration passes descriptors through SCM_RIGHTS to an exec'd
child, checks all used bytes against independent hashes, retires mappings before
ACK/exit, and checks read/write metadata and source retention. Linux must also
exercise truncated-file writeback rejection; other OSes attempt it where allowed.
Native tests verify real fd-backed aliasing/offsets with a shared-file fixture,
late fd failure without leaks, and public Zig ownership. Eighteen Bun tests cover
all 14 processed layouts with raw/lores, exact padded plane bytes, admission,
write exclusion/copyback, stopped sources and retryable camera close. Local
validation passes 410 native tests and 1,185 Bun media tests, C ABI and exec tests,
typecheck/fmt. The ordinary local runner still fails SDK/libSystem linkage before
compilation; direct builds pass. Platform/real-backend CI remains a release gate.

This is a low-level export API. Production descriptor transport, supervised
process jobs/pools, ACK routing, timeout/exit cleanup, remote scoped mappings and
full RemoteRequest equivalents remain required work. No Pi DMA mapping,
physical throughput or Picamera2 performance result is claimed by these fixtures.
