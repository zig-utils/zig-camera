# AAC-LC and synchronized MP4 (0.8)

Build with `-Dcodecs=true -Daac=true` for H.264/HEVC + AAC-LC MP4. Linux microphone
capture additionally needs `-Daudio=true` and ALSA. Home's new AAC adapter links
the standalone FDK AAC library directly; its streaming MP4 module writes both
tracks. There is no FFmpeg/Libav dependency or external encoding process.

```python
import time
from zigcamera import Picamera2, H264Encoder, RotatingOutput

with Picamera2() as camera:
    camera.configure(camera.create_video_configuration(main={"size": (1920, 1080)}))
    output = RotatingOutput("trail-{index:06d}.mp4", duration_ms=60_000)
    recording = camera.start_recording(
        H264Encoder(bitrate=16_000_000, iperiod=60), output, fps=30,
        audio={"device": "hw:1,0", "sample_rate": 48000, "channels": 2,
               "codec": "aac", "bitrate": 192000})
    time.sleep(10)
    camera.stop_recording()
```

`audio=True` chooses the existing explicit ALSA defaults. A dictionary accepts
capture settings plus `codec` and `bitrate` (bits/s). `.mp4` selects AAC by default;
`.mkv` selects lossless PCM. An explicit codec must match the container. AAC defaults
to 64kb/s mono or 128kb/s stereo. Supported rates are 8, 11.025, 12, 16, 22.05, 24,
32, 44.1 and 48kHz; one or two channels, 16–320kb/s. Unsupported combinations fail;
there is no implicit resampling or fallback encoder. HEVC uses `HEVCEncoder`.
AAC in Matroska, HE-AAC, circular A/V and MP4 audio-only output remain unsupported.
The native CLI remains video-only; use Python or the C API for A/V.

The bitrate field is extracted before opening the input device. Both high-level
recording and `Recorder(..., audio={"sample_rate":48000,"channels":2,
"codec":"aac","bitrate":192000})` use the same Home encoding/muxing path.
`Recorder.write_audio` still accepts explicit S16LE bytes with a first-sample
nanosecond timestamp. C users may use `zc_video_open_ex` for default AAC bitrate
or `zc_video_open_aac` for an explicit bitrate; original ABI v1 layouts are unchanged.

## Install the optional standalone codec

The build uses `pkg-config fdk-aac` and the system's FDK headers. Tests pin FDK 2.0.3
at `716f4394641d53f0d79c9ddac3fa93b03a49f278`. If your distribution does not provide
the development package, build that standalone source, without FFmpeg:

```sh
git clone https://github.com/mstorsjo/fdk-aac.git /tmp/zig-camera-fdk
git -C /tmp/zig-camera-fdk checkout --detach 716f4394641d53f0d79c9ddac3fa93b03a49f278
cmake -S /tmp/zig-camera-fdk -B /tmp/zig-camera-fdk-build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON
cmake --build /tmp/zig-camera-fdk-build -j 2
sudo cmake --install /tmp/zig-camera-fdk-build
sudo ldconfig
zig build -Dcodecs=true -Daac=true -Daudio=true -Doptimize=ReleaseSafe
```

The Home adapter is MIT. FDK, libx264/libx265 and ALSA retain their own licenses;
see [FDK's license](https://github.com/mstorsjo/fdk-aac/blob/v2.0.3/NOTICE).
The codec is opt-in and is not represented as a pure Zig AAC implementation.
Home's older envelope/fixed-width AAC prototypes now reject encoding explicitly
instead of returning invalid streams. The broad Home media graph remains outside
these focused module tests.

## Sample clocks, priming and finalization

Capture uses the same BOOTTIME/sample-count clock and bounded PCM ownership as
[PCM recording](audio-rotation.md). AAC input is continuous after the first kept
sample. Video frame gaps retain continuous audio. A low-level PCM timestamp gap
larger than the two-nanosecond rounding allowance fails explicitly; this path
never silently inserts audio, drops input, stretches timestamps or resamples.
Device XRUN, disconnect, queue exhaustion and measured drift retain the existing
failure policy. No consumer encoding runs in libcamera's completion callback.

AAC-LC frames represent 1024 samples/channel. Home accepts partial input, tracks
how many frames the codec consumed, and drains all delayed output. Packets use
the sample-rate timebase; timestamps come from sample counts rather than arrival
or encode completion. The first kept PCM sample determines the audio offset
relative to the first video exposure. AVC/HEVC timing retains actual capture gaps.

MP4's `mp4a`/`esds` records the actual AAC AudioSpecificConfig. Audio and video
have independent fragment clocks and a shared movie timeline. The edit list
records the actual encoder delay, initial offset and presented duration. Roll
sample groups mark explicit decoder pre-roll; without these, Apple readers may
apply a legacy extra trim. A staged final audio packet records the valid last
sample duration to exclude padded tail samples in fragmented playback. Encoder
delay is read from FDK, not assumed to be 1024/2048 samples. See Apple's
[explicit priming representation](https://developer.apple.com/documentation/quicktime-file-format/using_track_structures_to_represent_encode_delay_explictly).

Only one encoded AAC packet and one encoded video packet are staged. Header/PCM/
codec queues remain bounded; no file-sized sample table is built. On close or an
IDR split, audio is clipped at the video boundary, the segment's AAC encoder is
drained, and fixed duration/edit fields are patched with `pwrite`. The next file
has its own fresh AAC state, configuration and priming metadata. Accepted PCM
samples appear once across the files; decoded audio is lossy and is not bit-exact.

MP4 A/V therefore requires seekable files and clean finalization; it is not a
pipe/live-HLS output. There is no global seek index, automatic crash recovery or
retention deletion. Failure finalization is best-effort; storage errors may leave
an incomplete MP4. Rotation byte/time limits remain soft. Movie timecodes are
microseconds, so sample phase/offset can differ by less than one PCM sample.

## Validation and remaining acceptance

Focused tests cover partial and sub-AAC-frame inputs, exact PCM presentation
counts, first-sample offsets, mono/stereo channel order, 44.1/48kHz, input rejection
without truncation, video gaps, delayed drain, restart, manual splits and automatic
rotation. The parser checks sample descriptions, roll associations, data offsets,
per-track clocks, finite durations, priming and tail declarations. FAAD2 decodes
raw packets independently and verifies waveform alignment after applying the
container edits. OpenH264/libde265 independently decode each video segment.
The independent decoder also checks and normalizes the duplicated mono output
of FAAD 2.11.1; FAAD 2.11.4 preserves mono directly. Linux x86/ARM CI checks
mkvtoolnix track identification and ALSA null input.

`tests/check_mp4_audio.swift` independently checks AVFoundation demux/decode on
macOS, including presented counts, offsets and lossy waveform comparisons. Set
`ZC_APPLE_AAC_DECODER` to its compiled executable to include it in the AAC Python
tests. These are synthetic codec/container tests. Physical acoustic/exposure
latency, long-run drift, microphone quality and sustained Pi 5 FPS remain unmeasured;
there is no claim of full Picamera2 compatibility or measured speedup.
