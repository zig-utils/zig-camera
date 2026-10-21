# Pre/post request callbacks

Camera.setRequestCallbacks({ pre, post }) replaces both callbacks. preCallback and
postCallback properties update one phase while preserving the other. Omit a
callback to clear it. Inputs are validated/copied once; a frozen callback pair is
selected per frame, so a registration change affects later frames. Default
capture has no scope/view allocation when callbacks are absent.

```ts
await using camera = new Camera({ width: 1280, height: 720, writable: true })
camera.setRequestCallbacks({
  pre(request) {
    request.withMappedStream(mapped => mapped.row(0).fill(0))
  },
  post(request) {
    console.log(request.metadata().sequence)
  },
})
const copy = await camera.captureRGB()
camera.setRequestCallbacks({})
```

The main pump runs pre callback, capture selection/copy, post callback, recording
input snapshot/encode, then preview. This follows the ordering of the pinned
Picamera2 process_requests implementation. Pre edits appear in owned captures;
post edits appear in encoding/display and retained request results. An owned RGB
copy made before post remains unchanged. Async producers copy their RGB input only
after post and scope retirement. No callback runs inside a libcamera manager
completion callback or a native codec/output-I/O callback.

Callbacks are synchronous and run on the main Bun thread. They receive
RequestFrame, a scoped view with metadata/catalogs, geometry, owned copy helpers,
JPEG/DNG save, mapStream/withMappedStream and retain. No primary release method or
raw primary descriptor is exposed. The view expires at phase exit; mappings opened
through it close automatically, including mappings the callback forgot to close.
Ordinary escaped row/subarray/DataView aliases detach before native retirement.
withMappedStream also retires its map on return/throw. Enable writable:true for
edits; read-only cameras still support inspection/copies and explicit retention.

retain returns a normal owned Frame for work crossing await. Release every owner
explicitly. A pre-stage retained sibling prevents a post-stage write map until
that sibling releases; native exclusive-write rules still apply. Returning a
Promise from a hook rejects TypeError, expires its view and retires maps; the
framework does not await that Promise. The async continuation must not access the
expired view. A valid pattern launches async work with its own retained owner and
returns synchronously. Retained owners may backpressure capture or prevent mode
restoration just like ordinary retained requests.

Camera ownership operations reject BUSY during a hook: direct acquisition, new
capture/AF/mode jobs, start/stop/close, preview lifecycle, recording attachment and
callback registration. RequestFrame.retain is the safe acquisition path. Normal
camera metadata/control access remains available outside mode ownership; use the
request's metadata, controls() and setNativeControls() against its exact active
handle during a mode hook. Native AF ownership/range/type/replay rules still apply.
Accepted controls target subsequent requests; they do not change the current
frame's metadata. Mode callback writes reserve rollback revision headroom before
publication, including at u64 exhaustion. Temporary-mode changes are local to the
target and the previous desired state is replayed on restoration. Permanent
targets retain their accepted control journal.

A started camera with callbacks pumps even without recording, preview or pending
captures. Registration itself does not start a camera. Clearing callbacks removes
that pump demand. Stop joins work and pauses callbacks; restart resumes registered
callbacks. Hooks observe frames delivered to the public consumer pump, not every
physical sensor exposure or frames evicted by latest-queue policy. Internal stop
cleanup/AF restoration recycling is not a separate public hook delivery stream.

Mode workers hand off each warmup, AF-observation and selected capture frame to
the same main-thread callback code. The worker pins its primary native lease while
waiting, and the main thread expires the scope before acknowledging progress.
Only one callback frame per mode worker can be in flight. A checked nonwrapping
ticket and atomic pending/claimed/retired/cancelled states reject stale delivery.
Cancellation can retire an unclaimed event without invoking it; a delayed message
then never accesses its old native pointers. A claimed callback must retire before
worker release/restore, even after cancellation/deadline. Synchronous user code
must eventually return; a job deadline cannot interrupt arbitrary JavaScript.

Worker-based temporary RGB/stream/metadata/JPEG/DNG captures run pre before copy
or file save and post before release/restoration. A capture/file failure still
runs post when pre completed. Callback failure aborts that mode transaction and
joins existing rollback. Explicit retained requests can prevent rollback/close:
the job reports restoration failure and leaves those owners readable, rather than
freeing their buffers. Release them before retrying mode restoration. Coordinated
recording mode jobs use the same protocol after the old recorder session drains.

A RequestCallbackError records phase, sequence and original cause, including a
thrown undefined value. The failing registration is disabled; the other phase
remains registered. camera.requestCallbackError exposes the latest failure.
In the main pump, the affected frame is omitted from encoding/display, the current
capture rejects, and healthy recording/queued captures continue. A post failure
discards an unpublished captureRequest primary. A separate capture-operation
failure does not consume another queue entry when post also fails. Mode errors
preserve the callback cause and native restoration diagnostics.

If a scoped map cannot close, its owner is preserved in error.unclosedMappings
and camera.requestCallbackMappings, bounded by the native reference table. Replacing
callbacks does not orphan these owners. retryRequestCallbackCleanup retries them;
stop/close also attempts retirement. A persistent detachment/retirement failure
remains observable and prevents unsafe buffer reuse/close. Ordinary native close
errors that consume the map leave its views detached. Explicit retained frames
created by user code remain the user's cleanup responsibility. Already accepted
control requests, file writes and in-place edits are not rolled back by a later
callback failure/cancellation.

Home lease_pool and frame_access retain ownership and exclude conflicting writers;
completion/preparation gates continue to own Bun job settlement. The hook layer
adds scoped views and a bounded worker handoff, not another pixel/frame queue.
Tests cover exact pre/copy/post/video/preview order, forgotten-map cleanup, retained
results, thenables, reentry, both cancellation races, target controls/revision
headroom, recording/CAF integration, file errors and recoverable cleanup. Synthetic
tests do not establish physical Pi throughput, optical quality or DMA acceptance.

Reference: [pinned Picamera2 request processing](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/picamera2.py#L1470).
