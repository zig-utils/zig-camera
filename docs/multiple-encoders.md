# Multiple encoders on one camera

One Bun Camera can attach up to eight independent Recorder instances. Each
recorder chooses main or lores, codec, audio settings and its existing output
objects, queues, split, rotation and recovery policy. Encoders consume the same
acquired request; each asynchronous producer owns its compact pixels before that
request returns to the camera. There is no additional frame queue in the camera.

```ts
const main = new Recorder('trail.mp4', {
  width: 1920, height: 1080, codec: 'h264', asyncWrites: true,
})
const low = new Recorder('preview.mp4', {
  width: 640, height: 360, stream: 'lores', codec: 'hevc', asyncWrites: true,
})
const archive = camera.startRecording(main)
const preview = camera.startRecording(low, { backpressure: 'drop' })
// camera must have negotiated the corresponding main/lores dimensions.
console.log(camera.activeRecordings, preview.stats())
await preview.close() // archive keeps recording
await archive.close()
```

`backpressure` defaults to `wait`: a busy encoder pauses acquisition and therefore
its peers, preview and captures. This preserves the single-encoder behavior.
`drop` lets a busy video encoder skip frames while healthy consumers advance. Use
`asyncWrites: true` for independent asynchronous progress. Synchronous codec work
runs on the Bun thread. Per-output pressure within each recorder still follows
that recorder's own policy; camera `drop` does not bypass its admitted write.

There is at most one unfinished automatic producer per encoder. Its copied input
and PCM remain subject to the recorder's byte/count limits. An attachment consumes
one of eight native slots, including quarantined failures and retired consumers
whose entered producer has not finished. Admission rejects before claiming a
recorder if these slots are full. Consumer IDs and producer tickets never recycle.
A Recorder can belong to only one automatic recording at a time.

`Recording.stats()` returns copied native counters: bigint `id`, `submitted`,
`completed`, `skipped`, `failures`, `cancelled`; booleans `active`, `pending`,
`failed`, `retiring`; and `backpressure`. Counters saturate. A submission includes
an attempted write that later fails; completed counts successful producer returns,
not independent output delivery acknowledgements. `frames` retains its legacy
submitted-frame meaning. Retired statistics remain readable after camera close.
Source timestamps preserve dropped-frame gaps; synthetic timestamps use offered
source ordinals relative to each recording's first claim, rather than its count
of accepted frames. Recordings sharing microphone audio use their group's common
input clock. Each recording must use the camera's intended cadence.

Encoding/output failure quarantines that encoder. It remains observable on the
Recording and must be closed to release its attachment. A source/lease failure
fails all active recordings. `Recording.close()` stops its admission immediately,
releases any wait gate, joins its producer and closes its recorder/audio resources.
`flushAsync()` leaves the recorder reusable after terminal flush. It retains the
existing fail-fast admission rule: if its configured producer queue is full,
retry once the active producer settles. Camera stop/close starts every encoder's
close before awaiting cleanup, joins entered writes, and reports failures after
cleanup. A user output hook that never settles can still delay close.

Current boundaries:

- AudioCapture can be shared by same-camera, same-FPS encoders, including `drop`.
  [Shared audio](shared-audio.md) retains PCM within bounded history, isolates
  overruns and releases the microphone after the last consumer. Sharing across
  cameras or using raw read/close while attached rejects.
- Coordinated camera/recorder mode switching requires other encoders to be
  stopped and detached producer turns to have settled. Rejection precedes flush.
  The one-recorder job waits cancellably for its last copied producer before
  flush; cancellation during that wait preserves the original recording.
- Queue byte limits persist across session reconfiguration; provision them for
  the largest intended input and audio catch-up burst. Multi-encoder atomic mode
  transactions, hardware encoding and measured Pi throughput remain parity work.

The additive C `zc_fanout_*` API exposes this caller-serialized, frame-free native
admission registry. C callers still perform frame copying, encoding, cleanup and
source timestamp assignment. `offer` precedes per-consumer `claim`; TIMEOUT means
skip. Match each ticket with `finish`, retain failed entries until retirement,
and finish retiring tickets before closing the registry. No C calls retain camera,
recorder or frame pointers. The Home implementation and provenance are in NOTICE.
