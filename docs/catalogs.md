# Discovery, capabilities and full request metadata

Camera.discover() lists real libcamera devices without acquiring, configuring or
starting a camera. It returns an owned descriptor array with index, stable backend
ID and typed property records. No cameras is a successful empty array. A build
without libcamera rejects UNSUPPORTED; use Camera.discover({ simulate: true }) to
explicitly inspect the virtual device. The virtual discovery snapshot is available
in either build, but streaming a virtual camera still requires a synthetic build.
No fallback from a missing real camera to synthetic data occurs.

```ts
const cameras = Camera.discover()
for (const camera of cameras) console.log(camera.index, camera.id, camera.properties)
const camera = new Camera({ cameraIndex: cameras[0].index })
const advertised = camera.controls()
const properties = camera.properties()
using request = await camera.captureRequest()
const full = request.metadataCatalog()
console.log(full.records.find((r) => r.name === 'SensorTimestamp')?.values)
```

Discovery indices describe the current manager snapshot and may change after
hotplug; persistent selection by ID is not yet implemented. The CLI command
`zig-camera list` prints index and ID without opening a camera; `list --simulate`
selects virtual discovery. Enumeration/queries are synchronous, may start the
manager and allocate, and belong outside latency-sensitive capture callbacks.
All open cameras and discovery calls in this library share one libcamera manager;
leases serialize its startup/shutdown. It stops after the last consumer releases
its camera references. Discovery never acquires cameras or changes a live mode.
Hotplug notifications/watch jobs remain unimplemented.

properties()/controls()/metadataCatalog() return TypedCatalog with kind and a
sorted owned array of CatalogRecord. Full libcamera properties and request
metadata retain every entry; the controls catalog retains all advertised controls,
including vendor controls outside zig-camera's convenience set. Names come from
the backend ID map; absent mappings use #nativeId. Each record includes native ID,
native type number, portable kind, group, optional appId, flags and typed values.
An appId is an existing convenience Control ID when recognized, otherwise zero.
Discovery groups are camera indices and include a synthetic CameraId record with
ID zero. Keep records as a sequence; that synthetic ID is not a native property.

Value roles are current, minimum, maximum, default, choice and enumerator.
Enumerators carry symbolic labels where the libcamera headers expose them; their
presence does not assert that every enum value is allowed on this device. Choices
are the device's advertised ControlInfo values. Empty/no-default values retain the
none type. Each value contains kind, nativeType, isArray, count, littleEndian,
label, owned exact bytes, and decoded value. Integer64 decodes to bigint; floats
preserve f32 bits in bytes, including NaNs. Rectangles use signed x/y and unsigned
width/height; sizes/points preserve those component types. Arrays preserve all
elements and shape metadata, including empty arrays; strings decode to text while
retaining exact bytes. Unknown native types use opaque kind with untouched raw
bytes/count. Native type numbering can change with libcamera versions: use the
portable kind to interpret data, not a hardcoded libcamera enum number.

Newer headers advertise vendor, input/output direction, declared array extent and
enumerator support. Older headers lack some of these APIs; the corresponding
properties are undefined instead of fabricated. Dynamic extent is null, fixed
extent is a number, scalar extent is zero. Input/output flags describe libcamera's
native declaration, not whether zig-camera currently exposes a setter. Existing
setControls still accepts its bounded convenience IDs/types; generic native/vendor
control writes and full typed persistent replay remain outstanding work.

metadataCatalog snapshots a leased request's native metadata on the consumer
thread, including arrays/tensors and fields absent from compact metadata(). It
can be used on an independent retained request and after stop. The snapshot owns
its data and survives frame release, mode changes and camera close. Reading a
released request fails. Compact metadata() remains the source for zig-camera's
logical control revision/event ID; those application fields are not invented in
the backend metadata catalog. The virtual backend stores metadata per request and
adds a clearly named SyntheticOpaque fixture to exercise unknown payload handling.
Its capabilities are test data, not claims about Raspberry Pi hardware.

Native snapshots are immutable and bounded to 4 MiB, with explicit BUSY on capacity
exhaustion and NOMEM on allocation failure. Nothing is silently truncated. The
caller owns zc_catalog_close. zc_catalog_copy(null, 0, &length) queries the exact
size; a short buffer rejects without writing any bytes. Failed snapshot creation
sets the out handle to null. C APIs are additive to ABI v1: zc_discover,
zc_camera_properties, zc_camera_controls, zc_frame_metadata_catalog,
zc_catalog_copy and zc_catalog_close. Zig discover/Camera.properties/controls and
Frame.metadataCatalog return owned Catalog handles; Catalog.copy(allocator)
returns owned bytes for catalog_format.Reader. A Reader borrows unchanged source
bytes and may not outlive them. Catalog.deinit is idempotent for that handle.

Bun copies native bytes and closes the native handle even on copy/decode error.
Record/array objects are frozen; Uint8Array payloads remain caller-owned mutable
bytes. Mutation cannot alter the native request or another snapshot. Queries on a
camera being closed or switched reject through the existing admission guards.
Native frame queries serialize with release to protect request metadata. Snapshot
serialization never runs inside the camera-manager completion callback.

The HCAT v1 framing and validation come verbatim from Home typed_catalog at
f313dc5a6b0472b7f6837fd314f7ef5575c546b9. See Home's typed-catalog documentation for
header/value layout. Application catalog kinds are discovery=1, properties=2,
controls=3, metadata=4. Record flags: input=1, output=2, array=4, directionKnown=8,
extentKnown=16, vendorKnown=32, enumeratorsKnown=64. Value flags: array=1,
littleEndian=2. Roles: current=0, minimum=1, maximum=2, default=3, choice=4,
enumerator=5. All wire headers are little-endian, independent of payload byte order.

Native, C and Bun tests cover explicit discovery, exact i64, all portable types,
geometry/arrays/opaque data, malformed inputs, retained/stopped request stability,
mode changes, source close, short-copy atomicity and cleanup on failure. Linux
x86/ARM CI builds/loads the real bridge and performs repeated no-camera discovery;
actual camera properties/metadata and hotplug still require hardware acceptance.

The manager lifetime rule and thread-safe camera enumeration follow the
[libcamera CameraManager implementation](https://github.com/raspberrypi/libcamera/blob/main/src/libcamera/camera_manager.cpp).
The portable value mapping is independent of the
[backend control enum](https://github.com/raspberrypi/libcamera/blob/main/include/libcamera/controls.h).
