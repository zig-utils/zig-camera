# Circular audio/video history

Recorder's circular options allocate bounded encoded bytes/frame slots and PCM
blocks. GOP eviction preserves a decodable leading key; snapshots select a key
with complete retained audio. Insufficient audio coverage fails explicitly.
History is non-consuming and remains available while capture continues.

snapshot(path) freezes owned encoded/PCM data under serialization and writes Home
containers/AAC on a Bun worker. At most two frozen snapshots exist. Independent
snapshot handles survive recorder close; cloned PCM preserves fractional sample
phase. Snapshot does not include an input still retained inside the video codec.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
