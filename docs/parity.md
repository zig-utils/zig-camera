# Feature coverage in 0.29

zig-camera targets Picamera2's capabilities through Zig, the additive C ABI and
TypeScript/Bun. The Python facade and its scripts have been removed. Its API
names and previous Python-only convenience behavior are not compatibility
promises for the Bun API. Full Picamera2 parity remains ongoing work.

| Capability | Native Zig/C implementation | Bun surface / remaining work |
| --- | --- | --- |
| Capture | Reused libcamera requests, persistent DMA mappings, FIFO/latest queues, linear leases | Camera/Frame, owned RGB/lores copies; bounded async capture queue |
| Sensor modes and lores | Cached advertised modes; exact raw size/depth; paired RGB/I420 lores | Constructor selection, sensorModes, copyStream; measured FPS/crop catalog missing |
| Controls and autofocus | Typed atomic control batches; metadata revisions; revision-filtered AF jobs | setControls, metadata, asynchronous autofocus; physical optics unvalidated |
| Preview | SDL aspect-preserving display; borrowed frame input | Asynchronous capture pump on Bun UI thread; no Qt/DRM zero-copy/overlays |
| Still images | Home JPEG 4:4:4, PPM; Bayer DNG with metadata/calibration | JPEG/DNG capture; PiSP compressed raw and advanced DNG profiles missing |
| Video | Home MJPEG/MKV and x264 AVC/x265 HEVC, fragmented MP4, GOP/bitrate/quality controls | Recorder; no hardware encoder or per-output codec settings |
| Audio/A/V | ALSA or synthetic PCM, independent sample cursors, PCM MKV / AAC-LC MP4 with priming/tail edits | AudioCapture, manual writeAudio and shared recording pump; physical drift/latency calibration missing |
| Circular and delayed output | Bounded GOP history, synchronized owned path/custom snapshots, global/per-output delays, tail rules | CircularOutput2 typed Bun recorder, dynamic delay, custom pre-roll and shared PTS; arbitrary upstream signatures remain unsupported |
| Multiple outputs | Eight stable IDs, shared encoding, separate container/AAC/PCM state, isolation | Path/custom object attachment, owned pre-roll, FileOutput/local PTS and shared PtsStream, MP4/MKV ByteSink, per-output split/recovery; arbitrary upstream signatures remain unsupported |
| Async recording preparation | Native bounded workers, held header acceptance, off-capture file/header/AAC/I/O preparation, keyframe splits, retained results, cancellation/close cleanup | PreparationJob, custom lifecycle coordination, per-output async splits/recovery; initial native attachment setup remains synchronous |
| Rotation and recovery | Exclusive indexed rotation; fresh recovery preparation, lifetime media-clock retry/backoff, inode-safe cleanup | Path patterns or Bun factories, per-output setRotation/setRecovery and observable status; one automation per ID, no retention deletion |
| Output I/O and lifecycle | Bounded owned queues, acknowledged host mailbox, retired epochs, fixed-prefix drains, terminal flush, transactional session restart/reconfiguration and persistent producer worker | Async lifecycle, host telemetry, RGB/PCM/A/V writes, cooperative cancellation, recording drains, flush/restart/reconfigure, per-session codec/audio settings and camera-pump session reuse; synchronous attachment/snapshot calls remain fail-fast |
| Mode switching | Stop/lease/reconfiguration guards in the camera ABI | Bounded FIFO BunJob, worker reopen/drop/temporary RGB/metadata/lores/JPEG/DNG, cancellation, rollback and preview recreation; coordinated recording switch drains/reconfigures/resumes with negotiated geometry and audio; AF/lease coexistence and runtime-control restoration remain unsupported |
| Multiple cameras | Independent camera indices | Independent Camera objects; no synchronized stereo or tracking/navigation |

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
