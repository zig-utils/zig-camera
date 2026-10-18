# Async mode changes, circular recording and splits

The Python compatibility facade adds serialized mode jobs. The native recorder
adds encoded pre-roll and keyframe-aligned output changes through additive C ABI
v1 APIs. Existing public structure sizes and recording calls remain unchanged.
No FFmpeg, Libav or Python video framework is used.

## Mode jobs

```python
from zigcamera import Picamera2

with Picamera2() as camera:
    preview = camera.create_preview_configuration(main={"size": (1280, 720)})
    still = camera.create_still_configuration()  # Includes uncompressed raw.
    camera.configure(preview)
    camera.start()
    job = camera.switch_mode_and_capture_file(still, "trail.dng", name="raw",
                                              num_frames=4, wait=False)
    metadata = camera.wait(job, timeout=15)
    # Previous configuration and started/stopped state are restored before result.
    # In an asyncio coroutine: metadata = await job
```

`switch_mode(config)` changes configuration and starts the selected mode.
`switch_mode_and_drop_frames(config, num_frames)` additionally consumes that many
requests. Temporary `switch_mode_and_capture_array/buffer/metadata/file` jobs
switch, optionally drop frames, capture owned results, and restore the previous
configuration and running state. Active async preview is recreated for target
and restored geometry. No warmup count is claimed to establish AE/AWB stability.

`wait=True` blocks; `wait=False` or a supplied `signal_function` returns a job.
Callbacks receive the completed job on a separate thread. `result(timeout)` limits
the caller's wait; `timeout_ms` (default 5000) bounds dispatch-stage/frame waits,
including elapsed reconfiguration/preview setup time. It cannot interrupt a
native reconfiguration or filesystem write already running, and restoration is
attempted even after the deadline. Increase it for slower preview startup.
Queued cancellation is terminal; once a lifecycle job starts it finishes its
transition/restoration. Cancelling an asyncio await cannot interrupt running work.

One mode job may be pending/running per facade. Up to 32 mode jobs or unreturned
callbacks retain admission slots. Other facade operations serialize with the mode
worker; a new mode submission fails while another is active. Callback code does
not run while the mode worker holds the facade lock. Recordings must be stopped
first. User-owned request leases and pending/running request-returning capture
jobs block the transition before it stops the current camera. Other queued
capture jobs are cancelled by stop. AF monitors wake on stop without waiting for
application callbacks, avoiding callback/lifecycle lock deadlocks.

A failed target or capture attempts to restore the previous camera. If restoration
also fails, `ModeRestoreError` exposes `operation_error` and `restoration_error`;
the camera may remain stopped/unconfigured. This implementation reopens the native
camera during reconfiguration. It does not implement temporary captures returning
old-mode leased requests, mode changes while encoding, or the complete Picamera2
signatures. Accessing the private underlying Camera concurrently bypasses facade
serialization and is unsupported during mode changes.

## Circular pre-roll

```python
from zigcamera import Picamera2, H264Encoder, CircularOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1280, 720)}))
    history = CircularOutput(buffer_duration_ms=5000, max_bytes=64*1024*1024,
                             max_frames=180)
    recording = camera.start_recording(H264Encoder(iperiod=30), history, fps=30)
    # Let capture fill history; inspect history.stats to determine readiness.
    # On an event:
    history.open_output("dog-on-trail.mp4")  # Retained pre-roll, then live packets.
    # Application continues; split at a new IDR without resetting the encoder:
    camera.split_recording("next.mp4", wait=False).result(timeout=5)
    # Closing an output keeps the history/encoder running.
    history.close_output()
    history.save_buffer("recent.mp4")  # Snapshot; encoding remains usable.
    camera.stop_recording()
```

Use `HEVCEncoder` for HEVC/MP4, or `MJPEGEncoder` with `.mkv`. AVC/HEVC require
`-Dcodecs=true` with the installed x264/x265 libraries. CircularOutput starts
without a file; `open_output` replays retained history and then writes live output.
`save_buffer` creates an independent snapshot without consuming history or draining
the encoder. It fails while no retained keyframe exists. Calling `open_output`
with empty history waits for an encoded key. The API differs from Picamera2's
CircularOutput2 delayed-forwarding semantics; no alias for it is advertised.

A Home packet ring owns a fixed byte arena and entry array. The byte, frame and
time limits are upper bounds, not a promised clip duration. Eviction removes
leading dependent frames through the next keyframe. History can become empty if
a GOP cannot fit; choose limits/GOP accordingly. An individual packet larger than
the byte arena fails recording explicitly. No DMA leases or uncompressed frames
are retained. `stats` includes retained frames/bytes, first/last relative capture
nanoseconds, evicted/skipped packets, opened segment count and pending split state.

The payload arena is at most `max_bytes` (1 GiB maximum), with `max_frames`
metadata slots (maximum 65536). Explicit replay uses scratch space for the largest
retained packet. Codec state, owned parameter sets and one MP4 duration-staging
packet are additional bounded-by-packet allocations. Replay/file I/O serializes
with encoding and can delay consumers; native capture queues remain bounded.
No real Pi memory/FPS claims follow from synthetic tests.

AVC VFR can retain one input internally; snapshots and closing an output do not
drain it and may omit that latest input. Stopping recording drains the encoder
before finalizing the active file. Snapshot and new output timelines start at
zero, with fresh codec headers and actual capture gaps preserved. The final
sample duration uses nominal FPS where there is no following sample timestamp.

## Splitting and lower-level APIs

`camera.split_recording(path, wait=False)` stages a fresh file and requests an IDR.
A job completes only after the first encoded key commits the switch. The previous
file receives all packets before the boundary; the next file receives the key
and following packets, with no duplicate/lost inputs across successful splits.
AVC's buffered output is handled by emitted packet PTS, not input submission time.
MJPEG can switch on the next packet because every frame is independently coded.
Each file has its own container/header/timeline. This is a video-only operation.

Only one split may be pending. `cancel()` cancels a staged split before commit;
stop cancels it before draining to the current output. A cancelled staged file may
contain headers and no frames. Waiting with a timeout does not cancel a split.
Preparing a destination failure preserves the current output. File identities
are compared before truncation, including hardlinks to active/staged files.
A write failure during commit can poison recording and is surfaced explicitly.

Low-level `Recorder` exposes `split`, `cancel_split`, `buffer_stats`,
`open_output`, `close_output` and `save_buffer`; it serializes its calls. Create a
circular recorder with `Recorder(width=..., height=..., circular={"duration_ms":
5000, "max_bytes": ..., "max_frames": ...})`. Its C counterparts are
`zc_video_open_circular`, `zc_video_split`, `zc_video_cancel_split`,
`zc_video_buffer_stats`, `zc_video_open_output`, `zc_video_close_output` and
`zc_video_save_buffer`. C callers must serialize calls and keep input leases alive
during encode. Closing a standalone recorder with an unresolved split reports an
error; cancel it first or provide frames until the split commits.

Compressed audio, retention deletion, arbitrary output classes, crash recovery
and circular disk recording are still gaps. Hardware ISP reconfiguration, focus,
long-running recording reliability and sustained Pi 5 throughput remain untested.

For duration/size automatic rotation and synchronized PCM audio, see
[audio and rotation](audio-rotation.md). Circular A/V remains unsupported.
