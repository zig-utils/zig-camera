# zig-camera

Native Zig capture and recording for Raspberry Pi 5 with a TypeScript/Bun API.
libcamera supplies the camera/ISP pipeline; Home supplies image encoding,
AVC/HEVC/AAC adapters, containers and bounded media queues. No FFmpeg or Python
runtime, bindings, test scripts or build scripts are used by this project.
Physical camera performance and image quality have **not been measured**.

Version 0.93 adds [asynchronous remote still encoding and saves](docs/remote-async.md)
through bounded native Home codec workers. Jobs own copied pixels/Exif/ICC before
source closure; joined cancellation and staged publication preserve destinations.
Shared Home allocator budgets also cover native zlib workspace.

Version 0.92 adds [request-owned configuration](docs/request-configuration.md)
for source frames, retained exports and remote/process frames. Snapshots include
requested and negotiated geometry, formats, color, sensor settings and orientation;
reused workers see each source request's configuration after mode changes. Home's
bounded catalog projection preserves the existing transport and ownership rules.

Version 0.91 adds [request-derived remote image metadata](docs/remote-exif.md):
Home image encoding and atomic saves with source dimensions, exposure, gain-based
ISO, UTC, model and copied ICC/Exif. JPEG defaults now match request capture.

Version 0.90 adds [remote stream arrays and calibrated DNG](docs/remote-media.md):
compact main/raw/lores bundles, physical buffer copies, native raw16 samples,
request-time calibration transport, and DNG/processed image saves in workers.

Version 0.89 adds [supervised process jobs and pools](docs/process-pools.md)
with native export/argument/result admission, matched ACK/result routing,
joined active cancellation, isolated worker failures, restart generations and
callback-aware drain/close. Workers reuse the shared Home image path.

Version 0.88 adds [local descriptor channels and remote owners](docs/frame-channels.md)
through Zig/C/Bun, with atomic bounded fd transfers, cached shared metadata,
checked receiver mappings, explicit ACKs and owned Home image conversions.

Version 0.87 adds [retained descriptor exports](docs/frame-exports.md) through
C/Zig/Bun, with one native frame gate, owned fd duplicates, explicit staging and
metadata snapshots. This establishes ownership for later supervised process jobs.

Version 0.86 adds [temporary-mode owned image jobs](docs/mode-images.md),
with native-precision target pixels/metadata, optional worker resizing and
publication after camera/preview restoration.

Version 0.85 adds [owned image resizing](docs/image-resizing.md) and optional
capture-time dimensions, reusing Home’s checked native-precision, alpha-aware
resampler with bounded tables and row caching. Home’s public Image resizing
also gains checked indexed input and transactional word-precision operations.

Version 0.84 adds [owned image objects](docs/image-objects.md) across capture,
focus-locked capture and scoped callbacks, with independent RGB8/RGB16 pixels,
checked Home clone/crop/conversion, encoding and joined staged saves after camera
release. Home's Image API also receives transactional word conversion and deep
animation-frame cloning fixes.

Version 0.83 adds [GIF still capture](docs/gif.md) through C/Zig/Bun/CLI, reusing
Home's bounded palette and dictionary LZW with independent giflib readback.
Ordinary and focus-locked file captures now keep output private through request
callbacks and CAF restoration before joined native publication.

Version 0.82 adds [async APNG capture and encoding](docs/apng.md) through Bun/C:
bounded copied inputs, RGB8/RGB16 main/lores bursts, cancellable native row
encoding and joined atomic file publication. Scoped request callbacks now expose
owned RGB16/raw16 copies, and staged-file thread admission is bounded.

Version 0.81 exposes Home's checked [APNG encoder](docs/apng.md) to Zig callers
over copied capture rasters and reuses its shared PNG row/chunk implementation.
It supports frame rectangles, exact rational delays, disposal/blend controls,
8/16-bit gray/RGB/RGBA and a separate optional static image. That shared codec
now supplies the jobs in version 0.82.

Version 0.80.1 fixes duplicate owner cleanup when native zlib stream initialization
fails. The Home adapter now tests native initialization errors independently of
host allocation failures; normal PNG encoding is unchanged.

Version 0.80 adds [sensor raw formats](docs/sensor-raw.md): monochrome, CSI-2 and
Pi 5 PiSP COMP1 capture, owned raw16 jobs and streaming Bayer/mono DNG through a
checked Home helper. Explicit raw packing survives temporary DNG capture jobs.

Version 0.79 adds [RGB16 processed streams](docs/rgb16.md): BGR161616/RGB161616
main/lores capture, owned RGB16 copies, full-precision PNG/TIFF/PPM, and explicit
high-byte preview/JPEG/video input through existing Home codecs and containers.

Version 0.78 adds [packed YUV 4:2:2 streams](docs/yuv422-layouts.md): YUYV/YVYU/
UYVY/VYUY capture and preview, odd-height stills, raw layout ownership and direct
I420 codec downsampling through improved shared Home conversion.

Version 0.77 adds [NV12, NV21 and YVU420 streams](docs/yuv420-layouts.md): checked
Home chroma views, raw/mapped capture, stills, preview, codec input and explicit
bounded async ownership across mode changes and recording recovery.

Version 0.76 adds [packed processed RGB formats](docs/packed-rgb.md): RGB888,
XBGR8888 and XRGB8888 main/lores streams, checked Home byte-layout conversion,
owned capture copies, still images, bounded recording inputs and SDL preview.

Version 0.75 adds [named software quality tiers](docs/quality-tiers.md): exact
Home bitrate planning, JPEG tier values, C/Bun/CLI selection and recomputation
from negotiated geometry across recording sessions and recovery.

Version 0.74 adds [repeated packet parameter headers](docs/repeated-headers.md):
AVC/HEVC packet keyframes carry cached parameter sets by default, with a copied
first-only opt-out across snapshots, splits and session transactions.

Version 0.73 adds [counted keyframe requests](docs/keyframes.md): synchronous
and FIFO async requests, distinct repeated IDRs, cancellation at commit, and
per-session request accounting through Home.

Version 0.72 adds [mixed tiny and 4K HEVC recording](docs/hevc-geometry.md):
shared CTU32, edge padding with exact visible crops for tiny I420 inputs, and
stable parameter-set caching through Home's encoder bridge.

Version 0.71.1 preserves automatic AVC level selection under high ceilings so
small streams do not advertise unnecessarily high decoder requirements.
Version 0.71 adds [decoder-level ceilings and VBV policies](docs/encoder-limits.md):
checked nominal resources and emitted headers, explicit rate/buffer limits,
transactional session propagation and coordinated policy resets.

Version 0.70 adds [encoder profiles, presets and fixed QP](docs/encoder-options.md):
copied per-session codec policies, AVC Baseline/Main container support and
transactional propagation through restart, mode changes and recording recovery.

Version 0.69 adds [coordinated recording and preview recovery](docs/reconnection.md):
fresh camera ownership, shared encoder publication, retained microphone sample
phase and independent preview/overlay snapshots across device loss.

Version 0.68 adds [bounded reconnection jobs](docs/reconnection.md): exact-ID
discovery/retry, fresh worker-owned cameras, persistent control/CAF restoration,
joined cancellation and old frame/map independence.

Version 0.67.1 closes AbortSignal registration reentry during watch-job admission.
Version 0.67 adds [bounded manager hotplug watches](docs/hotplug.md): full-ID
added/removed events, explicit overflow/rescan, cancellable Bun jobs, and manager
and tuning lifetime across camera close/reopen gaps.

Version 0.66 adds [device disconnection handling](docs/disconnection.md): terminal
loss notifications, owned frame/map cleanup, coalesced async observation and
mode-worker loss reporting through rollback.

Version 0.65.1 includes checked-allocator Home environment ownership and the
real-library catalogue test integration. Version 0.65 adds
[manager-lifetime tuning application](docs/tuning-sessions.md):
owned Raspberry Pi IPA snapshots, matching-profile sharing/conflict rejection,
environment restoration and camera reservations across mode/recording jobs.

Version 0.64 adds [owned tuning documents](docs/tuning.md): bounded loading,
lossless JSON algorithm edits and atomic saves through Home and Zig/C/Bun.
Physical tuning/ISP acceptance remains required work.

Version 0.63 adds [processed stream alignment](docs/stream-alignment.md): explicit
PiSP/VC4/minimum geometry recipes, atomic configuration planning and C/Zig/Bun/CLI
helpers that preserve automatic dimensions and raw sensor modes.

Version 0.62 adds [software-sync request selection](docs/synchronization.md):
backend SyncReady/SyncTimer metadata, atomic sync controls, cancellable synchronized
capture jobs and readiness combined with frame dropping, timing and focus locks.

Version 0.61 adds [burst and paced file capture](docs/capture-series.md): lazy
patterns, bounded progress history, fast single-mode bursts, preview between
paced shots, cancellation and joined staged publication using Home intervals.

Version 0.60 adds [retained capture-and-stop](docs/capture-request-stop.md): a live
target request remains readable while stopped, with cancellation cleanup and
explicit restoration after release through Bun and additive C/Zig helpers.

Version 0.59 adds [owned stream bundles](docs/stream-bundles.md): paired main/raw/lores
copies during temporary mode capture, shared native preflight, and one compact
owned allocation through C/Zig and Bun.

Version 0.58 adds [capture Exif](docs/capture-exif.md): request-derived JPEG
metadata, copied typed/raw overrides, PNG/TIFF opt-in, and shared Home JPEG
metadata encoding without a second image copy.

Version 0.57 adds [staged temporary-mode files](docs/staged-files.md): publication
after request callbacks and camera/preview restoration, coordinated cancellation
and deadlines, and joined native I/O cleanup.

Version 0.56 adds [still-image ICC profiles](docs/still-metadata.md): copied custom
profiles or checked built-in sRGB for JPEG/PNG/TIFF, including async, focus-locked
and temporary-mode captures. Capture Exif is available in 0.58.

Version 0.55 adds [recording color profiles](docs/recording-color.md): copied
AVC/HEVC VUI and MP4 nclx settings, matching matrix/range conversion, and propagation
through splits, snapshots, factories and camera/recorder mode jobs.
[Camera color requests](docs/color-configuration.md) retain strict negotiation
and mode restoration. See [main-stream formats](docs/main-formats.md),
[preview stream selection](docs/preview-streams.md) and [display views](docs/preview-views.md). See [headless preview](docs/headless-preview.md), [RGBA preview overlays](docs/preview-overlays.md), [coordinated recording groups](docs/recording-groups.md),
[shared microphone audio](docs/shared-audio.md),
[multiple encoders](docs/multiple-encoders.md) and the
[Home OS reuse audit](docs/home-os-reuse.md).
See [recording streams](docs/recording-streams.md), [still images](docs/still-images.md)
and [camera orientation](docs/orientation.md).
See [request callbacks](docs/request-callbacks.md), [mapped streams](docs/mapped-streams.md), [capture barriers](docs/capture-barriers.md), [native controls](docs/native-controls.md),
[continuous AF and focus-locked capture](docs/controls.md#continuous-autofocus-and-focus-locked-capture),
[camera selection](docs/camera-selection.md) and the [parity worklist](docs/parity-plan.md).
See [async producers](docs/async-producers.md).

The former Python facade has been removed. This is a feature-oriented alternative
to Picamera2, not a drop-in package or a claim of full parity. The Bun facade
covers a subset of the native ABI; see [coverage and gaps](docs/parity.md).

## Build

Use **Zig 0.15.2** and **Bun 1.4.3**. On 64-bit Raspberry Pi OS:

```sh
sudo apt update
sudo apt install build-essential libcamera-dev libsdl2-dev libx264-dev libx265-dev zlib1g-dev pkg-config
zig build -Dpreview=true -Dcodecs=true -Doptimize=ReleaseSafe
bun install --frozen-lockfile
./zig-out/bin/zig-camera info
./zig-out/bin/zig-camera capture --output trail.jpg --warmup 60
./zig-out/bin/zig-camera capture --output trail.dng --warmup 60
./zig-out/bin/zig-camera preview --width 1280 --height 720 --frames 0
./zig-out/bin/zig-camera record --codec h264 --width 1920 --height 1080 --fps 30 --frames 300 --rotate-pattern 'trail-{index:03}.mp4' --rotate-ms 5000
```

The rotation pattern defines index zero's initial file and subsequent files.
Existing destinations fail; rotation does not overwrite or delete old recordings.
Duration and byte limits are soft because preparation and keyframe delivery take
time. Storage/construction failures are observable through automation state and
leave the existing healthy sink recording. The CLI reports errors after cleanup.

Synthetic CLI rotation waits, without a leased camera frame, for each admitted
asynchronous replacement to become ready before advancing synthetic media time.
The existing CLI timeout bounds this wait and preparation errors propagate. Real
capture retains asynchronous, soft keyframe-aligned rotation. This prevents a
fast synthetic fixture from reaching EOF before its file/header worker can run;
it is not physical capture pacing or evidence of real-time throughput. The CLI
smoke checks exact frame accounting across segments and exclusive-path failure.


JPEG defaults to quality 98 with 4:4:4 sampling. DNG accepts supported Bayer/mono formats, including PiSP COMP1 with standard driver reconstruction. See [raw formats](docs/sensor-raw.md). Codec options enable direct x264/x265 links.
Add `-Daac=true` with standalone FDK AAC installed for AAC MP4, `-Daudio=true`
with ALSA for microphone capture. Hardware encoding remains unsupported.
The libcamera bridge uses the system C++ toolchain and distribution STL ABI.

## TypeScript / Bun

```ts
import { Camera, Recorder } from './ts'

await using camera = new Camera({ width: 1920, height: 1080, role: 'video' })
await using recorder = new Recorder('trail-000.mp4', {
  width: 1920, height: 1080, fps: 30, codec: 'h264', gop: 60,
  exclusive: true, isolate: true,
  io: { maxBytes: 16 * 1024 * 1024, maxOperations: 4096 },
})
recorder.setRotation('trail-{index:03}.mp4', { durationMs: 5000 })
const recording = camera.startRecording(recorder)
const metadata = await camera.captureMetadata()
console.log(metadata)
await Bun.sleep(10_000)
console.log(recorder.automaticState())
await recording.close()
```

`ZIG_CAMERA_LIBRARY` selects an alternate shared-library path. Synthetic builds
require `new Camera({ simulate: true, ... })`; no real camera is silently replaced.
Frame descriptors are linear references. retain() creates an independent owner;
only final release recycles a request. Use `using frame = camera.acquire()` and
release before leaving the camera scope. Copies returned by `copyRGB` and
`copyStream` own their bytes. Do not pass a released descriptor to low-level FFI.

Bun polls native jobs without waiting on their I/O. Recorder close, fixed-prefix
drains and owned snapshots execute on Bun workers. Encoding and bounded camera
acquisition remain synchronous FFI calls; Bun is not a hard realtime scheduler.
See [native jobs](docs/native-jobs.md) for cancellation and serialization rules.

```ts
const still = await camera.switchModeAndCaptureRGB(
  { width: 4056, height: 3040, role: 'still' },
  { dropFrames: 4, timeoutMs: 15_000 },
)
// The previous camera configuration is restored before this resolves.
```

Mode jobs require released leases and idle recording/capture work. Existing
autofocus uses an explicit cancel, wait or reject policy.
See [mode jobs](docs/mode-recording.md) and [custom output objects](docs/output-objects.md)
for temporary JPEG/DNG capture, cancellation, async hooks and owned byte sinks.

## Develop without hardware

```sh
zig build test -Dlibcamera=false -Djpeg=false
zig build -Dlibcamera=false -Djpeg=false -Doptimize=ReleaseSafe
bun install --frozen-lockfile
bun run typecheck
bun test tests/ts
zig build bench -Dlibcamera=false -Djpeg=false -Doptimize=ReleaseFast
```

Linux CI builds and loads the real backend on x86_64 and aarch64, retaining the
no-camera smoke test. Independent OpenH264/libde265/FAAD2/libjpeg and LibRaw checks
validate generated media without FFmpeg. Synthetic results do not establish Pi
throughput, optical quality, microphone latency or physical A/V synchronization.

See [C ABI](include/zig_camera.h), [architecture](docs/architecture.md),
[Home reuse](docs/home-reuse.md), [hardware](docs/hardware.md), and
[performance acceptance](docs/performance.md). License: MIT; optional codec and
system libraries retain their own licenses and notices.
