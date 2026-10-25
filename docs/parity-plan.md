# Picamera2 capability parity worklist

Version 0.121 adds [owned CNN output tensors](cnn-outputs.md):
selective request snapshots, checked column/row storage and retained capture
context in C/Zig/Bun. Firmware/network loading, ROI/input tensors, model
postprocessing and physical IMX500 acceptance remain open.

Version 0.120 adds [timestamp-matched multi-camera capture](synchronized-capture.md):
bounded same-host request groups, backend readiness, retained results and joined
cancellation/stop/cleanup. Physical synchronization and the other parity families
remain open.

Version 0.119 adds [owned raster compositing](image-compositing.md): Home exact
source-over shared with APNG, clipped RGBA8/16 results, explicit sample/color
policy and two-input copied async jobs with joined cancellation. Remaining image
operations, color conversion, GUI/GPU and physical acceptance remain open.

Version 0.118 adds [multi-object capture planes](capture-planes.md):
linear planar/semi-planar imports and factories, per-object budgets/maps/fences,
exact new factory loans, unchanged logical geometry and retained cleanup.
GPU-specific layouts and physical Pi acceptance remain open.


Version 0.117 adds [automatic capture buffer factories](capture-factories.md):
actual negotiated layouts, asynchronous caller-input release, bounded native
notification ownership, joined cancellation/rollback and async Camera.open in
Bun. Physical Pi acceptance and the remaining parity families stay open.


Version 0.116 adds explicitly provisioned caller-owned Linux capture buffers,
exact negotiated allocation snapshots, whole-object budgets, FD identity/offset
validation, DMA_SYNC capability checks, inherited mode workers and retryable
cleanup in Zig/C/Bun; see capture-imports.md. Automatic factory callbacks,
multi-object/GPU frame layouts and physical Pi acceptance remain open.

Version 0.115.1 fixes retained cleanup of failed shared-memory unmaps in Home
and camera export/remote owners, with bounded explicit retry and telemetry in
Zig/C/Bun. See shared-cleanup.md. This is an ownership prerequisite for custom
allocation; imported custom buffers and allocator factories remain open.

Version 0.115 adds bounded persistent DMA heap/synthetic capture allocation in
Zig/C/Bun with actual-layout reuse, retained request/map/export owners, worker
pins, mode/recorder/group rollback and independent overlapping reconnect loans;
see capture-allocator.md. Shared Home resources retain cleanup failures for retry.
Custom allocator callbacks, GPU storage, physical Pi acceptance and the other
capability families below remain open.

Version 0.114 adds bounded owned JPEG loading through shared Home scan and
restart reconstruction, component sampling, progressive refinement and source
metadata, with native workers and shared JPEG/PNG file budgets. See jpeg-loading.md.
Arithmetic/lossless/higher-precision JPEG, further formats/operations, profile
conversion and physical acceptance remain open alongside the other families.

Version 0.113 adds separate DRM alpha planes through shared Home two-plane
atomic ownership, named blend modes, strict stacking, async overlay jobs and
joined mode/recorder restoration. See drm-overlays.md. Physical acceptance,
desktop/GUI integration, mode setting and the remaining capability families
below are still open.

Version 0.112 adds optional explicit RGB16/BGR16 high-byte DRM display copies
through Home's checked word views and two reusable driver allocations, with CPU
coherency fences, input retirement before flip waits, storage telemetry and
retained cleanup retries; see drm-rgb16.md. Other formats/modifiers,
desktop/GUI integration and physical acceptance remain open.

Version 0.111 attaches the native DRM worker to Camera through an explicit
backend, bounded skip feed, async view/source/drain/stop jobs and joined mode,
recorder/group, close and reconnect transitions; see camera-drm-worker.md.
Desktop integration, additional display formats and physical
acceptance remain open. This does not complete the overall parity goal.

Version 0.110 adds an independent native async DRM consumer with bounded worker
jobs and Bun frame/view/background/drain/close operations; see drm-async.md.
Version 0.111 provides explicit Camera ownership as described above; the
independent consumer still requires application-managed source retirement.

Version 0.109 adds direct linear DMABUF DRM preview through shared Home atomic
plane ownership and C/Bun APIs; see drm-preview.md. Flip completion proves source
retirement; uncertain submissions retain possible owners for explicit cleanup
retry. Desktop leases/shared-card ownership and physical display
acceptance remain open alongside the full
capability families below.

Version 0.107 adds bounded sequential APNG display canvases through shared Home
integer compositing and C/Bun ownership; see png-compositing.md. Additional image
formats/operations, asynchronous compositing and other animation/color semantics
remain open alongside all other required capability families and hardware
acceptance. This feature does not complete the overall parity goal.

The goal is full capability parity through Zig/C and TypeScript/Bun, with Home
codecs/containers and no Python or FFmpeg runtime, tools or bindings. Publishing a
feature release or passing existing tests does not complete this goal.

The reference audit pins raspberrypi/picamera2 commit
5e2a35d3bb230825c98c56d98e01b41ddeb43e86. The adjacent parity-reference.json records
public names in 51 source modules, including capture, configuration, preview,
encoders, outputs, allocators, remote processing and camera-specific inference.
It was derived by inspecting source text, never executing it. It is a lexical
inventory, not a complete semantic export inventory: conditional definitions,
inherited methods, configuration fields, constants and documentation still need
manual review before completion. Recheck upstream changes during the final audit.

## Required capability families

| Family | Evidence now | Outstanding work before parity |
| --- | --- | --- |
| Discovery/configuration | Unacquired global discovery, typed properties/control catalogs, shared manager, cached sensor modes, backend/index/exact-ID selection with pinned mode reopens, RGB/BGR/RGBX/BGRX/I420/YVU420/NV12/NV21 and packed YUYV/YVYU/UYVY/VYUY and RGB161616/BGR161616 main and lores, raw, explicit processed color descriptions, requested/effective/actual negotiation with strict adjustment policy, roles, negotiated geometry, requested/actual orientation with strict policy and mode restoration; explicit VC4/PiSP/minimum processed geometry planning with atomic configuration outputs; owned bounded tuning document load/lookup/edit/save for both JSON layouts; native Raspberry Pi IPA profile reservation/application with manager-lifetime file/environment ownership, sharing/conflicts and mode/recording rollback retention; terminal device loss, retained lease/map cleanup, coalesced observers and mode-worker loss handoff; bounded manager hotplug watches with full IDs, overflow/rescan and tuning ownership across camera gaps; exact-ID bounded reconnect jobs producing independently owned replacement cameras with validated persistent controls/CAF, joined cancellation and retained cleanup owners; coordinated all-active recorder recovery into a fresh camera with shared encoder publication, retained PCM phase, preview and owned overlay restoration | Continuous background reconnect supervision, richer mode limits, additional stream configuration/formats, physical color-space acceptance, physical orientation/alignment/stride acceptance, physical IPA/tuning/hotplug acceptance and remaining reconfiguration semantics |
| Requests/capture | Retained references, owned RGB/raw16/raw/lores bundles and metadata, bounded capture jobs, JPEG/DNG, owned temporary-mode image jobs with target precision/provenance and worker resizing after restoration, retained target capture-and-stop and temporary-mode paired main/raw/lores copies with metadata and staged file publication after callbacks/restoration, timestamp/frame-drop barriers, scoped mapped planes and RGB/planar-YUV/NV/packed-422/Bayer rows; lazy fast/paced file series with joined publication and bounded partial progress; backend SyncReady request selection combined with drops/timing/CAF and request-local signed sync metadata; bounded two-through-eight same-host timestamp-matched Bun request groups, Home Zig/C matching, retained input-order results and joined cancellation/stop/cleanup | Complete format conversions and compressed raw, remaining multi-camera request/mode semantics and physical synchronization acceptance, remaining retained-request restoration conveniences, additional burst configuration/capture equivalents and convenience semantics |
| Controls/metadata | Atomic native/vendor and convenience batches, exact typed persistent snapshots/replay, AF scan and CAF pause/resume/lock jobs, owned full typed metadata/control catalogs with vendor/opaque preservation | Metadata mapping conveniences, opaque write semantics if exposed by future backends, remaining sensor-specific control/timing behavior and physical sync-control acceptance |
| Preview/UI | SDL/headless preview through the shared native request pump, explicit suspension and joined lifecycle, bounded native RGBA overlays, SDL alpha composition, window/view/aspect controls, independent orthogonal image/overlay transforms and rectangles, main/RGB-BGR-RGBX-BGRX-RGB16-BGR16-I420-YVU-NV-422 lores/background selection with atomic live replacement, isolated display failure and mode restoration; explicit Camera-owned native DRM worker with bounded frame offers, async view/source/drain/stop jobs, cleanup retries and joined mode/recorder/reconnect ownership; explicit high-byte word display copies with reusable driver buffers and source-independent scanout; separate alpha overlays with named blending/strict stacking, atomic video/UI updates, bounded driver pools, async jobs and shared master/cleanup ownership |  Additional display formats, DRM mode setting/desktop leases, GPU/GUI integration and physical acceptance |
| Still media | Home JPEG/PNG/BMP/TIFF/PPM/GIF, independent main/lores RGB8/RGB16 image objects with checked clone/crop/gray-RGB-RGBA conversion, owned sync/async clipped straight RGBA8/16 source/over composition with explicit sample/color policy, exact orthogonal transforms, and bounded sync/async PNG/APNG loading with raw animation/metadata ownership; bounded sequential/progressive 8-bit JPEG loading with component sampling, restart/progression validation and source ICC/Exif, native workers and shared JPEG/PNG file admission; bounded sequential RGBA8/16 APNG display composition with alpha and disposal, owned snapshots and iterator retirement; bounded native-precision resizing with capture-time dimensions and encoding/saves, bounded async APNG byte/file encoding and RGB8/RGB16 main/lores capture bursts with joined cancellation/publication, and calibrated Bayer/mono DNG with checked CSI-2 and PiSP COMP1 row decoding; atomic files and owned encoded bytes from main/RGB-BGR-RGBX-BGRX-RGB16-BGR16-I420-YVU-NV-422 lores across capture/CAF/mode jobs; negotiated color metadata and copied RGB ICC and typed/raw capture Exif in JPEG/PNG/TIFF across capture jobs | Remaining image-object transforms, additional external decoded formats and other animation semantics, asynchronous display compositing, APNG metadata/temporary-mode animation capture conveniences, additional pixel formats/demosaicing, complete Exif/tag/thumbnail semantics and physical metadata acceptance, advanced DNG/decompression behavior and color conversions |
| Encoders/recording | Home MJPEG, AVC, HEVC, AAC, MKV/MP4; named software JPEG/AVC quality tiers and a shared HEVC rate heuristic with exact rational planning, limits admission and session propagation; repeated in-band parameter sets on packet keyframes with immutable first-only opt-out across outputs and sessions; counted public IDR requests with synchronous/async producer ordering, cancellation and per-session accounting; copied AVC profile ceilings, validated codec presets and fixed-QP session policies with Baseline/Main container configuration; mixed tiny/4K HEVC with shared CTU32 and visible conformance crops; copied decoder-level ceilings and VBV/CPB policies with nominal resource/actual-header checks and explicit coordinated resets; copied session color profiles with matching matrix/range conversion and ISO/VUI/nclx across native/Bun outputs, snapshots, restart/reconfiguration and coordinated modes; main/RGB-BGR-RGBX-BGRX-RGB16-BGR16-I420-YVU-NV-422 lores encoder sources, compact producer ownership, shared encoding and session transactions, bounded independent encoders with wait/drop policy and shared PCM retention/catch-up and coordinated all-active encoder mode transactions | Complete upstream quality/rate-control behavior, additional pixel formats/raw input, general gamut/transfer conversion, MJPEG/Matroska color metadata options, independent cadence/resampling and physical shared-audio acceptance, hardware encoder paths where available, timestamps and metadata inputs |
| Output families | File/custom output objects, circular/delayed A/V, PTS, split/rotation/recovery, bounded async I/O; Home AVC/HEVC/AAC RTP framing and bounded Bun UDP sender with signed AAC priming, shared RTCP correlation, actual-header SDP and recorder recovery/circular snapshots; bounded raw TCP/UDP elementary video and Home Matroska TCP A/V with joined prefix/flush/close semantics; supervised raw/Home-container process outputs with bounded diagnostics and parent-fd/group joins | Remaining upstream buffering/flush semantics, remaining muxer/network/process-output equivalents through Home/Bun, RTCP feedback/congestion/RTSP/SRTP session behavior, full close/reopen/failure coverage |
| Scheduling/extensibility | Bounded Bun jobs, cancellation, completion callbacks, drains, joined native ownership, exact frame dropping/timestamp waits, scoped pre/post callbacks with main-thread mode-worker handoff and explicit retained acquisition | Complete arbitrary dispatch/wait/cancel/flush semantics and remaining callback/allocator integration behavior |
| Memory/process boundaries | Retained pointer-free descriptor exports with duplicated fds, explicit fd-less staging, full typed metadata and one whole-frame gate; bounded actual SCM_RIGHTS channels, cached shared catalogs, checked receiver-owned maps, explicit ACK primitives, request-owned configuration across source/export/remote/process boundaries, parent-controlled process byte-result publication after matched result/ACK with source retirement before I/O and retained task drains, bounded joined remote asynchronous still encoding/staged saves with owned metadata, remote owned image copies, compact/shaped/physical/raw16 copies, calibrated DNG and processed saves with request-derived Exif/ICC encoding, and opt-in scoped write planes; supervised actual Bun process pools with native moved-export/argument/result admission, matched ACK/result routing, verified-exit cancellation, isolated failures, generations and callback-aware prefix drains; bounded persistent DMA heap/synthetic backing with exact layout reuse, mode-worker pins, retained cleanup and overlapping reconnect loans; persistent DMA maps, bounded retained requests, scoped read/shared and write/exclusive native mappings; opt-in Bun write contexts with detached views on close | Remaining allocator conveniences, physical allocation/import/coherency acceptance, remaining remote conveniences, richer value and automatic recovery semantics, remaining IPC/allocator behavior; GPU integration remains unimplemented |
| Camera-specific integrations | Generic typed libcamera controls; bounded pre-open IMX708 sensor HDR helper with exact identity, exclusive manager/layout guards, readback diagnostics and fresh mode catalogs; independent runtime HdrMode with staged control replay | Remaining IMX708 workflows and physical HDR acceptance, IMX500 tensor/network/inference/ROI workflows, Hailo integration and postprocessing equivalents; hardware-backed validation |
| Hardware/quality/performance | Synthetic ownership/media tests; Linux x86/ARM real-backend build/load/no-camera smoke; independent decoders | Matched Pi camera benchmarks, sensor/optics controls, sustained capture/preview/video, disconnects, physical A/V synchronization, multi-camera and device-specific acceptance |

Python class signatures and FFmpeg/PyAV subprocesses are not implementation
requirements under the user's constraints; their camera/media/output capabilities
remain requirements and must have verified Zig/Bun/Home equivalents. Platform
integration gaps cannot be declared complete merely because SDL or a custom sink
exists. Optional hardware must have an implementation and appropriate acceptance
evidence, not fabricated sensor results.

## Completion evidence

For each reference capability, identify its concrete implementation, public API,
positive and failure tests, platform coverage and required hardware observations.
Review omitted exports and upstream changes. Distinguish synthetic semantics from
physical results. All required capabilities and validation remain in scope until
proven; this worklist must not be reduced to the already implemented subset.

Still-metadata foundation evidence is tracked in still-metadata.md. The shared
Home ICC profile/curve corrections and independent CMM tests are available;
public ICC embedding and scoped capture Exif options are implemented. Complete
tag/thumbnail semantics and physical metadata acceptance remain required. A valid profile alone does not establish matching pixels
or sensor quality. Temporary-mode files now use staged publication with
request-callback/restoration preconditions and joined native disposal; see
staged-files.md for the implemented claim, cancellation and I/O outcome contract.

The shared Home layer additionally implements combined JPEG/PNG/TIFF ICC/Exif
embedding with pointer/byte-order relocation and independent reader/decoder checks.
Capture-facing Exif now derives selected dimensions, exposure, gain-based ISO
and explicit UTC times, with caller precedence and copied admission across file,
owned-byte, focus and temporary-mode jobs; see capture-exif.md. This is a scoped
software capability, not complete Exif/Picamera2 or physical sensor acceptance.


RGB16 processed formats now have checked main/lores word capture, owned RGB16
copies, full-precision PNG/TIFF/PPM and explicit high-byte preview/JPEG/video input;
see rgb16.md. Physical format/bit-depth support, higher-bit-depth video, general
transfer/gamut conversion and the broader required families above remain open.
This feature does not complete Picamera2 capability or hardware parity.

The 0.81 APNG foundation exposes the checked Home encoder through Zig over owned
or borrowed capture raster views, with frame rectangles, rational delays,
disposal/blend and separate default-image support; see apng.md. Home's Image API
also receives corrected animated PNG encoding. Version 0.82 adds bounded Bun/C
encoding jobs, owned main/lores RGB8/RGB16 bursts and joined staged publication;
see apng.md. Image-object/compositing equivalents, animation metadata,
temporary-mode animation conveniences and the broader still-media requirements
remain open. This does not complete the still-media family or hardware parity.

Version 0.83 adds Home GIF still capture across C/Zig/Bun/CLI and processed
main/lores streams, with explicit palette/RGB16/alpha policies; see gif.md.
Ordinary and focus-locked files now delay publication through callbacks and CAF
restoration. Image animation/compositing, decoded objects, background GIF
compression jobs, further metadata/format work and physical acceptance remain
open. This does not complete the still-media family or the overall goal.

Version 0.84 adds owned image capture/callback equivalents, checked word
conversion and staged standalone saves after source/camera retirement; see
image-objects.md. General resampling, decoded file formats, palette/float/gamut
conversion, temporary-mode image conveniences and complete image/animation
semantics remain required work as applicable. Hardware acceptance and the broader
parity families remain open; this does not complete the goal.

Version 0.85 adds explicit owned image resizing and capture-time dimensions,
using Home's native-precision, widened-window separable resampler; see
image-resizing.md. Filters/alpha/limits are defined explicitly and do not promise
Pillow-identical samples. Remaining image transforms, decoding, temporary-mode
image conveniences, complete compositing/color semantics and physical acceptance
remain open. This does not complete the still-media family or overall goal.

Version 0.86 adds temporary-mode owned image jobs with target-time native
precision/provenance, joined release/restoration, worker resampling, one buffer
transfer and post-preview sealed publication; see mode-images.md. General
decoding/compositing, animation conveniences and the other required capability
families remain open. This does not complete the overall parity goal.

Version 0.87 adds retained fd export owners and independent exec/SCM_RIGHTS
validation; see frame-exports.md. Production process supervision, ACK routing,
timeout/exit cleanup, remote scoped requests/pools and persistent allocator
semantics remain required. Descriptor export alone does not complete memory/
process parity, physical DMA acceptance or the broader goal.

Version 0.88 adds bounded local descriptor transport and receiver-owned remote
frames with explicit ACKs and Home image copies; see frame-channels.md. Production
process jobs/pools, automatic result/ACK routing, timeout/cancellation/exit
joining, configuration/property snapshots and remaining remote conveniences
remain required. This does not complete memory/process or physical DMA parity.

Version 0.89 adds supervised actual process jobs/pools with native ownership,
argument/result reservations, joined cancellation/failure, generation restarts
and callback-aware drain/close; see process-pools.md. Complete remote array/
buffer/save/DNG and configuration equivalents, richer values, automatic recovery,
persistent allocator/GPU integration and broader hardware/parity families remain
required. This does not complete the overall goal.

Version 0.90 adds compact remote stream bundles, shaped typed arrays, physical
buffer and Home raw16 copies, immutable request calibration transport and
calibrated DNG/processed saves across C/Zig/Bun/process workers; see remote-media.md.
Further remote configuration/property, async/metadata/file-like save semantics,
advanced DNG, automatic recovery, persistent allocator/GPU integration and all
other required families and physical acceptance remain open. This does not
complete the overall parity goal.

Version 0.91 adds remote request-derived Exif and ICC image encoding/saves,
including JPEG defaults, selected dimensions/exposure/gain ISO/model/UTC,
explicit overrides and unchanged channel schema; see remote-exif.md. Complete
metadata, async/file-like publication, remote configuration/property, allocator,
automatic recovery, optional integrations and physical acceptance remain open.
This does not complete the overall parity goal.

Version 0.92 adds immutable request configuration across C/Zig/Bun, exports and
remote process workers, using bounded Home catalog projection without another
transport version or fd; see request-configuration.md. Full property snapshots,
async/file-like publication, allocator and automatic recovery, optional
integrations and physical acceptance remain open. This does not complete parity.

Version 0.93 adds bounded native remote image encode/save jobs and asynchronous
DNG with source-independent input, Home workspace budgets, copied Exif/ICC and
joined staged publication/cancellation; see remote-async.md. Full property
snapshots, file-like and parent-controlled process publication/cleanup, allocator
and recovery semantics, optional integrations and physical acceptance remain open.

Version 0.94 adds parent-controlled process file publication through the existing
result/ACK transport and bounded copied-byte native staging; see process-files.md.
Direct descriptor streaming, file-like destinations, full property snapshots,
allocator/recovery and optional camera integration families and physical
acceptance remain open. This does not complete the overall goal.

Version 0.95 adds joined sequential still destinations on local frames, remote
frames and owned image objects, native async local/raster encoding, bounded
partial writes and flush/cancellation, and retained Home admission through slow
output I/O; see image-outputs.md. Existing staged image bursts preserve their
32-file bound with cancellable codec-capacity waits. Capture/mode sink convenience
jobs, incremental streaming, full metadata/property/allocator/recovery behavior,
optional integrations and physical acceptance remain open. This is not parity.

Version 0.96 adds ordinary, CAF-locked and temporary-mode camera output jobs,
with parent-owned native image preparation, source retirement and selected
callbacks/CAF/camera/preview restoration before bounded sink delivery; see
capture-outputs.md. Still hooks share asynchronous lifecycle reentrancy guards.
Burst/series sink conveniences, further properties/allocator/recovery behavior,
incremental encoding, complete metadata/device integrations and all physical
acceptance remain open. This does not complete full Picamera2 parity.

Version 0.97 adds exact owned source properties across local frames, callback
scopes, retained exports and actual remote/process workers. Home's new checked
nested-catalog helper preserves vendor/native/opaque bytes within existing
metadata transport; camera caches immutable session properties and preserves
legacy absence and bounded combined-catalog failure. See request-properties.md.
Mapping conveniences, remaining allocator/GPU/recovery/output/device behaviors,
complete metadata semantics and all physical acceptance remain open.

Version 0.98 preserves full source Model strings in automatic Exif and calibrated
DNG across local/remote copied jobs, with Home strict borrowed string lookup,
explicit Exif override precedence, bounded dynamic TIFF directories and charged
async model ownership. See source-model.md. Localized model/DNG metadata, complete
image transforms/decoding, remaining allocator/GPU/recovery/output/device families
and all matched physical/performance acceptance remain open. This is not full
Picamera2 parity.

Version 0.99 adds exact native-precision owned-image rotations/flips/transpose
through Home's checked copies and shared native geometry, with C/Zig/Bun entry
points and retained color/request provenance. Home Image operations now preserve
native words, indexed palettes and transformed animation rectangles/owners.
See image-transforms.md. General-angle/affine transforms, compositing, decoding,
remaining allocator/GPU/recovery/output/device families and physical/performance
acceptance remain open. This is not full Picamera2 parity.

Version 0.100 adds bounded PNG/APNG decoding and Bun file loading, exact native
word reconstruction, packed/Adam7 input, explicit raw animation rectangles and
copied color/Exif metadata. Shared Home work also corrects the public Image
decoder; native decode jobs reuse Home gates/budgets and share still-encoder
admission. Other decoded formats, compositing and the remaining families above
remain open. No hardware or comparative-performance acceptance is implied.

Version 0.103 adds reusable bounded raw TCP/UDP video output and a TCP byte sink
for Home Matroska A/V, with checked shared Home send progress, peer half-close,
joined lifecycle/deadlines, shared PTS, isolated recovery and async output splits.
See socket-output.md. Listening/process outputs, broader network protocols and
sessions, remaining buffering/flush behaviors and all other capability families
and physical acceptance remain open. This does not complete full parity.

Version 0.104 adds supervised process video output and Home-container byte sinks,
with shared Home bounded diagnostics/control framing and a standalone Zig host,
exec readiness, joined cancellation, ordinary descendant groups and parent-fd
loss, immutable argv/env, shared socket/process admission, isolated recovery and
async splits. See process-output.md. Additional media containers/protocols,
escaped or hard-killed-supervisor process-tree policy, remaining output semantics
and every other required family and physical acceptance remain open. This does
not complete Picamera2 parity.

Version 0.105 adds forward-only AVC/HEVC/AAC fragmented MP4 byte outputs with
bounded deferred initialization, real first-PCM clock binding, final tail trim,
64 KiB prefix writes, async splits/restart, circular snapshots and isolation.
See forward-mp4.md. This general ISO BMFF mode does not claim CMAF/MSE or player
interoperability. Broader containers/protocols, remaining output and device
families, physical synchronization and matched performance remain open. The
full Picamera2 parity goal is still active.

Version 0.106 adds one-peer listening TCP byte/raw outputs, shared dialing/accept
TCP chunk ownership, immutable session endpoints, joined bind/accept cancellation,
write deadlines and global transport admission. Real loopback tests exercise raw
Home codecs, PCM Matroska, decoded AAC fMP4, async splits and isolated recovery.
See listening-output.md. Borrowed socket adoption, multiple consumers, broader
protocols, other capability families and physical/performance acceptance remain
open. This does not complete Picamera2 parity.

Version 0.106.1 hardens process retirement with independent cancellation and proof
channels, joined ownership of both sockets, native closed-descriptor checks and
controlled unread-cancel terminal fixtures. The record ABI and strict final proof
requirement remain unchanged. Full Picamera2 parity and physical acceptance remain
open; this is an output-lifecycle correction.
