# Asynchronous remote stills

Version 0.93 adds Bun `RemoteFrame.encodeImageAsync`, `saveAsync` and
`saveDngAsync`, plus C/Zig native image encoding jobs. They cover main/lores
JPEG, PNG, TIFF, BMP, PPM and GIF and calibrated raw DNG through Home codecs.

```ts
const job = remote.saveAsync('trail.jpeg', {
  quality: 98,
  maxInputBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxWorkingBytes: 128 * 1024 * 1024,
})
remote.close() // Admission already owns pixels and needed metadata.
// Low-level callers still acknowledge/retire their source export separately.
await job
```

Admission synchronously copies selected physical used bytes (including used row
padding), requested ICC/Exif and any metadata needed for request-derived Exif.
The worker owns no camera, lease, remote map, fd or caller metadata pointer.
Conversion, metadata generation, compression and file staging run on the native
worker. Owned encoded bytes and completed files outlive source closure. Bun owns
option snapshots before admission and rechecks private read permission after all
application accessors. Writable remote scopes reject admission.

`encodeImageAsync` accepts the synchronous image options, byte limits and ordinary
Bun job options. `saveAsync(path, options, stream)` preserves the existing main/
lores save signature and extension inference. `saveDngAsync(path, jobOptions)`
selects raw. JPEG still defaults to source-request Exif; PNG/TIFF opt in with
`exif: true`, and explicit fields override defaults. ICC interpretation checks
and RGB16 precision follow the synchronous encoders. These methods do not infer
values from the process pool's initialization camera.

## Bounds and ownership

Input/output defaults are 64 MiB, working memory 128 MiB. Each limit accepts
1 byte through 256 MiB. Input counts copied physical pixels, ICC, raw Exif and needed full
metadata. Working memory counts live allocator requests, including conversion,
metadata, encoded bytes and native zlib workspace. Native zlib uses the caller's
allocator with checked aligned allocation hooks and failure-safe partial cleanup.
An output ceiling can reject after compression; the working budget also applies
while the output is being built. Allocator denial reports NOMEM; input/output
limit violations report INVALID.

Four live jobs share a 512 MiB input-plus-working reservation (including owners);
byte limits can admit fewer than four. Completed handles stay charged until
close. Bounds cover owned payload and allocator requests, not thread stacks,
allocator bookkeeping, source storage or application-retained returned results.
C state reports input bytes, encoded output size, working peak and budget denials;
working/output telemetry is published only after the worker finishes.

C `zc_remote_frame_encode_async` accepts optional limits and an optional existing
staged-file owner. Poll state, optionally cancel, then take a byte result once or
finish the staged file. Keep that file alive until image-job close. Close returns
BUSY until the worker finishes, consumes only on success and joins before freeing
input/workspace. Zig `ImageEncodeJob` preserves that retryable ownership. Native
callers serialize API entries against close.

Cancellation is cooperative between codec stages; an active codec call completes
before cleanup joins. Bun remains responsive during native encoding. An accepted
cancellation/deadline suppresses file publication and joins job/file disposal
before terminal completion and callbacks. Native staged files retain inode checks
against substitution. Publication claims the irreversible decision before rename;
late cancellation can be refused. Existing destinations survive admission,
encoding, budget, cancellation and staging failures.

A process handler must await its image jobs before returning. Process termination
is an external boundary: files already published cannot be rolled back, and a
process killed while owning a named temporary may leave that temporary behind.
Parent-controlled cross-process publication is added in 0.94 (`process-files.md`)
and joined file-like destinations in 0.95 (`image-outputs.md`). Neither cooperative
job cleanup nor parent publication claims rollback after parent SIGKILL.

Software coverage includes all 14 processed layouts and 46 raw layouts, exact
synchronous/async bytes, independent DNG/Exif/ICC readback, early source retirement,
actual child processes, input/output/workspace denial, completion-held admission,
native result transfer, event-loop responsiveness, deadline/cancellation cleanup,
callbacks and accessor reentry. Full parity and physical Pi acceptance remain open.

Local validation passes 445 native ReleaseSafe tests with an explicit macOS 15
target and all 1,418 Bun tests with Home codecs/AAC, independent media readers and
SDL dummy. Independent C ABI/export/channel/process exec checks, TypeScript,
pinned formatting and workflow YAML validation pass. The normal local build
runner still fails macOS SDK/libSystem linkage before project compilation; its
failure is retained separately. Hosted platform, real-backend and Home/APNG
consumer checks remain independent publication gates.
