# Reusable outputs and PTS streams (0.16)

`Recorder`, `Camera.start_recording`, `Picamera2.start_recording` and circular
`open_output` accept reusable output objects as well as paths. Packet output and Home container output share the existing delayed
keyframe/audio timeline. No FFmpeg, Libav or PyAV dependency is used.

```python
import time
from zigcamera import Picamera2, H264Encoder, CircularOutput2, MuxedOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    delayed = CircularOutput2(pts="delayed.pts", buffer_duration_ms=5000)
    output = MuxedOutput("trail.mp4", pts="trail.pts")
    camera.start_recording(
        H264Encoder(bitrate=16_000_000, iperiod=30), delayed, fps=30,
        audio={"device": "hw:1,0", "sample_rate": 48000, "codec": "aac"})
    delayed.open_output(output)
    time.sleep(10)
    delayed.close_output()
    # Reuse the object after close; format stays fixed at MP4.
    output.fileoutput = "next.mp4"
    output.ptsoutput = "next.pts"
    delayed.ptsoutput = "next-delayed.pts"
    delayed.open_output(output)
    time.sleep(3)
    camera.stop_recording()  # Flushes the delayed tail, then stops the object.
```

For synthetic development select `Picamera2(simulate=True)` and
`audio={"backend":"synthetic"}`. See [AAC setup](aac-mp4.md) for standalone
FDK dependencies and supported rates. Physical camera/microphone synchronization
and Pi throughput remain unmeasured.

## Simultaneous recording and dynamic attachment

```python
import time
from zigcamera import Picamera2, H264Encoder, FileOutput, MuxedOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    movie = MuxedOutput("trail.mp4", pts="trail.pts")
    elementary = FileOutput("trail.h264", pts="elementary.pts")
    recording = camera.start_recording(H264Encoder(bitrate=16_000_000, iperiod=30),
                                       [movie, elementary], fps=30)
    time.sleep(3)
    backup = MuxedOutput("backup.mp4", pts="backup.pts")
    attachment_id = recording.add_output(backup)
    time.sleep(3)
    print(recording.output_stats(attachment_id))
    recording.remove_output(attachment_id)  # Finalizes backup; others continue.
    time.sleep(2)
    camera.stop_recording()
```

`Recorder`, `Camera.start_recording` and `Picamera2.start_recording` accept a
list or tuple of paths/output objects. The limit is eight simultaneous outputs.
An empty list starts encoding without a sink, for later dynamic attachment.
`Recorder` and `Recording` expose `outputs`, `add_output`, `remove_output` and
`output_stats`. `Camera`/`Picamera2` also provide `add_recording_output` and
`remove_recording_output`. Add returns a nonzero attachment ID; remove/stats accept
that ID, the original output object, or the same path. IDs are not reused during
a recorder's lifetime, so stale removals cannot detach another addition. Duplicate
object claims, shared memory streams and file aliases are rejected. A group
startup failure closes every successfully started output and the native recorder;
preparation can already have written new headers, so it is not a file transaction.

Video is encoded once, then the same packet is delivered to each native output.
Initial outputs receive the same first key. Dynamic additions receive metadata
and initialization headers during attachment, then wait for the next forwarded
key; a new IDR is requested. Each starts its own zero-based PTS and fresh AVC/HEVC
parameter sets. Adding to circular recording does not replay history; use the
primary `open_output` or a snapshot for retained pre-roll. A recorder's delay
applies to all its outputs; adding during delayed recording can start with an
already queued key when it matures. Sink execution is serialized, with bounded
attachment storage and no per-sink worker or unbounded packet queue. A slow sink
applies backpressure; there is no silent dropping for other sinks.

Every output owns its container and AAC state. Home's non-consuming PCM windows
provide independent sample cursors; live PCM is released only after every active
consumer has read it. Rolling history keeps its existing retention/overrun rules.
MP4 receives AAC-LC, MKV receives PCM, and custom packet outputs receive PCM.
All outputs share source sample rate/channels and video encoding parameters.
`FileOutput` still rejects audio; use audio-capable outputs for an A/V recorder.
No implicit resampling is performed. Finite output removal finishes buffered
video and AAC through the emitted timeline; it excludes that sink's delayed tail.
Other sinks continue, and recorder stop drains their remaining encoder/FIFO tail.

The first initial output is the legacy primary, ID `0`. Existing
`split_recording`, `Recorder.split`, rotation and `close_output` operate on that
primary while added outputs continue uninterrupted. Pending primary splits count
as a replacement, not a ninth active output. Removal of a primary with a pending
split is rejected; cancel or finish that split first. Rotation manages its own
primary, so remove additional outputs freely but do not detach the rotating
primary. With an empty initial list, use the returned IDs for additions;
`open_output` may later create a primary if capacity permits.

Attachment/removal runs under the same recording lock as frame delivery. It
finishes native ownership before Python `stop` and keeps all callback contexts
alive through finalization. Failed preparation releases only the attempted new
attachment. With the default `failure_policy="fail_fast"`, a packet/write failure
poisons the whole recording and is surfaced to the owner; close is required. Close
attempts to finalize every sink and calls every stop hook even when another sink
fails. A removed sink's finish/stop error is reported after detachment; remaining
healthy sinks can continue. Per-output splitting and opt-in failure isolation are
described below.
`output_stats` reports each attachment's frames, bytes, relative recorder start,
PCM frames delivered and whether it is still waiting for a key. Legacy recorder
stats remain primary-specific for media bytes/frames and rotation; the audio
written counter sums sample deliveries across all sinks. Source audio frames
remain a single input count.

## Per-output async splits and failure isolation

```python
import time
from zigcamera import Picamera2, H264Encoder, MuxedOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    main = MuxedOutput("main.mp4", pts="main.pts")
    alternate = MuxedOutput("alternate.mp4", pts="alternate.pts")
    recording = camera.start_recording(H264Encoder(bitrate=16_000_000, iperiod=30),
                                       [main, alternate], fps=30,
                                       audio={"device": "hw:1,0", "sample_rate": 48000},
                                       failure_policy="isolate")
    time.sleep(3)
    next_main = MuxedOutput("main-next.mp4", pts="main-next.pts")
    next_alternate = MuxedOutput("alternate-next.mp4", pts="alternate-next.pts")
    job_a = recording.split_output(0, next_main)
    job_b = camera.split_recording_output(1, next_alternate, wait=False)
    assert job_a.result(5) is next_main
    assert job_b.result(5) is next_alternate
    # Other outputs continue while either attachment splits or fails.
    print(recording.output_status(1), recording.output_errors)
    time.sleep(3)
    camera.stop_recording()
    print(recording.output_errors)  # Includes errors discovered during close.
```

`Recording.split_output(current, replacement, signal_function=None)` returns an
awaitable job. `Camera`/`Picamera2.split_recording_output(current, replacement,
wait=None, signal_function=None)` provide the same default wait/callback behavior
as `split_recording`. Identify `current` by attachment ID, object or original path.
The ID survives a successful split; `output_status(id)['generation']` increments.
The replacement becomes that ID's target in `outputs`, removal and stats. Only
one split may be pending per attachment, so up to eight can progress independently.
The primary's existing split/rotation API continues to use ID zero. Rotation
manages primary splits; other IDs can split manually during rotation.

`Recorder.split_output(current, replacement)` stages the native split for manual
frame feeding. Its `cancel_output_split(current)` and `output_status(current)`
provide low-level control. A keyframe request is shared, but each old sink clips
its own PCM and finishes its own container before its replacement receives the
key. The new sink starts at zero PTS with fresh AVC/HEVC headers and AAC state.
A split before an attachment's first frame preserves one old frame before moving.
Delayed FIFO recording uses the same rules at the forwarded key. Neither a
successful split nor a cancelled split interrupts another attachment's timeline.

Cancellation wins before native commit. A job wait timeout leaves the split
pending; it does not cancel. Camera recording stop cancels all unresolved split
jobs before draining. Removing an attachment with a pending split is rejected;
cancel or finish the job first. Preparation can write headers/reset owned targets,
so cancellation may leave empty elementary media or unfinished container headers.
All active and pending media/PTS/snapshot identities participate in alias checks.
Old and pending callback contexts stay alive until their native ownership ends.
User job callbacks run on the existing bounded callback mechanism after lifecycle
cleanup; callback errors are reported in `callback_error`.

Select `failure_policy="isolate"` at Recorder/Camera/Picamera2 recording startup to
quarantine sink packet/write, audio conversion/encoding and finalization failures.
The default remains `"fail_fast"` for compatibility. Quarantined outputs receive
no more packet or byte callbacks, including no repeated finish attempts. They
stay attached and keep their descriptor/object claims until remove/close, so the
error can be inspected and their storage cannot be overwritten through an alias.
They no longer pin PCM; healthy outputs continue with their complete timelines.
`output_errors` maps attachment IDs to original Python exceptions, or native
`CameraError` objects for native path errors. `output_status` reports `error_code`,
`generation`, `pending` and numeric split state: idle 0, pending 1, committed 2,
failed 3, cancelled 4. Counts remain available through `output_stats`.

If the old sink fails while finalizing a split, that attachment is quarantined,
its pending replacement is cancelled and stopped, and only its job fails. If the
new sink fails after commit, its generation has advanced but its job reports that
failure and it is quarantined. A Python old-output stop-hook failure fails that
job and is recorded for the ID, while the committed new native sink stays healthy;
its native `error_code` remains zero. Later splits replace the prior operation's
lifecycle error. Preparation failures are raised synchronously and do not damage
the old sink. Detach a quarantined sink and re-add an output to restart it with a
fresh ID, epoch and codec state; there is no automatic retry.

Native close attempts every healthy sink, reports per-output finalization errors,
and consumes all native ownership even if a sibling fails. Python calls every
stop hook, preserves final errors in `output_errors`, and permits final
`output_status(id)` queries by numeric ID. These error records are bounded by the
active attachments; removal discards an ID's record, so save/log it before detach.
In isolation mode, a sink or stop-hook error does not make whole-recording close
raise; shared recorder/capture failures still do. A direct low-level recorder
closed with an unresolved healthy split retains its existing `ZC_STATE` behavior.

Shared video encoder/input errors, delayed FIFO overflow and shared storage
allocation failures remain recorder-fatal and fail every outstanding job. Sink
callbacks still execute serially and can apply backpressure; isolation does not
add worker threads or deadlines for blocking callbacks. Per-output delay, encoding
settings and automatic recovery remain outside this interface.

## Direct recording and async splits

```python
import time
from zigcamera import Picamera2, H264Encoder, MuxedOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    first = MuxedOutput("first.mp4", pts="first.pts")
    second = MuxedOutput("second.mp4", pts="second.pts")
    camera.start_recording(H264Encoder(bitrate=16_000_000, iperiod=30), first,
                           audio={"device": "hw:1,0", "sample_rate": 48000})
    time.sleep(3)
    job = camera.split_recording(second, wait=False)
    assert job.result(5) is second
    time.sleep(3)
    camera.stop_recording()
```

Direct objects do not allocate circular video history. `Recorder(output, ...)`
provides the same interface for manually supplied frames and PCM. Its
`split(output_or_path)` stages a split; `buffer_stats['split_pending']` tracks
completion as the caller feeds frames. At camera level, `split_recording` and
`Recording.split` return bounded jobs when `wait=False` or a signal callback is
provided. Jobs are awaitable and return the target object/path unchanged. A
result timeout limits the wait and leaves the split pending. Job cancellation
wins only before the native keyframe commit; stopping a camera recording cancels
an unresolved split before draining the active recording. Callbacks run after
old output finalization and `stop`, with callback exceptions in `callback_error`.

The new object is claimed, started and given source metadata during preparation.
A muxed sink can receive initialization headers immediately, and accepted owned
media/PTS targets reset during preparation. Cancellation can therefore leave an
empty elementary file or an unfinished container header; it does not restore old
target contents. The pending object receives no packets before commit. At the
next encoded key after at least one old frame, native code finishes old media
and clips PCM at that timestamp, then switches to fresh container/AAC state.
No packet is duplicated or dropped at a successful split. A pending split before
the first input gives the first key to the old output and requests another key.
The new clip's key and PTS start at zero, with fresh AVC/HEVC parameter sets.
The old object's Python `stop` runs after the native call returns; its context
remains alive through native finalization. Sink errors are visible and require
closing the failed recording. A stop error still releases both native ownership
and object claims during recording close.

Paths and objects can be mixed in successive splits. Paths retain their native
route unless a CircularOutput2 sidecar needs callback observation. Each output's
own sidecar ends with that output. CircularOutput2's separate sidecar stays open
across splits and appends the timestamps of each segment, including its new zero;
it is transferred to the new attachment without reopening/truncation. Cancellation
leaves that sidecar with the old output. Split outputs must use distinct media
and per-output PTS storage, including borrowed in-memory streams. CircularOutput2's
shared sidecar is the single explicit exception. No automatic retention deletion
or background sink thread is added.

## Output types and ownership

`Output(pts=None)` is the reusable packet protocol. Implement `start`, `stop`,
`outputframe` and optionally `_add_stream`; subclassing is optional. Objects are
attached once at a time. Stream descriptors are replayed on every attachment,
after `start` and before packet delivery. A failed attachment calls `stop` and
releases its claim. `close_output` finishes the native output before stopping the
object. Recording stop flushes queued video/audio before stopping it. Native and
Python resources are released even when packet, metadata, PTS or stop methods
raise. A failed recording must be closed; the output object can then be reused.

`FileOutput(file=None, pts=None)` writes elementary MJPEG (concatenated JPEG) or
AVC/HEVC Annex B. A new attachment starts on a key; compressed video includes
fresh parameter sets at that key. It rejects audio before attachment. It does
not infer MP4 from a filename: use `MuxedOutput` for containers. A `None` file can
be used for PTS-only video consumption.

`MuxedOutput(file, pts=None, format=None)` delegates all encoding/muxing to Home.
Paths infer `mp4` or `mkv`; file-like streams require an explicit format. The
format stays fixed when `fileoutput` changes. MP4 supports H.264/HEVC with optional
Home AAC-LC; MKV uses existing MJPEG/AVC/HEVC plus PCM support. AAC MP4 requires
seek/tell/truncate and patch support. Video-only MP4 may use a sequential writer.
Unsupported combinations fail explicitly; no implicit resampling/container swap
or external encoder is introduced.

Paths are opened and closed per attachment. Opening reserves their identity
without truncation; native descriptor/snapshot checks run before media or PTS
reset. Accepted elementary and PTS paths reset for a new clip, even when no key
matures before close. Muxed paths receive fresh initialization headers. File
errors can leave partial output; media and PTS writes are not an atomic pair.
Hardlinks/aliases among reported media, PTS and reserved snapshot descriptors are
rejected before truncation. Opaque custom sinks must report/manage their own
storage identities; the library cannot inspect hidden files inside custom code.

Borrowed streams are never closed. `FileOutput` writes at their current position.
`MuxedOutput` resets seekable borrowed streams to zero per session so the next
movie replaces the previous movie. Read/copy the result before reuse. Borrowed
PTS streams append at their current position; each attachment's timestamps start
at zero. Use a new stream or reset it to keep one sidecar per clip. Keep all
borrowed streams/descriptors open until native detach/stop completes. Change
`fileoutput`/`ptsoutput` after close, not while attached.

```python
import io
from zigcamera import MuxedOutput

movie = io.BytesIO()
pts = io.StringIO()
output = MuxedOutput(movie, pts, format="mp4")
delayed.open_output(output)
# ... capture ...
delayed.close_output()
mp4_bytes = movie.getvalue()  # Both borrowed streams remain open.
```

## PTS format and timing

`CircularOutput2(pts=...)` and each built-in output's `pts` accept a path, a
writable text stream (such as StringIO), or a binary IO stream (such as BytesIO).
`ptsoutput` returns the active stream or configured target. Sidecars contain one
line per accepted video frame, including the final encoder/FIFO flush; audio
never adds lines. No header is written. Integer microseconds are formatted as
milliseconds with exactly three decimals and LF, matching Picamera2's convention:

```text
0.000
41.666
83.333
```

The first video key is zero. Subsequent timestamps preserve capture gaps and
match the rebased MP4/MKV video timeline. PTS formatting uses Home's checked
integer helper, avoiding float/locale rounding. Both CircularOutput2's stream and
an attached output's own stream may be used, provided they are distinct files
or stream objects. A PTS write/flush failure surfaces to the recording owner.
For a custom subclass, call `outputtimestamp(timestamp)` or the base
`Output.outputframe` when you want that output's own PTS stream written;
CircularOutput2's PTS stream is written independently after successful delivery.

## Custom packets and stream metadata

```python
from zigcamera import Output

class Consumer(Output):
    def _add_stream(self, stream, codec, **parameters):
        print(codec, parameters)

    def outputframe(self, frame, keyframe=True, timestamp=None, packet=None, audio=False):
        # frame is owned immutable bytes; it may be retained after this call.
        # timestamp is integer microseconds; packet.timestamp_ns preserves ns.
        consume(frame, keyframe, timestamp, audio)
        if not audio:
            self.outputtimestamp(timestamp)
```

Video is JPEG or Annex B AVC/HEVC; audio is interleaved S16LE PCM. Custom packet
outputs receive source PCM even when the recorder's container preference is AAC;
`MuxedOutput` performs AAC encoding inside Home. `packet` is an immutable native
`PacketInfo(codec, timestamp_ns, keyframe, audio)`, not a PyAV packet.
`_add_stream` receives an immutable `StreamInfo` plus codec/parameters. Video
extradata contains checked four-byte NAL-length-prefixed parameter sets (empty
for MJPEG); audio metadata includes sample rate and channels. It is not an AV
encoder stream. No implicit pacing or sink-specific stream negotiation occurs.

Callbacks run synchronously on the serialized recording consumer, never the
libcamera manager callback. They can apply backpressure. Camera/recorder API
re-entry from an output callback raises before state mutation; schedule lifecycle
changes elsewhere. Keep callback work bounded. Write methods must report positive
progress until all bytes are accepted; zero/invalid progress is an error. Python
callback exceptions cross the C boundary as failure statuses, then the original
exception is raised to the recording owner. No exception unwinds through C.

## Native API and limits

`zc_video_add_callbacks` and `zc_video_add_output` add bounded independent sinks
and return stable IDs; `zc_video_remove_output` finishes/detaches an ID, and
`zc_video_output_stats` fills an additive 48-byte structure. ID zero denotes the
primary. For a removal error, query stats: `ZC_STATE` means the ID was consumed;
otherwise retain its callbacks until detach or recorder close.
`zc_video_split_output` accepts an attachment ID and exactly one path/callback
descriptor. `zc_video_cancel_output_split` cancels that ID's pending replacement.
`zc_video_set_failure_isolation` selects the policy before first video input.
`zc_video_output_state` returns an additive 24-byte state; `zc_video_close_outputs`
consumes the recorder and returns up to eight 32-byte ID/state results after
encoder/FIFO drain and finalization. Capacity below eight is rejected without
consuming the handle. Preserve callback contexts through the close call.
`zc_video_create` creates an output-less direct recorder with optional PCM
configuration and no history. `zc_video_open_callbacks` attaches a 56-byte
callback descriptor to direct, circular or delayed recording.
`zc_video_split_callbacks` stages the same descriptor for a keyframe handoff.
Retain both callback contexts until split commit, cancellation or recorder close.
`zc_video_buffer_stats` exposes pending state and segment count; no callback
data/context is retained after detach/close. PACKETS delivers borrowed Annex B/JPEG/PCM through a 32-byte
`zc_output_packet`. MP4/MKV invoke synchronous byte writes and optional absolute
patches; packet callbacks in mux modes carry video metadata only (NULL data).
Provide real file descriptors when available, or -1 for non-file storage, and
keep them open through close. Media/PTS/snapshot descriptors must be distinct.
`zc_video_get_headers` copies source parameter sets, and `zc_format_pts` formats
microsecond timestamps into caller-owned storage. Original ABI v1 layouts remain
unchanged. Callbacks must not re-enter native recorder/camera APIs.

This covers the reusable protocol and PTS subset, not every upstream
FileOutput/socket/datagram option, PyavOutput, arbitrary AV packets or all
Picamera2 constructor signatures. The existing [delay/close/stop rules](async-delayed.md)
remain, including zero meaning immediate forwarding here. Non-delayed circular
attachments replay retained history; delayed attachments wait for a mature key.

Validation covers sequential reuse across recorders, owned/borrowed streams,
exact PTS, capture gaps, PCM offsets, fresh AVC/HEVC parameter sets, file identity
collisions, partial writes, lifecycle/metadata/PTS failures, callback re-entry and
C/Python ABI, direct object startup, async object/path splits, cancellation,
per-segment headers/PTS and fractional 44.1 kHz sample boundaries. Simultaneous
coverage includes identical packets, shared encoder behavior, bounded capacity,
stale IDs, joins/removals, primary splits with continuous parallel A/V, descriptor
collisions, snapshot reservations, failure cleanup and zero-consumer PCM release. FAAD2/AVFoundation independently check stream-backed AAC MP4 audio;
Linux CI additionally decodes elementary and muxed video with OpenH264/libde265.

## Independent delays and automatic recovery

`Recorder` and the background `Recording` handle expose the same APIs. Delays
and recovery policies belong to an attachment ID, survive its splits, and do not
re-encode video. Primary ID is `0`; use the ID returned by `add_output` for additions.

```python
from zigcamera import Camera, MuxedOutput

with Camera() as camera:
    backup = MuxedOutput("backup.mkv")
    recording = camera.start_recording(["live.mkv", backup], fps=30,
                                       failure_policy="isolate")
    recording.set_output_delay(1, delay_ms=1000,
                               max_bytes=16 * 1024 * 1024, max_frames=120)
    recording.set_output_recovery(
        1, lambda attempt, error: MuxedOutput(f"backup-recovery-{attempt}.mkv"),
        max_attempts=3, retry_delay_ms=100, max_delay_ms=2000)
    # Application runs capture. Inspect while active:
    print(recording.output_delay(1))
    print(recording.recovery_status(1))
    camera.stop_recording()
```

`set_output_delay(output=0, delay_ms=..., max_bytes=..., max_frames=...)` creates a
native FIFO plus scratch arena, each bounded by `max_bytes`, and a fixed entry
array. Defaults are 8 MiB per arena and 300 entries. There is no per-frame queue
allocation; explicit compressed packet copies release the camera lease normally.
The frame and byte bounds must cover the chosen delay and bitrate, including
large keyframes. Overflow fails that attachment under isolation; fail-fast remains
the default. Unconfigured outputs have no extra queue. Recorder-wide
`CircularOutput2` delay is additive: the per-output clock advances when that
shared timeline forwards packets.

Delay may change dynamically with unchanged bounds; it takes effect on the next
encoded packet and decreasing it can forward a burst in order. Resizing a nonempty
queue fails without mutation. Delay zero drains on the next packet. `output_delay`
reports nanoseconds, queued frames/bytes and capacities. `remove_output` excludes
that sink's pending tail; recorder stop flushes every healthy tail. A split commits
on a keyframe in its own forwarded timeline, so a queued key captured before the
split request can form the boundary. Packet timestamps and PTS restart at zero
for each new segment. Audio uses the same boundary and remains sample-clipped.

Size the shared audio `buffer_frames`/`max_blocks` to cover the longest total
delay plus encoder latency and input-block headroom (the PCM limit is ten seconds).
Insufficient source/audio-history capacity remains an explicit shared input
error. For example, a one-second delay at 48 kHz needs more than 48,000 retained
samples, plus headroom; do not rely on the default two-second audio buffer for a
longer delay. Circular snapshots continue to use the recorder's shared history.

`set_output_recovery(output, factory, max_attempts=3, retry_delay_ms=100,
max_delay_ms=5000)` requires isolation. After accepted video writes, Home's retry
policy polls the last video timestamp in nanoseconds. The first observed failure
starts a deadline; retry delay doubles for later attempts up to its cap. Zero delay
allows an immediate attempt. Time advances with media input, so paused capture
also pauses retries. This is not a wall-clock reconnect service. Factories run on
the serialized recording consumer, under the output callback re-entry guard;
keep them short. Camera manager callbacks do not execute factories. Factories and lifecycle hooks still run on that consumer. Enable the optional
async I/O workers below to move runtime sink calls off it.

The factory receives `(attempt, error)` with attempts starting at one and returns
a fresh output object or container path. Sink creation, stream metadata, descriptor
and snapshot reservation checks run before releasing the quarantined target.
Aliases to any active/pending/quarantined media or PTS file are rejected. Choose a
new path for each recovery. The native replacement preserves the attachment ID,
increments its generation, discards its stale queue, requests a new keyframe and
starts fresh container/AAC/PTS state. A primary CircularOutput2 observer sidecar
keeps its descriptor across recovery and records the new zero-based epoch. It does not repair or append to a partially
written file. Healthy attachments continue their own timelines. A failed split
job keeps its original failure even if automatic recovery succeeds immediately.

Failed factory/setup attempts consume the budget. Successful recovery preserves
the lifetime attempt count, so a flapping sink cannot retry indefinitely.
`recovery_status` reports limit, attempts, exhaustion, pending deadline and the
last factory/setup error; `last_failure` retains the original sink error after a
successful replacement. `output_errors` describes current failures. Creation
failures keep the old target quarantined and retry on later input. Final recovery
status remains queryable by numeric ID after close. Stop/detach releases factories
and borrowed contexts; close does not start recovery attempts.

Use `set_output_recovery(id, None)` to disable, or configure again to explicitly
reset its budget. `recover_output(id, replacement)` manually replaces a quarantined
sink using the same ownership and keyframe rules, including after exhaustion.
Encoder/source failures remain outside sink recovery. Optical quality, physical
A/V synchronization and Pi throughput still require hardware validation.

The timing/flush behavior follows the upstream
[CircularOutput2 source](https://github.com/raspberrypi/picamera2/blob/main/picamera2/outputs/circularoutput2.py),
with explicit bounded storage and separate attachment timelines. This is a tested
compatibility subset, not complete Picamera2 parity.

## Async output I/O and per-output backpressure

`Recorder`, `Camera.start_recording` and `Picamera2.start_recording` accept
`async_io`. It defaults to `None` (synchronous). An options dictionary enables
workers for every attached output and supplies defaults for later additions and
circular opens. `{}` selects the worker defaults. A dictionary keyed by stable
output IDs selects individual attachments:

```python
from zigcamera import Camera, MuxedOutput

with Camera() as camera:
    recording = camera.start_recording(
        [MuxedOutput("live.mkv"), MuxedOutput("backup.mkv")], fps=30,
        failure_policy="isolate",
        async_io={1: {"max_bytes": 8 * 1024 * 1024, "max_ops": 1024,
                      "backpressure": "fail"}})
    # Only backup (ID 1) has a worker; live (ID 0) uses synchronous delivery.
    print(recording.output_io_stats(1))
    # Application captures frames here. Drain waits for admitted I/O, while
    # stop also flushes encoder, delayed video, audio and container finalization.
    recording.drain_output_io(1)
    camera.stop_recording()
```

Call `set_output_io(id, max_bytes=8*1024*1024, max_ops=512,
backpressure="fail", timeout_ms=100)` once to enable an existing synchronous
attachment at a serialized call boundary. It also works after a synchronous
prefix has already been delivered. An active/staged worker cannot be resized,
disabled or reconfigured; detach and attach a fresh sink for different settings.
`add_output(sink, async_io={...})` and `open_output(sink, async_io={...})` override
recorder defaults when attaching. Splits and automatic recovery inherit the
attachment's native worker configuration, with fresh per-segment counters.

Each worker owns Home's fixed byte arena, a same-sized scratch arena, an entry
array, and one thread. Enqueue explicitly copies bytes; it never retains a frame,
PCM view or camera DMA lease. Queued **and in-flight** bytes/operations count
against the same bounds. Empty metadata notifications consume entries too. A
container frame may generate several writes, so `max_ops` counts I/O operations,
not video frames. Limits are 1 GiB per arena and 65,536 operations; memory for
entries, container/encoder state, existing delay queues and PCM history is
additional. No per-operation queue allocation or background unbounded list is
used. Eight attachments can each retain at most a current and a staged/retiring
worker epoch.

Runtime media writes, random-access MP4 patches, raw video/PCM packet callbacks
and PTS notifications run in FIFO order on that sink's native worker. User calls
are made outside the queue mutex. Home muxing/AAC encoding still run on the
recording consumer. Target opening, headers/history replay before worker enable,
`start`, stream metadata, commit and `stop` lifecycle hooks remain synchronous.
This is asynchronous sink delivery, with no hardware throughput claim.

Backpressure is selected independently:

- `"fail"`: a full byte/operation queue immediately fails that attachment with
  `ZC_BUSY`; an operation larger than the byte arena fails with `ZC_INVALID`.
- `"wait"`: the producer waits for capacity up to `timeout_ms` **per operation**
  (1–60,000 ms), then fails that attachment. Other producer work waits during
  this opt-in bounded wait. Worker calls themselves have no imposed timeout.

With `failure_policy="isolate"`, queue/worker failures quarantine only that sink
and peers continue. The default fail-fast policy still stops recording on the
next observed failure. Individual compressed packets/container fragments are
never silently dropped to relieve pressure. Once a sink fails, pending work is
abandoned after any in-flight call returns; the partial container may be
incomplete. Existing fresh-target recovery can restart it on a new keyframe,
and does not claim an attempt while its failed worker still owns an in-flight
callback. Recovery preserves queue bounds and lifetime retry budgets.

`output_io_stats(id)` reports queued bytes/operations (including in-flight),
accepted/completed/rejected operations, high-water marks, configured limits,
worker running state, I/O error and a separate `split_error`. Accepted counts
mean admitted to the queue, not delivered to the OS. Completed counts mean sink
calls returned successfully, not durable storage. A returned `write` can precede
a later worker exception. `output_errors`, subsequent input, explicit drain and
close surface those failures under the selected policy.

At a split key, the new epoch may accept operations while the old one drains.
A completion fence prevents its worker from delivering callbacks before the old
worker ends, preserving shared CircularOutput2 PTS epoch order. The old context,
file identity and object claim remain reserved until completion. Generation
advances at keyframe commit, while state `pending` remains set until retirement;
the async split job completes then. It cannot be cancelled after commit. A late
old-worker failure fails that split job and records `split_error`, while the new
sink can remain healthy under isolation. New splits/removals are busy until that
retirement finishes. The capture pump checks completions even during frame
starvation, and stop resolves committed jobs after draining; uncommitted jobs
are cancelled as before.

`drain_output_io(id)` waits for already admitted operations in current/retiring
epochs and reports errors. It does not flush a pending encoder frame or release
the separate configured A/V delay tail. Explicit detach and stop finish accepted
I/O before releasing callbacks, owned files or claims. Stop uses draining
backpressure for final writes/patches so normal finalization does not fail merely
because the queue was temporarily full. These explicit operations can wait for
a sink; arbitrary blocked callbacks cannot be forcefully cancelled safely. Use
appropriate device/socket timeouts in custom sinks. Borrowed streams remain
open, and storage `fsync`/durability is the application's responsibility.

Callbacks may execute on native threads and must eventually return. Camera,
recording and recorder API re-entry is rejected before acquiring producer locks,
including during stop/drain. Keep application shared state synchronized. Queue
statistics require a live recorder; final output errors remain queryable after
close. Native C callers can enable/query/drain with `zc_video_set_output_io`,
`zc_video_output_io_stats`, and `zc_video_drain_output_io`; old ABI layouts remain
unchanged and the 88-byte I/O statistics structure is additive.
