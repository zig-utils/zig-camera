# Remote request image metadata

Version 0.91 adds `RemoteFrame.encodeImage(options)` and upgrades the existing
`save(path, options, stream = 'main')` to use the source request's capture Exif
and the shared Home ICC/Exif encoders. These work in low-level channels and in
`ProcessPool` handlers without accessing a live camera object in the child.

```ts
// Inside a ProcessModule handler; configure an adequate pool result reservation.
export function run(request) {
  const jpeg = request.encodeImage() // main JPEG, request-derived Exif by default
  const png = request.encodeImage({ format: 'png', stream: 'lores', exif: true })
  request.save('/photos/detail.tiff', { exif: true }, 'lores')
  return { jpeg, png }
}
```

`encodeImage` accepts existing `ImageOptions`: JPEG/PNG/BMP/TIFF/PPM/GIF from
main/lores, or DNG from raw, explicit quality/PNG compression/filter policies,
and copied ICC/Exif inputs. PNG/TIFF/PPM retain RGB16 word precision; JPEG/BMP/GIF use
the existing word-reduction and palette policies. Format, channel, transfer and
metadata policies match source-request encoding. `save` retains its 0.90 third
processed-stream argument and infers the format from the path when omitted.
Use `saveDng` for streaming raw files; generic encoded DNG is an owned blob.

JPEG gets capture Exif by default; `exif: false` disables it. PNG and TIFF need
explicit opt-in. Typed caller fields take precedence, including ISO/exposure,
model, timestamps/fractions/zones, GPS and thumbnails. Raw TIFF Exif follows the
existing explicit-byte policy. Unsupported format/metadata combinations reject.
A standalone image returned by `makeImage` keeps its existing explicit Exif
policy; request-derived defaults are supplied by these remote-request methods.

## Source values and missing fields

Selected dimensions, exposure and analogue gain come from the immutable remote
stream/scalar snapshot. Camera model comes from the existing request-time raw
metadata sidecar. Digital gain and `FrameWallClock` already travel in the full
HCAT metadata catalog, so no new wire packet/version, initial-camera lookup,
metadata copy file or Python interpretation is introduced.

The new Home scalar reader is reused verbatim. Remote capture policy selects
group 0/current values, output records and exact names. Accepted vendors are
`libcamera`, the explicit `synthetic` backend, and an empty vendor for older
libcamera headers without provenance. Foreign vendors, groups and advertised
array records are not substituted for these scalar controls. Exact f32 digital
gain and signed i64 wall-clock payloads use their declared byte order. Wrong
scalar types/shapes, unknown value flags and duplicate supported identities
reject capture metadata encoding. Missing fields remain missing; no digital gain
of 1 or arbitrary first record is invented. The fixed scalar metadata size and
HCAT metadata kind are checked before use.

ISO is derived only when both gains are available, finite and positive and their
product is representable. A positive request UTC wall-clock timestamp takes
precedence. Otherwise a known capture timestamp can use the existing bounded
host clock correlation: BOOTTIME on Linux, MONOTONIC for Darwin's simulator,
with realtime jump/window/future/overflow checks. Unknown capture time stays
absent rather than becoming encoding time. Saved time is generated separately.
Non-finite gains and unrepresentable timestamps do not become invented tags.
Explicit timestamp overrides do not acquire a guessed UTC zone or fraction.

Legacy v1 channel records retain their full metadata catalog but have no raw
model sidecar. Available gain/time metadata can still produce Exif; an absent
model stays absent. Legacy DNG calibration remains unsupported. Neither scalar
reading nor Exif serialization authenticates a hostile peer or proves physical
sensor calibration/clock accuracy.

## Ownership, limits and files

C exposes `zc_remote_frame_encode_image_metadata` and
`zc_remote_frame_save_image_metadata`; Zig provides `RemoteFrame.encodeImage`
and `saveImage`. C/Zig use an explicit `zc_image_exif` capture descriptor for
capture defaults. Existing structs, ABI version and ZCFD v2 layout are unchanged.

The native encoder borrows canonical RGB rows under the existing remote owner;
other processed layouts use one checked Home conversion. Saving no longer needs
the intermediate owned image object used by the 0.90 convenience. This removes
that unconditional pixel copy; no camera throughput or speedup is inferred.
Converted rasters and returned blobs each have a 256 MiB ceiling. Existing ICC,
Exif and format-specific metadata limits still apply. Metadata/profile bytes and
all getters are admitted before the native handle is rechecked. No public
`info()` override supplies internal permission or ownership decisions. The process
bootstrap captures the native remote close method before application import, so
handler instance/prototype overrides cannot replace retirement before ACK. A
regression retains overridden-close frames across 36 jobs, beyond the receiver
capacity, and verifies that old frames are closed and source references retire.

Copies/encoding/saves reject during a remote writable context. Encoding returns
owned bytes and does not retain another source reference. Calls are synchronous
on the invoking thread/process; low-level users serialize close and still retire
all remote maps before ACK. Native file saves encode privately, then atomically
replace the path. Validation or encoding failure preserves an existing file.
A successful child save is an external side effect and is not rolled back by
later process-job cancellation/failure. Abrupt peer loss can leave its private
atomic temporary file. Parent-coordinated publication, asynchronous remote
save/encoding jobs and general file-like outputs remain required work.

## Evidence and remaining scope

Eight Home tests pass pinned/development Zig in Debug/ReleaseSafe and both
compiler lines cross-link ARM64/x86-64 Linux tests. A new consumer CI matrix
runs that unchanged module on all three hosted platforms with both compilers.
Home's exact-commit Actions listing is unavailable; local and consumer evidence
must not be described as a completed upstream hosted run.

Camera passes 429 target-qualified ReleaseSafe native tests and 1,326 Bun tests
with independent image/AVC/HEVC/AAC/DNG readers and SDL enabled. New tests cover
all 14 main/lores processed layouts, byte-identical local/remote plain encodings,
request metadata after source release/stop, DNG preservation, independent libexif
and ICC readback, defaults/disable/overrides, getter-close and writer exclusion,
failed-file preservation and actual child saves/results. Native tests cover
exact UTC nanoseconds, legacy/foreign vendor filtering, big-endian fields,
duplicates, unavailable/array/non-finite values and public Zig/C owned blobs.
Independent C wire implementations exercise both legacy/new imports across exec.

The normal local build runner still fails macOS SDK/libSystem linkage before
project compilation; target-qualified tests pass. Exact-commit CI, including real
Linux backend compile/load/no-camera checks, remains a publication gate. Complete
Exif/tag/thumbnail semantics, remote configuration/property/allocator behavior,
async/file-like publication, physical metadata/DMA/A/V/optical acceptance and the
other families in parity-plan.md remain open. This does not complete the goal.
