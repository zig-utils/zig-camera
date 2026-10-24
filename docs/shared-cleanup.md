# Shared mapping cleanup

Export and remote-frame close consume their public handle even on an I/O error.
Callers must retire borrowed views and stop using that handle. Failed shared
memory unmaps now retain the exact native mapping and original admission ticket
in a deferred owner. These slots share the existing limit of 32 exports and
32 remote frames, each registry capped at 512 MiB declared planes/catalog cost.
There is no unbounded fallback list or new cleanup allocation.

```ts
import { sharedCleanupState, drainSharedMappings } from '@zig-utils/camera'

// After closing and joining consumers, inspect deferred native cleanup.
const state = sharedCleanupState()
if (state.exports || state.remoteFrames) drainSharedMappings()
```

The state reports deferred exports, remote frames, owners claimed by another
drain, and retained admission bytes as bigint. Live caller-owned handles are
excluded. Zig exposes the same sharedCleanupState/drainSharedMappings functions;
C exposes zc_shared_cleanup_state_get and zc_shared_cleanup_drain. Each drain
attempts each of the 64 possible slots at most once. It reports IO for an
attempted cleanup failure and BUSY if owners remain, including a concurrent
drain. Correct the underlying error and call drain again; never retry a consumed
frame/export close. The state combines two separately locked registry snapshots;
new closes may add work at any time. It is not a session or camera fence.

Export writeback, source catalog close and camera map/lease retirement execute
once on logical close. Deferred drains only close independent physical mappings
and already-owned descriptors. A descriptor number is consumed on close even
when close reports an error, so it cannot accidentally be closed again after
the OS recycles it. Successful unmaps are also never repeated. Incoming metadata
maps belong to the remote owner immediately, including validation/setup failures.
Follow the existing ACK/join contract; after a failed remote close, finish its
shared cleanup before acknowledging an unmapped consumer to the sender.

Home's mapping helper is improved at a26569ce2ab717fa05446c7b1c1c9875771e0b84
and reused verbatim. An independent POSIX peer tests failed unmaps with real
live mappings, consumed close errors, descriptor reuse, partial export/receive
setup, catalog cleanup, exhausted admission and blocked concurrent drains.
The main CI runs it on Linux x86_64/ARM and macOS; the shared-helper matrix
compares the pinned Home source and tests Zig 0.15.2/master in all three safety
modes. These are hosted ownership tests, with no physical Pi or speedup claim.
