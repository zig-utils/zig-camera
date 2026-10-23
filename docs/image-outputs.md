# Sequential still outputs

Version 0.95 adds `Frame.saveToAsync`, `RemoteFrame.saveToAsync` and
`CapturedImage.saveToAsync`. Each returns `BunJob<void>` and accepts a caller-owned
`ImageOutput`: a `write(Uint8Array)` method and optional `flush()` method. It uses
Home JPEG/PNG/TIFF/BMP/PPM/GIF encoding, with calibrated DNG available on local/raw
and remote/raw requests. Raster alpha/precision restrictions match synchronous
encoding. No Python, FFmpeg, alternate codec stack or child process is introduced.

```ts
const frame = await camera.captureRequest()
const writer = Bun.file('trail.jpeg').writer()
try {
  const job = frame.saveToAsync(writer, {
    format: 'jpeg', quality: 98,
    maxInputBytes: 64 * 1024 * 1024,
    maxOutputBytes: 64 * 1024 * 1024,
    maxWorkingBytes: 128 * 1024 * 1024,
  })
  frame.release() // Admission already copied the selected request.
  await job
} finally {
  frame.release()
  await writer.end() // The caller owns closing the sink.
}
```

Use `Bun.file(path).writer()`, a memory accumulator or a sequential custom sink.
`Bun.file(path).write` replaces the whole file per call; it is unsuitable as a
chunk writer. There is no extension inference for outputs; the default is JPEG,
so specify `format` explicitly for another encoding. Main/lores/raw selection and
request Exif/ICC options match `encodeImage`. Image objects accept explicit Exif;
they do not invent capture provenance from their pixels.

## Write contract

Each offered chunk is a fresh independent copy of at most 64 KiB. Returning
`undefined` accepts the whole chunk; a positive integer accepts that prefix and
the next call starts at the first unaccepted byte. Zero, negative, fractional,
non-finite, non-number or excessive counts reject immediately. A sink requiring
backpressure returns a promise which settles when it accepts bytes. A promise
resolving to zero is still invalid. Node-style `write(): boolean` requires an
adapter that waits for its drain event and reports accepted bytes.

Methods and receiver binding are captured once before native admission. The sink
may retain, mutate or transfer an offered chunk without changing future bytes.
Only one write is active on a destination at a time. Another job reaching the
same destination during an active write/flush fails BUSY. Await jobs to preserve
whole-image ordering. Distinct wrappers sharing an underlying descriptor must be
coordinated by their caller. Successful output invokes the captured `flush` once;
the library never invokes `close` or `end`. The same output can be reused.

Cancellation/deadlines suppress future calls and join an already accepted write
or flush promise before rejecting. A sink rejection or invalid progress remains
observable even if cancellation arrives during that call. Completion callbacks
run after native/output cleanup; `cleanupDone` additionally joins those callbacks.
Synchronous writers yield to timers after bounded calls, and wall-clock checks
also enforce the deadline. A promise that never settles cannot be forcibly joined;
custom asynchronous sinks must eventually settle their accepted operations.

Accepted bytes are an externally visible prefix. Cancellation, encoding/output
errors and deadlines cannot roll them back. Reuse the existing staged path saves
for atomic destination replacement, or `ProcessPool.submitToFile` for parent-owned
result/ACK publication. A `flush` call does not imply device durability. These APIs
do not claim rollback after process termination.

## Native work and bounds

`Frame.encodeImageAsync` now returns owned encoded bytes using
`zc_encode_stream_image_async`; the public Zig frame wrapper returns the existing
`ImageEncodeJob`. Local admission copies the selected stream under the request
operation/read gate. An exclusive writable map rejects admission. DNG calibration
is copied; local clock/model Exif provenance is resolved while its request is
owned, then passed to the worker as a copied explicit payload. No camera, frame,
map, fd or caller metadata pointer survives in the worker.

`CapturedImage.encodeAsync` and its saves use `zc_raster_encode_async`. Home's
checked pixel view validates bounds and compacts only logical rows into owned
storage, preserving gray/RGB/RGBA, 8/16-bit samples and word order. Padding is not
charged as copied input. Conversion/compression uses the same Home codecs and
allocator budget as asynchronous remote encoding. Input/output defaults are
64 MiB and working memory 128 MiB; each limit is 1 byte through 256 MiB.

All three sources share the existing Home admission registry: four owners and a
512 MiB input-plus-workspace reservation; byte limits may admit fewer than four.
The file-like job retains that reservation through writes/flush and joined
cancellation. Slow sinks therefore cannot release codec ownership and accumulate
unbounded pending output buffers. BUSY is a terminal admission error for frame,
remote and byte/file-like raster jobs. Retry after another job completes.

`CapturedImage.saveAsync(path)` preserves its existing 32 staged-file admission
bound. Those bounded saves retain their immutable private pixel/metadata snapshot
and wait cooperatively for native codec capacity, with cancellation and deadlines.
The image may close immediately; no borrowed camera buffer waits in this queue.
Native input copying occurs once capacity is admitted. Staged files preserve the
existing publication claim, inode checks and joined cleanup.

Encoding still builds a complete bounded result before output delivery. This is
chunked sink I/O, not an incremental codec stream or a zero-copy path. Native to
Bun result transfer temporarily duplicates encoded bytes; source storage, thread
stacks, allocator bookkeeping and application-retained chunks/results are outside
the native allocator budget. Codecs remain cooperative at codec-stage boundaries.

## Evidence and remaining work

Tests cover all 14 processed layouts and both streams against synchronous Home
bytes, raw DNG and an independent TIFF reader, standalone raster precision/alpha/
word order, independent Exif/ICC/pixel readers, early camera/remote/image closure,
partial progress, retained/transferred chunks, one active writer, joined write/
flush cancellation and deadlines, sink failures, quota reuse and bounded staged
admission waits. Independent C tests exercise raster bounds and local PNG/DNG jobs
after source closure; Zig tests cover compact raster ownership and public frames.

Local validation passes 450 target-qualified Zig 0.15.2 ReleaseSafe tests, all
1483 Bun tests with Home AVC/HEVC/AAC and independent image/media readers, six
independent C ABI/ownership executables, TypeScript and pinned Zig formatting.
The ordinary local build runner still fails macOS SDK/libSystem linkage before
project compilation; target-qualified tests are separate evidence. Linux real
libcamera build/load and no-camera discovery remain CI checks, not sensor tests.

The Picamera2 reference is source-reviewed at
5e2a35d3bb230825c98c56d98e01b41ddeb43e86 (`request.py` save/save_dng/helpers);
no reference Python is run. Camera/focus/temporary-mode sink jobs are added in
0.96 (`capture-outputs.md`). Additional file-like adapters and series, incremental codec
streaming, complete tag/thumbnail/advanced DNG semantics, allocator/GPU/device
integrations and physical acceptance remain open in `parity-plan.md`. This scoped
software capability does not establish full parity or physical Pi performance.
