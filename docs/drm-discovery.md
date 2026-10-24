# Read-only DRM/KMS display discovery

Version 0.108 adds `listDrmDisplays({card?})`, the owned C catalog API and public
Zig `KmsDiscovery`/`KmsDiscoveryHost` helpers. Picamera2's pinned
`previews/drm_preview.py::list_devices` enumerates DRM connectors, modes and
compatible plane formats. This implements that discovery capability through
Home and native Linux UAPI queries. DRM scanout/preview, atomic plane ownership,
buffer imports/lifetimes and physical display acceptance remain unimplemented.
This release does not complete the preview family or the overall parity goal.

```ts
import { listDrmDisplays } from '@zig-utils/camera'
const catalog = listDrmDisplays() // Linux; card0..card63
for (const display of catalog.displays) {
  console.log(display.card, display.name, display.status,
    display.activeMode ?? display.defaultMode,
    display.formats.map(format => format.processedFormat ?? format.name))
}
console.log(catalog.issues) // permission/query/race/limit diagnostics stay visible
```

The synchronous call opens temporary read-only/nonblocking/CLOEXEC DRM card
descriptors. It enables only this client's atomic/universal query visibility,
never acquires master, forces connector probes, modesets, imports buffers or maps
device memory. All descriptors and native snapshot storage close before Bun
returns frozen objects. No libdrm runtime or media dependency is added. Linux
driver queries can block; fixed cardinality limits are not a wall-clock deadline.
Other platforms throw unsupported. An exact `card` path has 1..63 UTF-8 bytes;
the path/options are validated and read once before native admission.

Each record retains raw connector/type/instance and current CRTC identities,
connected/disconnected/unknown state, active geometry, cached preferred/default
geometry when connected, physical millimeters, compatible CRTC IDs and compatible
plane-format unions. Active and default geometry are separate. Format records
preserve numeric FOURCC, printable code/hex name and endian flag; recognized
camera formats use Home's shared mapping. Unknown codes survive unchanged.
Atomic/universal flags report client-capability acceptance. They do not reserve
an unused plane or prove buffer modifier, stride, color, scaling or scanout
acceptance. These [KMS identifiers and masks](https://www.kernel.org/doc/html/latest/gpu/drm-uapi.html)
must be revalidated by a future renderer.

Auto discovery scans 64 card paths. Absent automatic nodes are normal. An exact
absent path or any other card error produces an explicit issue with stage, reason
and original errno. Limits are 256 displays, 64 connectors, 32 CRTCs, 128 encoders,
planes and modes (modes per connector), and 256 format values per display. Fixed
buffers are supplied to kernel ioctls; returned counts are checked before reads.
A query failure/limit or inconsistent object reference discards all records for
that card while preserving independent cards. Resource and plane ID lists are
read again to detect obvious hotplug changes. There are no retry loops.
Multiple ioctls cannot form an atomic hardware snapshot; connection/mode/property
changes can still race collection. The result is discovery, not a display lease.

The C owner API has four slots sharing 8 MiB and no waiting queue. Every owner
must close; index errors return zeroed output records. Source-independent Bun
objects survive owner closure. C and Zig consumers have the same limits and
diagnostics. Zig callers own storage for `KmsDiscovery.Result` and can use the
injected collector for another query transport.

Tests exercise failure at every query stage, FD zero, descriptor joining,
permission/absent nodes, unknown formats, CRTC-index masks, distinct active/default
modes, card rollback on late failures and topology races, bounded format unions,
and shared native owner saturation. Linux CI uses an independent C UAPI peer
with system libdrm headers to drive the actual ioctl adapter through successful
catalogs, rejected capabilities, oversized counts, missing encoders, query errors
and changed IDs, while verifying read-only flags, FD retirement and absence of
display-mutating ioctls. The peer virtualizes one exact fixture path in an
isolated Bun process; it does not simulate hardware acceptance. Real `/dev/null`
and missing-path tests cover native failures. Portable policy tests run both Zig
versions in Debug/ReleaseSafe on all three CI platforms; the native ABI remains
pinned to 0.15.2.
