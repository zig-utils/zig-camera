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

Automatic patterns apply to path outputs. Custom objects use explicit split and
recovery jobs. The initial file is opened separately (use `exclusive: true`).
Configure rotation with the next replacement index. The native CLI opens index
zero itself. Patterns
accept one `{index}` or `{index:06}` field, widths 1..128 and paths <=4096 bytes.
Indices never wrap. Filenames are fresh, not retention slots.

There is one automation per ID: primary rotation or recovery. Additional outputs
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
