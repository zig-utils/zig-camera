# Async producers and automatic host backpressure

Bun producers can encode and write on one persistent native worker per recorder.
Host hooks keep running on Bun's event loop while native mailbox sends wait for
acknowledged capacity. No JavaScript runs on the worker. Synchronous write and
writeAudio remain synchronous and fail-fast at host queues.

```ts
const recorder = await Recorder.open(new MuxedOutput('trail.mp4'), {
  width: 1920, height: 1080, fps: 30, codec: 'h264',
  outputQueue: { maxBytes: 16 * 1024 * 1024, maxOperations: 64, waitMs: 100 },
  producerQueue: { maxBytes: 64 * 1024 * 1024, maxOperations: 8 },
})
using frame = camera.acquire()
const written = recorder.writeAsync(frame, frame.timestampNs)
frame.release() // RGB was copied into owned native storage at submission.
await written
await recorder.drain() // Await sink acknowledgements for this accepted prefix.
await recorder.close()
```

writeAsync(frame, timestampNs?, options?) and writeAudioAsync(data, timestampNs,
options?) return BunJob<void>. Submission validates/adopts a bounded native copy
before returning; queued work never borrows a Frame lease or mutable PCM array.
writeAVAsync(frame, blocks, timestampNs?, options?) copies one frame and up to
256 {data, timestampNs} PCM blocks as one admission. The worker writes those
blocks in order before the video frame. This supports exact Home PCM cursors,
AAC priming/tail edits and MP4 patching across asynchronous segment boundaries.

producerQueue defaults to 64 MiB and eight jobs, with a maximum of 1 GiB/eight.
The byte limit includes copied RGB, PCM and grouped-audio metadata; fixed job
headers are additionally bounded by the job count. Completed retained native
handles remain charged until cleanup. Admission failure does not allocate an
unbounded pending queue. Budget enough for the actual RGB size, including large
sensor modes; submission packing/copying still runs synchronously on the caller.
Every producer job also occupies one of the recorder's 16 Bun lifecycle slots.

Producer jobs run FIFO, including when an intervening queued job is cancelled.
A successful result means native encoding/output admission completed, not that
all asynchronous sink hooks finished. Use drain for a fixed accepted prefix.
Encoding/file operations and arbitrary user hooks have no hard realtime bound.
This is a feature/ownership improvement, not measured Pi throughput evidence.

## Wait policy and errors

outputQueue.waitMs defaults to 100 ms for asynchronous producer sends. Zero
selects fail-fast pressure; values must be finite and 0..60000 ms. If outputQueue
is omitted, io supplies its bounds/wait policy for host outputs. The deadline
applies to each blocked native send, including container writes, patches and
zero-byte packet notifications. The existing Home capacity_wait registry tracks
blocked attempts and outcomes; delivery_fifo owns and acknowledges their bytes.
An acknowledgement or failure wakes the worker under the mailbox mutex. No
polling thread or second encoded-packet queue is added.

A producer waits for the exact operation's bytes and one entry, then enqueues
under that same lock. This differs from waitForOutput's non-reserving capacity
observation. In-flight host work remains charged. Oversized operations fail
immediately. A deadline, full wait-ticket pool or sink failure returns an output
error without retrying the encoded operation. With isolate enabled, healthy
outputs continue; a slow output can still delay shared fan-out up to its wait
budget. Native wait timeout/rejection and host errors remain visible through
hostIOStats/outputErrors. Immediate successful sends do not create wait tickets.

JobOptions timeoutMs and AbortSignal cancel queued work, including copies and
admission ownership. Once the worker starts, encoder mutation is irreversible:
cancel returns false and those job cancellation/deadline requests cannot abort
it. Its configured host-send wait limits still apply. Parent close cancels queued
jobs and joins active work before freeing the recorder. A user hook or native
filesystem/codec call must eventually return; cleanup never forcibly terminates
a worker or recycles a camera buffer. signalFunction runs after native ownership
cleanup and may close the recorder safely.

## Camera pump and lifecycle coordination

Camera.startRecording selects async writes when asyncWrites is true, when a
producerQueue is supplied, or when a positive outputQueue/io waitMs is supplied.
An explicit asyncWrites:false retains the synchronous pump. The async pump packs
a frame and its captured audio as one native input, displays/resolves capture
work, and releases its camera lease before awaiting the producer. A single pump
owns scheduling, so additional capture requests cannot create overlapping loops.
Capture-manager callbacks remain independent of sink waits. Recording.frames in
this mode counts admitted frame groups; a group cancelled during stop can be
included in that count. Use output/producer statistics for completion counts.

During an active producer turn, synchronous recorder state/mutation calls reject
BUSY. hostIOStats and producerStats remain available; new async inputs may be
admitted within their configured bounds. Await a producer before ordinary manual
routing or recorder-statistics calls. Existing async preparation, replay and
factory lifecycle loops defer their native work until a safe owner turn.
Snapshots retain their independent frozen history and mailbox ownership.

Splits publish immutable epoch-handoff notifications from the producer. Bun can
then drain and stop the retired output while native code writes the successor.
This releases shared CircularOutput2 PTS predecessor fences even when a delayed
multi-frame batch cannot finish without host capacity. New source epochs are
validated before hook retirement; callbacks cannot outlive freed native owners.
Async recorder close runs final codec/AAC/MP4 tail work with the same host wait
policy while Bun drains hooks. Ordinary synchronous attachment/header setup and
custom snapshot replay remain bounded caller-side calls with fail-fast sends.

producerStats reports ownedBytes/ownedJobs, peak and configured limits, admitted,
released/rejected inputs, completed/failed jobs, cancelled queued inputs and
running. A failed-job count means the native operation returned an error; isolated
output failures may coexist with a successful shared producer job. Final producer
statistics remain readable after recorder close. Host epoch telemetry and the
bounded final-report cache retain their previous contract.

The additive C ABI exposes copied input creation, start, completion polling,
handoff snapshots and explicit handle close. Native close returns BUSY for any
retained producer input. Ordinary recorder calls and preparation-state mutations
reject BUSY during worker ownership. External caller-owned preparation recipes
must finish their build/commit/close lifetime before a producer can start. Native
control admission/lifecycle calls remain caller-serialized; the worker alone
mutates the encoder and recorder during its exclusive turn.

Host descriptor claims remain live through the retired sink's stop hook, even
when its native writer has already handed off. Alias checks therefore still
protect media and PTS files during asynchronous retirement. Immutable handoffs
also publish the successor's host epoch for telemetry and capacity waits while
the producer is active. Async input FIFO orders async submissions; await queued
inputs before mixing in synchronous producer calls.
