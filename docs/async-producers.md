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

## End-to-end recording drains and terminal codec flush

```ts
const writing = recorder.writeAVAsync(frame, pcmBlocks, timestampNs)
frame.release()
const delivered = recorder.drainRecordingAsync()
await writing // Individual producer result, including validation/cancellation.
await delivered // Every earlier producer finished; all its emitted output acknowledged.
await recorder.flushAsync() // Terminal video, delayed media, AAC and MP4 tails + delivery.
// Inspect outputs while the recorder still owns them, then release resources.
await recorder.close()
```

`drainRecordingAsync(options?)` inserts a control job into the producer FIFO.
After earlier inputs finish native processing/cleanup, the worker captures the
current and retiring native output-I/O prefixes. Bun captures published host
mailbox prefixes, including still-retiring epochs. The job waits for all these
acknowledgements, surfacing a delivery error only after other captured sinks
settle. Isolation still preserves healthy outputs. Published host delivery errors
remain latched for later whole-recording drains, including after an epoch retires;
individual output drains retain their existing prefix/epoch semantics.

This drain keeps the FIFO barrier until acknowledgement completes. Later async
writes may be admitted within bounds but cannot execute through it. Synchronous
recorder mutations return BUSY during that Bun turn, including while native
producerStats.running is false and the barrier is waiting on hooks. Cancellation,
AbortSignal and timeout can release a recording drain while it waits. They do not
cancel earlier inputs or hooks, and create no abandoned background polling jobs.
Previously submitted producer jobs retain their own results; cancellation or a
validation failure in one is not itself a delivery failure. Await those jobs to
observe their results. Native I/O and codec errors remain errors.

A nonterminal drain does not force buffered AVC/HEVC packets, the final MP4 sample,
AAC padding, unmatched queued PCM, or delayed circular tails onto the output.
`flushAsync(options?)` adds a terminal control job: it drains the Home video codec,
forwards delayed video, drains synchronized PCM through the last video's nominal
end, flushes per-output AAC, emits the final MP4 sample and duration/edit patches,
and then waits for all captured native/host output acknowledgements. No stop hook
runs and no recorder or descriptor is freed. Stop submitting input before flush;
submissions already queued behind it fail STATE when executed. Submissions after
native finalization entry reject before copying input. Call restartAsync with a fresh output target to encode another session, or
create a new recorder.

Terminal flush is irreversible once its native job starts. Queued flushes can be
cancelled without ending codecs; active cancel returns false and parent close
joins the entire flush/delivery job. A deadline cannot forcibly interrupt an
entered codec flush or user hook. Repeated flush and subsequent close replay the
native finalization result without repeating codec tails or container patches.
Native file-I/O workers use their finalization policy for these tails; host sends
retain their configured per-send wait budget. Neither drain nor flush is fsync or
a physical storage durability guarantee.

Flush rejects BUSY before codec entry while a held output, unfinished preparation,
pending split or claimed factory owns publication. Finish that transition with
more frames, cancel it through its supported lifecycle, or close the recorder.
A rejected flush leaves media acceptance intact. Queries, output drains, output
retirement and supported retained-history snapshots remain usable after flush;
new attachments, splits, recovery and media writes reject STATE. Close still
joins preparation/retirement and runs stop hooks.

Both new jobs use a zero-payload slot in the same native producer admission pool
(default eight, configurable through producerQueue) and one of the 16 Bun lifecycle
slots. Reserve a producer slot when queuing barriers behind writes. They appear
in admitted/completed/cancelled/failed producer counters and remain charged as
ownedJobs until their fences are freed; they own no copied RGB/PCM bytes.
`drainProducersAsync` therefore also fences earlier retained control-job cleanup.

The additive C API `zc_video_producer_barrier(recorder, flush, &job)` creates these
control jobs (0 = capture delivery prefixes, 1 = terminal flush then capture).
The caller orders native starts after prior producer writes, polls finish to
release the recorder turn, then polls `zc_producer_job_drain_outputs` until all
retained native worker prefixes settle. Native callers may resume later writes
after a nonterminal marker; those cannot extend its captured fences. C callbacks
must supply their own host acknowledgement fence if they enqueue asynchronous
work; Bun combines both layers. A retained control job keeps recorder close BUSY
until job_close releases its fences. Future inputs, control cancellation and
native handle close remain caller-serialized.

## Reusable recorder sessions and async restart

```ts
let recording = camera.startRecording(recorder, { audio: firstAudio })
// ...capture...
await recording.flushAsync() // Detaches this pump and closes its audio capture.
await recorder.restartAsync(new MuxedOutput('next-session.mp4'))
recording = camera.startRecording(recorder, { audio: nextAudio })
// ...capture again...
await recording.flushAsync()
await recorder.close()
```

`Recording.flushAsync(options?)` stops that camera/audio pump, joins its submitted
inputs through the producer FIFO and performs the recorder's terminal flush.
The recorder remains caller-owned. Closing that detached Recording later joins
its flush but does not close a recorder that may now serve another session.
Supply a new AudioCapture for the new pump. Camera.startRecording requires an
open recorder session; await restart before starting capture again. Calling
Recorder.flushAsync directly does not detach a camera pump.

`Recorder.restartAsync(output = null, options?)` returns BunJob<void> and runs
on the existing producer worker after earlier FIFO work. The source must have
finished a terminal flush (success or failure); restarting live media rejects
STATE. One restart may be pending per Bun recorder. Native restart rejects BUSY
until other producer inputs/control handles, preparations and owned snapshot
windows are released. This protects retained handles that belong to the earlier
session. A restart can be queued immediately behind flushAsync, but await restart
before submitting further writes, control jobs or lifecycle changes.

A restart prepares fresh video encoders/headers, PCM queues, container/AAC state
and encoded circular history. Codec/geometry/fps/quality/audio configuration,
failure isolation, buffer capacities and global delay are preserved. Video/audio
counts, clocks, history, output layout, output errors, rotation/recovery policies
and factory registrations begin fresh. Reattach secondary outputs and configure
session-specific rotation/recovery again. Native path output I/O inherits its
previous primary's configuration; Bun also applies its configured io limits when
restarting from a custom sink to a native path.

The Recorder object, native address, worker and byte/count admission limits stay
stable. Producer counters remain cumulative, including restart jobs. The current
media statistics describe the new session. `sessionState()` reports its bigint
id (initially 0), open/flushing/flushed/failed phase and terminal native error.
Session IDs never wrap. Secondary output IDs are not reused; primary generation
advances, so old epochs and callbacks cannot fail a new output with the same ID.
Header/queue reports from previous sessions do not overwrite current telemetry.

Pass a fresh custom output, a fresh path, or null for an unattached session.
Custom hooks receive the newly created codec headers before binding. Their
commit hook and owned header writes must finish successfully before native
publication. Existing media/PTS aliases remain protected while the previous
session owns them. Restart paths are created exclusively even if ordinary initial
recording used exclusive:false. Existing files are never truncated by restart.
Null leaves the recorder ready for openOutput/addOutput without retaining any
previous attachment or history.

Before publication, cancel, AbortSignal, deadlines, header failures and setup
errors discard only the candidate. They join native cleanup before retiring its
hooks with discard:true; the previous flushed session and outputs remain intact
for inspection or another restart attempt. An uncommitted native path is removed
only if its inode/device still match the exclusively created file. A replacement
at that path is preserved. Application-provided outputs own their discard policy.
Preparation can temporarily retain two bounded session allocations, including two
history/PCM buffers and codec states. Copied path bytes also count against the
producer byte budget; at most one candidate is built on this worker.

Publication seals cancellation. The worker exchanges session state and destroys
the previous native codecs/outputs, then Bun drains/stops old host epochs before
releasing the producer FIFO. Old delivery errors do not poison the new session.
A stop-hook error after publication makes restart reject while the new session
remains open and usable; sessionState identifies the committed session. Such a
failure cannot roll back an already published output. Parent close cancels an
unpublished restart and joins outstanding hooks; a published restart is joined
before close consumes the new session. Arbitrary hooks must eventually return.

Input timestamps may restart at zero because the new video/PCM clocks are fresh.
A shared PtsStream still requires monotonically increasing source timestamps over
its own lifetime. Use a new PtsStream when resetting that external observer's
source clock, or continue absolute source timestamps across sessions. Reusing a
recorder after close is unsupported; flush/restart is the reusable lifecycle.

The C API creates a bounded producer job with zc_video_producer_restart: kind 0
is unattached, kind 1 owns a copied exclusive path, kind 2 waits for callbacks.
After start, stage 1 exposes immutable candidate codec headers; kind 2 binds its
callbacks through zc_producer_job_restart_bind. Stage 2 means output setup is
ready. Acknowledge host headers, then call restart_publish to seal publication.
Finish/close join worker ownership and release admission just like other producer
jobs. Native callers must keep callback contexts alive through cancellation or
publication cleanup. Callback output acknowledgement and retirement remain their
responsibility. zc_video_session_state returns BUSY during worker ownership.
