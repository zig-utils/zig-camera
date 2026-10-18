# Circular A/V and synchronized snapshots (0.9)

Circular recording now retains encoded video and bounded owned S16LE audio.
H.264/HEVC snapshots use Home's AAC-LC adapter and fragmented MP4 writer;
MJPEG uses lossless PCM in Matroska. No FFmpeg/Libav is used.

```python
import time
from zigcamera import Picamera2, H264Encoder, CircularOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    history = CircularOutput(buffer_duration_ms=5000, max_frames=180,
                             max_bytes=64 * 1024 * 1024)
    recording = camera.start_recording(
        H264Encoder(bitrate=16_000_000, iperiod=30), history, fps=30,
        audio={"device": "hw:1,0", "sample_rate": 48000, "channels": 2,
               "codec": "aac", "bitrate": 192000})
    time.sleep(6)
    history.save_buffer("trail-pre-roll.mp4")
    history.open_output("trail-live.mp4")  # Retained history, then live input.
    time.sleep(10)
    history.save_buffer("second-snapshot.mp4")  # Does not consume live audio.
    history.close_output()  # History and capture continue.
    print(history.stats, history.audio_stats)
    camera.stop_recording()
```

Use a device name installed on your system. Microphone access remains explicit.
For synthetic development use `Picamera2(simulate=True)` with
`audio={"backend":"synthetic"}`. Build AAC MP4 with `-Dcodecs=true -Daac=true`;
real ALSA input also requires `-Daudio=true`. See [AAC setup](aac-mp4.md).

## Bounds and timeline

Video limits are unchanged: fixed bytes, frame descriptors and maximum timestamp
span; eviction preserves complete GOPs beginning on a keyframe. Circular PCM has
separate frame and block limits. `Recorder(..., circular={...},
audio={"sample_rate":48000,"buffer_frames":288000,"max_blocks":4096})` sets
these explicitly. Default PCM capacity is the rounded-up video duration plus one
second, capped at ten seconds; default block capacity is 4096. Rates/channels
retain existing limits. Frames count interleaved sample frames, not channel values.
PCM byte capacity is `buffer_frames * channels * 2`; descriptors are also allocated
once. Smaller sample or descriptor limits can shorten pre-roll. Rolling input
rejects a block larger than the arena before mutation; otherwise it evicts whole
oldest blocks. `audio_stats` reports retained frames/bytes, evicted frames, absolute
first-sample time and exclusive end time on the capture clock.

Snapshots begin at the first retained video key after any evicted PCM prefix.
If no covered key exists, `save_buffer` returns STATE without opening the path;
wait for the next key or increase history capacity/reduce GOP length. If PCM
has not reached the video endpoint, it returns BUSY without opening the path;
feed/wait for audio and retry. A legitimately later audio start is represented
with an initial track offset. Gaps inside AAC PCM are rejected, never concealed.

The snapshot ends after the last emitted video packet. If a newer input remains
inside the encoder, its timestamp defines that last packet's duration; otherwise
nominal FPS defines the tail. The buffered input itself is omitted. Audio is
sample-clipped to that same interval. Fresh AAC state encodes retained PCM,
including actual encoder delay and exact tail edits. Video packets are remuxed
without re-encoding. Repeated snapshots preserve both histories, encoder state,
live output cursor and recording counters. Each output gets independent headers,
AAC state and a zero-based video timeline. AAC sample phase is preserved when
rebasing a window, including fractional sample boundaries.

`open_output` replays pre-roll, then continues writing the shared clock. Live
splits still switch at a requested video key and divide audio at that boundary.
`close_output` finishes through the last emitted video interval without draining
or restarting the video encoder. Reopening includes the then-current pre-roll;
overlap between separate clips is intentional. If a live output falls behind
PCM eviction, recording fails explicitly; stop consumes the handle and releases
resources. Keep enough audio history for encoder delay and consumer stalls.

These synchronous calls serialize with the capture consumer. Snapshot AAC/file
work can delay that consumer and cause the bounded camera queue to drop frames;
it never runs inside the libcamera manager callback. There is no background
snapshot executor or performance claim. Output errors may leave a partial file;
snapshot errors do not poison the live recording. Identity checks protect the
active/pending file, including hardlinks. Seekable regular files are required
for AAC MP4. These APIs retain history; they do not implement Picamera2
CircularOutput2's delayed forwarding, arbitrary output objects or mutable delay.

## C API and validation

`zc_video_open_circular_av(config, video_limits, recording_options, bitrate, out)`
adds audio to the original circular API; `sample_rate` must be nonzero. Bitrate 0
selects the existing AAC default; the output extension selects `.mp4` AAC or
`.mkv` PCM. `zc_video_audio_buffer_stats` adds a 40-byte stats structure. Original
ABI v1 layouts remain unchanged. All recorder calls require serialization.
Python defaults compressed circular video to AAC/MP4 and MJPEG to PCM/MKV;
explicit `codec="pcm"` selects MKV for compressed video too.

Tests verify repeatable snapshots, sample/block eviction, arena wrap, incomplete
coverage/retry, live splits/close/reopen, capture gaps, offsets, stereo 44.1kHz,
48kHz mono, overrun cleanup, background audio ownership and C ABI. FAAD2 and
Apple AVFoundation independently check decoded PCM counts and waveforms. Linux
CI additionally decodes video with OpenH264/libde265. Physical A/V latency,
long-run clock drift and sustained Pi 5 performance remain unmeasured.
