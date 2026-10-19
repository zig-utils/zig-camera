# Reusable outputs and PTS streams (0.11)

`CircularOutput2.open_output` now accepts reusable output objects as well as
paths. Packet output and Home container output share the existing delayed
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

`zc_video_open_callbacks` attaches a 56-byte callback descriptor to a delayed
circular recorder. PACKETS delivers borrowed Annex B/JPEG/PCM through a 32-byte
`zc_output_packet`. MP4/MKV invoke synchronous byte writes and optional absolute
patches; packet callbacks in mux modes carry video metadata only (NULL data).
Provide real file descriptors when available, or -1 for non-file storage, and
keep them open through close. Media/PTS/snapshot descriptors must be distinct.
`zc_video_get_headers` copies source parameter sets, and `zc_format_pts` formats
microsecond timestamps into caller-owned storage. Original ABI v1 layouts remain
unchanged. Callbacks must not re-enter native recorder/camera APIs.

Output objects currently attach through CircularOutput2 or a low-level delayed
Recorder. Plain path recording without PTS preserves its direct native route and path
splits. Snapshots remain available.
Manual splitting while a reusable object is attached is rejected; close/reopen
it instead. This covers the reusable protocol and PTS subset, not every upstream
FileOutput/socket/datagram option, PyavOutput, arbitrary AV packets or all
Picamera2 constructor signatures. The existing [delay/close/stop rules](async-delayed.md)
remain, including zero meaning immediate forwarding here.

Validation covers sequential reuse across recorders, owned/borrowed streams,
exact PTS, capture gaps, PCM offsets, fresh AVC/HEVC parameter sets, file identity
collisions, partial writes, lifecycle/metadata/PTS failures, callback re-entry and
C/Python ABI. FAAD2/AVFoundation independently check stream-backed AAC MP4 audio;
Linux CI additionally decodes elementary and muxed video with OpenH264/libde265.
