# Raw socket recording and byte-stream sinks

`SocketOutput` writes video-only JPEG or Annex B AVC/HEVC to numeric IPv4/IPv6
TCP/UDP destinations. It implements Picamera2 FileOutput's raw socket capability
without a Python socket wrapper. `SocketSink` is independently reusable with
`MuxedOutput(sink, 'mkv')` for Home Matroska video/PCM audio. No external muxer or
media subprocess is involved.

```ts
import { Camera, Recorder, SocketOutput } from '@zig-utils/camera'

const camera = new Camera({ width: 1920, height: 1080 })
const output = new SocketOutput({
  protocol: 'tcp', address: '192.168.1.20', port: 5000,
  chunkBytes: 65536, connectTimeoutMs: 5000, writeTimeoutMs: 2000,
})
const recorder = await Recorder.open(output, {
  width: 1920, height: 1080, codec: 'h264', fps: 30,
  asyncWrites: true,
  outputQueue: { maxBytes: 8 * 1024 * 1024, maxOperations: 16, waitMs: 2000 },
})
try {
  camera.start()
  for (let i = 0; i < 300; i++) {
    using frame = camera.acquire()
    await recorder.writeAsync(frame)
  }
} finally {
  await recorder.close() // flush codec tails, drain queue, finish TCP, join close
  await camera.close()
}
```

Raw UDP splits each submitted frame into datagrams of at most `chunkBytes`
(default 1200, maximum 65507); the final datagram can be shorter. TCP chunks
default to 65536 (maximum 1 MiB). UDP chunks have no RTP, timestamp, sequence or
frame-boundary header. Receivers must already understand the elementary stream
and its reassembly constraints. Use `RtpOutput` for AVC/HEVC/AAC framing and clocks.
UDP raw video rejects audio during preparation. Attach `PtsOutput`/`PtsStream`
for exact source-clock timestamp sidecars. Each raw session waits for a keyframe;
recorder packets already include the appropriate first/repeated parameter sets.

The shared Home `SocketWriteCursor` checks every advance before changing progress.
TCP accepts a prefix; UDP accepts an entire datagram or zero. Zero waits for a
writable event with a monotonic deadline for the complete submitted write, so a
slow peer cannot retain one write forever by making tiny progress. Wakeups during
send are retained. One input is borrowed until its write promise settles; direct
callers must keep it immutable. No copied packet list is constructed. The default
TCP adapter owns at most one additional chunk while Bun's Node-compatible socket
finishes its callback. Producer completion joins this buffered tail before native
mailbox ACK/drain; discard cancels the joined flush. Successful send means local
acceptance, not receiver ACK.

There are at most 16 active/preparing SocketSink sessions, each with one active
write and a 16 MiB submitted-write cap. Overlapping direct writes reject with BUSY.
Recorder queue storage and producer admission remain bounded by the native
mailbox. `stats()` reports accepted bytes/chunks, blocked waits, session, phase,
in-flight status and the first failure. Counts reset on restart. Independent
outputs use the existing isolation, async splits and recovery factories; a failed
socket does not keep healthy sibling queues blocked when isolation is enabled.

Normal `stop()` joins preparation and an active write, finishes locally accepted
TCP data, then joins socket close. A peer may half-close its sending side while
continuing to receive our stream. Discard/`close()` cancels setup, blocked writes
and cooperative finish, and joins retirement. Discard can escalate an active
drain. Failed close retains the transport/session quota for retry, including
failed setup cleanup. Old callbacks are generation-guarded after reuse. Error
notifications between writes fail normal stop; a write error already delivered
to OutputBridge is not rethrown as an unrelated stop-hook failure.

Custom `socketFactory` implementations must honor their setup/flush/finish AbortSignals,
retain accepted bytes themselves, expose `flush(signal)` when acceptance buffers
bytes beyond a write call, signal writability after zero, and resolve
`close()` only after their callbacks/resources retire. Cancellation joins a late
factory result rather than abandoning its owner. The same returned transport
object cannot have two owners across raw and RTP adapters. Factories must not hide the same underlying
socket behind different wrappers. Arbitrary custom promises cannot be forcibly
settled by the library. Raw UDP is a best-effort transport with no receive ACK,
retransmission or congestion control. TLS, DNS/Unix sockets, listening outputs,
process outputs and broader network sessions remain separate parity work.

Validation includes independent raw IPv4/IPv6 TCP/UDP receivers, peer half-close,
exact whole/suffix progress, deterministic backpressure/deadlines, joined setup
cancellation, finish escalation, alias/capacity/failed-close handling, actual Home
JPEG/AVC/HEVC recording with healthy packet comparisons, shared PTS, async splits,
isolated recovery, and independent parsing of received Home Matroska video/PCM
blocks. No physical Pi/LAN or comparative performance result is implied.

The runtime contracts were checked against [Bun UDP documentation](https://bun.com/docs/runtime/networking/udp)
and [Bun TCP documentation](https://bun.com/docs/runtime/networking/tcp), and the
pinned Bun 1.4.3 runtime. The default TCP adapter uses its Node-compatible socket
handle to support cancellation before connection establishment.

Local 0.103 validation: 534 native tests, 1,687 Bun tests across 93 files and ten
C ABI programs pass. Minimal features: 526 pass, two explicit skips. Real Linux
x86_64/aarch64 Zig objects compile; CI performs system-STL bridge compilation,
load/no-camera smoke and standard builds. The local standard Zig build runner
still fails macOS libSystem linking before project compilation; target-qualified
builds/tests pass and logs are retained. Shared Home progress/public API tests
pass Debug/ReleaseSafe on Zig 0.15.2 and 0.18.0-dev.470. The camera compiler stays
pinned to 0.15.2. Raw and RTP restart admission also rejects the interval before
a previous close promise has completely settled.

Version 0.104 shares the transport lifecycle and its 16 active/preparing slots
with ProcessSink. Raw video gating is shared as well; duplicate starts cannot
reset an active output's codec/keyframe state. Socket factory contracts and
TCP/UDP framing remain unchanged.
