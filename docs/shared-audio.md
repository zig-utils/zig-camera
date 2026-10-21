# Shared microphone audio across encoders

Several recordings on one Camera can pass the same AudioCapture to
`startRecording`. One native capture cursor supplies a bounded PCM history;
each encoder has an independent sample watermark. A busy `drop` encoder skips
video frames and catches up its continuous PCM on its next admitted frame.

```ts
const microphone = new AudioCapture({
  sampleRate: 48000, channels: 2, blockFrames: 480,
  sharedHistory: { maxFrames: 96000, maxBlocks: 256 },
})
const archive = camera.startRecording(mainRecorder, { audio: microphone })
const preview = camera.startRecording(loresRecorder, {
  audio: microphone, backpressure: 'drop',
})
console.log(preview.audioStats(), microphone.sharedStats())
await preview.close() // archive and the microphone remain live
await archive.close() // last consumer releases and closes the microphone
```

Recorder geometry, audio format and FPS must match the selected camera stream
and capture format. Consumers sharing one microphone must use the same recording
FPS. Sharing a source across different Cameras rejects before ownership changes.
The camera's default video pressure policy remains `wait`; asynchronous producers
are needed for independent progress. Configure recorder output and producer
queues for the intended burst, including PCM accumulated during video skips.
Synchronous writes retain their existing fail-fast output pressure behavior.

`sharedHistory` is optional. Its default is two seconds of sample frames and 256
block descriptors. Maximum history is ten seconds and 256 descriptors. Both limits
apply: tiny input blocks can exhaust metadata retention earlier than the sample
limit. One source scratch buffer owns at most one future capture block, bounded
by AudioCapture's blockFrames (maximum 4096). Each acquired camera frame performs
at most 256 nonblocking source reads per active microphone group. Exhausting
this read budget is a terminal, observable group error rather than unbounded work
on Bun's thread. Budget sizes and FPS should suit the source's block size.

The shared arena owns PCM in Zig. The private synchronous admission passes native
spans directly to the recorder's existing bounded producer, which copies samples
before advancing the consumer watermark. Bun stores descriptor bytes and counters,
not PCM payload arrays. No native span escapes through the public Bun API. Exact
tickets fence mutation until the copy finishes; failed admission cancels its
borrow. Encoder failure never rolls back data that a codec already wrote.

Sample windows use the Home timeline's fractional phase and preserve every sample
at 44.1/48 kHz boundaries and ring wrap. A successful empty window does not jump
past PCM that has not arrived. Video cuts inside one audio sample interval may
produce empty batches. Synthetic consumers share their microphone group's offered
frame clock, including late joins. A late consumer starts at its first video
window and receives the corresponding source samples. Recorder/container output
epoch normalization remains unchanged; audioStats.nextTimestampNs observes the
shared input clock, while packet output timestamps use their recorder epoch.
Real capture uses the existing camera/microphone clocks; physical drift, latency
and sustained Pi performance still require hardware validation. Source clock gaps
are not repaired or resampled by this feature.

History eviction does not necessarily mean lost audio: healthy producers may
already own those samples. If a consumer falls behind eviction, it is quarantined
with an explicit retention error and overrun count, including while its video
producer is busy. Its entered producer remains bounded and owned until cleanup.
Healthy peers continue. Source read failure affects its microphone group; unrelated
video-only recordings continue. Close a failed Recording to release its reserved
camera and audio consumer slots. Finite history and producer byte/descriptor limits
bound catch-up; unlimited stall recovery is unsupported.

AudioCapture is owned by its automatic recording group after successful start.
Direct `read()` and `close()` return BUSY while attached, enforced in native code.
Stopping/flushing one consumer leaves peers and source alive; the last retirement
closes the shared history and microphone once. A flushed recorder can restart
and rejoin a still-live group with a new consumer ID at the current source clock;
closing its old Recording cannot release the replacement owner. Failed start releases the capture
claim and leaves the caller's source open. Camera stop/close joins copied producers
after source retirement; their owned PCM remains valid independently of capture.
A future microphone supplied to a mode job stays caller-owned until attachment.
Already claimed candidates reject before flush/publication. A competing claim
that occurs after media publication reports an error without stranding recorder
ownership. Atomic multi-encoder mode transactions remain outstanding parity work.

`Recording.audioStats()` returns an owned snapshot or undefined without a source:

- `id`, `nextTimestampNs` (undefined before first accepted batch),
  `admittedFrames`, `overruns`, `cancelledBatches` are bigint observations.
- `active` describes the audio consumer's lifecycle; `pending` describes a borrowed
  copy window. Group failures are reported separately on Recording.error and the
  group errorCode. Admitted samples count producer copies, not output delivery.

`AudioCapture.sharedStats()` returns undefined before sharing, then copied native
statistics, including after close: current `frames`/`blocks`, `maxFrames`/`maxBlocks`,
`highFrames`/`highBlocks`, cumulative `capturedFrames` copied into shared history,
`evictedFrames`, `sampleRate`, `channels`, last `clockErrorNs`, successful capture
`reads`, `pendingFuture` and terminal `errorCode`. The pending future block is
counted by reads and pendingFuture, not capturedFrames. State remains readable
after close. Closed history reports closed=true, zero retained frames/blocks and
no pending future payload; high-water/cumulative observations remain available.
Admission, cancellation, overrun and read counters saturate. Neither telemetry nor synthetic waveform tests
establish physical synchronization.

The additive C zc_audio_fanout API exposes the same serialized ownership:
open claims one live capture; add consumers, fill history through a video cut,
prepare borrowed spans, copy into a producer, finish the exact ticket, then retire
consumers before closing the fan-out. Raw source read/close remains BUSY until
fan-out close. C callers serialize operations and must not use spans after finish
or retirement. Standalone Home helper provenance is in NOTICE.
