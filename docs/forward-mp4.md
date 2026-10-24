# Forward-only MP4 output

Version 0.105 adds `format: 'fmp4'` / `ZC_OUTPUT_FMP4`. It uses Home's
fragmented AVC/HEVC MP4 writer and optional AAC-LC encoder, with forward writes
only. Existing `mp4` remains the seekable AAC mode with finite metadata patched
at finish. No external media program is used.

```ts
import { MuxedOutput, Recorder, SocketSink } from '@zig-utils/camera'

const sink = new SocketSink({ address: '127.0.0.1', port: 5000 })
const recorder = await Recorder.open(new MuxedOutput(sink, 'fmp4'), {
  width: 1920, height: 1080, fps: 25, codec: 'h264',
  audio: { sampleRate: 48000, channels: 2 },
})
// Submit frames and timestamped S16LE through writeAVAsync, or use the existing
// microphone/recording coordinator. Close joins AAC flush and sink shutdown.
await recorder.close()
```

The same mode works with `ProcessSink` and custom byte sinks. Their existing
partial writes, bounded queues, producer waits, cancellation, lifecycle hooks,
PTS wrappers and output identities still apply. Generic custom outputs can set
`format: 'fmp4'` and implement `write` without a `patch` hook. Video-only output
requires native codecs; AAC requires `-Daac=true`. MJPEG remains Matroska or raw
JPEG output. Merely configuring audio does not capture a microphone.

For AAC, native output allocates one fixed **16 MiB startup arena per output**,
including its initial movie and pending video fragments. Before the first PCM
chunk supplies its actual timestamp, bytes remain in this arena. Binding that
clock publishes the header and deferred prefix in writes of at most 64 KiB;
subsequent video/AAC fragments stream normally. The arena is retained until the
output retires. If audio never arrives, final flush binds offset zero and emits
only encoder priming with zero presented PCM. If the arena fills first, the
output fails with the existing buffer-full status and failure-isolation policy;
it does not grow memory or publish a partial header. Frozen snapshots bind their
known first PCM window before replaying video, avoiding this startup backlog.
Downstream queue limits still apply to ordinary individual encoded samples.

The initial empty audio edit preserves a late first PCM timestamp on the video
clock. The next edit skips encoder delay and has duration zero, meaning it spans
all subsequent fragments. Unknown movie/track/media durations stay zero in the
header; readers obtain actual duration from fragments. Final flush validates
encoded/PCM counts and shortens the final AAC sample duration to remove tail
padding. Decode priming packets to establish AAC decoder state, then apply the
edit and final duration to presentation. No emitted byte is patched or replaced.

This is general fragmented ISO BMFF using two audio edits. It does **not** claim
CMAF, HLS, DASH or browser MSE compatibility: the required single-edit MSE subset
is narrower. Receivers must honor the empty edit, delay and final sample duration.
See [W3C ISO BMFF byte-stream format](https://www.w3.org/TR/mse-byte-stream-format-isobmff/)
and [Apple AAC priming background](https://developer.apple.com/documentation/quicktime-file-format/background_aac_encoding).
Player interoperability and physical microphone/sensor sync remain acceptance work.

The focused Bun suite uses actual TCP and supervised Bun consumers, short writes,
zero-patch sinks, pre-finish fragments, late/absent audio, async splits, session
restart, circular snapshots and isolated failures. Its independent container
reader checks sizes, offsets, clocks and edit values; independent AVC/HEVC and AAC
decoders check real media and waveform/channel order. Home's shared tests also
exercise finite staging, startup/partial sink failures and bounded prefix writes
on pinned and development Zig. These synthetic/loopback checks do not establish
Pi throughput, camera quality or matched Picamera2 performance.
