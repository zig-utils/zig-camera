# AAC-LC and synchronized MP4

Build with codecs and aac enabled and install standalone FDK AAC. Recorder audio
options set sampleRate, channels, bufferFrames, maxBlocks and optional bitrate.
Only explicit S16LE input is accepted. Each output/segment owns fresh AAC state;
Home MP4 writes decoder priming edits, roll groups and final sample trimming.
Per-output PCM cursors split audio at the corresponding video keyframe boundary.
No FFmpeg/Libav process or dependency is used.

Bun's AAC acceptance parses tracks/fragments/edits and independently decodes via
FAAD2; it checks exact sample counts, priming, waveform and channel order across
native asynchronous rotation. OpenH264/libde265 independently decode matching
video access units on Linux. Physical sync and Pi throughput remain unmeasured.

See [coverage](parity.md), [native jobs](native-jobs.md), and the
[C ABI contract](../include/zig_camera.h).
