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

The color-signaling follow-up contributes explicit `Encoder.initWithColor` and
`mp4_stream.Writer.initWithColor` / `initAvWithColor` to Home before verbatim reuse
at 4aeedc1e4a06aaec93201ac8e245e0ee1f0166b3. `Description.signal()` maps portable
processed YCbCr descriptions to ISO codes rather than confusing enum identities
with VUI/nclx values. The old 32-byte encoder config and default tags are preserved;
the additive C color recipe is 20 bytes. Both constructors validate supported
codes before allocation/output. Pixel conversion remains the owner's job.

The copied standalone test independently reads actual AVC/HEVC SPS/VUI and MP4
nclx for all 54 supported color combinations per codec, both video-only and AAC
track descriptions. It also checks legacy defaults, ABI sizes, invalid/null C
recipes and failed-handle clearing. Debug/ReleaseSafe runs pass with pinned and
Home development Zig; camera CI runs these tests on x86_64/aarch64 Linux. These
shared primitives require the camera owner to propagate one description through
session recipes, producer validation, pixel matrix/range conversion and every
output replacement/snapshot; the 0.55 integration below supplies that path. Gamut and
transfer conversion remains outstanding. No physical color accuracy is inferred.

The 0.55 session integration reuses those same verbatim helpers from Home
4aeedc1e4a06aaec93201ac8e245e0ee1f0166b3, plus checked `yuv_rgb.encode420` and
`yuv_remap`. A copied camera-specific recipe now ties input admission, target
matrix/range conversion, VUI and MP4 nclx together. Legacy RGB rounding remains
unchanged. Private prepared/snapshot/restart owners copy that recipe; neither
host metadata hooks nor released request buffers can change it. No second codec,
container, pixel converter or general scheduler is introduced into Bun.

Tests independently inspect encoded headers/container fields and provide floating
Y/U/V references to Linux's OpenH264/libde265 decoders. They exercise copied async
main/lores inputs, AAC snapshots after source close, delayed CircularOutput2,
splits, rotation/recovery factories, restart/reconfiguration, cancellation and
coordinated multiple-encoder mode publication. General gamut/transfer conversion
and physical Pi acceptance remain separate work. Home's source revision is
unchanged by this integration; the shared implementation already landed upstream.
The repository audit also fetches and fast-forwards to Home main
43416467a3b115fcf7a83d23c8eeb57d360a8fac. That intervening revision changes only
TypeScript compiler sources/fixtures; media packages and the copied source pin
above are unchanged.

The bitrate follow-up reuses the existing camera C scalar session snapshot and
Home session/audio validation instead of guessing an effective AAC setting from
requested Bun options. An unchanged audio format inherits its current recipe;
explicit bitrate/zero and new-format defaults retain their separate semantics.
Tests compare the native recipe with actual MP4 AAC descriptor bitrates and
encoded sample presence. No codec/container implementation or ABI layout changes.

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

The 0.50 audit reuses the existing Home preparation_gate-backed Bun jobs and
native lease_pool/frame_access ownership for headless preview. It needs no
additional native payload queue, task runtime or allocator. The existing
immutable RGBA validator remains used for SDL; headless overlay updates validate
shape but retain no bytes. Home async's general task scheduler and Home OS's
framebuffer machinery do not replace the hosted request pump. No shared helper
needed a code change in this cycle; existing provenance and tests remain intact.

The 0.51 audit reuses Home image orientation and the checked region helper fixed at
9f430f21ae271ba15c44dcad4201fb6c675e61a5. New viewport.Plan combines integer aspect
fitting, post-transform overlay regions and independent UV maps without pixels,
allocators or renderers. It was contributed at ac8eef68bd64a601ca72399a19fd3152dc81bba0
and copied verbatim with region.zig. Eight standalone/dependency tests pass in
Debug/ReleaseSafe with pinned and development Zig. Camera code validates the
public scalar ABI in Zig and keeps SDL calls in the existing system bridge;
window manager requests and display transforms never alter camera frame buffers.

The 0.52 audit reuses Home video yuv_rgb for selected I420 preview directly into
SDL's locked RGB texture. Home main 7ec5214016ca0486b48eb9ad48b2574726fa960a
improves decode420 to reuse chroma contributions per 2x2 block while preserving
fixed-point rounding/clipping. All four standalone tests pass with pinned 0.15.2
and development Zig in Debug/ReleaseSafe, including 75,264 legacy-equivalence
blocks and padding canaries. The camera copy is verbatim. Existing frame_access
read gates pin a synchronous scoped read without allocating a reference token.

Home retains a reproducible legacy/new padded 640x480 benchmark and raw CSVs.
Local macOS/arm64 ReleaseFast median batch ratios were 1.77–1.89; ReleaseSafe
was 0.94–1.46, including a slight BT.709-full regression. A concurrent-compiler
run is also retained to expose noise. These are shared-host observations, not Pi
results, camera throughput or a Picamera2 comparison. No safety checks were removed.

The 0.53 audit inspects Home video core/yuv_rgb.zig, yuv_remap.zig, plane_pack.zig
and pixel_convert.zig at 7ec5214016ca0486b48eb9ad48b2574726fa960a. Main I420
reuses the same checked conversion, direct matrix/range remapping and compact
owned-plane helpers already used for lores; no second converter or new Home API
is needed. Synthetic setup shares one checked fill/attachment path for main and
lores. The real backend requests YUV from libcamera. Existing Home attribution
and verbatim helper revisions in NOTICE remain in force. No Home source change
is required for this integration; additional pixel formats remain in scope.

The 0.54 audit reads image/colorspace.zig's Image/Color pixel transformations and
video/pixel_convert.zig's matrix/range conversion. They do not describe capture
request versus backend negotiation. Home video now supplies color_description.zig
for that allocation-free policy, exported from video.zig with standalone workflow
coverage. Commits 4b7f39b1e063c2314a12e69a558f18247d9d7af0 and
3c3c3a8814d822de8df0d0085fbb94d9c1a242cf were pushed before verbatim camera reuse.
Four tests pass pinned/development Zig Debug/ReleaseSafe, including independent
gamut, transfer, matrix and range adjustment checks. Existing yuv_rgb/yuv_remap
continue to handle pixels; negotiation is not a substitute for a gamut transform.

The still-metadata audit inspects Home image/metadata/icc.zig, exif.zig and
format_utils.zig at b5c9236c3 before contributing ICC fixes at
2c0d4c5be72b3c271d2b1e8988757fde1d932f64. The ICC generator used a gamma-2.2
curve, its v2 text descriptions lacked required tail fields, and malformed
profiles could produce partial successful parse results. The shared fix adds
allocation-free bounded tag geometry, supported sampled/parametric curve
validation/evaluation, owned curve bytes, a conservative copy budget and proper
UTF-16 description decoding. The v2.4 generator now uses a shared sampled sRGB
curve, D50 colorants and chromatic adaptation. Those three modules and their
ownership/CMM tests are copied verbatim into this repository.

Pinned 0.15.2 and development Zig pass 7 direct + 5 separate ownership tests in
Debug/ReleaseSafe. The full metadata suite passes 15 tests. Independent Little
CMS tests read all 196,608 channel values and transform 4,913 RGB patches; local
maximum curve error is 0.000015054 and XYZ-component error 0.000018893. The same
curve oracle rejects the previous Home generator. This is serialized-profile
validation, not physical image quality or a general ICC conversion claim.
Home Actions rejects workflow dispatch with HTTP 422 (repository disabled), so
local evidence and camera copied-source CI must be distinguished. The dedicated
camera workflow checks both toolchains and Linux x86/ARM plus macOS.

Existing Home format_utils ICC conversion refers to unavailable profile methods
and uses approximate white-point scaling. It is not reused as a working CMM.
Exif parsing/writing also needs further bounds/IFD and capture-field work before
camera exposure. No camera ICC embedding or Exif public API is claimed by this
foundation. See still-metadata.md; those integrations remain on the parity plan.

The 0.56 audit rechecks Home JPEG APP2/PNG iCCP markers and TIFF handling after
the ICC foundation. Existing format enums do not implement profile embedding.
Home image now supplies metadata_embed.zig, exported as IccEmbedding and published
at f310e9345448d909041ad20a3bc332d07b78130f. The camera reuses it with only two
import-path adjustments to existing flat Home raster/zlib modules. zlib_stream
also gains an owner cleanup on C initialization failure and is copied verbatim.
The helper preserves JPEG scans/PNG IDAT/TIFF strips, replaces active profiles,
checks container metadata geometry and PNG CRCs, supports both classic TIFF byte
orders, and keeps next-IFD links. Seventeen standalone/dependency tests pass in
Debug/ReleaseSafe with pinned and local development Zig, including allocation
failure sweeps. No encoder, deflater or pixel conversion is duplicated in Bun.

Native code owns the public ABI, source-color preflight, scoped lease read,
encoded blob and atomic destination. Bun copies custom profile bytes before job
admission and rebuilds borrowed descriptors inside mode workers. Independent
container libraries extract embedded bytes and Little CMS opens them; platform
image readers compare profile/unprofiled decoded samples. The shared validator
and embedding helper do not implement arbitrary gamut/transfer transformation,
complete JPEG scan/TIFF page decoding or Exif fields. Those parity requirements
remain in scope. Home Actions remains disabled; copied-source camera CI supplies
Linux x86/ARM and macOS coverage separately from the local Home results.

The 0.57 audit fetches Home main at f310e9345448d909041ad20a3bc332d07b78130f
and reads async/preparation_gate.zig, video/core/recording_path.zig and the fs VFS
and bindings. The existing Gate, contributed at
1ebb311b33b9e4982c6b15d971981792c599560c and already copied verbatim, supplies
claimed cancellation, immutable publication and cleanup/error precedence. The
camera reuses it under a mutex for staged still-file ownership. The recording
path helper supplies naming policy, not hosted atomic replacement. Home fs's
kernel/VFS abstractions and incomplete hosted bindings do not replace pinned
Zig's atomic-file/descriptor I/O here. No shared helper needs a source change.

The camera retains capture leases, filesystem handles/identity checks, native
I/O-thread reservation/join and ABI outcomes. Paths are copied and staging keeps
no camera/frame or Bun payload. Request callbacks and camera/control/preview
restoration precede publication; completion callbacks follow its joined result.
The optional system-JPEG file-descriptor path is preserved; Home codecs, ICC
embedding and RGB/I420 conversions are unchanged. Native cross-thread/identity
and Bun cancellation/restoration/decoder tests cover the new contract. General
filesystem crash recovery, hardware acceptance and remaining parity capabilities
are not established by a successful atomic rename.

The Exif foundation audit starts from Home f310e9345 and contributes shared
image fixes at 05c131f97466cce6cb497aad5607e4dc77ad6ad6, rebased on current Home
main's unrelated parser changes. The old Exif parser could read malformed shapes,
recurse through cyclic pointers, leak replaced strings and lose GPS signs. Its
writer emitted only four fields. The new bounded layout, owned parser and typed
builder serialize image/Exif/GPS/interoperability/thumbnail directories, preserving
selected exposure/ISO/date/lens fields and owned thumbnail bytes. Those three
source files and the standalone/independent tests are copied verbatim here.

Validation includes every truncated fixture prefix, malformed offsets/types/counts,
cycles/aliases, duplicate tags, table overlaps, 64 MiB alias ownership budgets,
GPS total-angle/time limits, unsigned/signed rationals, every allocation failure
and deterministic mutations. Libexif independently reads actual output fields
and writes both byte orders back into the Home parser. Local Debug/ReleaseSafe
checks use pinned and installed development Zig. home-exif.yml adds pinned/master
Linux x86/ARM and macOS coverage. Libexif is a test dependency only. Home Actions
availability remains separate from camera copied-source CI. These primitives do
not yet expose capture Exif options, embed Exif in images, relocate MakerNotes or
establish complete Exif/Picamera2 conformance. Those requirements remain in scope.

The combined metadata embedding audit contributes Home image's shared
metadata_embed.zig and metadata_tiff.zig at ee61d81948836c7c2e1943d9fd402f8d178ce674. ICC and Exif can be
written together into JPEG/PNG/classic TIFF. JPEG APP1 and PNG eXIf carry bounded
bare TIFF metadata; TIFF merges primary tags and relocates directories, numeric
values, next links and JPEG-thumbnail pointers into the image's byte order. It
keeps original sample bytes/offsets and page directories, replaces marked reduced
JPEG thumbnails, and rejects protected primary pixel tags and thumbnail pointer
forms it cannot safely relocate. The selected parser now keeps the first JPEG
thumbnail, so later image pages cannot overwrite it. Proprietary MakerNote offsets
and complete TIFF/Exif conformance remain separate work.

The merger reserves metadata-table capacity once; JPEG/PNG reserve output space
before copying image bytes, PNG writes profile chunk parts directly, and TIFF
avoids zeroing original pixel data before copying it. Twenty-seven standalone and
dependency tests pass in Debug/ReleaseSafe with pinned/development Zig, alongside
eleven separate Exif regressions. Libexif independently creates both byte orders;
libjpeg/libpng/libtiff extract metadata and decode before/after samples, and Little
CMS opens embedded profiles. Sixteen format/endian/profile combinations also
replace thumbnail bytes and metadata byte order; a two-page big-endian TIFF keeps
its original second-page offset and decoded samples. Thumbnail fixtures are not
decoded images. These checks establish hosted software behavior, not Pi quality.

metadata_tiff.zig, the selected Exif parser and C/Zig fixtures are copied verbatim.
metadata_embed.zig changes only the two existing flat format-module import paths;
the test facade changes only its raster import path. Production still uses Home
codecs and zlib, with no independent reader dependency. Camera capture/ABI ownership
is unchanged; capture-facing Exif options and metadata generation remain required.
Home Actions remains disabled, so copied-source camera CI supplies platform tests.

The Linux reader matrix found a fixture portability defect: rewinding buffered
stdio after fread did not guarantee that the descriptor duplicated into libtiff
was at byte zero. Home's independent reader now flushes and explicitly seeks the
reader descriptor at 917c796e0b37acc9f018bf802bcc90c3f6a95547; that C fixture is
copied verbatim here. Both local toolchains' 16 independent cases pass again.
The production embedding implementation is unchanged. The reader workflow also
watches the JPEG/raster/zlib sources it exercises, so codec-only changes run it.

The 0.58 capture audit contributes Home image d0abb3777b6255843ffe2364f1bd09e660c36ced:
Exif.withDefaults appends only missing primary image/Exif defaults while retaining
caller bytes/value locations, endian and secondary directory graphs. Shared
ISO/GPS helpers and allocation-free GPS domain checks prevent divergent capture
writers. jpeg_metadata.zig supplies checked APP1/APP2 markers without codec or
zlib dependencies; Home Encoder.encodeMetadata writes them inline and
encodeOwned transfers its output allocation, avoiding a second JPEG-sized copy.
Exif numeric endian conversion is shared by defaults and TIFF relocation.

Five defaults/value, twelve JPEG/dependency, twenty-nine embedding/dependency
and thirteen separate Exif tests pass in Debug/ReleaseSafe with Zig 0.15.2 and
installed 0.17 development Zig. Sixteen independent container/endian/profile cases
plus replacements and four inline JPEG combinations pass with both toolchains.
Libexif/libjpeg/libpng/libtiff/LCMS are test dependencies only. Home's dispatch
returns HTTP 422 Actions disabled despite the permissions endpoint saying enabled;
local checks and the copied-source camera matrix supply validation.

Sources and tests are copied verbatim except the two existing flat format imports
in metadata_embed and the raster import in the test facade. Camera owns request
lease, clock/gain policy, C ABI and Bun admission snapshots; those do not belong
in Home's serializer. The independent JSON inspector is reused verbatim for
actual capture outputs. No kernel stub, Python or FFmpeg path is imported.

The capture-reader Linux CI caught a misleading-indentation warning in its
seek/bounds statements. Home's test-only JSON reader separates the declaration
from the preceding conditional; camera copies that fix verbatim and the Exif
matrix now compiles this additional reader too. Production Exif/JPEG code is
unchanged. Both reader compilation and the eleven actual capture regressions
pass locally after the fix; GCC CI supplies Linux acceptance.

The 0.59 stream-bundle audit improves Home video at 44bf4e911437251479a4a535fc311e1471cc93d5.
plane_pack.zig gains a borrowed Plane description, checked aggregate packedSize
and allocation-free pack. Every source and complete destination are validated
before any row is copied; heterogeneous plane bundles concatenate in order and
leave unused output suffix bytes untouched. Existing rows and I420 helpers share
the same preflight/copy implementation. Four standalone tests cover padded final
rows, late truncation, mixed shapes, short output and aggregate overflow without
pixel reads. Debug/ReleaseSafe pass with pinned 0.15.2 and development 0.17 Zig.
The copied-source camera matrix supplies pinned/master Linux x86/ARM and macOS
checks while Home workflow dispatch remains disabled.

Camera adapts RGB/I420/Bayer descriptors to up to nine borrowed planes, snapshots
selected geometry/metadata under one request lock, and copies into one owned
allocation. Existing frame copies and temporary worker copies now share that C
operation rather than duplicating format/size code in Bun. Home's generic plane
helper owns no capture token or DMA pointer; request callbacks, cancellation and
mode/preview restoration remain camera policy. No generic async scheduler or
image streaming decoder was imported for this ownership operation.

The 0.60 retained-request audit reads Home main at
44bf4e911437251479a4a535fc311e1471cc93d5, including video core/lease_pool.zig,
frame_access.zig and async preparation_gate.zig. The generation-checked pool
already keeps each retained reference distinct and the access gate distinguishes
BUSY from consumed ownership; BunJob already reuses the preparation gate for
publication. No new pool, scheduler or artificial Home API is needed. Camera
adds request-specific sequencing: post hooks retire, the target stops, the
original token moves to the main thread, cancellation releases it before rollback,
and publication seals before exposing the Frame. Exceptional BUSY cleanup keeps
an explicit retry owner instead of losing its token. The C helper similarly
releases a private acquisition when stopping fails. These policies stay in camera;
Home sources are reused unchanged for this step. Fault-injected hosted tests do
not establish physical DMA or process-crash recovery.

The 0.61 file-series audit improves Home async at
8779c7c861360540bcf1fe49f4329d8c5f0f2397. New relative_delay.zig supplies a checked
u64 idle interval with atomic overflow failure, inclusive deadline, reset and
clock-regression rejection. Its three standalone tests pass in Debug/ReleaseSafe
with pinned 0.15.2 and development 0.17 Zig; the copied-source camera matrix
tests both Zig channels on Linux x86/ARM and macOS. Home's workflow dispatch is
still disabled. The helper is copied verbatim and gains a 32-byte camera C state
wrapper. Home timer.zig is coupled to Future/Waker, while media PTS rebasing is a
different clock policy; neither is imported as a second host scheduler.

Bun owns serial camera mode/file jobs, bounded metadata history, cancellable
host waits and filesystem publication. Existing Home preparation gates, leases,
frame access, image metadata and encoders are reused. A single owned image-option
factory shares Exif/ICC bytes across format templates while retaining JPEG's
automatic capture-Exif default and PNG/TIFF opt-in. This avoids repeated metadata
copies for each file. No video codec, container, kernel camera object or request
queue is reimplemented for the series. Timing tests establish hosted ordering and
ownership only; physical sensor cadence and focus acceptance remain unmeasured.

The 0.62 software-sync audit improves Home video at
1f1c8690507bf14e71c8c5ea273ade18366493a1. frame_barrier.zig gains require_ready
and observeReady, preserving the old observe path. Per-observation readiness must
be explicitly true after distinct drops and exact timing criteria; absent/false
waits, repeated events cannot revise a pending observation, and terminal acceptance
is immutable. Required timing errors preserve the whole gate. Five standalone
tests pass in Debug/ReleaseSafe on pinned 0.15.2 and development 0.17 Zig. The
updated helper is copied verbatim; the camera matrix checks pinned/master Zig
on Linux x86/ARM and macOS, with C filter checks on the pinned camera compiler.
Home's own workflow dispatch remains disabled.

Existing Home typed catalogs, persistent control state, leases and job gates
supply ownership, exact signed metadata and atomic control replay. Camera adds
an allocation-free request-local SyncReady/SyncTimer bridge and combines those
observations with the shared gate. It does not infer readiness from a timestamp
matcher, use a second queue, or import a new network sync algorithm. libcamera
owns the real server/client algorithm. Virtual server countdown/client-pending
behavior tests control and request association, not network or exposure alignment.

The 0.63 alignment audit improves Home video at
34aa602dfba2bd6af982c5e6b4887550a5da70b2. New stream_alignment.zig supplies explicit
VC4/PiSP processed layout recipes and minimum alignment without allocation,
pixel changes or device negotiation. Positive extents that would round to zero
reject; subtraction/remainder arithmetic stays exact at u32 limits. Three
standalone tests pass in Debug/ReleaseSafe with pinned 0.15.2 and development
0.17 Zig. Camera copies the source verbatim; its copied-source matrix checks
pinned/master Zig on Linux x86/ARM and macOS, with C ABI checks on the pinned
compiler. Home's own Actions dispatch remains disabled.

Existing Home region/orientation helpers validate bounds and transforms, while
plane_pack validates/copies already negotiated planes. They do not encode these
output-size recipes, so alignment is a separate small planner. Native camera
configuration aligns local main/lores copies, then shares existing structural
preflight before publishing either output. Bun owns copied options and CLI calls
the same native operation. Raw/sensor modes and backend stride negotiation remain
separate contracts. No additional pixel format or ISP performance is inferred
from an advisory geometry plan.

The 0.64 tuning-document audit improves Home image at
960700eb74abd292d86bc884b2f667e3862a38dd. New metadata/tuning.zig uses Zig's
strict JSON scanner/parser with explicit byte/token/depth budgets and owned
trees, preserving unknown fields and exact numeric lexemes. Version comparison
is decimal-exact rather than rounded through f64. Both tuning layouts, missing
and ambiguous algorithm lookup, transactional edits and exhaustive allocation
failures are covered by five pure tests in Debug/ReleaseSafe on pinned 0.15.2 and
development 0.17 Zig. Camera copies this source verbatim and tests pinned/master
on Linux x86/ARM and macOS. Home's workflow dispatch explicitly returns HTTP422
"Actions has been disabled for this repository"; local/copied-source coverage is
recorded separately from an unrun Home workflow.

Audited packages/json, basics JSON wrappers and tsconfig's JSONC parser. Their
f64 value conversion or recovery behavior does not supply strict lossless tuning
edits. The shared helper therefore uses the standard JSON implementation rather
than adding another parser or importing lossy conversions. Home owns portable
data and transactional allocation; camera adds the mutex-protected C owner and
Bun owns bounded search, descriptor reads and staged publication. Existing Home
codec/container, request and job helpers remain in place. OS kernel ownership is
not imported, and no ISP application or physical quality result is inferred from
document editing. Native tuning application still requires an explicit shared
manager/environment lifetime policy, including worker reopens and restoration.

The 0.65 manager-tuning audit reuses Home image's tuning editor unchanged at
960700eb74abd292d86bc884b2f667e3862a38dd and improves Home env at
465a71b4e8fefbdd7f1004c93e5b64c10b3b6d87. The env reader had returned null on
Linux even when libc was linked, and set/unset treated values as filesystem paths.
The standalone PosixEnv helper now owns raw-byte reads and complete override
snapshots before mutation, preserves absent/empty/external values, and retains
failed restoration owners for retry. Public get/set/unset reuse it, fixing Linux
libc reads and supporting values beyond path limits. Three pure tests pass in
Debug/ReleaseSafe on pinned 0.15.2 and current 0.18 Zig, including exhaustive
allocation failures. The public wrapper executable passes locally on current
0.18; its unrelated current-runtime imports prevent claiming pinned support for
the whole env package. A no-libc Linux executable also compiles independently.

Camera copies the helper and no-libc fixture verbatim and uses Override directly
for the manager environment duty. Its copied-source matrix checks both compilers
on Linux x86/ARM and macOS, runs the no-libc executable on Linux, and checks the
public Home wrapper from that exact upstream revision on current Zig. Home's
own workflow dispatch still returns HTTP422: Actions is disabled for its repo.
Native camera owns profile reservations, immutable temporary files and shared
manager counters; C++ only balances startup/shutdown notifications around manager
leases. Bun pins one reservation through existing Home-gated camera/recorder jobs,
reusing their joined rollback/cancellation rather than adding another scheduler.
No codec/container, kernel camera or process environment implementation is
imported from OS. Physical IPA/hotplug/tuning results remain unverified.

The 0.65.1 follow-up pins the environment source/public wrapper regression to
3888e242056533d2da2e0c082129354885d920ec. Owned reads now allocate plain slices
to match env.get's existing nonsentinel return type; hiding a sentinel allocation
behind that type lost the extra byte during caller frees. A checked-allocator
regression deliberately aborts against the earlier helper and passes the fixed
public wrappers in Debug/ReleaseSafe. Pure tests pass on pinned/current compilers.
The camera's standalone catalogue test now links the actual built Zig library
for manager policy hooks; it does not replace those hooks with test stubs.

The 0.66 device-loss audit fetches unchanged Home main at
3888e242056533d2da2e0c082129354885d920ec and verifies the copied video lease_pool,
frame_access and async completion_gate against their upstream files. These
existing helpers retain generation tokens, read/write scopes and AF job state
through loss. No new pool or scheduler is needed. Audited async channel and
concurrent_queue: sends allocate nodes and their lifecycle does not supply the
fixed terminal observation required on an SDK callback, so neither is imported
as an unbounded device-event transport.

Camera keeps its SDK-specific sticky loss/status and final-close handoff in Zig;
the C++ relay owns only SDK callback retirement. Bun's 32 bounded subscribers
share one poll/scratch descriptor and existing Home-gated jobs. Worker responses
carry owned loss observations across close/rollback without retaining a driver
pointer. Home sources remain unchanged for this step, with their existing notices
and license preserved. Synthetic relay, fence and wait tests do not establish
physical disconnect/DMA behavior; manager-wide watches and recovery remain open.

The 0.67 manager-watch audit fetches unchanged Home main at
3888e242056533d2da2e0c082129354885d920ec. It inspects events/src/events.zig,
async channel/concurrent queue, and video core/owned_fifo.zig/device_identity.zig.
The emitter copies listener snapshots with an allocator and runs handlers; the
channel/concurrent queue allocates nodes. Those are not SDK callback storage.
Existing verbatim Home owned_fifo and device_identity instead supply bounded
preallocated payload ownership, wrap/copy/ack and exact UTF-8 validation. New
camera-specific eviction/sequence/rescan policy and SDK relay retirement stay in
zig-camera rather than introducing a second Home queue. Tuning sessions reuse
Home's existing owned POSIX override and the camera manager lease. Copied sources
are compared to current Home, retaining attribution; no Home source changes are
needed for this feature. Callback paths allocate no application storage and do
not invoke consumers. This is not a guarantee about SDK-internal allocation or
physical camera behavior.

The 0.68 reconnect audit fetches Home main at
0cb789b4cbc2568bcf97308647f1ad4035bb2fa8. The eight new commits since 3888e242
concern the TypeScript compiler and change no audited media/async/env packages.
The research checkout fast-forwards cleanly; output_recovery.zig and exact
identity storage remain verbatim matches. Home video's existing Retry already
provides bounded lifetime claims, capped/saturating backoff, completion-time
observation, and no deadline drift; no second retry algorithm or new Home API is
needed. A camera C bridge exposes that unchanged policy with validation and
caller-owned state, and Bun supplies a private monotonic epoch, discovery watch
and joined native open/disposal. Existing Home-gated Bun jobs and native control
snapshot/replay provide cancellation/publication and owned exact settings. The
portable policy is tested on pinned/development Zig; the C-import ABI is tested
on camera's pinned 0.15.2, since development Zig has removed @cImport. No Home
source is changed for this feature, and no physical reconnect result is inferred.

The 0.69 coordinated-recovery audit fetches and fast-forwards clean Home main to
c57880cd4ae3d878777df940bea14953aac9eb84. Changes since the previous 0cb789 audit
are TypeScript compiler ambient-merge/barrel work; the inspected media/async/env
helpers are unchanged. Camera's publication_batch, pcm_timeline, pcm_fanout and
rgba_view copies compare byte-for-byte with this revision. Existing native
RestartGroup/shared publication and held PCM consumers already provide bounded
all-member commit, fractional sample phase and future-block retention. Recovery
reuses them across fresh camera ownership instead of adding a second transaction
scheduler, queue or audio clock. The existing Home RGBA View validates/copies only
active rows for an independently owned overlay snapshot; the camera adds only a
small C clone owner and Bun admission/retirement. No new portable primitive is
missing from Home for this step, so no Home source changes are needed.

Synthetic tests cover all eight encoders, separate main/lores inputs, changed
AVC/HEVC/AAC sessions and FPS, shared microphone phase through failed preparation,
old retained frame independence, joined host hooks/cancellation and exclusive file
disposal. Independent AAC checks run locally; Linux CI additionally supplies the
independent AVC/HEVC decoder. These tests establish software ownership and media
semantics, not physical hotplug timing, ALSA continuity or optical acceptance.

The 0.70 encoder-policy audit fetches unchanged Home main c57880cd4, inspects
native_encoder.{c,h,zig}, h264_encoder.zig/hevc_encoder.zig, mp4_stream.zig and the
native test runner, and improves Home on main at
cf2c30911736e8c31e4a674c26884ab9d73df94c. Existing pure encoder configuration
fields alone do not prove a conformant emitted stream. The working header-checked
adapter therefore gains copied validated profile ceilings, preset selection and
CQP policy, with the legacy scalar ABI/defaults preserved. Slow HEVC presets are
constrained to valid transform depths for the existing shared CTU16 policy.
Home's MP4/Matroska configuration builder now supports emitted Baseline/Main AVC
headers with their shorter configuration records, preserving High extensions and
failure atomicity. Camera copies all four implementation files and the standalone
IDR/C-admission test verbatim, retaining attribution.

Home's focused native-media suite passes Debug/ReleaseSafe on pinned Zig 0.15.2
and development 0.18; the new raw C failure-admission test also passes on pinned
Zig. Pure policy tests check rejected combinations on both compilers. Camera
adds only additive C owners/setters and copied Bun session admission/transaction
plumbing. Its matrix checks portable copied policies/container records on both
compilers and all three hosts; main Linux CI checks actual adapters and
independent decoders. Bun tests inspect real AVC SPS compatibility and PPS QP
endpoints, all presets, copied/rejected/cancelled policies, session reuse,
coordinated modes and AVC/HEVC/AAC reconnect. Local video decoding is unavailable;
local AAC checks and header/container tests are distinct from Linux video-decode
coverage. Home's own workflow remains disabled rather than claimed as run.
No speed, physical-camera quality or full codec conformance result is inferred.

The 0.71 decoder/VBV audit fetches Home main, fast-forwards through the unrelated
TypeScript compiler changes at 7d1b12717b533404a7b438a2de103abddd353f9a and
992794895cd4472c188f011d3416dbf9859ed40a, and contributes the media changes at
a7a746d1f04072657f3c87702900326ac2bffb95. It inspects native_encoder, the pure
H264/HEVC configuration modules, codec/bitrate.zig and analysis/quality.zig.
BitrateAnalyzer accumulates samples/statistics; it is not a bounded codec VBV
policy or SDK admission path. Existing metric/configuration fields alone do not
prove emitted level conformance. The working header-checked Home adapter therefore
gains a separate Limits recipe, exact-unit and minimum-frame-buffer validation,
AVC vendor-table resource checks and HEVC Main-tier checked integer nominal
bounds. Actual SPS requirements are checked before ownership escapes. Existing
color/options/open ABIs keep their sizes and defaults. Camera copies the C/header,
Zig wrapper and IDR/raw-C/boundary test verbatim with attribution.

Explicit HEVC ceilings also preserve the existing shared CTU16 policy: higher
ceilings can contain a <=4.1 stream but cannot silently induce vendor CTU32
mutation. Higher-resolution HEVC ownership remains work. Full codec/HRD conformance
is not inferred from SPS/resource checks. Home's focused suite passes Debug and
ReleaseSafe with pinned 0.15.2 and development 0.18. Camera's copied-source matrix
covers both compilers, while Linux main CI builds actual adapters and independent
decoders. Local video decoding remains unavailable; independent AAC/image checks
are distinct evidence. Bun tests cover high-complexity VBV volume and all accepted
frames, scalar ABI/failure ownership, copied/cancelled reconfiguration, explicit
coordinated default resets, modes and AVC/HEVC/AAC recovery. Camera reuses existing
Home-gated publication/flush ownership instead of adding another scheduler.
The current Home permissions endpoint reports enabled, but no workflow run exists
for the contributed head and manual native-media dispatch still returns HTTP422
"Actions has been disabled for this repository". Local focused suites and camera's
copied-source/adapter CI are separate evidence; an unrun Home workflow is not
counted as passing. No Actions settings are changed.

The 0.71.1 follow-up fast-forwards Home's unrelated TypeScript work through
b5ea012c6715b7055328c1c2481c889e2e35b6d7 and contributes the codec fix at
929f20b776aba80f2f4fbe0da0ee3a04f4a81f31. The first Linux independent-decode run
caught that a small AVC stream under a 6.2 ceiling advertised raw level 62.
OpenH264 rejects that unsupported requirement. Home now preserves automatic
minimum-level and motion-range selection after the resource bounds, then checks
the emitted level against the ceiling. High ceilings no longer inflate small
streams. The raw High-profile IDC 9 (level 1b) is compared semantically above 1.0,
preventing numeric ordering from bypassing the ceiling. Camera copies the source
and seven-case native fixture verbatim; strict independent decoding is retained.
Pinned Debug/ReleaseSafe full Home suites and development-compiler native tests
pass, along with camera's native/C/Bun checks. No codec capability is removed and
no decoder rejection is hidden by skipping high-ceiling cases.

The 0.72 HEVC geometry audit fast-forwards unrelated Home TypeScript fixes through
0b4411745 (full upstream hash retained in Git ancestry) and improves the shared
codec path at c66ce6bb8c6bde84adf0d684eb9399660e3e7428. It inspects util/bitstream,
core/nal_convert, codecs/video/hevc, codec/hevc_analysis and the working native
encoder bridge. The broad decoder/parser imports do not supply a bounded encoder
crop transaction; the existing bit reader is extracted as an allocation-free leaf
with cursor-preserving failures, retaining its legacy public alias and tests.

The bounded SPS conformance editor, its scalar Zig/C bridge, the fixed CTU32
native encoder and mixed tiny/4K fixture are copied verbatim. Only tiny inputs
need edge-padding copies. Native HEVC headers are generated once and cached,
avoiding the duplicate parameter sets exposed by repeated x265 header calls.
Larger requested levels no longer inherit the old CTU16/effective-4.1 restriction.
Nominal admission includes padded/4-aligned geometry and rational sample rates.
Home and camera keep the vendor's process-global CTU rule explicit; unrelated
external x265 users still need compatible CTU settings.

Local pinned and development Zig pass Home's focused suite in Debug/ReleaseSafe,
including the legacy bitstream wrapper. Camera passes 334 native tests, C ABI and
770 Bun tests with the rebuilt codec/AAC/preview library. The new Bun fixture
keeps seven visible sizes, including 3840x2160, alive together; Linux CI supplies
independent Y/U/V decode checks. Local media tests without that decoder establish
encoding/container behavior only. The standard local macOS build runner still
fails SDK libSystem linkage before the project build; direct target-qualified
native tests succeed. No physical camera, Pi throughput or quality claim follows.
Home-hosted Actions have previously returned disabled despite enabled repository
permission metadata; this local suite and the copied camera CI are distinct from
claiming a Home-hosted run succeeded. See hevc-geometry.md for scope and ownership.

The 0.73 public-keyframe audit fast-forwards Home's unrelated TypeScript fixes to
a3dcf41299cfac151cd211af04672d4dc441022c and contributes the allocation-free
keyframe_requests ledger at 0fc3d41481ab4beb7007a0110ddb79f1ed9ad95f. It inspects
native_encoder's existing requestKeyframe/IDR operation, packet_ring keyframe
handling, recording_policy session transitions and the shared preparation gate.
Those supply encoding, GOP retention and ownership primitives; a public repeated
request still needs distinct intent per accepted input. The new bounded ledger
is therefore implemented in Home and copied verbatim, with nonwrapping counters,
transactional capacity rejection and independent session state.

zig-camera reuses the existing Home encoder operation when an input has pending
public intent. Native/Bun producer ownership supplies ordering and cancellation:
a zero-payload job shares the bounded producer pool, and commit is linearized
with cancellation under the existing owner lock. No codec/sink call holds that
lock, and a control job does not become a recording drain. Actual encoder input
acceptance advances accounting before sink delivery; rollback preserves the old
ledger, and successful session publication installs a fresh one. Existing
internal split/recovery keyframe flags stay coalesced and do not increment these
public counters.

Home's focused suite passes pinned Zig Debug/ReleaseSafe; ledger tests also pass
Home development Zig in both modes. Local camera validation passes 338 native
and 779 Bun tests, C ABI, format and type checks. A two-thread native test holds
worker completion open to verify cancellation before versus after commit.
The copied Linux fixture checks IDR NALs, MP4 flags and independent I420 decoding.
The normal macOS build runner still fails SDK linkage before project compilation;
the direct target-qualified native build succeeds. Home-hosted Actions remain
separate from these local checks and the camera CI matrix; no Home-hosted success
is asserted. See keyframes.md for public semantics and outstanding limitations.

The 0.74 repeated-header audit fast-forwards unrelated Home TypeScript fixes to
9ed10f32f06f28c30c31fd04662e5406cbc72b01 and improves packet_output at
f071c988992aa76bd2feeadb18c128fb5c77ed2a. It inspects the shared Annex B/NAL
helpers, native_encoder's length-prefixed header cache, and the broader x264/x265
wrappers. The latter do not supply a safe replacement for the header-checked
bridge; the x265 wrapper's repeated-header comment is attached to an AUD setting.
The working encoder keeps vendor header repetition disabled, preserving cached
HEVC conformance crops and header-free container samples.

The verbatim shared helper now extracts required AVC/HEVC parameter sets while
excluding other header NALs, checks output capacity/overlap, and preflights the
header prefix plus access unit before any destination write. Each packet output
owns a filtered parameter-set cache prepared once; no codec restart or per-frame
filtering is introduced. Prefix bytes count toward sink queues and output byte
accounting. The camera owns the copied default-true/first-only session policy,
its C/Bun admission and prepared/snapshot/restart publication. No output scheduling
or lifecycle ownership moves into Home's allocation-free helper.

Home's nine focused tests pass pinned and development Zig in Debug/ReleaseSafe.
Local camera validation passes 342 native tests, C ABI and 794 Bun tests,
including 15 focused repeated-header cases and the final single-read session
accessor fix. New fixtures inspect exact parameter bytes, raw file/PTS output,
queue byte accounting, header-free muxed samples, snapshots, delayed splits,
recovered sinks, session rollback/null reset and coordinated modes. Linux CI
supplies independent decoding of raw clips beginning at a later IDR with no
separate header message. Local tests without that decoder prove stream assembly
and ownership only. The standard macOS build runner still fails SDK linkage
before project compilation, while the direct target-qualified native build
passes. Home-hosted Actions remain distinct from local checks and copied camera
CI; no Home-hosted success is inferred. See repeated-headers.md for policy and
remaining codec/hardware limitations.

The 0.75 named-quality audit inspects clean Home through
f071c988992aa76bd2feeadb18c128fb5c77ed2a and contributes capture_quality at
fb8be0b3432316743e74b99ebc880ddf5876f4d0. It reads codec/config and core/types
quality presets, native_encoder's ABR/CRF/CQP policy and session_config. The broad
CRF/bit-per-pixel presets do not implement Picamera2's software capture tier tables
or rational square-root scaling. The new standalone helper therefore reuses
session_config validation and the standard integer square root, with a checked
u128 ratio and explicit vendor-unit rounding. It is copied verbatim here.

The inspected Picamera2 reference remains
5e2a35d3bb230825c98c56d98e01b41ddeb43e86: software JpegEncoder uses JPEG values
25/35/50/65/80 and LibavH264Encoder uses 3/4/7/10/14 Mbps at 1080p30 with square-root
complexity scaling. These are implemented without executing Python or using
Libav/FFmpeg. HEVC sharing the rate policy is an explicit Home extension. The
upstream hardware encoders' different linear policies and remaining rate/default
semantics are not declared implemented by this software feature.

C/Bun/CLI apply the same helper. Named video tiers derive ABR targets and are
validated with codec options/limits before output construction. Numeric quality
and defaults remain unchanged. Session geometry is resolved before applying the
tier and VBV checks; an integration case shrinks geometry to fit a newly supplied
CPB cap that would reject the inherited geometry. Fully resolved quality resets
are passed explicitly through coordinated publication so an old tier cannot be
re-inherited. Requested tiers remain copied for later geometry/fps recomputation.
No second rate-control formula is implemented in Bun or the CLI.

Home focused tests pass pinned/development Zig Debug/ReleaseSafe. Local camera
validation passes 803 Bun and 345 native tests, C ABI, CLI tier/numeric byte
comparisons, format and type checks. JPEG tier output matches its numeric quality
bytes; video fixtures provide independent Linux I420 decoding across tiers,
mode/reset/limit admission and fresh-camera recovery. Pure plans open no SDK,
file or hook. The local normal build runner still fails SDK linkage before
project compilation; direct target-qualified native/CLI builds succeed.
Home-hosted Actions remain distinct from these local checks and the copied
camera matrix. See quality-tiers.md for units and remaining hardware limitations.

## 0.76 packed RGB rows

The audit starts with clean Home main fb8be0b3432316743e74b99ebc880ddf5876f4d0
and inspects video/core/pixel_convert.zig, image/ops/rgba_view.zig and the borrowed
raster encoder. Pixel layouts and straight-alpha interpretation already exist;
RGBA views already demonstrate checked spans and overlap rejection. The public
video RGB-to-RGB loop still performed unchecked pixel reads, and equal-format
copies copied whole slices without independent source/destination pitches.

Home commit 321fe476c625d398d9b80abaaa8695e110025ae2 adds allocation-free
video/core/packed_rgb.zig and uses it in public packed RGB conversions, including
equal layouts. It checks complete spans/overflow/overlap before writes, retains
alpha for alpha layouts, treats X as opaque, excludes padding and preserves output
suffixes. Other format families retain their existing dispatch; this is not a
claim that every Home pixel conversion is now checked. All 49 layout pairs and
public padded/truncated/overlapping frame cases pass pinned/development Zig in
Debug/ReleaseSafe. Home-hosted Actions still has no run for the published head;
local and copied-camera checks are separate evidence.

The helper is copied verbatim into zig-camera. Hosted stream format selection,
DMA/request ownership, codec scratch storage and SDL locking stay in camera code.
C/Bun/CLI select BGR/RGBX/BGRX main and lores; compact producer ownership preserves
actual source bytes. Existing canonical RGB rows still borrow; conversion costs
are explicit. See packed-rgb.md for names, coverage and remaining hardware work.

Local release checks pass 828 Bun tests and 348 native tests, C ABI, exact SDL
pixel readback, C/Bun type/format checks and CLI image/sidecar/recording comparisons.
The normal local Zig build runner again fails macOS SDK/libSystem linkage before
project compilation; target-qualified direct library/native/CLI builds pass.
Independent video decoding and real-backend compilation are checked by Linux CI;
no local independent AVC/HEVC decoder or physical camera is present.

## 0.77 planar and semi-planar YUV

The audit starts at clean Home main 321fe476c625d398d9b80abaaa8695e110025ae2
and inspects video/core/pixel_convert, yuv_rgb, yuv_remap and plane_pack. Home
already names NV12/NV21, but its RGB routes used unchecked per-pixel reads and
selected one corner for subsampled chroma. The checked I420 decoder and remapper
already implement shared block arithmetic and matrix/range policy worth reusing.

Home commit 26f842190aa69a3d23ed73756ecc4815b0433e80 extends logical Y/U/V
views with checked chroma step 1/2, zero-allocation semi-planar constructors,
canonical packing and shared NV encoding. Public RGB24/NV12/NV21 routes use them,
including four-pixel chroma averaging. RGB decode/encode and remapping preflight
source/destination bounds and overlap; source U/V aliases remain intentional for
interleaved input. Other Home conversion routes retain their existing behavior
and are not declared fully checked. Pinned/development Zig both pass Debug and
ReleaseSafe tests across every matrix/range, planar equivalence and failure case.
Home-hosted Actions remain separate: no run is available for this published head.

The yuv_rgb/remap improvements are copied verbatim here. Hosted C/Bun/CLI select
YVU420/NV12/NV21 and preserve physical layout in raw copies and producer queues;
workers use logical U/V views directly, avoiding a producer-side chroma shuffle.
All async input still has explicit bounded copied ownership. Shared raw-copy
plans serve capture bundles and encoder admission; no C ABI/module cycle is
introduced. A native test inspects queued physical bytes before starting the
worker and overwrites the original source. The C alignment planner also now
checks format/color options before its layout switch, rejecting invalid codes
without mutating either output. See yuv420-layouts.md for supported layouts and
remaining physical acceptance requirements.

Local checks pass the full 855-test Bun suite, C ABI and SDL matrix/range pixel
readback, Home compiler matrix and CLI raw-layout/image/recording comparisons.
The standard local build runner still fails SDK/libSystem linkage before
project compilation; direct target-qualified native/CLI builds succeed. Local
independent still decoding is available; Linux CI supplies independent AVC/HEVC
decoding and real-backend compile/load/no-camera smoke. No camera is attached.
The final native suite passes 353 tests, including the inspected YVU/NV producer
payload after source overwrite and joined worker completion. This validates the
physical-layout queue contract rather than inferring it from decoded pixels alone.

## 0.78 packed 4:2:2

The audit starts at clean Home main 26f842190aa69a3d23ed73756ecc4815b0433e80
and reads core/pixel_convert, yuv_rgb/remap and packed_rgb. YUYV/UYVY reads exist,
but packed writes fell through the setter without initializing output. Shared
RGB layout checks, fixed-point color coefficients and direct I420 remapping are
reused rather than introducing a parallel color implementation in camera code.

Home commit 49793c1fe7b6d65e58833cdc880ec1dd48326f0e adds a checked packed-422
view for all four byte orders, RGB encode/decode and repacking, plus direct I420
sampling/remapping. Horizontal RGB chroma uses both pixels; vertical 422-to-420
chroma uses adjacent-row averages. Public packed routes use these helpers and
append YVYU/VYUY enum entries without moving earlier IDs. Unrelated conversion
routes remain outside this guarantee. Home tests pass pinned/development Zig in
Debug/ReleaseSafe, including independent floating color/chroma references and
atomic bounds/overlap failures. Home-hosted Actions still supplies no run for the
published head; local/camera matrix results remain separate evidence.

The new packed_yuv422 and updated yuv_rgb/remap modules are copied verbatim here.
Hosted source selection, retained planes, pixel copies and SDL lifetime stay in
camera code. Queue payloads retain physical bytes at two bytes per pixel; workers
perform codec conversion. C/Bun/CLI use even width with odd capture height, while
codec I420 keeps even height. Raw size queries additionally reject odd-width
external descriptors without changing the output count. See yuv422-layouts.md.
Local final checks pass 884 Bun tests, 357 native tests, C ABI, SDL matrix/range
readback and CLI raw-layout/image/recording comparisons. The normal local build
runner again fails macOS SDK/libSystem linkage before project compilation;
target-qualified direct native/library/CLI builds pass. Linux CI supplies the
independent AVC/HEVC decoding and real-backend compile/load/no-camera evidence;
local independent still decoding is available, but physical capture is not.

The 0.79 RGB16 audit checks Home image raster Views (existing 16-bit PNG/TIFF
preservation and BMP high-byte policy), packed RGB views and video converters at
49793c1fe7b6d65e58833cdc880ec1dd48326f0e. Those byte-oriented converters cannot
represent three independent u16 channels. Home main commit
0e0dc7d39b71f422ac22e5707e0ce44dfaf72ecd contributes image ops/rgb16_view.zig,
its public Rgb16View alias, documentation and helper workflow coverage. The std-only
view preserves low bits across checked byte/word-order conversion, supports
unaligned/padded rows and explicitly reduces to RGB8 via sample >> 8. It is copied
verbatim here, with existing Home raster/JPEG/codecs/containers reused unchanged.
The recorded Home OS audit excludes RGB565/gamma kernel code from this boundary.

Pinned Zig 0.15.2 and Home development Zig pass both helper tests in Debug and
ReleaseSafe. The complete Home image API passes 119 tests on development Zig.
Home-hosted Actions still returns no run for this exact published head; these
local and camera-consumer checks do not substitute for Home-hosted CI evidence.

Hosted main/lores capture, raw copies/mappings and producer admission preserve
six physical bytes per pixel. Owned RGB16 copies and PNG/TIFF/PPM preserve every
word, including existing ICC/Exif paths where applicable. RGB8 JPEG/BMP/preview
and current video codecs use the explicit high-byte policy. Workers reuse their
RGB scratch; producer queues retain low bits and release camera leases before
output I/O. Mode switches and fresh-camera recovery carry these formats through
existing transaction owners. Synthetic gradients expand an 8-bit pattern; tests
write deliberately different high/low words to verify precision independently.

Local evidence: 905 Bun tests, 360 target-qualified ReleaseSafe native tests,
C ABI and SDL pixel readback, typecheck, fmt and CLI raw/image/recording checks.
The normal local build runner still fails macOS SDK/libSystem linkage before
project compilation; direct library/CLI builds succeed. Linux CI supplies raw16
libpng/libtiff and AVC/HEVC independent decoding, plus old-SDK real-backend
compile/load/no-camera cleanup. No sensor precision or physical performance result
is inferred, and higher-bit-depth video/gamut/transfer conversion remains open.

The 0.80 sensor-raw audit inspects Home image raw.zig (BayerPattern/RawImage), its
formats/raw.zig TIFF decoder, checked image views and video conversions at
0e0dc7d39b71f422ac22e5707e0ce44dfaf72ecd, plus Home OS at the recorded revision.
RawImage stores Bayer u16 data but provides no checked borrowed CSI-2/mono/COMP1
view; generic TIFF decode is not sensor-block decompression. Home main commit
82d0989566ca6f4e01a48fc0d6d581a54072e5ef adds ops/sensor_raw.zig, reference vectors,
Bun vector tooling, public SensorRaw alias, docs/license and workflow coverage.
Both Zig modules are copied verbatim here. COMP1 adapts Picamera2's pinned
Helpers.decompress under its retained BSD-2-Clause license; the other checked
view/packing code uses Home's MIT terms. No Python or FFmpeg dependency is added.

Five helper tests pass pinned/development Zig in Debug and ReleaseSafe, including
455 scalar reference words, every legal companding-code pair, canonical formats,
partial groups, padding/unaligned input, clipping, overlap/overflow/truncation and
late sample errors without output changes. Home's full image API passes 125 tests
on development Zig. Home-hosted Actions has no run for this head; local and copied
camera checks are distinct from that unavailable evidence.

Hosted raw16 copies use existing lease/mapping exclusion. Physical bundles retain
COMP1/CSI-2 bytes, while DNG decodes only row scratch and mono omits fabricated
color/CFA calibration. Synthetic raw generation now covers all supported packing;
its COMP1 output is deterministic quantizer fixtures, not general compression.
Temporary DNG jobs/CLI preserve explicit raw formats instead of forcing unpacked
input. Native discovery includes mono modes and retains compressed Bayer CFA
renaming without inferring ADC depth from a compressed format name.

Local evidence: 964 Bun tests, 364 target-qualified ReleaseSafe native tests, C
ABI ownership/atomic-copy tests, full CLI format regressions, typecheck/fmt and the
Home matrix. The normal macOS build runner still fails SDK/libSystem linkage
before project compilation; direct library/CLI builds succeed. Linux CI adds
independent libtiff DNG sample readback and LibRaw recognition, plus real-backend
old-SDK compile/load/no-camera cleanup on ARM/x86. Physical Pi format/quality,
calibration/precision, additional compression/DNG behavior and performance remain
unverified; no parity completion is inferred from format coverage.

The 0.80.1 still-media audit at Home 82d0989566ca6f4e01a48fc0d6d581a54072e5ef
found duplicate errdefer owner destruction in the shared zlib_stream factory.
Host allocation-failure tests stop before native initialization and could not
observe this failure in zlib's separate allocator. A private initializer seam
reproduces memory/stream/version error results after successful owner allocation;
with duplicate cleanup it crashes in a second free. Home main commit
cf409eea44d0769862b2c04dd5717a930673579c removes the duplicate, keeps validation
and owner allocation before native init, and tests all native failure results
without publishing an owner. The module is copied verbatim here. No public API,
configuration switch, ABI or codec dependency changes. Pinned/development Zig
pass Debug and ReleaseSafe; the complete Home image API passes 126 tests.
Home-hosted Actions evidence remains unavailable and is not claimed as green.

The audit also identifies later GIF/APNG work: Home's GIF writer emits one image,
its literal LZW path never grows code width, and the APNG path bypasses checked
raster row encoding. Those capabilities remain in the parity worklist; their
presence in a source file is not completion evidence. This patch fixes the
shared native PNG initialization prerequisite without claiming animation support.

The 0.81 still-animation audit starts at Home
fdd4c7e2c20444a6db35f16bda9a980618f353b0 and Home OS at the recorded revision.
Home's preceding GIF correction fixes dictionary code widths, video quantizer
palette ownership and frame-control scope; those source corrections supersede
this document's earlier fixed-width GIF finding. Palette quality, Image GIF
animation and camera GIF capture remain separate work.

The APNG audit finds the Image path bypasses checked raster encoding: little-
endian 16-bit samples are copied as native bytes, short frames leave filtered
scratch uninitialized, first-frame control/pixels come from different owners,
rectangles lack dimensions and delay_ms is clamped. Home contribution
924bbf199cc3a7ffed382fb5c8d44f891eb8b786 adds a portable checked APNG encoder,
shares PNG row/header/chunk functions, corrects the Image adapter and indexed
alpha expansion, and preserves PNG/WebP decoded rectangle sizes. A local copy of
the previous encoder fails the first-frame regression (zero main-image pixels
instead of the supplied frame). The current complete Home Image API passes 140
tests on development Zig. Home hosted Actions remains unavailable; its configured
workflow is not presented as an executed pass.

The APNG and raster modules and independent test fixtures are copied verbatim to
camera, with public Zig ApngEncoder and copied-capture ownership coverage. Seven
new helper tests plus existing raster/zlib tests pass pinned/development Zig in
Debug and ReleaseSafe. Each of those four builds passes 216 C/libpng fixtures for
frame samples, independent CRC/order/sequence/control checks, rectangles, static
image participation, gray/RGB/RGBA, 8/16 bits, every filter, mixed endian, padded
unaligned rows, source retirement and multi-chunk data. The C harness reconstructs
static frame PNGs; it is not an APNG compositor. Camera still PNG uses the shared
refactor without changing C/Bun format selections. Bun/C animation capture,
joined jobs/atomic animated files, metadata and GIF remain parity work. No Python
or FFmpeg dependency is added; no physical camera result is inferred.

Camera-local validation for this reuse passes 373 target-qualified ReleaseSafe
native tests, all 965 Bun tests with image/ICC/Exif/AAC/preview decoders enabled,
C ABI checks, typecheck/fmt and 216 copied independent libpng fixtures. The normal
local build runner still fails macOS SDK/libSystem linkage before compilation;
the direct library and native-test builds succeed. These local results do not
substitute for Linux real-backend CI or attached Pi/camera measurements.
