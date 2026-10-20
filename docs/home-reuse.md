# Home reuse audit

zig-camera uses Home's bounded native primitives and media writers directly.
Verbatim modules retain MIT attribution in NOTICE. They compile with the camera's
pinned Zig 0.15.2; new helpers are also tested with Home's development compiler.
The former Python orchestration has been removed in 0.19; the native library and
Bun facade are the active implementation and test surfaces.

| Home source | Reuse and ownership |
| --- | --- |
| image native JPEG / DCT | Baseline JPEG and MJPEG; no application-side process |
| video native_encoder / rgb_i420 | Direct x264/x265 encode and explicit bounded RGB conversion |
| video mp4_stream / mjpeg_stream / av_stream | Streaming fragmented MP4, Matroska and PCM/AAC track metadata |
| audio native_aac / native_capture | Standalone FDK AAC and optional ALSA S16LE capture |
| video plane_pack | Checked padded RGB/I420 copies with explicit owned destination |
| video packet_ring | Fixed encoded byte/frame limits, GOP-safe eviction, delayed FIFO |
| video pcm_timeline | Fractional sample phase, independent cursors, owned snapshot windows |
| video packet_output | Stable bounded output slots, Annex B and exact PTS helpers |
| video recording_policy | Soft duration/byte thresholds that ignore empty or pending output |
| video output_recovery | Lifetime retry budget and capped backoff on supplied media clock |
| video factory_policy (new in 0.22) | Reserved asynchronous claims, stale-ticket protection and fresh indices |
| video owned_fifo | Owned output bytes/metadata, in-flight accounting and acknowledgement |
| async completion_gate / completion_watermark | Terminal completion and retained fixed-prefix I/O drains |
| async preparation_gate | Cooperative cancellation and serialized ready/publication boundary |
| video recording_path (new in 0.19) | Allocation-free indexed filenames, bounded padding/storage and strict field validation |
| video pts_clock (new in 0.21) | Exact integer source epochs for shared PTS across output replacement |
| video delivery_fifo (new in 0.20) | Sequence-checked host copy/ack, in-flight accounting and retained completion prefixes |

The new recording_path module was contributed to Home before being vendored
verbatim. Its tests cover index zero, the maximum u64, non-truncating padding,
insufficient destination capacity, malformed/multiple fields, NUL bytes and width
limits. Home's streaming A/V workflow includes it on x86_64/aarch64 with Zig 0.15.2
and development Zig. Exact source commits for all vendored modules are in NOTICE.

The 0.20 audit reused owned_fifo and preparation_gate rather than introducing a
second queue implementation in TypeScript. Home's new delivery_fifo composes
owned_fifo with monotonic delivery sequences, stale-ack rejection, sticky failure
and fixed-prefix completion. In-flight bytes/metadata retain capacity until
acknowledged. Its tests pass with both pinned Zig 0.15.2 and Home's development
compiler. The helper and workflow coverage were contributed to Home main at
51422a0c728730dae97f45b2e44ab0bff0253ee6 before verbatim camera reuse.

Async recording does not import Home's unrelated general task graph. Instead,
Zig workers build copied Home container/AAC recipes; caller-serialized publication
uses preparation_gate. File reservations outlive worker cleanup, and recovery
preserves stable IDs, delay capacity and lifetime retry policy while discarding
poisoned writers. One failed output cannot pin healthy outputs' PCM cursors.

Bun wraps additive ABI calls, bounds capture/tasks and uses workers for close,
snapshots and fixed-prefix drains. It does not implement or substitute codecs.
Linux independent decoders and native race tests validate these boundaries.
No FFmpeg, Libav, PyAV or Python implementation/test dependency is introduced.

The 0.21 audit retains Home packet_ring.cloneFrom, pcm_timeline.cloneWindow and
acknowledged delivery_fifo for custom pre-roll, rather than buffering borrowed
packets in TypeScript. The new pts_clock helper was contributed on Home main at
ffb6a26ad3983c13ebc20df8d768b439b272aea8 and vendored verbatim. Tests cover source
gaps, nanosecond epochs near u64 maximum, microsecond collisions and rejection
without state changes on both pinned and development Zig. Home's helper workflow
includes the module in its compiler/architecture matrix.

The 0.22 audit reuses packet_ring.cloneFrom and pcm_timeline.cloneWindow for
independent custom snapshots, and delivery_fifo for bounded, acknowledged replay.
The new factory_policy composes recording_policy and output_recovery instead of
moving scheduling, index ownership or retry budgets into TypeScript. Home's
Retry.observe now arms backoff when async construction completes without
consuming another attempt. Factory admission, pending claims, stale tickets,
positive-result rejection, failure latching, lifetime budgets and maximum-u64
index exhaustion are tested with pinned and development Zig. The helpers,
package export, documentation and compiler/architecture workflow coverage were
contributed to Home main at be777d256133638f6242dfdd7a7f2bd847882906 before verbatim
camera reuse. Bun holds application functions; Zig owns admission, media clocks,
queue storage, recipes, generation validation and keyframe publication.

The 0.23 audit keeps queue storage and accounting in Home delivery_fifo, extending
it with exact ownership snapshots, high-water marks and non-reserving byte/entry
headroom predicates. Home's new capacity_wait.Registry uses a fixed ticket array,
caller-supplied clock/capacity observations, immutable terminal outcomes, bounded
admission and nonwrapping identities. It supplies cancellation/closure accounting
and saturating elapsed-time counters without a second packet queue or thread.
Both modules pass focused tests with pinned Zig 0.15.2 and development Zig. The
Home package export, documentation and compiler/architecture workflow coverage
were pushed at 8451cabb28301c5f4ea1ef429122a0151dcbf4ba before verbatim camera reuse.
Bun contributes cooperative polling, parent/epoch cancellation and a bounded
cache of final reports; it does not duplicate the queue or wait policy.

The 0.24 audit reuses capacity_wait and delivery_fifo for producer-scoped timed
sends, rather than layering another encoded-packet queue over the host mailbox.
The new owned_admission helper bounds separately allocated input storage and
retained jobs, rejects stale releases, preserves live ownership on admission
failure and prevents identity wrap. Its focused tests pass with Zig 0.15.2 and
Home's development compiler. The package export, documentation and helper matrix
were pushed to Home main at a276dca96b958fec80b51220433b9d499c1c9b54 before verbatim
camera reuse. The camera-specific persistent worker owns encoder/recorder turns;
Bun coordinates hook retirement and lifecycle deferral without borrowing DMA
buffers or moving runtime callbacks to native threads.

The 0.25 audit extends owned_admission with pendingThrough(target), a bounded
cleanup-prefix scan that tolerates out-of-order releases and slot reuse. The
existing async completion_watermark deliberately assumes FIFO completions and
latches operation failures; producer input cleanup must also handle cancellation
holes and allow later inputs, so it uses the ownership registry instead. The
helper does not add threads, payload retention or completion-history allocation.
Home main commit 55852d43d52c745565176d0b3ed52ec1304ab1e9 contains the tested helper
and documented settlement semantics, copied verbatim here. Focused tests pass
with pinned Zig 0.15.2 and Home's development Zig. Camera code supplies retained
native drain handles, serialized cancellation/completion and safe codec-boundary
checkpoints; Bun only coordinates lifecycle polling and cancellation reasons.

The 0.26 audit keeps native delivery fences on Home completion_watermark and
uses delivery_fifo's acknowledged host prefixes. It adds Finalization to Home's
recording_policy: one irreversible codec/container entry, concurrent-entry
rejection, explicit media-acceptance state and immutable terminal success/failure.
Home main 3b4b323f3100e513e25e63c2e4679064238ef89b contains the helper, tests and
contract; the module is reused verbatim. Standalone tests pass on Zig 0.15.2 and
Home's development compiler. Existing workflow paths already include this module.
The camera supplies one bounded producer worker and retains at most nine native
sink fences per control job, while Bun combines published/retiring host epochs
without moving JavaScript callbacks onto native threads. Codec and AAC wrappers
remain the existing Home implementations; finalization prevents re-entering their
terminal flush loops during a later close.

The 0.27 audit extends Home recording_policy.Finalization with nextSession.
It prepares an open candidate after terminal success or failure without mutating
the old result, and rejects live/running owners and identity exhaustion. Pinned
and development Zig tests cover preparation, unchanged old results and repeated
session transitions. The helper and contract were pushed to Home main at
71f639d7f0f0109d053f0a6e4a46d184952158fc before verbatim camera reuse. Camera code
uses fresh Home codec/container/PCM/ring instances on its persistent worker;
it does not reset drained codec flags or concatenate finalized files. Producer
ownership, native I/O completion fences and host acknowledgement queues retain
their earlier bounded Home implementations across session publication.

The 0.28 audit adds Home core/session_config, pushed to Home main at
5d03fefdbc4728ec9479809d6058f3751ceab4e0 and reused verbatim. Its allocation-free
validator handles codec geometry, frame duration, quality/bitrate/GOP and enabled
PCM queue/AAC bitrate bounds before any candidate output hook or encoder setup.
Container/backend/AAC sampling-rate support remains with the existing Home
adapters. Focused tests pass on pinned Zig 0.15.2 and development Zig; the Home
packet-output workflow includes the helper. The camera uses the same video
validation for constructor and restart settings. Reconfiguration retains Home
Finalization's preparation/publication boundary and fresh native codec/container/
PCM instances. Candidate-specific callback validation checks the new media format
while descriptor identity checks still protect the previous session's outputs.
Bun snapshots media settings at admission and installs them only after native
publication; queue budgets and lifetime policies remain with the recorder.

The 0.29 audit extends session_config with withGeometry at Home main commit
79484d1a12ae9ab0b325474faebd2ad2a0cc3d3e and copies it verbatim. It resolves omitted
media dimensions from actual camera negotiation, checks explicit width/height
independently, validates the final codec shape, and preserves the proposal on
failure. Pinned and development Zig tests cover adaptive geometry, exact masks,
codec alignment and untouched rate-control/GOP fields. The camera exposes this
through an additive scalar C ABI; Bun reserves admission, joins the existing Home
finalization/producer worker, negotiates via the existing camera worker, prepares
fresh Home codecs/containers and publishes only after preview/output readiness.
The helper owns no native resources or locks. Existing Home queue, ownership,
codec, container and finalization implementations remain in use.

The 0.30 audit adds Home keyed_state.State(T, capacity), pushed to main at
6e1926728200f9e35470ecdeeb9f3a088589695d and reused verbatim. It stages sorted
fixed-capacity desired settings by nonzero ID, supports dependency removals before
explicit updates, bounds both input lists and preserves the source on rejection.
Zig 0.15.2 and development Zig tests cover replacement, removal, dependency
invalidation, invalid batches and capacity failure. The Home packet-output
workflow includes the helper. Camera core supplies control validation, transient
AF exclusions, AE alias policy, backend acceptance and logical revision mapping.
Bun mode workers copy the native snapshot and revalidate/replay it before every
start and rollback; Home owns no camera pointer, revision, thread or lock.

The 0.31 audit revisits Home's CompletionGate in packages/async. Home main commit
012ffc48852bb77d5527ae67c01dc5f8b1827eeb adds a monotonic observation watermark:
once a newer revision is seen, an older scan/result cannot advance the job, even
if it exceeds the original admission revision. Equal-revision transitions remain
valid; terminal outcomes remain immutable. The camera copies this helper verbatim
and exercises it through its native AF completion callback, including out-of-order
failure metadata. Home's standalone gate tests pass on pinned and development Zig.
Bun coordination keeps each AF job bound to its original handle, joins it before
mode transfer, and uses the same native Home gate for fresh target-mode scans.
Codec, container, queue and session helpers continue to come from Home.

The 0.32 audit extends Home CompletionGate with acknowledge(revision, outcome).
This single-phase path shares observe's monotonic watermark and immutable terminal
states, but accepts a direct acknowledgement without a scanning/active event.
Home main commit 5c80e5d184337b81fcf712286797b99c95fbc987 is copied verbatim.
Pinned/development Zig Debug and ReleaseSafe tests cover direct success/failure,
nonterminal newer observations, stale responses and terminal stop/cancellation.
Native CAF pause/resume uses this helper under the same callback mutex, with an
independent metadata validity bit. Existing Home codecs, containers, bounded
queues, persistent setting journal and finalization helpers remain in use.

The 0.33 audit contributes lease_pool.Pool(resources, references) to Home video,
pushed at f29a36b4a0be60c9b781dbf1358826a5359cb10b and copied verbatim. Fixed
reference tables issue a distinct generation-checked token for each retained
owner; resource lookup and release are constant time. Tests cover parent release,
slot reuse, stale/double releases, atomic capacity rejection, exhaustion and odd
capacity bounds on pinned/development Zig Debug and ReleaseSafe. The camera
serializes the helper under its existing locks, reserves primary-reference
capacity for other buffers, and performs DMA end/requeue only on final release.
Existing Home plane packing handles raw row copies and I420/RGB padding removal.
