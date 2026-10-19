# Performance evidence and acceptance

No Pi camera is connected to the development machine. Pi FPS, sustained recording,
optical quality, microphone latency and a speedup over Picamera2 are unmeasured.

Use Zig 0.15.2 for benchmarks. `zig build bench -Dlibcamera=false -Djpeg=false
-Doptimize=ReleaseFast` measures synthetic ownership/copy/luma operations. The
synthetic source is unpaced and performs no ISP work. Never label these as
physical camera FPS or Picamera2 speedups.

On Pi 5, build the real backend and run:

```sh
bun bench/run.ts --width 1920 --height 1080 --frames 300 --repeats 5 --output bench/results/native.json
bun bench/pi-acceptance.ts --frames 1000 --cycles 10 --output bench/results/pi-check
```

The first runner preserves raw CLI benchmark rows and negotiated geometry. The
second exercises all-buffers-held pressure, timeout, stop with live leases,
restart refusal, release/restart, timestamps, JPEG output and process RSS samples.
Add `--raw` for paired raw, or `--simulate` only with synthetic builds. Bun process
memory includes its runtime; it is not the native library's allocation count.

The previous comparison harness has been removed with the Python facade. A
matched upstream comparison is still required before any speedup claim. Compare
against both mapped/borrowed and owned-copy paths, with identical sensor mode,
BGR888 geometry, buffer count, exposure/gain, frame duration, high-quality noise
reduction, warmup and storage. Picamera2 already reuses requests and mappings;
owned-array copies have a different ownership contract from borrowed leases.
Retain raw timings, library versions, CPU temperature/throttling and configuration.

Hardware acceptance must also cover AE/AWB/AF convergence on trails and a moving
dog, bright sky/shade transitions, motion blur, rolling shutter, colour charts,
long capture, disconnects, DMA synchronization errors and memory plateaus. Match
raw and processed captures before judging optics. JPEG, DNG, preview and encoded
A/V each need separate sustained-rate/latency tests. Native/Bun synthetic tests
and independent decoders establish software properties, not physical performance.
