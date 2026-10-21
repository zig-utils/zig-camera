# Timestamp and frame-drop capture barriers

CaptureOptions extends JobOptions with flush?: boolean | bigint and
dropFrames?: number. The same options work for request/RGB/metadata/raw/lores,
paired streams, JPEG/DNG and focus-locked captures. Defaults preserve existing
selection and avoid an extra filter FFI call. Counts are unsigned u32 integers;
thresholds are exact unsigned u64 bigints. Invalid values reject at admission.

```ts
import { captureClockNs } from './ts'

using fresh = await camera.captureRequest({ flush: true })
const threshold = captureClockNs()
const streams = await camera.captureStreams(['main', 'raw', 'lores'], {
  flush: threshold,
  dropFrames: 3,
})
await camera.dropFrames(5)
const job = camera.captureMetadataAsync({ flush: true, timeoutMs: 5000 })
```

flush:true samples captureClockNs at admission, before starting a stopped camera.
flush:false or omission imposes no timestamp predicate. A bigint supplies a
caller-selected threshold in the same capture-clock domain. Linux uses
CLOCK_BOOTTIME, matching libcamera SensorTimestamp; the explicit Darwin virtual
backend uses MONOTONIC. Neither uses Date.now, Unix wall time nor process-relative
performance.now. Synthetic frame timestamps now use this same native clock.
No clock conversion from another device/process epoch is inferred.

The qualifying boundary is max(0, SensorTimestamp - ExposureTime * 1000) >= flush.
This intentionally follows the conservative formula in pinned Picamera2
wait_for_timestamp_; current libcamera describes SensorTimestamp as first-row
exposure time. Subtracting exposure adds a conservative guard, not a new claim
about the physical timestamp's meaning. Exact integer subtraction saturates at
zero. Compact metadata valid bit 16 confirms a sensor/capture-clock timestamp;
new bit 64 confirms exposure. Missing required timing rejects UNSUPPORTED, with
no fallback to receipt/wall time. Hardware timestamp support remains to be tested.

dropFrames skips that many distinct requests before accepting one. The native
filter uses the camera's nonwrapping completion event ID, so two retained owners
of the same request cannot consume two drops. Each queued job has independent
filter state; FIFO capture jobs select in order. Under the latest policy, native
queue eviction may already discard older completions: the requested count applies
to delivered requests, not an inferred number of sensor exposures. Use fifo:true
when exact delivered-sequence ordering matters. Frames rejected by selection
continue through recording and preview, then the pump releases its reference.

dropFramesAsync(count) returns BunJob<void>; dropFrames returns its Promise. It
discards exactly count delivered requests, then the next capture sees a subsequent
request. Count zero completes without starting/acquiring. Both forms support
deadlines, cancellation and signalFunction. A cancelled/timed-out barrier keeps
no private request, does not release caller-held references, and does not stop a
healthy recorder. Other queued captures can proceed after its owner retires.
Stop/close join the existing capture ownership path. Outstanding captures still
prevent mode ownership transfer; barriers do not bypass the mode/lease guards.

Focus-locked captures apply the filter after native pause/focus validation, so
drops count only eligible locked requests. They continue to join prior CAF intent
restoration before publishing the selected result. Caller-owned held buffers may
backpressure either phase; capture and restoration retain their separate deadlines.

The additive native APIs preserve ABI v1 layouts. zc_capture_clock_ns reads the
clock. zc_capture_filter_init initializes a 32-byte consumer-owned filter;
zc_capture_filter_accept tests an existing lease without retaining/releasing it.
ZC_CAPTURE_TIMESTAMP selects an inclusive timestamp comparison;
ZC_CAPTURE_EXPOSURE_GUARD adds the conservative exposure subtraction. Direct
sensor comparison is also available natively by omitting the exposure flag.
Serialize one filter per job on one camera completion timeline. Its fields are
library state, not a writable configuration after initialization. Acceptance is
terminal; reinitialize for another selection.

zc_acquire_filtered releases each rejected request and transfers one owner on
success. Timeout zero tries one request, retains filter progress and leaves the
out frame untouched on failure. Missing metadata, DMA errors, invalid/stale leases
and stopped cameras remain explicit failures. Native C/Zig acquisition is a
synchronous consumer operation; Bun uses nonblocking tests in the shared pump.
Zig exports CaptureFilter, captureClockNs, captureFilter and Camera.acquireFiltered.

Home frame_barrier owns the allocation-free policy; Zig owns filter state, lease
checks and release. Tests cover exact/inclusive boundaries, maximum counters,
duplicate observations, missing metadata, DMA failure, cancellation, retained
pressure, FIFO jobs, files/streams, recording delivery and CAF restoration. These
prove synthetic ownership and selection semantics, not physical Pi exposure timing.

References: [pinned Picamera2 selection](https://github.com/raspberrypi/picamera2/blob/5e2a35d3bb230825c98c56d98e01b41ddeb43e86/picamera2/picamera2.py)
and [libcamera SensorTimestamp](https://github.com/raspberrypi/libcamera/blob/main/src/libcamera/control_ids_core.yaml).
