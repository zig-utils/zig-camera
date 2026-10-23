# Local frame channels and remote owners

Version 0.88 adds `FrameChannel` and `RemoteFrame` in Zig/Bun and additive C
`zc_frame_channel_*` / `zc_remote_frame_*` APIs. These transfer actual fd rights
through Home's bounded Unix datagram channel. The receiver owns local fd
duplicates and checked maps; the sender continues to own the retained camera
export. This is a transport/remote-owner layer, with process supervision and
request pools still required for full Picamera2 remote processing parity.

```ts
import { FrameChannel } from '@zig-utils/camera'

const [sender, receiver] = FrameChannel.pair()
using request = camera.acquire()
const loan = request.exportFrame({ streams: ['main', 'raw', 'lores'] })
let remote: ReturnType<typeof receiver.tryReceive>
try {
  if (!loan.trySend(sender.fd, 1n)) throw new Error('queue full')
  remote = receiver.tryReceive()!
  using image = remote.makeImage('main') // independent RGB8/RGB16 image
  const metadata = remote.metadataCatalog() // owned full typed HCAT snapshot
  const bytes = remote.copyPlanes('raw') // owned physical bytes, used padding
  remote.close() // detach views, unmap and close receiver fds first
  if (!receiver.tryAcknowledge(1n)) throw new Error('ACK queue full')
  if (sender.tryReceiveAcknowledgement() !== 1n) throw new Error('wrong ACK')
  // image, metadata and bytes are independent of remote/loan lifetime.
} finally {
  remote?.close() // same-process example: join all maps before loan retirement
  sender.close()
  receiver.close()
  loan.close()
}
```

For a real Bun child, explicitly inherit the peer endpoint as stdin using
`Bun.spawn(..., { stdin: peer.fd })`, then close the parent's peer endpoint.
The child uses `FrameChannel.fromFd(0)` (a duplicate; it does not consume stdin).
Close the inherited original separately. Only inherit intended descriptors.
See tests/fixtures/frame-channel-child.ts and tests/ts/frame-channel.test.ts for
exec, readonly/write contexts and verified-exit retirement. Linux creates and
receives fds atomically CLOEXEC. Darwin sets CLOEXEC immediately afterwards, so
callers must serialize exec/inheritance with channel creation/receive there.

The sending export must remain live until **every** corresponding consumer has
closed its maps and acknowledged, or its process has verifiably exited. A sent
record, duplicated fd, empty queue, timeout, abort signal or sent kill signal
does not prove this. Wait for the process exit/join before retiring its export
after failure. In particular, do not put a sender `using loan` inside a try
block whose finally kills/joins the child: block disposal would run before that
join. Keep an explicit owner and retire it after joining in finally instead.
These low-level APIs do not enforce cookie uniqueness, associate ACKs with
exports, terminate children, or close sender exports on received ACKs. Cookies
must be unique nonzero uint64 values among live sends. A successful send must
not be retried as if unsent; each successful send adds another peer obligation.

All channel I/O is nonblocking. Bun returns false for full sends/ACKs and
undefined for empty receives; Zig/C report Timeout/TIMEOUT. The kernel queue is
bounded (requested 64 KiB buffers, OS accounting differs); there is no userspace
send queue. Applications own readiness/poll scheduling, retries and deadlines.
Receive frames in one direction and ACKs in the other. Calling the wrong receive
operation rejects/consumes that packet and cleans its rights. Unknown/invalid
records are consumed, with no partial remote owner returned. Initial preparation
slot/quota failure leaves the record queued; exact payload quota failure after
decoding consumes it. Supervisors must handle receiver errors and join peers,
rather than assuming every receive error leaves a retryable record.

The private local wire is a 32-byte little-endian ZCFD v1 header, followed by the
736-byte pointer-free local export ABI for frame records. It carries version,
kind, descriptor size/count, unique cookie and bounded catalog length. A frame
has one fd per declared plane and a final HCAT fd; sender integer fd fields are
sanitized to -1. ACKs contain only the header and cookie. It targets cooperating
64-bit little-endian Linux/Darwin executables with the same descriptor ABI, not
an external/network schema. Extents, offsets, flags, color/stream/plane counts,
plane ranges, costs and full typed HCAT are checked before publication. Unknown
formats may expose physical planes; unsupported conversions reject explicitly.

The sender lazily creates one shared HCAT file per export and charges its bytes
to the existing 32-export/512 MiB admission before allocation. Retried and queued
sends duplicate that same fd, rather than allocating/copying a catalog again.
It is immutable by contract. Each receiver has its own 32-owner/512 MiB declared
plane+catalog admission, with 256 MiB planes and 4 MiB metadata per remote. Page
rounding, kernel descriptor/queue/device storage and owner overhead are extra.
Every partial import unwinds maps, descriptors, catalog and quota. There is no
mapping cache keyed only by fd integers; each owner maps its own received fds.

Readonly Bun maps never escape as mutable Uint8Array views: `copyPlanes` copies
used physical bytes and `makeImage` uses existing Home conversions into owned
RGB8/RGB16 pixels. Those image objects support the shared transformations,
encoding and staged saves after remote/camera closure. Native C/Zig const views
are available through `stream`. Explicit writable exports permit Bun
`withWritablePlanes(stream, callback)`: synchronous only, no nested/reentrant
pixel access/close, with ordinary ArrayBuffer aliases detached on return/throw.
Do not transfer mapped buffers/pointers to other workers; use slice() for owned
data. Close reports native cleanup errors and consumes the remote owner; do not
ACK after failed cleanup without verifying process exit. These are cooperating
process APIs, not a hostile-peer sandbox. Do not truncate shared files while
mapped. Device fds lacking a reported extent remain unsupported by the mapper.

Home's descriptor channel receives enough ancillary space for the supported
kernel rights maximum before rejecting excess fds; a small Darwin ancillary
buffer can hide installed descriptors. Repeated overflow/truncated-payload tests
check unchanged fd counts. The Home helper and docs are reused, not VM/JSC IPC
or Home OS kernel tables. Source attribution is in NOTICE and the reuse audits.

Validation passes 416 target-qualified ReleaseSafe native tests and 1,207 Bun
tests with independent image/AVC/HEVC/AAC readback and SDL enabled. New coverage
includes 64 malformed/late-import failures without leaks, post-failure capacity,
metadata cache identity, explicit full queues, receiver admission, all 14
processed formats with raw/lores, image precision/provenance and write scopes.
Independent C wire/CMSG implementations interoperate in both directions across
exec; C/Bun children exercise explicit ACK and abrupt exit with joined source
retirement. The normal local build runner still fails macOS SDK/libSystem
linkage before project compilation; direct builds pass. Consumer platform CI
and real Linux backend load/no-camera checks remain publication gates.

Full Process/Pool jobs, automatic result/ACK routing, bounded per-worker pending
work, timeout/cancellation/worker-failure joining, arbitrary per-request data,
configuration/property snapshots, remaining remote convenience semantics and
persistent allocator/GPU integration remain required work. No physical Pi DMA
acceptance, zero-copy throughput or Picamera2 speedup is inferred from fixtures.
