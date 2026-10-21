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
| Discovery/configuration | Unacquired global discovery, typed properties/control catalogs, shared manager, cached sensor modes, backend/index/exact-ID selection with pinned mode reopens, main/raw/lores, roles, negotiated geometry | Hotplug watches/disconnect recovery, richer mode limits, stream configuration/format/color-space/transform/orientation, alignment, tuning and reconfiguration semantics |
| Requests/capture | Retained references, owned RGB/raw/lores bundles and metadata, bounded capture jobs, JPEG/DNG, temporary-mode copies, timestamp/frame-drop barriers using a matching clock | Mapped buffer/array workflows, complete format conversions and compressed raw, synchronized multi-camera requests, temporary request-return/restore workflows, burst and remaining convenience captures |
| Controls/metadata | Atomic native/vendor and convenience batches, exact typed persistent snapshots/replay, AF scan and CAF pause/resume/lock jobs, owned full typed metadata/control catalogs with vendor/opaque preservation | Metadata mapping conveniences, opaque write semantics if exposed by future backends, remaining sensor-specific control/timing behavior |
| Preview/UI | SDL preview through the shared pump | Overlay alpha blending, transforms/rectangles, headless preview lifecycle parity, DRM/KMS and GPU/GUI integrations and their buffer-lifetime rules |
| Still media | Home JPEG/PPM and calibrated Bayer DNG | PNG/BMP/TIFF/GIF and image-object equivalents as applicable, Exif/metadata options, advanced DNG/decompression behavior and color conversions |
| Encoders/recording | Home MJPEG, AVC, HEVC, AAC, MKV/MP4; shared encoding and session transactions | Complete upstream quality/rate-control behavior, input stream selection, independently managed multiple encoders, hardware encoder paths where available, timestamps and metadata inputs |
| Output families | File/custom output objects, circular/delayed A/V, PTS, split/rotation/recovery, bounded async I/O | Remaining upstream buffering/flush semantics, muxer/network/process-output equivalents through Home/Bun, full close/reopen/failure coverage |
| Scheduling/extensibility | Bounded Bun jobs, cancellation, completion callbacks, drains, joined native ownership, exact frame dropping and capture timestamp waits | Pre/post request callbacks, complete dispatch/wait/cancel/flush semantics and callback-safe acquisition |
| Memory/process boundaries | Persistent DMA maps and bounded retained requests | Mapped-array contexts, allocator/persistent-allocation equivalents, remote/process request and pool ownership/IPC |
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
