# Audio and rotation

AudioCapture selects ALSA or deterministic synthetic S16LE. Timestamp clocks are
Linux BOOTTIME and sample counts; buffers are bounded. Feed PCM via writeAudio
before the matching video interval, or pass an AudioCapture to startRecording.
The recording owns and closes a supplied source. Explicit overflow/clock gaps
are errors; there is no silent audio dropping or drift resampling.

MJPEG/AVC/HEVC with PCM uses Home Matroska. AAC-LC plus AVC/HEVC uses fragmented
MP4 with standalone FDK AAC enabled. Physical microphone latency is unmeasured.
Rotation and recovery now run on Zig workers; see native-jobs.md for patterns,
soft limits, failure status and synchronized keyframe ownership.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
