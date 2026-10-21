# Recording from main or lores

```ts
const camera = new Camera({
  width: 4056, height: 3040,
  lores: { width: 1280, height: 720 },
})
const recorder = new Recorder('trail.mp4', {
  stream: 'lores', width: 1280, height: 720, codec: 'h264', fps: 30,
  asyncWrites: true,
})
camera.startContinuousAutofocus()
const recording = camera.startRecording(recorder)
await camera.captureFocusLockedFile('photo.png') // main stays full resolution
const next = await recording.switchModeAsync(
  { width: 1920, height: 1080, lores: { width: 640, height: 480 } },
  {}, 'next.mp4',
)
await next.flushAsync()
await recorder.close()
await camera.close()
```

`RecorderOptions.stream` is `main` (default) or `lores`. It applies to manual
`write`, `writeAsync`, `writeAVAsync`, camera recording pumps, circular snapshots,
splits and rotated/recovered outputs. Preview and ordinary still captures keep
their own source selection. Main and lores accept negotiated RGB24 or planar I420;
set CameraOptions.format to YUV420 for native main I420 capture. Main RGB retains
the existing RGB path; raw requires a future demosaic/encoder path.

Width and height describe the encoder input. `startRecording` checks them against
the selected negotiated stream, and checks selected I420/lores format/color before
claiming camera ownership. Disabled streams, raw selection and mismatched geometry reject.
The stream option is snapshotted and immutable within a session. Restart retains
it; `reconfigureAsync` can change it after flush. Coordinated camera/recorder mode
jobs resolve geometry against the selected target stream, including adjusted
lores geometry. Missing target lores rejects before the current session is flushed.
After target negotiation, format/color validation precedes replacement session
publication. Existing rollback, cancellation, autofocus and callback rules apply.

RGB source rows stay borrowed for synchronous writes. I420 AVC/HEVC uses Home's
checked `yuv_remap` directly into the recorder's reused I420 codec buffer, with no
full RGB image. Full/studio BT.601/709/2020 encoded matrices map to the existing
limited BT.601 output; the same-matrix path only rescales planes. Matrix remapping
does not clamp through RGB or discard chroma detail by re-subsampling. MJPEG uses
Home's RGB JPEG interface and a reused, explicit RGB conversion buffer.

The existing AVC/HEVC VUI and MP4 `nclx` signal Rec.709 primaries, sRGB transfer,
limited BT.601 YCbCr. Selected inputs must have these primaries/transfer before
matrix/range conversion. Different gamut/gamma or unknown metadata reject
`UNSUPPORTED`, rather than silently receiving incompatible output tags. This is
not a general gamut/transfer conversion API. Those conversions and configurable
encoder color metadata remain on the parity worklist.

Async submission validates and owns tight pixel, color and PCM copies before
returning. An I420 producer owns `width * height * 3 / 2` pixel bytes; RGB owns
`width * height * 3`. PCM bytes and each group's audio descriptors remain charged
as before. Fixed job headers are bounded separately by the job-count limit.
Camera frames can be released or edited after successful admission. Jobs never
retain pointers into those camera planes. Existing producer cancellation,
backpressure, drains and session ownership remain in effect.

The additive C APIs are `zc_video_check_input_color`, `zc_video_write_input` and
`zc_video_producer_input_av`. They consume a selected descriptor in `frame.main`
and a separate `zc_color_space`; all existing public layouts/calls are unchanged.
C callers retain and synchronize borrowed inputs through synchronous calls.
Zig's `Frame.writeVideo(recorder, stream, timestamp)` selects a protected lease.
The CLI accepts `--record-stream main|lores` together with existing lores flags;
preview independently accepts --preview-stream main|lores|none.

Tests cover independent JPEG pixels, all decoded AVC/HEVC Y/U/V planes against
floating/reference input calculations, AAC timing, compact queue charges, source
editing after submission, cancellation, snapshots/splits, retained session source,
mode negotiation, main/focus capture coexistence and rejection before mutation.
Physical Pi throughput, optical results and A/V drift remain unmeasured.
