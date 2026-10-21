# Completed requests and capture jobs

captureRequestAsync returns BunJob<Frame>; captureRequest returns its Promise.
The capture pump moves its existing native reference into the returned Frame,
without copying pixels or briefly needing a second reference. Recording/preview
still consume the same captured frame. Release the returned request explicitly:

```ts
using request = await camera.captureRequest()
const metadata = request.metadata()
using anotherOwner = request.retain()
request.release()
// The retained reference is independent and valid for asynchronous processing.
await processImage(anotherOwner.copyRGB())
anotherOwner.release()
```

Each retain creates a distinct native token. Double release of a retired token
cannot consume another owner's reference. Metadata, raw, lores, JPEG and DNG
access use the retained token. No additional DMA begin occurs on retain; final
release performs DMA end and recycles exactly once. A failed DMA end still retires
the reference and is reported. Bun release becomes idempotent even after failure.

A camera has 256 reference-table entries, with primary capacity reserved for each
unleased physical buffer. referenceCount counts owners of one request; stats.leased
counts pinned buffers. Holding every physical buffer backpressures capture until
release or deadline. Requests remain readable across stop; close/restart/mode
changes reject outstanding references. On close rejection, release every owner
then retry. Tokens are scoped to the issuing camera. Cloning descriptor bytes does
not retain ownership. Do not access borrowed pointers after your reference ends.

captureAsync(callback, options), captureRGBAsync, captureMetadataAsync,
captureBufferAsync, captureStreamsAsync and captureFileAsync expose cancellation,
deadlines, signalFunction, operationDone and cleanupDone. The non-Async convenience
methods return Promises. Capture callbacks must finish synchronously: retain or
captureRequest for work that crosses an await. A published request handoff is sealed
against cancellation; cancellation before handoff retires the owned reference.
User completion callbacks do not extend native capture ownership.

CaptureOptions adds flush and dropFrames to these jobs, including the focus-locked
helpers. flush:true samples the native capture clock at admission; a bigint sets
an exact threshold. dropFrames skips distinct delivered requests before selection.
dropFramesAsync/dropFrames discard exactly the requested count. See
[capture barriers](capture-barriers.md) for clock domains, conservative exposure
guarding, FIFO/latest behavior, cancellation and recording coexistence.

captureFocusLockedRequestAsync/captureFocusLockedRequest provide the same owned
handoff after pausing continuous AF, validating a focused frame, and restoring
prior pause intent. The selected request stays pinned throughout restoration.
Failure/cancellation before publication discards it; after publication its caller
owns release. Keep another physical buffer free for restoration acknowledgement.
captureFocusLockedStreamsAsync/captureFocusLockedStreams return owned paired
stream copies and metadata. See [continuous AF](controls.md#continuous-autofocus-and-focus-locked-capture)
for restoration deadlines, buffer pressure and explicit recovery semantics.

captureStreams(['main', 'raw', 'lores']) copies all selected streams and metadata
from one completed request. Results own their arrays, so later captures cannot
change them. Names are validated/copied at admission. copyStreams on a retained
Frame offers the same operation. Each stream includes width, height, format,
rowBytes and data. BGR888 bytes are RGB; YUV420 bytes are tight I420. Bayer buffers
preserve CSI-2 packed bytes or unpacked little-endian samples and omit row padding.
PiSP compressed raw is still unsupported. This is a capability-oriented API, not
an emulation of NumPy array shapes or Python objects.

captureFile saves JPEG or DNG from the current mode; DNG requires an enabled raw
stream. The synchronous encoder/file operation cannot be interrupted once entered;
cancelling a job does not undo a file already written. Temporary mode buffer
capture now uses the same native sizing/packing path, including supported Bayer
formats. Retained returns from temporary mode jobs are not implemented: a retained
request would prevent restoring the prior mode until its owner releases it.

The additive C APIs zc_retain, zc_frame_references and zc_stream_copy_size preserve
ABI v1 layouts. Zig Frame.retain/referenceCount expose the same ownership. Existing
native mapped plane descriptors remain borrowed. [Scoped mapped streams](mapped-streams.md)
add independent owners, write exclusivity and Bun view invalidation. Native tests exercise concurrent retains/releases, DMA failures,
reference pressure and generation exhaustion; C/Bun tests cover parent release,
recording coexistence, stop/close, cancellation handoff and paired stream copies.
