# Tuning document utilities

The Zig/C/Bun data APIs cover Picamera2's load_tuning_file and find_tuning_algo
capabilities, with owned editing and save. They **do not apply tuning to the ISP**.
There is currently no CameraOptions.tuning. Native per-camera application and
reconfiguration semantics remain required for parity.

```ts
import { Camera } from '@zig-utils/camera'

using tuning = Camera.loadTuningFile('imx708.json', { platform: 'pisp' })
const autofocus = tuning.findAlgorithm('rpi.af') // owned ordinary JSON data
console.log(autofocus)
// Inspect/edit a selected existing algorithm, then save a separate file:
tuning.replaceAlgorithmJSON('rpi.af', tuning.algorithmJSON('rpi.af'))
tuning.save('/tmp/imx708-custom.json')
```

Pi 5 defaults to `pisp`; `vc4` is explicit. Search order is
`~/libcamera/src/ipa/rpi/<platform>/data`, `/usr/local/share/libcamera/ipa/rpi/<platform>`,
then `/usr/share/libcamera/ipa/rpi/<platform>`. Supply `directory` or up to 32
`directories` to replace the defaults. Absolute file names are read directly.
Missing paths and nonregular files skip; permission, corruption or size errors
from an existing candidate propagate without silently falling through. Regular
files are read through one descriptor, bounded before allocation, checked for
size/time changes and closed before a native document can be published. This
detects ordinary concurrent changes, not every possible adversarial rewrite.

`TuningDocument.parse(string | Uint8Array)` copies strict UTF-8 JSON;
`fromObject` snapshots plain JSON data. Both tuning layouts are supported:
version 1 uses root keys and version 2 an `algorithms` array of objects. Missing
version defaults to 1. Duplicate JSON keys reject; duplicate requested algorithm
names across version-2 entries reject as ambiguous. Missing algorithms report
ZC_UNSUPPORTED through CameraError. Numeric versions must equal exactly 1 or 2.

Bounds are 16 MiB, 262144 scanner tokens and 64 container levels. Names are
nonempty UTF-8 up to 256 bytes without NUL, paths up to 4096 bytes. Limits apply
to parsing and the complete edited document. Invalid edits preserve the original.
Unknown fields survive edits. `json()` preserves input whitespace until editing;
then JSON is compact. `algorithmJSON()` and `replaceAlgorithmJSON()` preserve
exact integer/decimal lexemes. `findAlgorithm()`/`toObject()` return copied ordinary
JavaScript values, whose Number precision limitations apply. Use the raw JSON
methods for lossless editing. Object input rejects unsafe integer Numbers,
nonfinite numbers, cycles, nonplain objects and other non-JSON data; it reads
selected getters once and does not call caller iterators or toJSON methods.

`save` creates a random exclusive 0600 file beside the destination, writes and
fsyncs it, closes it and renames it over the destination. It replaces a destination
symlink rather than following it. Failed staging retires only a matching owned
inode. Primary and cleanup failures are reported together; if ownership cannot be
established or unlink fails, cleanup may require caller action. This is atomic
publication, not a promise of power-loss durability (the parent is not fsynced).
Do not treat a writable hostile directory as a secure transaction boundary.
`close()`/Symbol.dispose release the native owner; closed documents reject access.

Zig exports `Tuning.Document` directly from Home. Its borrowed `algorithm` Value
must not be mutated or retained across edit/deinit; `algorithmJSON` is owned.
The additive C API exposes an opaque zc_tuning_document owner with open/version/
copy/find/replace/close. NULL output with zero capacity queries required byte
length, successful copies have no NUL terminator, and short copies leave the
destination unchanged. Calls serialize edits with a mutex; callers must coordinate
close with all calls. Parsing needs no camera and changes no process environment.

The libcamera Raspberry Pi IPA resolves its tuning configuration during manager
enumeration/IPA initialization. An environment override is process-wide; merely
setting it around Camera construction cannot safely define independent camera,
worker-reopen or concurrent-discovery semantics. Implementing that ownership and
restoration policy remains in scope. See upstream [IPA configuration lookup](https://github.com/raspberrypi/libcamera/blob/main/src/libcamera/ipa_proxy.cpp)
and [Raspberry Pi pipeline IPA initialization](https://github.com/raspberrypi/libcamera/blob/main/src/libcamera/pipeline/rpi/common/pipeline_base.cpp).

Native tests include exhaustive Home allocation-failure checks and atomic C
ownership/copies. Bun tests exercise data precision, search order, bounds,
transactional edits, file fault injection, symlink replacement, final close and
camera/environment independence. Pinned/master copied-source matrices cover
Linux x86/ARM and macOS. No physical sensor/ISP result or speedup is implied.
