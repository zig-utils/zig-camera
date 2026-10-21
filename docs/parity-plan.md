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
| Discovery/configuration | Unacquired global discovery, typed properties/control catalogs, shared manager, cached sensor modes, backend/index/exact-ID selection with pinned mode reopens, RGB/I420 main, raw and RGB/I420 lores, explicit processed color descriptions, requested/effective/actual negotiation with strict adjustment policy, roles, negotiated geometry, requested/actual orientation with strict policy and mode restoration | Hotplug watches/disconnect recovery, richer mode limits, additional stream configuration/formats, physical color-space acceptance, physical orientation acceptance, alignment, tuning and reconfiguration semantics |
| Requests/capture | Retained references, owned RGB/raw/lores bundles and metadata, bounded capture jobs, JPEG/DNG, temporary-mode copies, timestamp/frame-drop barriers, scoped mapped planes and RGB/I420/Bayer rows | Complete format conversions and compressed raw, synchronized multi-camera requests, temporary request-return/restore workflows, burst and remaining convenience captures |
| Controls/metadata | Atomic native/vendor and convenience batches, exact typed persistent snapshots/replay, AF scan and CAF pause/resume/lock jobs, owned full typed metadata/control catalogs with vendor/opaque preservation | Metadata mapping conveniences, opaque write semantics if exposed by future backends, remaining sensor-specific control/timing behavior |
| Preview/UI | SDL/headless preview through the shared native request pump, explicit suspension and joined lifecycle, bounded native RGBA overlays, SDL alpha composition, window/view/aspect controls, independent orthogonal image/overlay transforms and rectangles, main/RGB-I420 lores/background selection with atomic live replacement, isolated display failure and mode restoration | Additional display formats, DRM/KMS and GPU/GUI integrations and their buffer-lifetime rules |
| Still media | Home JPEG/PNG/BMP/TIFF/PPM and calibrated Bayer DNG; atomic files and owned encoded bytes from main/RGB-I420 lores across capture/CAF/mode jobs; negotiated color metadata | GIF/APNG and decoded image-object equivalents as applicable, additional pixel formats/demosaicing, Exif/ICC metadata options, advanced DNG/decompression behavior and color conversions |
| Encoders/recording | Home MJPEG, AVC, HEVC, AAC, MKV/MP4; main/RGB-I420 lores encoder sources, compact producer ownership, shared encoding and session transactions, bounded independent encoders with wait/drop policy and shared PCM retention/catch-up and coordinated all-active encoder mode transactions | Complete upstream quality/rate-control behavior, additional pixel formats/raw input, gamut/transfer conversion and configurable encoder color metadata, independent cadence/resampling and physical shared-audio acceptance, hardware encoder paths where available, timestamps and metadata inputs |
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
