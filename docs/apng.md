# APNG encoding and capture

Version 0.82 exposes Home's APNG codec through Bun and C jobs as well as the
borrowed Zig `camera.ApngEncoder`. PNG encoding stays in Home/Zig with zlib;
there is no Python or FFmpeg runtime or tool dependency.

```ts
import { Camera, encodePngAnimationAsync } from '@zig-utils/camera'
const camera = new Camera({ width: 640, height: 480 })
try {
  const job = camera.capturePngAnimationFileAsync('trail.apng', 8, {
    intervalMs: 100,
    delayMs: 100,
    timeoutMs: 30000,
  })
  const result = await job
  console.log(result.metadata.map(frame => frame.timestampNs))
} finally {
  await camera.close()
}

const bytes = await encodePngAnimationAsync({
  width: 2, height: 1,
  frames: [
    { width: 2, height: 1, data: new Uint8Array([255,0,0, 0,0,255]) },
    { width: 1, height: 1, x: 1, data: new Uint8Array([0,255,0]),
      delay: { numerator: 1, denominator: 25 }, dispose: 'previous' },
  ],
})
```

`encodePngAnimationAsync` returns a `BunJob<Uint8Array>`;
`savePngAnimationAsync(path, animation, jobOptions)` returns a `BunJob<void>`.
A raster supplies `data`, width/height, optional stride, `format` (gray/rgb/rgba),
`bits` (8/16) and endian (little/big). The data type is Uint8Array; a 16-bit
array can supply its byte view with explicit sample order. Inputs may be
unaligned/padded and need no final-row padding. Submission copies every active
row before returning a running job, so the caller may then overwrite or release
source bytes. Descriptors are snapshots; no camera or caller data pointer is
retained by the native worker. Pre-aborted/zero-deadline jobs do not submit.

Frames add x/y offsets, delayMs or rational `delay`, disposal
(none/background/previous) and blend (source/over). All frames share channels and
depth but may use different strides/endian. Rectangles must fit the canvas.
`delayMs` reduces to an exact fraction or rejects; it never silently clamps.
A zero denominator explicitly means hundredths of a second. With no
`defaultImage`, frame zero supplies IDAT and must cover the canvas at (0,0).
A separate full-canvas `defaultImage` is excluded from playback; all animation
frames then use fdAT. These are raw rectangles/controls, not precomposited inputs.

`capturePngAnimationAsync(count, options)` returns `{ data, metadata }`;
`capturePngAnimationFileAsync(path, count, options)` returns `{ path, metadata }`.
Promise facades omit the Async suffix. Main is the default stream; lores must be
configured. Capture defaults to native RGB precision: RGB161616/BGR161616 retain
all sample bits, other processed formats convert through existing RGB8 copies.
Explicit bits:8 reduces words to high bytes; bits:16 rejects 8-bit/YUV sources.
No higher precision is fabricated. The scoped RequestFrame interface now also
exposes copyRGB16/copyRaw16; returned words survive the callback while its request
view expires normally.

Capture selects frames serially with existing flush/dropFrames/syncReady rules.
A true flush snapshots the capture clock once at admission; dropFrames applies
to each selected frame. intervalMs paces capture requests, without promising
sensor delivery cadence or removal of FIFO backlog. delayMs declares playback
duration (default 40 ms); metadata preserves actual request timestamps separately.
An optional synchronous onFrame callback receives immutable index/metadata after
copy/release. Promise-returning callbacks reject. Pre/post request callbacks still
run through the shared pump, including their failure and mapping-cleanup rules.
No image compression or file writes run in the camera manager callback.

An animation capture exclusively reserves camera lifecycle/mode ownership until
capture, encoding and file cleanup retire. Public acquire, competing capture,
mode and recording changes reject while it is active. It releases its own leases
before encoding. Explicit callback retains remain separately owned by the caller.
Existing preview/callback pumping continues; capture leaves the camera started,
like other captureAsync calls. stop/close cancel and join the animation job before
retiring camera ownership. This API does not switch camera modes or change CAF
intent automatically.

The Bun/C async APIs accept 1..256 frames. maxInputBytes and maxOutputBytes default to 64 MiB
and each accept 1..256 MiB. Input charges active pixels, including a poster;
output caps the entire encoded payload including framing. Native admission
retains at most four encoder jobs and 512 MiB of logical input/output reservations
plus their descriptor/owner charge, including completed handles until close.
These caps are ownership/payload policy, not a measurement of process RSS;
allocator capacities, caller arrays, row scratch and zlib's native workspace are
separate. Camera capture preflights its total canonical pixel payload before
starting and holds bounded owned copies until native admission.

Staged-file creation is also globally bounded to 32 retained file handles,
including ready/finished handles. The Home admission registry reserves a slot
before path allocation/thread creation and releases it after close joins.
This bounds file threads even for bursts rejected by encoder admission. Busy
submissions fail without taking another slot; existing operations remain healthy.

Native workers use the existing Home row filters, PNG network byte order and a
separate pinned zlib stream per frame. Optional Home sink checkpoints run before
allocation, each filtered row and finish, so cancellation remains observable even
when compressible rows emit no chunk. Scratch is two rows plus bounded
compression state. No full filtered-image or second compressed-frame copy is
needed. Workers own copied inputs; cancellation/error always joins before freeing
those inputs or admission. A byte result transfers once to an owned image blob
and then to Bun. Sink/codec errors publish no partial byte result.

Files use the existing native staged-file identity checks and preparation gate.
The worker writes privately, then Bun joins capture callbacks/encoding before
claiming publication. Encoding, callback, deadline and accepted cancellation
failures dispose the temporary and preserve the previous destination. After the
native publication claim, cancellation is rejected and stop/close wait for the
I/O outcome. Publication/cleanup error fields retain the staged-file contract;
there is no fsync/durability guarantee or promise of crash cleanup.

C adds zc_apng_raster/frame/config, zc_default_apng_config,
zc_apng_encode_async, state_get/cancel/take_blob/close. Descriptors are borrowed
only during submission. Byte jobs transfer a blob once; file jobs borrow a live
zc_image_file through job close and publish separately with image_file_finish.
A worker-active close returns BUSY. C callers serialize handle publication/close
and keep handles live during other-thread cancellation. The existing C ABI version
and still-option layouts remain unchanged. Zig's synchronous borrowed encoder
remains available; keep all views and sinks alive for its call and stage/dispose
partial streaming output on error.

Home 9992b0608a44d6bca818900e0f2170e55adc48b1 adds row checkpoints to the shared
PNG/APNG modules, copied verbatim here. Its pinned/development Zig Debug and
ReleaseSafe matrix passes 16 helper tests and 216 independent libpng fixtures per
build; the complete Home Image API passes 141 tests locally. Hosted Home Actions
is unavailable and is not claimed green. Home OS at the revision in the reuse
audits supplies display animation state rather than a raster codec; no OS code
is copied, changed or executed.

Camera validation includes native ownership/allocation/failure/cap tests, C ABI
sizes/offsets and blob retirement, and Bun jobs/capture/precision/selection/
cancellation/deadline/callback/publication/pressure tests. A separate C/libpng
reader checks CRCs, contiguous sequences, raw frame samples and controls from
actual native/Bun outputs. It reconstructs static frames and does not claim
independent animation compositing. Platform CI preserves real libcamera
compile/load/no-camera checks. Hardware timing, precision/format acceptance and
throughput remain unmeasured. GIF, decoded image objects/compositing, animation
ICC/Exif, temporary-mode animation capture and broader parity work remain open.

Local release validation passes 381 native tests and the complete 1,001-test Bun
suite, including 33 APNG cases with independent libpng readback, plus C ABI,
typecheck and formatting checks. The standard local macOS build runner still has
its SDK/libSystem link failure before project compilation; direct builds pass.
Byte jobs remain cancellable until Bun value publication, including during their
internal blob handoff. Direct C blob take is its own publication boundary. Native
file-job cancellation also wins the staged file gate, so accepting cancellation
of a ready job prevents later file publication; a file already claimed rejects it.
