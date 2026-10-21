# Feature coverage in 0.52

zig-camera targets Picamera2's capabilities through Zig, the additive C ABI and
TypeScript/Bun. The Python facade and its scripts have been removed. Its API
names and previous Python-only convenience behavior are not compatibility
promises for the Bun API. Full Picamera2 parity remains ongoing work.

| Capability | Native Zig/C implementation | Bun surface / remaining work |
| --- | --- | --- |
| Capture | Reused libcamera requests, persistent DMA mappings, FIFO/latest queues, retained requests with distinct reference tokens; native exact timestamp/drop filters; retained read/shared and write/exclusive mapped streams | Camera/Frame, owned same-request RGB/raw/lores and metadata; cancellable bounded capture jobs with flush/dropFrames; scoped writable RGB/I420/Bayer rows and plane views with detach-on-close; synchronized multi-camera requests remain incomplete |
| Request callbacks | Home leases/access gates pin scopes, exclude writers and prevent requeue under live maps; existing native metadata/control APIs | Scoped synchronous pre/copy/post/encode/display order on the main Bun thread; mode-worker warmup/AF/capture handoff; failure isolation, retained owners, map cleanup recovery and ownership reentry guards; arbitrary dispatch remains incomplete |
| Discovery/catalogs | Shared manager, unacquired enumeration, exact ID selection/full identity copies, owned typed properties/control ranges/full request metadata | Camera.discover, properties, controls, Frame.metadataCatalog; exact i64/arrays/opaque bytes; hotplug watches missing |
| Sensor modes and lores | Cached advertised modes; exact raw size/depth; paired RGB/I420 lores | Constructor selection, sensorModes, copyStream; measured FPS/crop catalog missing |
| Camera orientation | Native orientation configuration, requested/actual result, optional strict negotiation; Home exact transform geometry and CFA phase | Rotation/flip/transpose options, C/Zig/Bun/CLI, mode and recording rollback propagation; all eight synthetic transforms, real capability adjustments reported; hardware chart acceptance pending |
| Controls and autofocus | Atomic convenience/native/vendor batches; exact typed bounded journals; pre-start replay; logical metadata revisions; revision-filtered AF jobs | setControls/setNativeControls and both snapshot/restore APIs; cancellable scan and CAF pause/resume jobs; focus-locked retained requests, paired streams and RGB/metadata/lores/JPEG/DNG with joined restoration and discard on failure; wait/cancel/reject mode handoff and optional fresh target AF; runtime settings restored across mode jobs; physical optics and sensor-specific timing unvalidated |
| Preview | SDL/Home aspect fitting, window requests, independent orthogonal image/overlay transforms and overlay rectangles, owned RGBA uploads and alpha composition; scoped token input and direct-to-texture I420 conversion | Asynchronous SDL/headless pump, main/RGB-I420 lores/background selection, atomic live source/view replacement, immutable state, isolated display errors and joined mode restoration; additional formats and Qt/DRM zero-copy remain |
| Still images | Home JPEG 4:4:4, streaming PNG, BMP, TIFF, PPM; Bayer DNG with metadata/calibration; owned immutable encoded blobs and atomic files | Named main/lores Frame/file/encoded-byte/RGB captures with negotiated YCbCr conversion, focus-locked and temporary-mode images, compression/filter controls and callback access; GIF/APNG, Exif/ICC, decoded image-object conveniences, additional pixel formats/demosaicing, compressed raw and advanced DNG profiles remain |
| Video | Home MJPEG/MKV and x264 AVC/x265 HEVC, fragmented MP4, GOP/bitrate/quality controls | Main/lores Recorder input selection, direct I420 remap and compact producers; no general gamut/transfer conversion, hardware encoder or per-output codec settings |
| Audio/A/V | ALSA or synthetic PCM, independent sample cursors, PCM MKV / AAC-LC MP4 with priming/tail edits | AudioCapture, manual writeAudio and shared bounded PCM across encoders, including dropped video with continuous audio; physical drift/latency calibration missing |
| Circular and delayed output | Bounded GOP history, synchronized owned path/custom snapshots, global/per-output delays, tail rules | CircularOutput2 typed Bun recorder, dynamic delay, custom pre-roll and shared PTS; arbitrary upstream signatures remain unsupported |
| Multiple encoders | Home frame fan-out registry, eight stable consumer IDs, one automatic producer per encoder, wait/drop admission and failure isolation | Independent main/lores Recorder attachments, per-encoder stats and joined close; shared bounded PCM with per-consumer watermarks and isolated overruns; coordinated all-active encoder mode jobs with shared publication and audio holds |
| Multiple outputs | Eight stable IDs, shared encoding, separate container/AAC/PCM state, isolation | Path/custom object attachment, owned pre-roll, FileOutput/local PTS and shared PtsStream, MP4/MKV ByteSink, per-output split/recovery; arbitrary upstream signatures remain unsupported |
| Async recording preparation | Native bounded workers, held header acceptance, off-capture file/header/AAC/I/O preparation, keyframe splits, retained results, cancellation/close cleanup | PreparationJob, custom lifecycle coordination, per-output async splits/recovery; initial native attachment setup remains synchronous |
| Rotation and recovery | Exclusive indexed rotation; fresh recovery preparation, lifetime media-clock retry/backoff, inode-safe cleanup | Path patterns or Bun factories, per-output setRotation/setRecovery and observable status; one automation per ID, no retention deletion |
| Output I/O and lifecycle | Bounded owned queues, acknowledged host mailbox, retired epochs, fixed-prefix drains, terminal flush, transactional session restart/reconfiguration and persistent producer worker | Async lifecycle, host telemetry, RGB/PCM/A/V writes, cooperative cancellation, recording drains, flush/restart/reconfigure, per-session codec/audio settings and camera-pump session reuse; synchronous attachment/snapshot calls remain fail-fast |
| Mode switching | Stop/lease/reconfiguration guards in the camera ABI | Bounded FIFO BunJob, worker reopen/drop/temporary RGB/metadata/lores/JPEG/DNG, cancellation, rollback and preview recreation; coordinated single/group recording switches drain/reconfigure/resume with negotiated geometry and audio; runtime settings replay with strict target validation; AF coordination with revision-filtered capture; outstanding leases remain unsupported |
| Multiple cameras | Shared manager with independent acquired camera indices | Independent Camera objects with ID-pinned worker reopens and rollback; no synchronized stereo or tracking/navigation |

## Validation

Native Zig tests exercise bounded queues, ownership, media clocks, codecs and
preparation races and exclusive asynchronous producer turns. C checks preserve the ABI v1 layouts. Bun tests cover leases,
controls, capture jobs, mode rollback, preview recreation, async output hooks,
publication cancellation, independent custom snapshots, factory rotation/recovery,
custom pre-roll/live handoff and
shared PTS ordering across asynchronous split/retirement and close/open gaps.
Custom snapshot and pre-roll MP4 tests independently decode GOP-aligned AVC/HEVC and verify
AAC priming, waveform alignment and exact presented sample counts.
Linux x86_64/aarch64 CI compiles/loads libcamera and independently decodes AVC/HEVC
and AAC segments, validating frame order, keyframe boundaries, priming and sample
counts. Libjpeg and LibRaw provide independent still-media checks. The suite uses
no Python or FFmpeg. Test counts from the retired Python suite are historical
and must not be cited as coverage of this release.

No camera/microphone is attached to the development machine. Pi throughput,
optical quality, long-run reliability and physical A/V sync remain unmeasured.
See [native jobs](native-jobs.md), [C ABI](../include/zig_camera.h), and
[hardware acceptance](performance.md).

The broader goal remains active. The [scope worklist](parity-plan.md) and pinned
[upstream API inventory](parity-reference.json) include unresolved capabilities
beyond this table; passing current tests is not proof of full parity.
