# Performance evidence and acceptance

Hardware results: **not yet measured**. There is no camera connected to the
current development machine. Do not infer sensor FPS, JPEG speed, image quality,
or Picamera2 speedup from synthetic numbers.

Picamera2 already has persistent mappings, MappedArray (copy-free views), reusable
requests and optimized JPEG encoding. Its `capture_array`/`make_array` path copies
pixels to provide an owned array; that copy is intentional. Native code must be
compared against both its copied and mapped paths. References:
[request.py](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/request.py),
[libcamera request reuse](https://docs.libcamera.org/master/public-api/classlibcamera_1_1Request.html).

## Synthetic measurements

`zig build bench -Dlibcamera=false -Djpeg=false -Doptimize=ReleaseFast` reports
lease/release overhead, a full 1080p RGB copy and RGB-to-luma conversion. The
synthetic device is unpaced and does no ISP work. The copy and lease cases have
different output ownership, so their ratio is not a Picamera2 speedup. The luma
conversion is optional downstream work, never forced into the capture path.

## Matched Pi 5 comparison

```sh
sudo apt install python3-picamera2 time
zig build -Doptimize=ReleaseSafe
python3 bench/compare.py --width 1920 --height 1080 --frames 300 --repeats 5 --output results.json
```

The harness alternates native lease, Picamera2 mapped request, and Picamera2
owned-array request paths in separate processes. It requests the same camera,
BGR888 (RGB byte order), geometry, FIFO buffering, warmup, fixed exposure/gain,
frame duration, and high-quality still-image noise reduction. It records negotiated geometry, wall time, process CPU,
peak RSS, sequence range when available, commands, platform and library versions.
A mismatched geometry or buffer count aborts the comparison. Keep the raw result
JSON; medians alone are insufficient evidence. The mapped baseline is the primary
apples-to-apples ownership comparison. The copied baseline shows an explicitly
different ownership contract.

Review the camera's selected sensor mode and measured cadence too: equal output
size does not prove equal sensor readout or ISP tuning. `--raw` is excluded from
this benchmark. Use an actual supported FPS for that sensor mode: a full-size
64MP frame will not run at a nominal 30 FPS just because it was requested.
CPU time per frame is the primary expected gain; FPS can remain sensor-limited.

## Hardware smoke runner

```sh
PYTHONPATH=python python3 bench/pi_acceptance.py --frames 1000 --cycles 10 --output pi-check
# Add --raw to exercise paired raw DMA-BUF reads and synchronization.
```

This exercises all-buffers-held backpressure, timeout, leased memory across stop,
restart/close refusal, release/restart, monotonic timestamps, JPEG output, and
process memory samples. It writes a report and sample JPEG. A successful smoke
run does not establish optical quality or a speedup.

## Hardware acceptance before production claims

1. Run `rpicam-hello --list-cameras` and save sensor modes, OS/kernel and libcamera
   versions. Use the distribution's matched Pi kernel/libcamera/IPA packages.
2. Capture a colour chart with stock rpicam-apps, Picamera2 and zig-camera using
   the same sensor mode, exposure, gain, colour gains, lens focus and lighting.
   Verify dimensions, RGB channel order and no stride/padding artifacts. Compare
   lossless processed outputs and paired raw; JPEG quality numbers alone do not
   establish identical encodings or image quality.
3. Confirm auto exposure, AWB and autofocus convergence after warmup outdoors;
   test a walking subject and a running dog, bright sky and shaded foreground.
   Check autofocus hunting, motion blur, rolling shutter and highlight clipping.
4. Exercise FIFO/latest with slow consumers, all buffers held, stop with leases,
   repeated start/stop, camera disconnect, DMA synchronization failure and long
   capture. Monitor frame sequence gaps and memory; confirm memory plateaus.
5. Run at least five alternating benchmark repeats with active cooling and a
   stable power supply. Save temperature/throttling state and memory usage.
6. Benchmark JPEG separately with equal resolution, 4:4:4 subsampling, quantization
   settings and storage medium. JPEG is CPU encoding on the Pi 5; a capture lease
   benchmark does not prove an encoder speedup.

Preview, hardware encoders and DNG are outside this version's benchmark scope.

## Local development evidence (not camera performance)

A synthetic ReleaseFast run on the development aarch64 Mac reported:

| Operation | Time |
| --- | ---: |
| Lease/release, 100,000 iterations | 69 ns/iteration |
| Full 1920x1080 RGB copy, 100 iterations | 108,148 ns/frame |
| RGB-to-luma, 100 iterations | 1,290,206 ns/frame |

These are single-run diagnostic timings, not statistically established results
or Picamera2 comparisons. The lease case does not copy or process a frame;
copy and luma are different workloads. Hardware camera speedup is unmeasured.
The run used Zig 0.15.2 targeting aarch64-macos.15.0, with the executable built
from bench/core.zig and a synthetic, unpaced device on the host aarch64 Mac.
On this macOS 27 development host, the older Zig build runner could not link
against the native OS target; the equivalent direct compiler invocation used
an explicit macOS 15 deployment target. Standard `zig build` was independently
validated on macOS 15 and Ubuntu x86_64/aarch64 in CI.
