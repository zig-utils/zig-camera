# Native recording jobs

`zc_video_prepare_async` takes a stable output ID, exactly one path/callback
protocol and a split/recovery selector. It copies immutable configuration and
headers, reserves one of eight job slots and one preparation per output, and
starts a native worker. Paths are created exclusively on that worker; collision
never truncates an existing file. Headers, Home AAC/container setup and inherited
bounded output-I/O allocation also run there.

The owner serializes recorder and job calls. `zc_video_write` polls ready jobs;
`zc_video_poll_preparations` also progresses them while capture is idle. Polling
does not wait for header/file I/O. It stages ready splits and requests a keyframe.
Split success becomes visible after generation advances and old output I/O has
retired. With no future frames, a staged split stays pending until teardown.
Recovery publishes a fresh sink immediately and requests the next keyframe.
The quarantined sink and its borrowed callback context remain alive through
worker cleanup. Failed workers must be complete before a recovery starts.

The worker owns prepared payload cleanup. Registry reservations remain live
through cleanup, protecting hardlink aliases across other output IDs. Worker
code never reads mutable recorder state. Capture and job ownership follow Home's
`preparation_gate`; publication and cancellation occur at serialized boundaries.
Callbacks run on native threads and must never re-enter camera/recorder APIs.

## Bun API

```ts
const job = recorder.split('next.mp4', outputId)
// Capture continues independently of preparation.
await job.wait({ timeoutMs: 30_000 })
job.close()

// Failed sink replacement; requires isolate: true and a quarantined sink.
const recovery = recorder.recover('fresh.mp4', outputId)
await recovery
recovery.close()
```

`job.cancel()` succeeds before staging. Claimed work is cooperatively cancelled;
it becomes terminal only after the worker returns and cleanup completes. A real
construction error takes precedence over cancellation. Terminal cancellation
uses `ZC_STALE`; `ZC_TIMEOUT` in job status means pending. Cancellation after
staging is rejected. `job.close()` returns BUSY while pending. Completed handles
retain their slot until released, bounding forgotten handles as well as workers.
Status and close remain valid after the recorder has been closed.

Custom Bun sinks use `zc_video_prepare_held`: READY remains unpublished until
owned header writes are acknowledged and `zc_preparation_job_publish` releases
publication. The Bun job seals cancellation at that serialized release, before
capture can stage it independently. Native callbacks enqueue into Home's bounded
acknowledged FIFO; JavaScript hooks run only on the Bun event loop. See
[output objects](output-objects.md) for hook ownership and failure isolation.

Recorder close cancels unstaged preparation, waits for owned workers, removes
uncommitted split files and drains final media. It preserves files whose output
generation committed, even if retirement was still pending. Deletion checks the
created file's device/inode without following symlinks. A replacement path with
a different identity is preserved. Arbitrary blocking callbacks must eventually
return; teardown cannot safely interrupt a native callback. Bun also uses the
teardown-only `zc_preparation_job_abort_pending` to retire a staged, uncommitted
object replacement when there will be no future keyframe. Ordinary job
cancellation remains rejected after publication is released.

Bun closes recorders on a worker and reserves this operation independently of
its 16 drain/snapshot task slots. Native drain handles retain a fixed accepted
I/O prefix, independent of recorder lifetime. Snapshots freeze bounded encoded
video and PCM ownership before writing on a worker; at most two frozen windows
exist per recorder. Close does not invalidate either type of independent handle.
Host delivery drains capture the same fixed-prefix semantics and cache completion
before mailbox destruction. Parent close waits for object jobs' `operationDone`
ownership fence, then retires hooks; `cleanupDone` additionally includes the user
signal callback. This permits a completed job's callback to close its owner
without creating a dependency cycle. Admission slots remain bounded through that
callback. Mode jobs follow the [same ownership rules](mode-recording.md).

## Automatic rotation and recovery

```ts
recorder.setRotation('trail-{index:06}.mp4', {
  nextIndex: 1n, durationMs: 5000, maxBytes: 512 * 1024 * 1024,
})
recorder.setRecovery(secondaryId, 'retry-{index:06}.mp4', {
  maxAttempts: 3, retryDelayMs: 100, maxDelayMs: 5000,
})
```

Automatic patterns apply to path outputs. Bun also accepts asynchronous output
factories for primary or secondary IDs; see [output objects](output-objects.md). The initial file is opened separately (use `exclusive: true`).
Configure rotation with the next replacement index. The native CLI opens index
zero itself. Patterns
accept one `{index}` or `{index:06}` field, widths 1..128 and paths <=4096 bytes.
Indices never wrap. Filenames are fresh, not retention slots.

There is one automation per ID. Path rotation is primary-only; factories support
rotation or recovery on any stable output ID. Additional outputs
can recover independently while primary rotation continues. Recovery requires
failure isolation and uses Home's lifetime budget with capped exponential
backoff on the last accepted capture timestamp. Failed construction consumes
one attempt and advances the filename. A full admission pool or in-flight failed
I/O does not consume an attempt. Healthy periods clear a deadline without
resetting the lifetime budget. No wall-clock sleeper retries a stalled stream.

`automaticState(id)` reports pending, next index and the latest preparation error.
Rotation errors latch and leave the existing healthy output active. Reconfigure
while idle to retry. Recovery continues until its configured budget is exhausted.
`recoveryState(id)` reports attempts, limit, deadline and exhaustion. Do not mix
manual mutation with automatic ownership of the same output; stop its automation
when idle first. One worker per preparing output and eight per recorder are the
hard bounds; thresholds can be exceeded while preparation or keyframe delivery
is slow. No retention deletion, crash repair or sustained Pi rate is claimed.

## Held custom pre-roll

zc_video_open_held_callbacks validates a primary sink and freezes retained GOP/PCM
ownership. zc_video_step_held_output produces at most one video interval and
returns TIMEOUT while history/live packets remain. The host acknowledges its
mailbox prefix between steps. zc_video_publish_held_output publishes only when
that backlog is empty; otherwise it returns TIMEOUT without mutation. Capture
queues new packets under the source ring's byte/frame limits. Held errors are
excluded from fail-fast recorder polling until publication, so a failed startup
can be discarded without poisoning healthy outputs. Split, delay mutation and
legacy unhold calls cannot steal a held replay's ownership.

zc_video_discard_held_output destroys an unpublished target without finalizing
its writer. Bun stop/close cancels the job, waits for hooks, then discards before
closing native storage. A committed target follows ordinary finalization.

## Custom snapshots and factory admission

zc_video_freeze_callbacks owns a submission-time GOP/PCM window under the same
two-window limit as path snapshots. zc_snapshot_open_callbacks binds the fresh
sink after async start. Serialize binding with the live recorder; pass NULL only
after source close and callback retirement. The snapshot owns copied history and
a refcounted reservation registry beyond recorder lifetime. zc_snapshot_step
produces one video interval, returning TIMEOUT until final tail/patch completion.
Drain the host mailbox between steps. zc_snapshot_close always consumes the
handle, including failed binding or cancellation, without finalizing a discarded
writer. Bun snapshot jobs are independent of the parent close job.

zc_video_set_factory installs Home's policy, not a runtime callback. Claim
reserves recipe/job capacity and a never-repeated recorder ticket. Host code
constructs a fresh sink and calls zc_video_prepare_factory with that ticket.
Generation validation, held headers and keyframe handoff use the existing native
preparation path. Finish every claim only after native handles and host hooks
retire; zc_video_finish_factory observes the last media timestamp for retry
backoff. Close returns BUSY while a claim remains pending. Bun cancels queued
claims, awaits late factory results and finishes claims before native close.

## Host capacity waits

Host producer capacity waits use Home capacity_wait.Registry(16), with a native
monotonic timer per mailbox and explicit open/poll/release ABI calls. No native
call sleeps. BunJob polls cooperatively and enforces parent cancellation and
output epoch ownership. Capacity considers bytes and operation entries together,
including unacknowledged in-flight work. It is an observation, not a reservation.
Terminal outcomes survive later failure, and releasing pending tickets cancels
them. Retire closes pending waits before mailbox destruction. Bun guards every
poll/release against freed bridge storage. Native snapshots and fixed-prefix
drain jobs retain their existing ownership semantics.

zc_output_mailbox_stats_get snapshots counters under the queue mutex. Byte-copy
and partial host-write progress do not acknowledge capacity. Bun additionally
reports the in-flight hook and caches a bounded set of final epoch reports;
unacknowledged queue storage becomes abandoned accounting when destroyed.

## Exclusive async producers

See [async producers](async-producers.md) for copied RGB/PCM input admission and
one persistent native worker per recorder. Ordinary recorder ABI access rejects
BUSY during a producer turn. Bun's lifecycle loops defer native access, while
mailbox consumers and telemetry remain available. A producer start is irreversible;
queued cancellation frees its input, and active completion precedes recorder
teardown. Completed retained native handles remain charged and block close.

Producer-scoped mailbox sends use a condition variable and Home's capacity_wait
registry under the queue mutex. They wake on acknowledgement, failure or deadline.
Only the persistent producer and worker-only recorder close enable this scope;
synchronous header/attachment/snapshot calls remain fail-fast. Immutable native
handoff events let Bun retire predecessor hooks and release shared PTS fences
before a blocked successor needs to complete its producer batch.
