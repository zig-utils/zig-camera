# Async pre-roll snapshots and delayed A/V (0.10)

Home's owned packet/PCM windows let snapshot workers operate independently of
capture. `CircularOutput2` adds bounded delayed forwarding of video and audio to
path outputs. Both paths use existing Home AAC/MP4 or PCM/Matroska writers; no
FFmpeg, Libav, PyAV or external encoding process is used.

## Snapshot jobs

```python
# history is a bound CircularOutput; recording and preview may keep running.
job = history.save_buffer("pre-roll.mp4", wait=False)
# Result is the supplied path; timeout only limits this wait.
path = job.result(timeout=10)

# From an asyncio coroutine:
path = await history.save_buffer("next-pre-roll.mp4", wait=False)

# Or receive the completed job on a separate callback thread:
job = history.save_buffer("event.mp4", signal_function=lambda job: print(job.result()))
```

`Recording.save_buffer` and low-level `Recorder.save_buffer` have the same
`wait` and `signal_function` arguments. Default calls still block and return
`None`. A callback or `wait=False` returns a job; `wait=True` waits even when a
callback is supplied. Jobs expose `done`, `cancel`, `cancelled`, `result`,
`get_result` and asyncio await. Callback exceptions are stored in
`job.callback_error` and do not replace the file result.

Submission selects the current keyframe/audio-covered window, copies only its
encoded packets and clipped PCM into owned Zig storage, and reserves a file
identity. Copying, allocation and file open/stat happen while recorder/camera
state is serialized; this is bounded work, not a guarantee of zero capture
stall. Worker AAC initialization/encoding, truncation and media writes run after
that lock is released. Even the default blocking Python call waits outside the
capture lock. No camera frame lease or mutable recorder pointer escapes to the
worker. Jobs keep their frozen view if live history advances or capture closes;
stop does not wait for these independent jobs. Explicitly await/result them
before application exit. Worker threads are daemon threads, not durable tasks.

At most two snapshot jobs per recorder may be outstanding. Each owns at most a
selected video window and PCM window plus descriptors, codec state and bounded
packet scratch. Slow callbacks retain a Python slot but native copies/fds are
freed before completion becomes observable. Queue exhaustion is explicit. Native
file identity reservations prevent active, pending and concurrent snapshot files
from aliasing, including hardlinks. Reservations survive recorder close.

Queued cancellation wins before worker claim and frees ownership. Once running,
AAC/file work finishes; cancellation and result timeouts do not interrupt native
writes. Cancelling an asyncio await requests queued cancellation but can leave a
running worker finishing its output. A reserved new destination may already
exist as an empty file; existing contents are not truncated until the worker
starts writing. Failure may leave a partial output but does not poison live
recording. Incomplete audio coverage or absent covered key fails at submission
before file open. AAC settings are checked by the worker before truncation.

C callers use `zc_video_freeze_buffer(recorder, path, &snapshot)` under recorder
serialization, then move the owned handle to a worker. Call single-use
`zc_snapshot_write(snapshot)` and always `zc_snapshot_close(snapshot)`, including
cancel/failure. Serialize calls to each snapshot; it may outlive its recorder.
Original ABI v1 structures are unchanged. The original `zc_video_save_buffer`
remains synchronous on the calling thread.

## Delayed forwarding

```python
import time
from zigcamera import Picamera2, H264Encoder, CircularOutput2

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    delayed = CircularOutput2(buffer_duration_ms=5000,
                              max_frames=180, max_bytes=64 * 1024 * 1024)
    recording = camera.start_recording(
        H264Encoder(bitrate=16_000_000, iperiod=30), delayed, fps=30,
        audio={"device": "hw:1,0", "sample_rate": 48000,
               "codec": "aac", "bitrate": 128000})
    delayed.open_output("trail-delayed.mp4")
    time.sleep(10)
    delayed.close_output()  # Finishes mature video; queued recent tail is excluded.
    delayed.open_output("continued.mp4")
    time.sleep(3)
    camera.stop_recording()  # Flushes the remaining queue into the open output.
```

Packets enter a fixed byte/descriptor FIFO. Each encoded video timestamp ages
the queue on the common capture clock; wall-clock sleeps do not flush stalled
input. Before enqueuing a new packet, mature entries are forwarded or discarded
if no output is open. An attached output waits for a video keyframe, rebases its
video to zero, and clips audio to that same capture epoch. AAC retains the real
sample clock and initial offset. Zero timestamp is a valid origin.

`open_output` attaches a new path without immediate pre-roll replay. An older
queued key may start it when that key matures. `close_output` finishes the latest
forwarded video interval using the next queued timestamp, clips audio through
that interval, and leaves the recent queue for capture/reopen. With no mature
key it writes only initialization headers. Stopping drains the video encoder,
flushes the FIFO to the still-open output and finishes its last frame at nominal
FPS. A closed output receives none of that later flush. Live splits request an
encoded key and commit when it reaches the delayed consumer, including during
stop. Delay is applied at video-frame granularity; finishing a clip includes its
last frame's interval and corresponding audio, not an arbitrary sub-frame cut.

`delayed.buffer_duration_ms = value` changes delay for subsequent input; it
neither recovers previously forwarded packets nor changes capacity. Setting zero
means immediate forwarding in this implementation (upstream Picamera2 currently
suppresses input at zero). Increasing delay retains future input longer;
decreasing it releases mature queued packets on the next input. Choose capacities
for the delay, frame sizes, GOP length and capture stalls. FIFO overflow fails
recording rather than silently losing encoded dependencies. PCM eviction passing
unwritten delayed audio also fails explicitly. Audio retains the existing maximum
ten-second PCM capacity; a longer delay cannot preserve audio beyond that bound.
`stats.frames/bytes` describe queued video; `stats.evicted` counts FIFO removals,
including successfully forwarded entries, rather than lost packets.

Version 0.11 adds [reusable output objects and PTS streams](output-objects.md),
including Home muxing to file-like streams. This remains a documented
CircularOutput2-style subset sharing camera start/stop; PyavOutput integration
and upstream's complete signatures are not implemented. `CircularOutput` keeps immediate pre-roll replay behavior. A snapshot
from `CircularOutput2` uses only its current unforwarded queue, beginning on a
covered key if one exists. No background executor is added for live delayed file
writes; those retain the existing serialized recording consumer semantics.

Low-level Python sets `circular={"delay_ms":5000,...}` at Recorder construction.
C calls `zc_video_set_delay(recorder, delay_ns)` on a circular recorder before
submitting input/opening output. Later calls change delay. Bounds and original
API layouts are unchanged. For microphone dependencies and clocks, see
[AAC MP4](aac-mp4.md) and [circular A/V](circular-av.md).

Tests cover frozen ownership after close/eviction, capture progress while a worker
is blocked, two-job bounds, queued cancellation, callback/startup/file failures,
await/result timeouts, reserved identities, FIFO overflow, delayed close/reopen,
runtime delay changes, stop before maturity, pending splits, capture gaps and
44.1kHz stereo offsets. FAAD2 and AVFoundation independently validate AAC counts
and waveforms; Linux also decodes video with OpenH264/libde265. Pi throughput,
physical microphone/camera latency and long-run clock drift remain unmeasured.
