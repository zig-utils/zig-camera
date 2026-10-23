# Parent-controlled process files

Version 0.94 adds `ProcessPool.submitToFile(frame, path, data?, options?)`. The
worker returns a nonempty `Uint8Array` of encoded bytes. The parent publishes
those bytes only after verifying both the matching result and frame ACK. The
path is resolved against the admission-time working directory and copied in the parent and is not added to the worker's arguments/context.

```ts
// Worker module:
export async function run(frame, imageOptions) {
  return await frame.encodeImageAsync(imageOptions)
}

// Parent (pool module points at that worker):
using frame = await camera.captureRequest()
await pool.submitToFile(frame, 'trail.jpeg', {
  format: 'jpeg', quality: 98, exif: { artist: 'Chris' },
})
```

The method returns a `BunJob<void>` and accepts the existing process submission
options: stream selection, writable export, cancellation, deadline and completion
callback. Child code selects the format; the parent treats bytes as opaque and
does not infer or convert a format from the path. Select `raw` for DNG. Configure
`maxResultBytes` and `maxPendingBytes` when opening the pool for large results;
the default serialized result limit is 4 MiB and includes serialization overhead.

No temporary is created before the result/ACK pair is verified. Child failure,
active cancellation, missing ACK or oversized/invalid result therefore cannot
publish through this API. Active cancellation still verifies peer exit before
retiring sent source ownership. Application code that writes files directly in
the child has separate side effects; this API cannot undo those writes.

Once result and ACK match, native camera ownership retires and the worker becomes
available for other tasks. The task's existing result/admission reservation stays
held through parent staging, publication and completion callbacks, so fixed-prefix
drains and pool close include that work. Cancellation/deadlines during parent
staging do not kill a worker already reused for another task. Publication claims
the irreversible decision before rename, and late cancellation can be refused.

## Native copied-byte staging

C `zc_image_file_prepare_bytes` copies 1 byte through 256 MiB before return and
uses the staged file's already-reserved native I/O thread. No caller byte pointer
survives admission. A shared Home admission registry limits copied staging to
512 MiB and 32 owners; reservations remain charged until joined close even after
the payload allocation is freed. The existing 32-file owner limit also applies.

Poll `zc_image_file_preparation_result`: TIMEOUT means pending, STATE means the
file was already released, and OK writes the preparation result code. Accepted
cancellation reports STALE when I/O otherwise succeeded; I/O errors retain their
code. Then finish
with publish/discard and join close using the existing file lifecycle. Preparation
failure still requires discard and close. Existing file-state ABI and result
semantics are unchanged. Zig exposes `StagedImageFile` with retryable close;
Bun uses the existing staged-file cancellation and inode identity checks.

The existing bounded process result channel carries the complete encoded result;
there is no new descriptor or packet version. This deliberately involves encoded
result copies, including a native staging copy, and uses the configured result
ceiling. Direct descriptor streaming and larger-result transports remain open.
Atomic publication is a namespace guarantee, not a claim of durability across
parent/host termination or power failure.

Tests cover all 14 processed layouts on main/lores with six image formats, DNG and
Exif independent readback, ACK omission after a serialized result, verified child
termination, parent-stage cancellation with worker reuse, late publication claims,
deadlines after source retirement, invalid/oversized results, I/O failures,
completion-held drains, native byte copies and C/Zig lifecycle wrappers. Full
Picamera2 parity and physical Pi acceptance remain open.

Local verification passes 448 target-qualified native ReleaseSafe tests, all
1,440 Bun tests with Home codecs/AAC, independent readers and SDL dummy, and five
independent C ABI/export/channel/process/encoded-staging executables. Pinned
formatting, TypeScript and workflow YAML checks pass. The normal local build
runner still fails SDK/libSystem linkage before project compilation; direct
builds pass and hosted platform/real-backend checks remain independent gates.
