# Retained request capture and stop

`Camera.switchModeCaptureRequestAndStop` switches into the supplied target mode,
selects a completed request, runs its processing hooks and stops the target camera.
It returns `BunJob<Frame>` with the original owned request reference. The target
configuration stays installed and stopped. No pixel copy or extra retained token
is needed for the handoff. This supplies the capability of Picamera2's
`switch_mode_capture_request_and_stop` through the existing Bun mode job system.

```ts
const previous = camera.options
using request = await camera.switchModeCaptureRequestAndStop(
  { width: 4056, height: 3040, raw: true, unpackedRaw: true,
    lores: { width: 640, height: 480 } },
  { dropFrames: 4, autofocus: true },
)
console.log(request.metadata(), request.copyStream('raw').data.length)
request.saveFile('still.jpg') // Exif comes from this stopped, retained request
using sibling = request.retain()
request.release()
const analysis = sibling.copyRGB('lores')
sibling.release()
await camera.switchMode(previous) // restoration is explicit after all owners release
```

The returned Frame supports ordinary metadata/catalog reads, raw/lores copies,
scoped mappings, still encoding and independent `retain` references. Post-request
edits are visible because the returned request owns the source pixels, unlike an
owned copy made before the post hook. All owners and mappings must release before
restart, close or another mode switch. The camera cannot destroy target buffers
while they are retained. Existing busy/stale/generation and DMA rules still apply.
A failed close preserves the request; release it and retry. Copies and encoded
blobs made from it remain owned independently after disposal.

Successful handoff retires preview as ordinary camera stop does. The prior preview
configuration is not opened against a stopped target which may lack its streams.
Capture failure or cancellation before publication restores the prior camera's
running/stopped state and preview using the existing rollback transaction. Prior
mode settings are not automatically restored while a successful returned request
still pins target buffers. Save `camera.options` and explicitly switch back after
final release if desired. This is distinct from
[temporary owned stream copies](stream-bundles.md), which can release their request
and restore the prior mode before returning.

Mode options retain their existing deadline, frame dropping, autofocus and
signal/completion callback semantics. Pre-aborted/queued jobs acquire nothing.
An unpublished candidate is released on callback, stop or cancellation errors
before rollback. Cancellation after worker response but before main-thread
publication releases that transferred private token first. Home async's preparation
gate seals publication, so later cancellation cannot revoke caller ownership.
A completion callback failure is reported on the job as usual and does not release
a published Frame on the caller's behalf.

If exceptional cleanup cannot release a still-owned token (for example a busy
native access owner), the rejection contains `requestCleanup: Frame` on an
AggregateError instead of losing the reference. Original and cleanup failures
remain in `errors`; an additional rollback failure is `restorationError`. Retire
the blocking mapping/owner, call `requestCleanup.release()`, then restore/retry.
Worker-side release errors are reported as `requestCleanupCode` when present.
Do not assume that an error containing an explicit cleanup owner already destroyed
the target camera. DMA end errors normally consume the reference and therefore
need no retained cleanup Frame. Abrupt worker/process crashes still have the
existing unproven native recovery limits; this is a cooperative ownership protocol.

## Native and Zig

`zc_acquire_and_stop(camera, timeout_ms, out)` acquires one request and stops the
camera while retaining CPU-readable ownership. Success returns an ordinary
`zc_frame`, with one reference for the caller to release. Failure clears `out`;
an acquired private candidate is released before returning a stop error, and a
cleanup error takes precedence. Acquisition failure does not add a stop call.
The caller serializes camera lifecycle operations as with acquire/stop. This
synchronous helper runs no Bun processing hooks and performs no mode switch.
Native callers use the existing configuration primitives for the target mode.

Zig `Camera.acquireAndStop(timeout_ms)` returns an owned Frame with the same
contract. It is readable while stopped, can retain sibling references and uses
ordinary Frame.release. Native ABI layouts stay unchanged; this adds a function.

Home video's generation-checked lease pool and frame-access gates already supply
the ownership semantics needed here, while Home async's preparation gate supplies
the existing job publication boundary. They are reused without a new scheduler,
second token pool or kernel dependency. Home OS's fixed RGB camera stub does not
supply a hosted request handoff or recoverable DMA ownership layer.

Tests cover stopped/running source modes, RGB/I420 and paired raw/lores access,
post edits, focused metadata, preview retirement/restoration, independent retained
owners, restart/close pressure, queued/active/late cancellation and callback
failures. Native fault injection covers stop and DMA begin/end failures without
leaking the private candidate. A main-thread busy-release fault verifies the
explicit cleanup owner and both errors. Physical Pi behavior and abrupt process
recovery remain separate acceptance work; this does not complete Picamera2 parity.
