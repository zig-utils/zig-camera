# Full source model in still metadata

Version 0.98 selects the complete current Model string from the source camera's
property snapshot for automatic Exif and calibrated DNG. This applies to leased
frames, synchronous and copied async image/file jobs, capture/focus/mode jobs,
exports, remote frames and process workers. It does not expand the fixed raw
metadata ABI or change descriptor wire versions, file descriptors or ownership.
`rawMetadata().model` remains the legacy fixed-width field; `properties()` exposes
the complete source string.

Home's strict borrowed HCAT string reader checks group/name/vendor/role, exact
kind/count/flags, UTF-8 and duplicates before success. The camera accepts Model
from libcamera, synthetic or explicitly legacy empty-vendor properties, group 0,
current value. Old libcamera property IDs may lack direction/vendor flags; the
validated properties catalog kind supplies their namespace. Unrelated vendors or
groups cannot substitute a model. Embedded NUL, malformed or ambiguous advertised
models reject instead of silently truncating or taking an arbitrary first value.

A missing or empty Model falls back to the legacy raw model, then the full source
camera identity when available. Remote identity comes from the existing owned
Config.CameraId snapshot. A legacy peer without either snapshot can only supply
its legacy raw model; the receiver does not invent the missing full name.

Automatic Exif Model remains ASCII-only: non-ASCII source names omit that generated
tag. Explicit valid typed/raw Exif fields retain precedence; an explicit Model
suppresses generating the source tag, including when the source name exceeds
JPEG's Exif segment limit. PNG/TIFF can retain longer Exif within the existing
16 MiB Home bound. A JPEG without an applicable override rejects oversized Exif
before publication. No truncation or character transliteration is performed.

DNG Model and UniqueCameraModel both retain the entire NUL-terminated ASCII name.
The directory now uses bounded allocator storage sized for two complete names
plus fixed tags/alignment, rather than truncating into a 256-byte scratch field
inside a fixed 4096-byte directory. Model size is limited by the 4 MiB property
catalog policy. Embedded NUL/non-ASCII DNG names reject; no UTF-8 is mislabeled as
ASCII or fabricated calibration identity substituted. Adobe's SDK reads both
UniqueCameraModel as ASCII and LocalizedCameraModel separately; see its
[source parser](https://android.googlesource.com/platform/external/dng_sdk/+/de700ad461e35af50b28b861943a0b0753b10929/source/dng_shared.cpp).
LocalizedCameraModel generation remains separate future work.

The directory, row scratch and checked classic-TIFF strip offsets are prepared
before the first sink write. Atomic saves preserve an existing destination on
invalid model/allocation failure. Async DNG admission copies and charges the full
model against maxInputBytes; the directory is charged against maxWorkingBytes.
No worker retains a camera, remote owner, property cache or borrowed model slice.
The existing four-owner and aggregate working/input limits, cancellation, joined
close and output gates remain in force.

Native tests cover complete 88,000-byte source names, byte-exact local/remote DNG
results after source closure/cache mutation, atomic rejection, exact input-budget
boundaries, inline TIFF terminators, allocation failures before any output, legacy
fallback, wrong provenance, malformed/duplicate models, and Exif override/size
policy. Bun checks local/remote async Bayer and monochrome results after source
retirement; independent libtiff reads verify both model tags and pixel samples,
and independent Exif readers verify generated PNG/TIFF model tags. These are
synthetic/software checks. Physical sensor identity/calibration, color quality,
performance and complete Picamera2/DNG metadata parity remain unverified/open.

Local validation for 0.98 passes 471 ReleaseSafe native tests, 1,570 Bun tests
with Home AVC/HEVC/AAC, SDL dummy preview and independent media readers, all six
C ownership/ABI executables, TypeScript checking and Zig formatting. The shared
reader's 12 tests pass both local compiler versions in Debug and ReleaseSafe.
An initial run concurrent with compiler/host load timed out in child-process
startup and cascaded shared-state failures; the complete serial run passes the
unchanged test assertions and default framework deadlines. Failure logs are
retained separately. The ordinary local Zig build runner still fails before
project compilation at macOS SDK/libSystem linkage; target-qualified direct native
checks pass. Standard builds and real Linux no-camera checks remain CI evidence.
