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

The 0.34 audit extends Home lease_pool with retainReserved(token, freeEntries),
published at 29f568c7a8e724b15da671de65fe097730a5dc7d and copied verbatim. This
moves primary-producer reference reservation into Home's atomic retain operation.
Tests prove reserved entries remain usable by other physical resources, oversized
reservations reject without mutation, zero reservation matches retain, and
sequence exhaustion preserves live ownership on pinned/development Zig Debug and
ReleaseSafe. Camera core supplies the reservation under its existing locks.
Focus-locked Bun requests transfer the pump's primary owner without an extra
reference allocation; that owner remains private until CAF restoration succeeds,
and cancellation/failure releases it. AF acknowledgement continues to use Home
CompletionGate; codecs/containers and bounded media queues remain Home-based.

The 0.35 audit checks Home JSON/serialization helpers and contributes
video/core/typed_catalog.zig at f313dc5a6b0472b7f6837fd314f7ef5575c546b9, copied
verbatim. The bounded wire format preserves original primitive widths, exact i64,
arrays, geometry, symbolic labels and opaque native payloads without passing them
through floating-point JSON numbers. Header/native type numbering are separate.
Pinned/development Zig Debug/ReleaseSafe tests cover allocation failures, atomic
capacity rejection, typed/opaque data, every truncation and corrupted fields.
Camera Zig owns immutable snapshots, consumer-side serialization and handle
cleanup; the system C++ bridge only traverses libcamera values and borrows them to
Zig callbacks. Bun validates lengths/counts and decodes bigint/arrays/geometry with
owned raw bytes. Home packet-output CI includes the helper. Existing Home lease,
queue, codec, container and completion helpers continue to supply capture/media.

The 0.36 audit contributes device_identity.Identity(capacity) to Home video at
ec65db3bb34c885d9e2a24c4d7a243f7ab8c8801 and copies it verbatim. It owns a bounded
UTF-8 backend key, rejects malformed/empty/NUL/oversized input, matches byte-exact
identities without normalization, and rejects short copies atomically. Pinned and
development Zig Debug/ReleaseSafe tests cover ownership, Unicode byte bounds and
strict matching. Camera core copies the actual selected ID once after acquisition;
Bun workers use it for target and rollback opens regardless of stale enumeration
indices. Home owns no camera-manager lease or thread. Existing Home control journals,
AF gates, catalog, media queues, codecs and containers remain in use.

The 0.37 audit reuses typed_catalog and keyed_state and contributes
video/core/catalog_state.zig to Home at 1122b859f9bdb72c0e522f73ff134f836f53ff12,
with additional invalid-key coverage at b5ff735d009f3b56c78bc060fdaacf10654480e0.
The latter source is copied verbatim. It stages sorted bounded replacements with
exact payload ownership, duplicate/key validation and removals before explicit
updates, leaving inputs unchanged on allocation/capacity failure. Focused tests
pass on pinned and development Zig in Debug/ReleaseSafe; Home's packet-output
matrix includes the helper. Camera Zig owns both replay journals and commits only
after backend validation and journal preparation succeed. The C++ bridge owns
libcamera candidate values; Bun handles typed input encoding and bounded mode
orchestration without substituting a second journal, codec or media queue.

The 0.38 audit checks Home's PTS clock and completion helpers, then contributes
video/core/frame_barrier.zig at 691fd4f5cfef4fd3b7da11342b2c066a50f33471, copied
verbatim. Capture selection is distinct from a PTS rebasing clock or submitted-I/O
watermark: it counts unique completion identities, skips configured requests and
compares a matching clock threshold with an optional saturated exposure guard.
The allocation-free helper retains no frame and owns no thread. Pinned/development
Zig Debug/ReleaseSafe tests cover exact boundaries, duplicate/out-of-order events,
missing timing without mutation, maximum counters and immutable acceptance; the
Home helper workflow includes source/doc triggers and its test. Camera Zig owns
ABI state, metadata validity and leases; Bun composes capture/CAF jobs and leaves
rejected-frame recording/preview delivery on the shared pump. Existing Home
codecs, containers, queues and retained-reference pools remain unchanged.

The 0.39 audit reuses lease_pool for map owners and contributes
video/core/frame_access.zig at 1e4274a587635602b9b76a5edbacd4fa2557e01a, copied
verbatim. Its pure staged gates permit shared readers and require a sole external
owner for writes. Stale modes, exhausted counters and conflicting access reject
without mutation on pinned/development Zig Debug/ReleaseSafe. The Home helper
matrix includes source/doc triggers and tests. Camera Zig owns native map handles,
retained references and publication; C++ handles mmap permissions and matched DMA
read/write fences. Bun owns no pixel copy for mapped streams and detaches scoped
views before native retirement. Existing Home plane packing remains the explicit
owned-copy path; codecs/containers and capture queues continue to reuse Home.

The 0.40 audit reuses Home lease_pool, frame_access and preparation/completion gates
without adding a second frame queue or a generic task graph. The native worker's
primary reference pins every callback handoff; scoped mappings retain their own
reserved, generation-checked owners and enforce exclusive writes. Bun expires
borrowed request views, retires maps before encode/worker progress and retains any
failed cleanup owners for retry. One private atomic ticket per mode worker
serializes main-thread callback access without running JavaScript on manager or
codec threads. Mode hooks use the existing typed native-control journal and
reserve restoration headroom. Home source/provenance remains the existing verbatim
modules in NOTICE; no codec/container implementation is duplicated or changed.

The 0.41 audit extends Home's async completion gate with `acceptsResult`, published
at 795a5d6c29448362cc738394d7bbd1b4f61a267e and copied verbatim. Successful
acknowledgement now fences buffered result revisions as well as completion events;
a result predating the observation cannot satisfy a focus-locked capture. Home
tests cover pending/unsuccessful states, newer observations, immutable terminal
states and the maximum revision on pinned/development Zig Debug/ReleaseSafe.
Camera validates leases and pause/focus metadata under the existing session lock.
Bun composes bounded cancellation restoration with the same native gate rather
than adding a second AF scheduler. Lease pools, media codecs and containers remain
the existing Home implementations. No camera hardware focus evidence is inferred
from these synthetic state/ownership checks.

The 0.42 audit inspected Home image/ops/transform.zig and video transform filters.
Their owned Image/VideoFrame operations are unsuitable for a libcamera buffer
configuration boundary. It contributes image/ops/orientation.zig at
0f75b12b4aa8f63780ed1adaccd03f1760919557, copied verbatim and exported by Home's
existing image transform module. The helper shares exact clockwise/flip geometry,
inverse coordinates, extents and phase-correct 2x2 tiles without allocating or
depending on image ownership/types. Pinned/development Zig Debug/ReleaseSafe tests
exercise every transform, odd/singleton dimensions and maximal coordinates.
Home's helper workflow includes its paths and standalone tests. Camera Zig uses
it for C/Bun admission conversion and synthetic RGB/lores/Bayer generation;
libcamera performs physical transforms and reports negotiated orientation. No
duplicate codec, container or per-frame software rotation worker is introduced.

The 0.43 audit reuses Home PNG/BMP/TIFF layout code and contributes shared
formats/raster_encoder.zig and zlib_stream.zig at
4899b5c3b7c727e3811cf87d77fa78f757709333, copied verbatim. Home Image's public
encoders use the same checked strided view. PNG streams filtered rows directly
into IDAT chunks with pinned-address system-zlib state; it avoids a second whole
filtered/compressed image. BMP alpha masks, TIFF per-sample tags, 16-bit byte
order and palette expansion are corrected. PNG/TIFF decoders select 16-bit high
bytes correctly; unsupported TIFF compression cannot free borrowed data.
Home validates the helper on pinned/development Zig and its complete 106-test
Image suite on development Zig. Camera's independent platform decoders validate
RGB pixels rather than trusting Home's own round trips. Existing Home JPEG and
Bayer DNG implementations remain the JPEG/DNG paths; DNG's shared row writer now
supports owned byte output. No codec/container implementation is duplicated.

The autofocus admission follow-up rechecks Home's async completion_gate and
preparation_gate and retains those sources verbatim. Their acknowledgement,
result-revision and cancellation/publication tests pass with pinned Zig and Home's
development compiler. Bun snapshots application options before native admission;
it adds no AF state machine or frame queue. Single-scan, continuous pause/resume
and focus-locked jobs share the existing native gates. No Home source change was
needed for the host option-lifetime fixes.

The 0.44 audit inspects Home pixel_convert, codec rgb_i420 and colorspace filters.
Home's general converter doubled inverse chroma and halved forward chroma. The
new core/yuv_rgb.zig helper, published with the public conversion fix at
98c7e78c6d1a7d508fad3c3d86cd81c480d6d301, is copied verbatim. It checks independent
I420 strides and all bounds before writes, precomputes fixed point BT.601/709/2020
full/limited coefficients, and averages four source pixels per encoded chroma
sample. Tests cover known color vectors, an independent floating reference grid,
padding, clipping and atomic rejection on pinned/development Zig Debug/ReleaseSafe.
Home's public RGB24/I420 converters use it and free new frames on conversion errors.
Existing limited-BT.601 rgb_i420 video encoding remains unchanged. Camera synthetic
lores now matches real requested full-range sYCC; negotiated native color metadata
chooses conversion rather than assuming the request survived validation. RGB rows
stay borrowed, I420 still encoding owns one temporary RGB buffer, and direct RGB
copy converts straight into the caller's destination. Existing Home image encoders,
queues, recording codecs and containers remain the shared implementations.

The 0.45 audit reuses Home native_encoder's planar I420 interface, plane_pack,
yuv_rgb and the existing canonical AVC/HEVC/MP4 color tags. It contributes
video/core/yuv_remap.zig at 3659d9ad3115e4f54d46b821ffcc9551ee5e1639 and copies it
verbatim. The allocation-free helper remaps matrix/range without an intermediate
RGB image or an RGB clipping step. The common same-matrix path scales individual
planes. Independent strides, atomic validation, all 256 identity codes, known
full/studio vectors and an unclipped floating reference grid pass on pinned and
Home development Zig in Debug/ReleaseSafe. Home exports the helper and includes
it in its compiler/architecture workflow. Camera Zig owns bounded compact source
copies and color metadata; it refuses incompatible gamut/transfer instead of
mislabeling the existing output tags. MJPEG shares Home JPEG and reuses a bounded
RGB scratch buffer. No alternative codec, packet queue or container is added.

The 0.46 audit also inspects Home OS at 151269666bc09aa15a271f1c1f4603f681132e65;
see [the source-by-source audit](home-os-reuse.md). Its media ADR places shared
codec work in Home stdlib; camera/decoder stubs cannot replace working Linux
paths. Kernel audio, DMA and framebuffer implementations remain hardware-specific
references. For independent encoders, Home packet_output.Slots is reused by the
new core/frame_fanout.zig helper at ff51b18e44e5fe82dba14258fa1034fb9aef8cdf,
copied verbatim. It stores eight camera consumer identities, wait/drop admission,
exact tickets and saturating counters without pixels, PCM or another queue.
Retired busy entries hold capacity until exact cleanup; stale completions cannot
release replacements. Cancellation and external source failure have explicit
semantics. Pinned/development Zig Debug/ReleaseSafe cover ownership/exhaustion;
Home exports the helper and includes both optimization modes in its workflow.
Existing Home compact producers, media codecs, output queues and containers remain
the byte-owning implementations. Full multi-encoder mode transactions and shared
PCM fan-out remain work; physical speedups have not been inferred.

The 0.47 audit reuses Home pcm_timeline.Queue and packet_output.Slots and contributes
core/pcm_fanout.zig at 53fdf28d5b1aa07a71d3b917f15c6a11f686dd2d, copied verbatim.
Independent sample watermarks, short borrowed preparation tickets, delayed-input
handling and overrun quarantine share one bounded history. Twenty standalone
helper/dependency tests pass on pinned/development Zig Debug/ReleaseSafe, with
Home exports and workflow triggers/tests. HomeOS's mixer settings, playback ring
and ALSA facade supply no equivalent capture fan-out; see the updated audit.
Camera Zig owns one capture cursor, fixed history/scratch storage and bounded read
work; Bun passes only private descriptors into existing native copied producers.
Exact stereo samples, fractional 44.1 kHz cuts, dropped-video PCM catch-up, late
joins, failed-start ownership, source-budget failure, overrun isolation and
publication races have Bun/C tests. AVC/HEVC/AAC MP4 tests verify edit durations
and decoded audio/video against independent references. Existing Home codecs,
containers and producer queues remain the implementations; no PCM payload queue
is duplicated in Bun. Physical drift/latency and multi-encoder mode transactions
remain acceptance/implementation work.

The 0.48 audit adds Home async publication_batch, contributed on main at
854d00fb613fd06b5739764b5aca9bdaf009ddb7 and reused verbatim. It validates bounded,
unique lock-owner identities, stable ordering and every candidate state without
allocation. The camera retains lock acquisition, all-member commit flags, worker
joins and resource cleanup. Standalone Debug/ReleaseSafe tests pass with pinned
Zig 0.15.2 and Home development Zig. Native shared PCM holds compose the existing
Home stable slots; no second capture cursor or codec implementation is introduced.
Home OS filesystem journaling and architecture-specific spinlocks do not provide
a portable hosted multi-recorder publication primitive; see the OS audit.

The 0.49 audit inspects Home image blend/composite/Porter-Duff code. Preview uses
SDL's separate straight-alpha texture rather than adding CPU camera-frame blends.
Home image now exports a standalone checked RgbaView for borrowed padded RGBA8,
compact copying, overflow/truncation and overlap rejection. It was contributed
at b8c29c456e2ec001a30dc5d24743b71bd8d6a486 and reused verbatim. Standalone
Debug/ReleaseSafe tests pass with Zig 0.15.2 and development Zig. Zig retains
immutable overlay bytes across mode changes; no renderer/codec dependency is
introduced into the Home helper. Existing Home OS compositor code remains a
kernel-only design reference, not a hosted SDL texture or camera lease owner.
