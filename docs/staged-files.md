# Temporary-mode file publication

Version 0.57 stages `switchModeAndCaptureFile` output until the temporary capture
has completed its request callbacks and the prior camera, controls, focus policy,
running state and preview have been restored. JPEG/PNG/BMP/TIFF/PPM/DNG and ICC
options use the same transaction. Existing synchronous frame/file APIs retain
their immediate atomic replacement behavior.

The mode worker encodes into a temporary file in the destination directory.
Native code owns the copied path, directory/file handles and temporary identity;
no encoded payload is copied into a Bun publication queue. The capture frame is
released before restoration. A separate native I/O worker then publishes or
discards the staged file and retires its resources. Its thread is reserved before
preparation starts, so failure to reserve a thread cannot leave a staged file
without a cleanup worker. Queued cancellation creates no file/thread. Active
file jobs remain bounded by existing mode admission and serialization.

Request pre/post callback errors, cancellation, expired deadlines, encoding
errors and camera/control/preview restoration errors prevent publication. The
prior destination is preserved and owned cleanup finishes before rejection.
The deadline is checked again after synchronous preview restoration, immediately
before publication. Native calls and synchronous callbacks cannot be forcibly
interrupted; cleanup can extend past a deadline.

Publication has an irreversible native claim. Before it, accepted cancellation
wins and the file is discarded. After it, `cancel()` returns false while the
rename result is pending; stop/close wait for the joined result. A rename failure
is reported as I/O failure and does not remove an existing destination directory
or its contents. Job progress 6 denotes file-publication I/O after mode-worker
progress 5. `operationDone` includes native disposal/join. Completion callbacks
(`signalFunction`) run afterward and can submit another file job; their errors
are recorded separately in `callbackError` and cannot undo the committed file.

Temporary identity is checked before publication/deletion. A replacement observed
at that temporary name is preserved and publication fails. Cleanup failures are
reported; if capture and cleanup both fail, an `AggregateError` preserves both
errors. Atomic rename is not an fsync/crash-durability guarantee. Process crashes
can leave orphan temporary files. Filesystem cleanup failures can also leave a
temporary on disk after handles have been retired.

The optional system-JPEG main-stream path still writes directly to the staged
file descriptor. Other encoders reuse the existing Home owned-byte encoders and
converters. No encoder, pixel converter, payload queue or media runtime is added.

## Native ownership

`zc_image_file_create` copies a destination and reserves the I/O thread without
file I/O. `zc_image_file_prepare` runs on the capture owner; other threads may
poll or cancel, but must retire that owner before finishing/closing the object.
It retains no frame or source camera. `zc_image_file_finish(output, 0)` disposes;
`finish(output, 1)` claims publication of a prepared file. Every created object
must be finished, even if preparation was never attempted.

`zc_image_file_state_get` returns a 32-byte state. `phase` uses Home's cooperative
preparation states; phase `PUBLISHED` means publication was claimed, not that
rename succeeded. `preparing` and `released` describe capture-owner activity and
I/O-worker release. Only `finished` plus `result`/`cleanup_code` and `committed`
establish the file outcome. `zc_image_file_close` joins a finished worker and
frees the object once; it returns BUSY while an owner or I/O job is active.
Callers serialize close against every other access. The header is the ABI contract.

Native tests cover claimed cross-thread cancellation, copied paths, camera/frame
teardown before publication, failed preparation/rename and changed temporary
identities. Bun tests cover all six formats, post-callback cancellation, deadline
expiry inside callbacks and preview restoration, restoration/worker failures,
late cancellation versus publication, camera close and completion re-entry.
Independent decoders check staged RGB/I420 processed images, including the
optional system-JPEG build. No physical camera/performance result is asserted.

Mode admission is checked again after option accessors run. Scheduling snapshots
read only job fields, so image/profile getters are not reread by a broad spread.
A getter that closes the camera or reenters scheduling cannot reserve an output
or overbook admission. Claimed operations also verify camera availability before
native lease queries and after waiting for autofocus ownership.
