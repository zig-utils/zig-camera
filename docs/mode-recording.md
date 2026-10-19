# Mode and recording semantics

The camera ABI rejects lifecycle destruction/restart with outstanding leases.
Select configuration in the Camera constructor; stop, release and close before
constructing another mode. Temporary mode-switch jobs from the retired facade
have not yet been ported to Bun. This is an explicit gap in feature coverage.

Recorder uses Home containers/codecs. startRecording shares the camera pump;
Recording.close detaches first and asynchronously drains the native recorder.
Preparing replacements uses bounded native jobs. See native-jobs.md for async
splits/rotation/recovery and cancellation. No frame is leased beyond encoding.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
