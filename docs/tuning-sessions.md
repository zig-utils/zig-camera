# Manager-lifetime ISP tuning

Version 0.65 applies owned Raspberry Pi tuning snapshots before real libcamera
manager startup. The Raspberry Pi IPA then consumes its tuning-file override;
other pipelines need not use that key. This implements application and lifetime
policy, not proof of sensor acceptance or improved image quality.

```ts
import { Camera, getTuningState } from '@zig-utils/camera'

using tuning = Camera.loadTuningFile('imx708.json', { platform: 'pisp' })
const camera = new Camera({ tuning, width: 1920, height: 1080 })
try {
  camera.start()
  await camera.switchModeAndCaptureFile({ width: 4608, height: 2592 }, '/tmp/still.jpg')
  console.log(getTuningState())
} finally {
  await camera.close()
}
```

`CameraOptions.tuning` accepts a TuningDocument or strict JSON string. File paths
must first go through loadTuningFile. Input is copied before open and remains
independent of document edits/close. Both tuning layouts and existing byte/token/
depth budgets use Home's lossless editor. JSON validation does not validate a
sensor's algorithm parameters; IPA initialization reports backend rejection.

libcamera has one manager per process and resolves IPA configuration while
enumerating devices. Its override is process-wide. The native policy therefore
holds one immutable profile per backend. Byte-identical snapshots share; different
snapshots reject BUSY, including different whitespace/spelling. Acquiring a new
explicit profile while a default manager is live also rejects BUSY. Ordinary
opens/discovery inherit an already reserved profile. Applications needing
different concurrent tuning profiles require separate process ownership.

Camera owns a tuning reservation until joined close. The reservation survives
worker close/open gaps, target failure, cancellation, recording/group mode jobs
and rollback. Modes retain the constructor profile; an explicitly different mode
profile rejects before work starts. To change it, close the camera and other
manager/profile users, then construct a new camera. Explicit
`TuningSession.open(tuning, {simulate: false})` can reserve the policy before
discovery or across several Camera lifetimes. Close it after its last use.
Zig exposes TuningSession.init/close and tuningState; C has opaque
zc_tuning_session open/close and zc_get_tuning_state/zc_tuning_cleanup.

The real reservation owns one exclusive random 0600 JSON file under `/tmp`, its
descriptor, inode identity and exact bytes. The path is verified before startup.
The override is set before the first manager user and held until the manager is
destroyed after its last user. Startup exceptions/failures balance that lease.
Home's POSIX override captures the previous value, distinguishing absent/empty,
and restores it without further Zig allocations. A different external value is preserved and
reported instead of overwritten. The file stays owned until both manager and
reservation counts reach zero. Cleanup never removes a replacement inode.

Callers must serialize other use of LIBCAMERA_RPI_TUNING_FILE while the manager
is active. No library can make unrelated environment writers cooperate; a same-
value external write is indistinguishable from the owned override. This is a
shared manager policy, not per-thread environment isolation or a hostile `/tmp`
transaction guarantee. No Bun process.env mutation is used.

`getTuningState({simulate})` returns an immutable observation: custom profile,
manager/session users, exact byte length, manager generation, environment-active,
external-change and cleanup status. Manager users include discovery leases;
generation counts startup attempts, not verified sensor applications.
`environmentActive` means this policy still owns an override/restoration duty.
It is always false for synthetic capture, which never changes the environment.

Failed close retains its session for retry. Camera.close also retains that owner
and can be retried. If construction fails and session cleanup fails too,
TuningCleanupError reports both errors and exposes `.session` for retry.
If an inherited manager was the last owner and shutdown cleanup fails, the
bounded global owner stays visible; `cleanupTuning` retries after manager users
reach zero. Never abandon a failed close or interpret pending cleanup as success.

Native tests cover policy conflicts, owned files, absent/empty/external environment
values, staging/stat/write/unlink/restoration failures and retained retry owners.
Home independently tests allocation-failure atomicity and lossless environment
values. Bun tests cover copied options, mode/recording/group jobs, callbacks,
cancellation and leased-frame close retries. Linux x86/ARM smoke tests exercise
the actual C++ manager startup/discovery/failed-open path without a camera.
Physical Pi IPA initialization, tuning-specific optics and hotplug behavior still
require hardware acceptance; no throughput or quality gain is claimed.
