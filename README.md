# zig-camera

Native Zig capture and recording for Raspberry Pi 5 with a TypeScript/Bun API.
libcamera supplies the camera/ISP pipeline; Home supplies image encoding,
AVC/HEVC/AAC adapters, containers and bounded media queues. No FFmpeg or Python
runtime, bindings, test scripts or build scripts are used by this project.
Physical camera performance and image quality have **not been measured**.

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


JPEG defaults to quality 98 with 4:4:4 sampling. DNG requires uncompressed Bayer;
PiSP compressed raw is unsupported. Codec options enable direct x264/x265 links.
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
