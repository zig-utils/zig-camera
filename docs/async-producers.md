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
await recorder.drainProducersAsync() // Cleanup of all inputs admitted so far.
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

JobOptions timeoutMs, AbortSignal and cancel(reason?) cancel queued and active
work. A native mutex serializes cancellation with worker completion; requests
after native completion return false, even before Bun observes that result.
An accepted active request keeps the job running until its native ownership ends.
The copied input, recorder turn and admission charge remain live until then.
Repeated cancellation returns false and preserves the original reason.

Cancellation checkpoints occur before each PCM block and video frame in an AV
group. An operation already entered completes all its codec/container writes,
patches, fan-out, split handoffs and delayed-output forwarding. Cancellation does
not interrupt that operation or roll back accepted data. A single-frame write
can therefore deliver its entire frame and still reject with its cancellation
reason. Unentered blocks/frames are skipped; use actual output/audio statistics
when resuming a partially processed group, rather than retrying the whole group.
An actual native operation failure takes precedence over the cancellation reason
and remains in failed-job/output telemetry. Cancellation itself leaves healthy
encoder/container state usable. Native finish reports ZC_CANCELLED (-10) when
cancelled without another failure; Bun preserves the supplied reason instead.

Host-send wait limits still apply to entered operations. A cancellation deadline
requests cancellation; it is not a hard bound on cleanup. Parent close requests
cancellation for queued and active inputs, then joins native work before freeing
the recorder. A user hook or native filesystem/codec call must eventually return;
cleanup never forcibly terminates a worker or recycles a camera buffer.
signalFunction runs after native ownership cleanup and may close the recorder
safely.

## Producer cleanup drains

drainProducersAsync(options?) returns BunJob<void> and captures the native input
admission prefix at the call, including queued, active and completed retained
handles. It completes when all those copied payloads have been freed. Later
inputs cannot extend the prefix, even when releases occur out of order or slots
are reused. It is a settlement fence: cancellation and write failures do not make
the drain reject; await individual jobs and inspect producer/output statistics
for their results. It does not flush codecs or wait for asynchronous sink hooks.
After draining producers, use drain(outputId?) to await sink acknowledgements.

Cancelling or timing out a drain only releases its retained fence; it never
cancels inputs. Parent close cancels its Bun drain jobs before freeing the source.
Each drain uses one of the recorder's 16 lifecycle slots. The native ABI allows
32 retained zc_producer_drain handles, polls with TIMEOUT while pending and OK
after cleanup, and permits polling/closing after recorder close. These handles
retain the small bounded ownership registry, not payloads or a live recorder.
Control calls and handle close remain caller-serialized.

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
released/rejected inputs, completed/failed jobs, cancelled queued/active inputs and
running. A failed-job count means the native operation returned a non-cancellation
error; an accepted cancellation and a real failure can increment both counters. Isolated
output failures may coexist with a successful shared producer job. Final producer
statistics remain readable after recorder close. Host epoch telemetry and the
bounded final-report cache retain their previous contract.

The additive C ABI exposes copied input creation, start, cancellation, completion
polling, retained cleanup drains, handoff snapshots and explicit handle close.
Native close returns BUSY for any
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
