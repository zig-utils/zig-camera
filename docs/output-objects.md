# Bun output objects, jobs and PTS

`Recorder.open(output, options)` asynchronously creates a recorder with a custom
output. Existing path constructors continue to work. `addOutput(object)` returns
a `BunJob<bigint>` containing a stable output ID; `openOutput(object)` attaches an
empty primary output. `split(object, id)` and `recover(object, id)` return
`PreparationJob` handles and preserve the ID across replacement.

```ts
import { Camera, Recorder, MuxedOutput, type CustomOutput } from '../ts'

const packets: CustomOutput = {
  streams(info) { console.log(info.width, info.height, info.codec) },
  async outputframe(packet) {
    // This Uint8Array is owned; it remains valid after this hook returns.
    await savePacket(packet.data, packet.timestampNs, packet.keyframe)
  },
  async stop() { await finishPackets() },
}
await using camera = new Camera({ width: 1920, height: 1080, role: 'video' })
await using recorder = await Recorder.open(packets, {
  width: 1920, height: 1080, codec: 'h264', isolate: true,
  outputQueue: { maxBytes: 16 * 1024 * 1024, maxOperations: 4096 },
})
const recording = camera.startRecording(recorder)
// Native Home MP4 writer; async file writes and patches execute in Bun.
const split = recorder.split(new MuxedOutput('next.mp4'))
await split
split.close()
await recording.close()
```

The example's `savePacket` and `finishPackets` are application functions. For
built-in files use `new FileOutput('video.h264', { pts: 'video.pts' })` or
`new MuxedOutput('video.mp4', 'mp4')`. Files are exclusive by default. `FileOutput`
writes elementary video and exact integer timestamps through Home's PTS formatter;
it excludes audio. `MuxedOutput` uses Home MP4/MKV, supports AVC/HEVC and AAC MP4,
and accepts a path or a `ByteSink`. A sink's `write(bytes)` and optional
`patch(offset: bigint, bytes)` may return a positive partial count or `undefined`
for complete acceptance. Zero/invalid progress fails. AAC MP4 needs random-access
patches for final priming/tail edits; streaming video-only MP4 does not.

## Ownership and lifecycle

`CustomOutput` defaults to packet delivery; set `format: 'mp4' | 'mkv'` for a Home
container byte sink. Hooks may return promises. Startup calls `start`, `streams`
and descriptor validation before `commit`, then acknowledges initial header
writes before publication. `streams` receives fresh owned codec headers and audio
geometry. `outputframe` receives owned bytes, bigint nanosecond timestamps, codec,
keyframe, audio and Annex B flags. Muxed sinks may also observe these packet events.

Native callbacks only copy into a mutex-protected Zig mailbox. Bun consumes that
mailbox on its own event loop; no JavaScript function runs on a native codec or
preparation thread. Delivery is FIFO. In-flight data stays charged until the hook
returns and its sequence is acknowledged. Defaults are 16 MiB/4096 operations;
limits must be positive and cannot exceed 1 GiB/65536 operations. Slow hooks fail
the affected output at capacity. Timed producer waits are unsupported for host
outputs because blocking Bun would prevent its consumer from making progress.
The native path-I/O worker remains available for path outputs.

Use `isolate: true` to quarantine a failed sink while healthy IDs continue. Async
hook errors retain their original exception in `recorder.outputErrors`; native
pressure errors retain their error code. Recovery uses a fresh object. An
unpublished replacement's failure never poisons the active generation. Headers
must finish before an added output receives media or retains audio history.

The bridge holds the output and resources returned by `resources()` through the
last delivery and `stop({ discard })`. Reusing an active object/resource fails.
Declare borrowed file descriptors with `descriptors()` (`file`, `pts`,
`secondaryPts`) so native identity guards reject file/hardlink aliases before
truncation. Built-in sinks do this automatically. Resources hidden by an arbitrary
object cannot be discovered. On cancellation, built-in file cleanup removes only
new files whose device/inode still matches; pre-existing files are retained.

Output hooks must not re-enter camera/recorder APIs, including close; the Bun
facade rejects this before a native call. Hooks must eventually return. Removing
an object output returns a job that waits for delivery and stop. Splits finish
only after keyframe publication and retirement of the old native I/O and host
hooks. Cancellation is accepted before publication is released; once released it
returns false. Parent close can discard an uncommitted staged replacement when
there will be no more frames. Stop is attempted once for every owned output even
when another output fails.

`drain(id)` freezes an accepted delivery prefix; later packets or failures do not
extend or poison a completed prefix. Its fence remains valid while recorder close
retires the mailbox. Close waits for owned operations and hooks, independently of
user completion callbacks, so a completion callback may close its recorder.

## Remaining coverage

Per-output delay queues also feed custom sinks. Native circular snapshots retain
synchronized A/V, but opening a custom primary on an already populated circular
ring is not supported by this Bun API. Start with an empty ring or use native
callback/pre-roll APIs. Automatic filename rotation/recovery applies to paths;
custom objects use explicit split/recovery jobs. `setIO`/`ioStats` describe native
path workers, not host-mailbox telemetry. Arbitrary upstream constructor
signatures, custom timed-wait pressure, shared CircularOutput2 PTS observers and
full class compatibility remain work in progress.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
