# Counted keyframe requests

Version 0.73 exposes `Recorder.requestKeyframe()` and
`Recorder.requestKeyframeAsync(options)`, with forwarding methods on an active
`Recording`. The async method returns the usual bounded, cancellable Bun job.

```ts
const recording = camera.startRecording(recorder)
await recording.requestKeyframeAsync()
await recording.flushAsync() // stop the pump and join producer ownership
console.log(recorder.keyframeState())
// { requested: 1n, applied: 0n or 1n, pending: 1 or 0 }
```

Each request applies to one subsequent accepted video input. Several requests
stay distinct and force successive inputs, including an input that already
starts a GOP. AVC/HEVC request IDRs through Home's existing encoder operation;
MJPEG frames are inherently key. Inputs rejected before encoding do not consume
intent. `applied` advances when the encoder accepts an input, including delayed
AVC inputs that produce no packet yet. It can therefore advance before output
delivery, and remains advanced if delivery of that input subsequently fails.
The counters do not promise a decoded frame, container publication or sink ack.

`keyframeState()` returns copied requested/applied bigint counters and a numeric
pending count. The ledger allows at most UINT32_MAX pending requests, rejects
counter exhaustion without wrapping, and allocates no per-request storage.
The owner's existing native producer pool bounds async control jobs as well as
copied inputs; keyframe jobs have zero payload bytes but consume a job slot.
State queries are busy while a native producer owns the recorder.

Synchronous requests reject while any producer/control job is retained, so they
cannot overtake copied writes. Async requests run in the same FIFO as writes,
drains and flushes. Completion means that intent was committed to the current
session, not that a later input has arrived. Cancellation before commit leaves
intent unchanged. A mutex linearizes request commit with cancellation; after
commit cancellation is refused even if the worker has not yet reported completion.
No codec or sink call runs while that commit lock is held.

A terminally flushed/failed recorder rejects new requests when they execute.
A request queued after a flush can be admitted but completes with STATE. Flush
preserves pending intent for inspection; publishing a fresh recorder session
resets the ledger. Cancelled or failed session preparation preserves the previous
ledger. Camera mode/recovery transactions use the same session publication rules.
Closing joins the ordinary producer jobs; no control job can outlive its recorder.
A stopped `Recording` rejects its forwarding calls.

Requests affect all outputs sharing that encoder. Internal split/rotation/recovery requests stay coalesced and do not increment
these public counters. Configured GOP policy is unchanged.
Distinct recorder owners have independent intent. This is the capability behind
Picamera2's counted `force_key_frame`, exposed with Zig/C and Bun ownership rules.
It does not add repeated in-band parameter sets or hardware encoder support.

C adds the 24-byte `zc_keyframe_state`, `zc_video_request_keyframe`,
`zc_video_keyframe_state` and `zc_video_producer_keyframe`. C callers retain control
of producer start order and must serialize calls according to the existing ABI.
A control job's drain-outputs operation returns STATE because it is not a drain.
No existing struct layout changes.

Tests cover counted AVC/HEVC IDRs and MP4 flags, independent Linux I420 decoding,
invalid inputs, FIFO/cancelled jobs, producer count bounds behind a blocked sink,
failed output accounting, flush/restart rollback, active camera forwarding and
option-accessor reentry. A native two-thread fixture holds worker completion open
to prove cancellation behavior on both sides of commit. Synthetic frames and
software decoding do not establish physical Pi latency or camera performance.
