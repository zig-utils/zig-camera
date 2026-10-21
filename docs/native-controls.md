# Native and vendor controls

Use Camera.controls() to obtain native IDs, portable kinds, supported ranges and
array shape. setNativeControls accepts one atomic batch of 1..256 controls with a
4 MiB encoded limit. These IDs differ from the convenience Control constants on
real devices. Select them from the current camera's catalog; names/vendor may be
supplied as identity assertions. appId and native enum-number hints are never
trusted for control identity, autofocus ownership or replay policy.

```ts
const controls = camera.controls().records
const windows = controls.find(r => r.name === 'AfWindows')!
camera.setNativeControls([
  { id: windows.id, kind: 'rectangle', value: [{ x: 100, y: 100, width: 400, height: 300 }] },
])
const snapshot = camera.nativeControlSnapshot()
await camera.switchMode({ width: 1920, height: 1080, role: 'video' })
```

Supported kinds are boolean, byte, int32, int64, float32, string, rectangle, size,
uint16, uint32 and point where the installed backend supports them. Use bigint
for int64, including every element of arrays. Exact i64 values never pass through
a JavaScript number or double. Scalars and arrays are distinct; empty/dynamic
arrays and values longer than the convenience API's sixteen numbers retain their
shape. Numbers must be finite and fit their primitive width. Strings use UTF-8;
geometry components use signed coordinates and unsigned sizes. Opaque/none writes
reject. Read-only controls reject where direction information is available.

The backend validates native identity, type, advertised bounds, choices and known
shape requirements before preparing a replacement pending/replay state. Newer
libcamera headers additionally validate input direction and declared array extent.
Older headers do not expose these declarations: camera map membership, ranges,
types and known convenience shapes are checked, without fabricating missing
capabilities. Driver/sensor-specific semantics still require hardware validation.

Zig stages an owned replacement journal and compatibility projection before the
backend commit. Invalid/duplicate/unsupported entries, allocation failure and
capacity rejection preserve the entire previous batch state and revision.
Successful requests advance one shared logical revision. Acceptance and request
metadata revision describe submission, not proof of physical sensor application.
Already queued requests and pipeline latency remain observable.

nativeControlSnapshot returns only persistent requests accepted through
setNativeControls. It is an owned typed catalog plus the current shared revision;
it is not an automatic sensor-state snapshot or a complete copy of settings
submitted solely through setControls. The existing controlSnapshot preserves its
convenience API contract. Representable known native values appear there too;
large integers, unsupported primitive kinds and long arrays are omitted rather
than rounded or truncated. The next convenience write to a known control removes
its native replay entry. AeEnable invalidates older exposure/gain mode aliases;
explicit aliases in the same batch still win regardless of argument order.

Persistent replay is the default. replay: false changes the current operating
request without replacing prior saved intent; stopping/restarting or reopening
resumes that prior intent. AF trigger and AF pause commands are always one-shot,
including when a caller forges snapshot identity hints. Native focus writes share
the AF job ownership guard and invalidate older focus-lock tokens. An explicitly
accepted continuous AfMode allows the existing pause/resume jobs and focus-locked
capture helpers. A transient mode affects operating AF intent until restart.

Mode jobs own both snapshots, filter duplicate convenience projections and replay
the remaining convenience values followed by the exact native values before
starting a replacement camera. They publish only after both passes succeed.
Target rejection closes the candidate and replays the complete old state during
rollback. Temporary captures and coordinated recording use the same path. Each
nonempty pass consumes a revision; mode admission reserves headroom for both
passes, rollback and AF work without wrapping. One-shot pause commands are not
restored across a mode change: a reopened continuous algorithm starts Running.

restoreNativeControls(snapshot) is for a fresh, never-started camera. It
revalidates native-only state against that camera and seeds revision continuity;
unsupported target values reject instead of being silently dropped. To manually
restore both APIs, restore the filtered convenience state first, then pass its
returned revision as the native snapshot revision. Automatic mode jobs already
perform this composition. Failed restore remains retryable; successful restore
and first start prohibit another restore.

C exposes zc_set_native_controls, zc_get_native_controls and
zc_restore_native_controls. Zig Camera exposes matching methods and owned Catalog
results. HCAT kind 6 carries updates, kind 5 persistent state, with exactly one
current value per native ID. The maximum is 256 records / 4 MiB; noReplay is record
flag 128. catalog_state from Home stages sorted, owned replacements before commit.
Catalog lifetime/copy rules are the same as [other snapshots](catalogs.md).

Tests use explicit synthetic vendor capabilities for exact integers, long arrays,
strings, all geometry types, read-only controls and retained metadata. They cover
atomic failures, replay/rollback, transient state, malformed/endian payloads,
forged one-shot snapshots, AF/recording ownership and bounded producer encoding.
Linux bridge tests exercise real libcamera value conversion and transactional
containers without requiring a camera. Pi focus, sensor control support and
timing remain part of hardware acceptance.
