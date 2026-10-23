# Temporary-mode owned image jobs

Version 0.86 adds Bun `Camera.switchModeAndCaptureImage(configuration, options)`.
It returns the existing bounded, cancellable `BunJob<CapturedImage>` and restores
the original mode/running state before publishing the image. This supplies the
capability of the pinned Picamera2 `switch_mode_and_capture_image` without a
Python facade. `await job`, `job.wait()`, `signalFunction`, `dropFrames`, fresh
target `autofocus`, autofocus coordination policy, timeout and abort options use
the existing mode-job semantics.

```ts
const job = camera.switchModeAndCaptureImage(
  { width: 4056, height: 3040, format: 'BGR888' },
  { stream: 'main', width: 1200, resample: 'lanczos3', autofocus: true },
)
using image = await job
// The original camera mode and preview have been restored.
await camera.close()
await image.saveAsync('trail.png')
```

The named main/lores source supports the existing processed RGB/BGR/RGBX/BGRX,
planar/semi-planar YUV420, packed422 and RGB16 formats. Image options are copied
once at admission. Default depth follows the actual source; `bits: 8` explicitly
reduces word data and `bits: 16` requires a native word source. Optional dimensions
and the five Home resamplers have the same policies as ordinary owned capture.
Invalid early options do not reconfigure the camera. Target-only errors, such as
missing lores or unsupported precision, release the request and join restoration
before rejecting. Raw/DNG captures remain the calibrated raw/request APIs.

A shared internal helper now serves ordinary `Frame.makeImage` and mode workers.
It reads authoritative native stream geometry, depth, scalar request metadata
and color description before request release. It makes one independent compact
RGB8/RGB16 copy. Public mutable frame descriptors or overridden metadata methods
do not relabel its provenance. Metadata describes the target request; the old
camera's restored color space or geometry cannot overwrite it. The image freezes
its metadata/color snapshots on adoption. This is scalar provenance, not a full
vendor metadata or image Exif catalog. Standalone image Exif defaults remain
explicit as documented in image-objects.md.

Pre callbacks run before copying, post callbacks after copying. The worker then
releases the target request and restores camera configuration, persistent controls
and running state. Optional resizing runs on the mode worker over owned pixels
after restoration, with no camera lease. Cancellation/deadline checks bracket
that synchronous native work. The independent buffer moves once to the main
thread through the existing worker transfer set; no DMA pointer or image class
instance crosses threads. The main owner restores preview, checks the deadline
again, adopts the image and seals publication. Completion hooks observe the
finished image and restored camera. Hook failure does not invalidate a published
image; callback errors before publication, camera close, cancellation, mode/
preview restoration failure and elapsed deadlines reject without an image result.

The mode queue retains its existing 32-job bound. Source/output pixel copies are
capped at 256 MiB each; Home resampling has a separate 64 MiB working-heap bound.
Cancellation cannot interrupt a synchronous codec/resample call halfway through;
the job joins it and discards the result. Ordinary `Frame.makeImage` resizing
still runs synchronously on its caller; only this mode workflow moves that work
to the existing worker. No new native queue, C ABI layout or version is introduced.

Sixty-six new Bun tests cover all 14 processed formats, both streams and both
original running states, exact pixels/provenance against target callbacks,
partial dimensions/word reduction, option getters, missing sources/limits,
post-copy mutations/failures, persistent controls/fresh AF/preview, active
cancellation/close, preview failure/deadlines and sealed completion hooks. Full
local validation passes 1,167 Bun tests with independent media decoders and SDL,
403 target-qualified ReleaseSafe native tests, C ABI execution, typecheck/fmt.
The standard local Zig runner still fails macOS SDK/libSystem linkage before
project compilation; direct native tests pass. Linux real-backend platform CI
remains a release gate. Physical mode timing, sensor/optics quality and Pi
throughput remain unmeasured. The broader parity goal remains open.

The same post-preview deadline boundary now sits inside mode rollback. A
permanent mode timeout stops the target preview before returning to the previous
camera owner; it cannot report failure while silently retaining the new mode.
The regression checks that the restored camera can acquire another request.
