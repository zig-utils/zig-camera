# Picamera2 capability parity worklist

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
| Requests/capture | Retained references, owned RGB/raw16/raw/lores bundles and metadata, bounded capture jobs, JPEG/DNG, retained target capture-and-stop and temporary-mode paired main/raw/lores copies with metadata and staged file publication after callbacks/restoration, timestamp/frame-drop barriers, scoped mapped planes and RGB/planar-YUV/NV/packed-422/Bayer rows; lazy fast/paced file series with joined publication and bounded partial progress; backend SyncReady request selection combined with drops/timing/CAF and request-local signed sync metadata | Complete format conversions and compressed raw, synchronized multi-camera requests, remaining retained-request restoration conveniences, additional burst configuration/capture equivalents and convenience semantics |
| Controls/metadata | Atomic native/vendor and convenience batches, exact typed persistent snapshots/replay, AF scan and CAF pause/resume/lock jobs, owned full typed metadata/control catalogs with vendor/opaque preservation | Metadata mapping conveniences, opaque write semantics if exposed by future backends, remaining sensor-specific control/timing behavior and physical sync-control acceptance |
| Preview/UI | SDL/headless preview through the shared native request pump, explicit suspension and joined lifecycle, bounded native RGBA overlays, SDL alpha composition, window/view/aspect controls, independent orthogonal image/overlay transforms and rectangles, main/RGB-BGR-RGBX-BGRX-RGB16-BGR16-I420-YVU-NV-422 lores/background selection with atomic live replacement, isolated display failure and mode restoration | Additional display formats, DRM/KMS and GPU/GUI integrations and their buffer-lifetime rules |
| Still media | Home JPEG/PNG/BMP/TIFF/PPM/GIF, independent main/lores RGB8/RGB16 image objects with checked clone/crop/gray-RGB-RGBA conversion, bounded native-precision resizing with capture-time dimensions and encoding/saves, bounded async APNG byte/file encoding and RGB8/RGB16 main/lores capture bursts with joined cancellation/publication, and calibrated Bayer/mono DNG with checked CSI-2 and PiSP COMP1 row decoding; atomic files and owned encoded bytes from main/RGB-BGR-RGBX-BGRX-RGB16-BGR16-I420-YVU-NV-422 lores across capture/CAF/mode jobs; negotiated color metadata and copied RGB ICC and typed/raw capture Exif in JPEG/PNG/TIFF across capture jobs | Remaining image-object transforms and external decoding as applicable, APNG metadata/temporary-mode capture conveniences, additional pixel formats/demosaicing, complete Exif/tag/thumbnail semantics and physical metadata acceptance, advanced DNG/decompression behavior and color conversions |
| Encoders/recording | Home MJPEG, AVC, HEVC, AAC, MKV/MP4; named software JPEG/AVC quality tiers and a shared HEVC rate heuristic with exact rational planning, limits admission and session propagation; repeated in-band parameter sets on packet keyframes with immutable first-only opt-out across outputs and sessions; counted public IDR requests with synchronous/async producer ordering, cancellation and per-session accounting; copied AVC profile ceilings, validated codec presets and fixed-QP session policies with Baseline/Main container configuration; mixed tiny/4K HEVC with shared CTU32 and visible conformance crops; copied decoder-level ceilings and VBV/CPB policies with nominal resource/actual-header checks and explicit coordinated resets; copied session color profiles with matching matrix/range conversion and ISO/VUI/nclx across native/Bun outputs, snapshots, restart/reconfiguration and coordinated modes; main/RGB-BGR-RGBX-BGRX-RGB16-BGR16-I420-YVU-NV-422 lores encoder sources, compact producer ownership, shared encoding and session transactions, bounded independent encoders with wait/drop policy and shared PCM retention/catch-up and coordinated all-active encoder mode transactions | Complete upstream quality/rate-control behavior, additional pixel formats/raw input, general gamut/transfer conversion, MJPEG/Matroska color metadata options, independent cadence/resampling and physical shared-audio acceptance, hardware encoder paths where available, timestamps and metadata inputs |
| Output families | File/custom output objects, circular/delayed A/V, PTS, split/rotation/recovery, bounded async I/O | Remaining upstream buffering/flush semantics, muxer/network/process-output equivalents through Home/Bun, full close/reopen/failure coverage |
| Scheduling/extensibility | Bounded Bun jobs, cancellation, completion callbacks, drains, joined native ownership, exact frame dropping/timestamp waits, scoped pre/post callbacks with main-thread mode-worker handoff and explicit retained acquisition | Complete arbitrary dispatch/wait/cancel/flush semantics and remaining callback/allocator integration behavior |
| Memory/process boundaries | Persistent DMA maps, bounded retained requests, scoped read/shared and write/exclusive native mappings; opt-in Bun write contexts with detached views on close | Allocator/persistent-allocation equivalents, remote/process request and pool ownership/IPC; GPU integration remains unimplemented |
| Camera-specific integrations | Generic typed libcamera controls | IMX708 helpers, IMX500 tensor/network/inference/ROI workflows, Hailo integration and postprocessing equivalents; hardware-backed validation |
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
