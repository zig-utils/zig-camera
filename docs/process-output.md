# Supervised process recording outputs

`ProcessOutput` sends raw JPEG or Annex B AVC/HEVC video to a consumer's stdin.
`ProcessSink` is a reusable byte sink for Home containers, for example
`MuxedOutput(sink, 'mkv')` for timestamped video and PCM audio. Encoders, capture
and muxing stay in Home/zig-camera. There is no automatic external media program,
wall-clock retimestamping, Python integration or FFmpeg dependency.

```ts
import { ProcessSink, MuxedOutput, Recorder } from '@zig-utils/camera'

const sink = new ProcessSink({
  command: [process.execPath, './save-stream.ts', './recording.mkv'],
  diagnosticBytes: 64 * 1024, // per stdout/stderr stream
  startupTimeoutMs: 5000,
  writeTimeoutMs: 2000,
  finishTimeoutMs: 5000,
  terminationGraceMs: 1000,
})
const recorder = await Recorder.open(new MuxedOutput(sink, 'mkv'), {
  width: 1920, height: 1080, fps: 30, codec: 'h264', asyncWrites: true,
  outputQueue: { maxBytes: 8 * 1024 * 1024, maxOperations: 16, waitMs: 2000 },
})
// Feed captured frames through recorder.writeAsync and PCM through
// recorder.writeAudioAsync, then await recorder.close() to flush and join.
```

A minimal Bun `save-stream.ts` consumer can preserve the Home stream directly:

```ts
const output = Bun.file(process.argv[2]).writer()
for await (const bytes of Bun.stdin.stream()) {
  await output.write(bytes)
  await output.flush()
}
await output.end()
```

Commands are explicit copied argv arrays (up to 64 entries/64 KiB), never shell
command strings. Environment and working-directory settings are snapshotted;
relative cwd/host paths resolve at construction. The environment has bounded
entry/byte counts. Raw `ProcessOutput` is video-only and starts on a keyframe;
attach `PtsOutput`/`PtsStream` for source-clock sidecars. Container streams carry
the Home muxer's timestamps without a second encoder or guessed frame clock.
For AAC MP4 over this sink, use `MuxedOutput(sink, 'fmp4')`; see
[forward MP4](forward-mp4.md) for startup bounds and receiver requirements. The
existing `mp4` mode requires a seekable sink for its final metadata patches.

The installed `zig-camera-output-host` is a separate single-threaded Zig POSIX
executable, built on pinned Zig 0.15.2. `ProcessSink` discovers it beside the
library's sibling bin directory; set `hostPath` or `ZIG_CAMERA_OUTPUT_HOST` for
another installation layout. Use the matching provided host, not an arbitrary
program: its private proof/cancellation protocol is part of the ownership contract. Consumer
argv/cwd/env are used by that host without shell interpolation. No fork happens
inside a running camera or Bun callback thread.

The consumer inherits media fd 0 and stdout/stderr fd 1/2, and never inherits the
private descriptors. In 0.106.1, fd 3 carries only proof records and fd 4 carries
only cancellation/parent EOF. The parent drains both diagnostic pipes concurrently through
Home's allocation-free ByteTail. Each retains only the last configured bytes
(default 64 KiB, maximum 1 MiB; zero still drains/counts). `diagnostics()` returns
owned binary snapshots with exact bigint total/dropped counts; `stats()` exposes
PIDs, supervisor/consumer exit status and accepted input counters. Diagnostics
reset on actual preparation, and failed duplicate starts preserve a live session.

Process and socket sinks reuse the same bounded transport engine and share its
16 active/preparing slots. They use Home's checked send-progress cursor and the
existing native recording mailbox for queue ownership/backpressure. Each has one
active borrowed input (maximum 16 MiB), with at most one pending pipe chunk. A
write/flush is joined before its producer completes or its native queue event is
acknowledged. Explicit delays, producer wait jobs and isolated output failures
remain supported by the recorder. Process outputs participate in async splits,
recovery and reusable sessions through the same lifecycle hooks as file/socket
outputs.

Preparation waits for exec confirmation via a close-on-exec pipe. A failed exec
is reported with errno, its forked child is joined, and preparation unwinds.
Failure/cancellation before fork has a distinct terminal no-child proof. A queued
startup cancellation is sent on the control fd so it cannot kill an unprepared
host before it can report ownership. The parent validates fixed 32-byte records,
PID identities/order, terminal state and actual supervisor exit.

Normal stop joins the producer, sends stdin EOF, waits for the consumer result,
drains diagnostics, and joins the supervisor and both private channels. Nonzero exits fail normal
stop with ProcessOutputError, preserving diagnostics and exit fields. Write/finish
deadlines and discard request cancellation, with SIGTERM then SIGKILL after the
configured grace period. Discard can escalate an active drain. Signal dispatch or
Bun's killed flag is never treated as process exit proof; cleanup retains its
owner until real joins complete. OS-uninterruptible processes may therefore keep
cleanup pending beyond a requested deadline.

The cancellation fd remains independent of media and proof delivery: a child that never reads stdin
cannot hide cancellation or parent-fd EOF. Parent app death follows this path
and terminates the owned process group. The host observes the leader with
waitid(WNOWAIT), signals remaining group members while the PID/PGID is still
reserved, then reaps the leader. Linux additionally adopts/reaps group descendants
and arms a parent-death signal for the direct consumer. Mac behavior is validated
for inherited ordinary process groups; it does not provide Linux subreaper APIs.
No group signal is sent after the leader PID has been reaped.

Consumer programs own their destinations and side effects; they may create files
while preparation runs. The library cannot stage/undo arbitrary child writes or
infer their file aliases from argv. Deliberately detached/escaped process groups,
hard-killed-supervisor recovery, a supervisor/kernel that cannot make progress,
listening/network protocol sessions, additional muxers and other parity families
remain open. This is not an isolated execution environment or full process-tree
policy. Physical Pi capture, device A/V synchronization and performance acceptance
also remain separate work.

Tests use actual Bun consumers and Zig hosts: copied binary/large diagnostic
streams, zero-capacity drains, stalled/broken/failed stdin, nonzero EOF exits,
rapid preparation cancellation, real descendants, parent SIGKILL, exact JPEG/
AVC/HEVC flush tails, shared slot admission, immutable argv/env, isolated recovery,
async splits, and independently parsed received Matroska PCM/video timestamps.
Failures preserve media under zig-out/media-failures or ZC_MEDIA_FAILURE_DIR.

References: [Bun subprocesses](https://bun.com/docs/runtime/child-process),
[Linux wait/waitid](https://man7.org/linux/man-pages/man2/waitpid.2.html),
[Linux subreapers](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html),
[parent-death signals](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html),
and [Matroska timestamps](https://www.matroska.org/technical/elements.html).

Local 0.104 validation passes 540 native tests, 1,706 Bun tests across 94 files,
eleven C ABI programs, and the shared Home 3+1+2 helper/export tests in Debug and
ReleaseSafe on Zig 0.15.2 and development 0.18.0-dev.470. Standalone host acceptance
runs on native macOS; final Linux x86/ARM host executables cross-compile, with
native execution and full real libcamera build/load/no-camera checks in CI. A
relative library's directory is frozen at module load so later cwd changes do
not retarget sibling-host discovery. The local standard Zig build runner still
fails macOS libSystem linking before project compilation; target-qualified
builds/tests pass and logs are retained.
The minimal profile has 532 passes and two explicit skips; both Linux real-backend
Zig objects compile with the new exports as well.

Version 0.106.1 separates cancellation (fd 4) from readiness/problem/final proof
records (fd 3), using `grace-ms --control-fd4 -- command argv...`. Rebuild the
matching standalone host with these Bun bindings. The native host still supports
its legacy duplex CLI for standalone clients. Terminal problem/result records
no longer cause an unnecessary cancel write; normal retirement requires both
channels to close plus the same strict result/no-child and actual exit proofs.
An unread late cancellation cannot share the socket carrying the final result.
The native acceptance fixture deliberately leaves cancellation unread before
exit, and exec consumers verify that neither private descriptor survives exec.

A failed exec reports its original errno (ENOENT for a missing executable). The
joined consumer may exit 127 or be terminated by TERM/KILL before its `_exit`
runs; its actual status is retained. This does not change the requirement for a
final consumer-result record. Controlled fixtures whose child was already reaped
before the problem record continue to require exactly their known exit status.
