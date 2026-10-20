# Selecting and retaining camera identity

Camera accepts either cameraIndex or cameraId. The ID is the exact backend string
returned by discovery, not a model name or an index converted to text:

```ts
const cameras = Camera.discover()
const camera = new Camera({ cameraId: cameras[0].id })
console.log(camera.cameraId) // full selected backend ID
await camera.switchMode({ width: 1920, height: 1080 })
console.log(camera.info().cameraId) // the same selected ID
await camera.close()
console.log(camera.cameraId) // owned identity remains available after close
```

The selectors are mutually exclusive, including cameraIndex: 0. IDs are nonempty
UTF-8, at most 4096 bytes, without embedded NULs. JavaScript strings with unpaired
surrogates reject before encoding. Matching is exact: no trimming, case folding,
prefix matching, normalization or fallback to a numeric/default camera. An absent
valid ID returns DEVICE. Invalid ID/selector arguments reject before acquisition.
An already acquired real device reports BUSY through the existing backend.

After the first successful open, Bun copies the full backend ID from native owned
storage, even for a camera initially selected by index. camera.cameraId is an owned
read-only getter and info().cameraId reports that full value. The fixed-width
zc_info.camera_id field remains for ABI v1 compatibility; do not use it to recover
long identities. The original requested selector remains in camera.options.

Every ordinary/temporary mode job, fresh target autofocus, coordinated recording
mode switch and rollback opens the pinned ID. Workers clear stale numeric indices
in their private configuration copy before calling the ID API. Mode admission
rejects a different ID/backend or a changed original numeric selector. ID-selected
cameras cannot switch to numeric selection. An explicitly repeated matching ID is
accepted. The ID is copied into worker messages; caller configuration mutation
cannot change the admitted identity. Controls, AF coordination, queue limits,
leases, preview restoration and recorder-session publication keep their existing
ownership rules.

If the pinned ID disappears, target open and rollback may both fail. The mode job
reports those errors and leaves no usable handle; it never opens a different
available index to hide the failure. Reconnect and construct a new Camera after
handling the error. Hardware disconnect recovery/watch jobs remain outstanding.
Backend IDs are opaque: their persistence across reconnects, bus changes and reboot
is determined by libcamera/the device, not by zig-camera. Matching the same backend
key does not prove immutable physical identity if that backend reuses keys.

The CLI accepts --camera-id ID in place of --camera N:

```sh
zig-camera list
zig-camera info --camera-id '/base/axi/pcie/...'
zig-camera capture --camera-id '/base/axi/pcie/...' --output trail.jpg
zig-camera info --simulate --camera-id synthetic
```

The actual real ID must come from list. Synthetic selection is the literal
synthetic and still requires the explicit simulation flag/build. Bad/ambiguous
selectors fail before capture/output creation.

The additive C API zc_open_id_pipeline accepts config, pipeline options, a byte
pointer and u32 byte length, and an out handle. The config's camera_index must be
zero; the ID determines selection. Failed opens set the out handle to null.
zc_get_camera_id(camera, null, 0, &length) queries exact UTF-8 byte length.
A subsequent copy requires sufficient capacity, appends no terminator and rejects
short buffers without writing a prefix. Copy before close if the caller needs to
keep the ID. Both native entry points preserve existing ABI v1 struct layouts.
Zig Camera.initId/initPipelineId and cameraId(allocator) expose the same behavior;
the returned byte slice belongs to the caller.

Home device_identity.Identity(4096) supplies owned validation, exact equality and
atomic bounded copies, reused verbatim at ec65db3bb34c885d9e2a24c4d7a243f7ab8c8801.
It owns no camera or thread. The real backend asks CameraManager.get for the exact
ID and holds the same manager lease used by index selection. Snapshot/catalog and
media/codec code continue to come from Home.

Tests cover discovery-to-open, strict selection/UTF-8 bounds, full IDs beyond the
legacy field, atomic short copies, configuration admission, queued/temporary modes,
AF, recording reconfiguration and rollback. Worker tests deliberately supply stale
numeric indices and verify ID-based target/rollback behavior and missing-ID failure
without fallback. Linux x86/ARM CI loads the real backend and checks missing-ID
selection; physical hotplug/reordering tests remain hardware acceptance work.
