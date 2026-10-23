# Source-camera property snapshots

Version 0.97 adds `properties()` to Bun `Frame`, retained `FrameExport`,
`RemoteFrame` and scoped request callbacks. It returns the same owned typed catalog
shape as `Camera.properties()`. Actual process workers therefore read their source
camera properties independently of initialization context. The C and Zig APIs
provide exact owned catalogs or allocator-owned bytes.

```ts
using frame = await camera.captureRequest()
const properties = frame.properties()
const sensor = properties.records.find(record => record.name === 'PixelArraySize')
frame.release()
// The catalog and exact record/value bytes own their data after source closure.
```

Properties describe the backend's camera/sensor capability data: model, physical
pixel-array geometry and any vendor records. They are distinct from negotiated
main/lores geometry, startup hints and per-request applied controls/metadata.
Unknown native types, vendor strings, flags, array shapes, labels and opaque
payloads are retained without rebasing record IDs or coercing values.

## Snapshot policy and lifetime

Camera properties are cached lazily under the native session operation lock on
the first property or full request-metadata read. Later reads copy that immutable
session snapshot, avoiding another backend catalog walk. A replacement mode or
reconnected camera has its own cache. The cache is bounded by the existing 4 MiB
catalog limit and is freed only when camera close succeeds; BUSY/failed close
retains its owner. Allocation/backend failure before initialization allows retry.

This is a source-session property snapshot taken at catalog generation, not a
sensor-time sample of changing controls. The supported libcamera camera-property
list is session capability data; applied control results remain request metadata.
Callers need a live request to obtain `Frame.properties()`. Returned catalogs are
independent of the cache and caller mutation cannot change subsequent snapshots.

Full request metadata carries a copy of the source properties when built for
metadata/export. Retained exports and remote owners retain that exact copy through
the existing maps, ACK/verified-exit retirement and catalog lifetime. Selecting
only main still carries properties for the source camera; it grants no access to
unselected pixel streams. Metadata-only property reads remain available inside
exclusive source/remote write scopes. Closed wrappers reject subsequent calls;
previously returned values remain usable. Scoped callback views expire normally.

## C, Zig and transport

C `zc_frame_properties_catalog(camera, token, out)` returns an owned `zc_catalog`
closed with `zc_catalog_close`. Export/remote `*_properties_copy` support the
normal NULL/0 size query and caller-buffer copy. They reject short or overlapping
destinations before changing output. Invalid schemas have length zero; short
output still reports required size. Legacy metadata without the property record
returns UNSUPPORTED and length zero, and its pixel/configuration APIs remain usable.

Zig `Frame.properties()` returns `Catalog`; export/remote `properties(allocator)`
return allocator-owned exact HCAT bytes. Bun copies and decodes owned bytes; its
two-pass reader checks bounded, stable size and the properties catalog kind.

The existing HCAT metadata kind 4 gains one reserved read-only byte-array record:
vendor `zig-camera`, group `0x5a440000`, id 1, name `Properties.Catalog`. The payload
is the entire original HCAT properties catalog, kind 2. Its own header, identities,
order and value bytes are unchanged. Home's new generic `catalog_envelope` checks
the complete outer input and nested catalog, exact identity/value shape, kinds,
limits and uniqueness before borrowing/copying it. Duplicate identities, malformed
foreign tails and incompatible nested kinds fail explicitly.

The existing full-metadata/cached-descriptor channel and v1/v2 packet formats are
reused. No new descriptor channel or packet version is added. The property bytes
are included in existing request/export/process admission accounting. Combined
metadata, configuration and properties must still fit 4 MiB: a property catalog
which fits alone can fail an export when the combined snapshot exceeds that cap.
Such failure releases map/admission ownership and emits no truncated catalog.
The per-session property cache and caller-returned decoded copies are separate
from per-export admission, each with its existing owner/lifetime.

## Validation and remaining work

Coverage includes all 14 processed layouts, retained values after camera closure,
cache-copy isolation, exact source/export/remote equality, callback-scope expiry,
metadata reads inside exclusive writes, control/stream versus property separation,
36 reused actual-worker jobs with misleading initialization properties, stale old
remote wrappers, C exec/v1/v2 interoperation and legacy absence, malformed/short/
overlapping copies and combined-catalog quota failure with repeated reuse. Home
tests check exact opaque snapshots, malformed nested/foreign records, flags,
roles, duplicate identities, limits and atomic allocation-failure rollback.

Local validation passes 460 target-qualified Zig 0.15.2 ReleaseSafe tests, all
1568 Bun tests with Home AVC/HEVC/AAC, independent image/media readers and SDL
dummy preview, six independent C executables, TypeScript, pinned Zig formatting
and workflow parsing. The normal local build runner still fails macOS
SDK/libSystem linkage before project compilation; target-qualified tests are
separate evidence. Linux real-backend build/load and no-camera discovery remain
CI gates rather than physical sensor validation.

The reference remains Picamera2
5e2a35d3bb230825c98c56d98e01b41ddeb43e86 (`picamera2.py` configuration/property
refresh and `remote.py` request/fake-camera context), read without executing it.
This provides property snapshot capability
through Zig/Bun rather than executing reference Python. Full property-mapping
conveniences, persistent allocators/GPU integration, richer metadata and sensor-
specific behavior, output/recovery gaps and physical acceptance remain in
`parity-plan.md`. This does not establish complete parity or measured Pi speedups.
