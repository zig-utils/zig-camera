# Request-owned configuration

Version 0.92 adds `configuration()` and `configurationCatalog()` to Bun `Frame`,
`FrameExport` and `RemoteFrame`, plus owned catalog APIs in Zig and C. Configuration
belongs to the source request's native session. A process pool's initialization
camera is descriptive startup context; reusing that pool for another camera or
mode does not change the request snapshot.

```ts
using frame = await camera.captureRequest()
const config = frame.configuration()
console.log(config.cameraId, config.streams.main?.format)
console.log(config.requested.width, config.streams.main?.width)
// Owns values after release, camera closure, or subsequent mode switches.
frame.release()
```

The frozen Bun value contains schema version, full camera ID, backend, negotiated
buffer count, queue policy, requested/actual orientation and adjustment/strictness,
sensor geometry/bit depth, initial configuration hints and all configured stream
layouts. Stream descriptions include width, height, stride, plane count, exact
format string, negotiated color space and physical allocated frame size (`bigint`,
sum of declared plane lengths). They contain no pointers, file descriptors or
pixel bytes. Sensor zeros mean the backend did not report a selected sensor mode.
An export selecting only main still describes configured raw and lores streams;
that does not grant access to their pixels.

`requested` records the native open recipe: base geometry/buffer count, camera
index, policy, exposure/frame duration/gain/lens hints, raw preferences, role,
noise reduction, sensor selection, lores/main formats and color preferences. These
are startup hints, **not applied runtime controls**. Use the frame's compact/full
metadata and control revision for actual per-request exposure, gain, focus and
other control results. Bun alignment helpers may already have changed the recipe
before native open. Negotiated stream geometry and orientation remain separate.

C `zc_frame_configuration_catalog` returns an owned `zc_catalog` closed with
`zc_catalog_close`. Export/remote `*_configuration_copy` use the normal size-query
then caller-buffer contract. Zig `Frame.configurationCatalog` returns `Catalog`;
export/remote methods return allocator-owned bytes. Bun catalog and friendly
values own their data independently of native lifetime. Calls through released or
closed wrappers fail; retained returned values remain usable. Metadata-only reads
also work inside a writable remote pixel scope.

## Transport and bounds

HCAT version 1 catalog kind 7 is configuration. Source metadata kind 4 also
contains the same records under vendor `zig-camera`, groups `0x5a430000` through
`0x5a43000c`, with `Config.` names. Group 0 holds identity/negotiated session
fields, group 1 the requested recipe; groups 10/11/12 describe main/raw/lores.
Absent streams omit their whole group. These groups are reserved for this schema.
Existing full typed metadata APIs expose the additional records.

Configuration is generated under the request lease/operation lock and accompanies
already owned full metadata through exports and processes. Home's allocation-free
catalog projection validates all source records and projects exact selected bytes
into caller storage, preserving unknown extensions and order. Projection has a
64 KiB ceiling within the existing 4 MiB full-catalog limit; short, malformed or
overlapping destinations are rejected before changing output. Existing accounting
includes the configuration bytes because it already charges the complete catalog.
No new fds, extra cached catalog or channel packet version are introduced. Channel
v1/v2 and ACK v1 remain unchanged. A legacy peer lacking this namespace returns
`ZC_UNSUPPORTED` and length zero for configuration; its image APIs remain usable.

The friendly decoder requires schema 1, exact field identities/types/directions,
scalar/array shapes, unique identities and complete configured stream records.
Unknown schema/enumerations fail explicitly; the catalog API preserves extensions
for applications that need exact records.

Software tests cover all 14 processed layouts, all eight orientations, retained
owned values, controls versus startup hints, partial stream exports, writable
metadata scopes, actual reused child processes across mode changes, malformed
schemas, bounded atomic projection and stale native ownership. Independent C
channel tests cover both packet versions. This does not establish physical sensor
negotiation, sustained Pi performance or complete Picamera2 parity.

Local validation: 435 native ReleaseSafe tests with the explicit macOS 15 target,
all 1,353 Bun tests with Home codecs/AAC, independent media readers and SDL dummy,
and independent C ABI/export/channel/process exec tests pass. The 27 focused Bun
configuration tests also verify joined stop before remote reads. Pinned formatting,
TypeScript and workflow YAML validation pass. The normal local `zig build test`
runner still fails macOS SDK/libSystem linkage before compiling project sources;
that failure is retained separately from the direct native pass. Linux real-backend
build/load and the Home projection consumer matrix remain independent CI gates.
