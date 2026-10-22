# Encoder profiles, presets and fixed QP

Version 0.70 adds a copied `RecorderOptions.encoder` policy for Home's AVC/HEVC
adapter. It is applied before output headers or producer allocation, and travels
with each session through restart, reconfiguration, coordinated camera mode
switches and fresh-camera recording recovery.

```ts
const recorder = await Recorder.open('trails.mp4', {
  width: 1920, height: 1080, codec: 'h264', fps: 30,
  encoder: { profile: 'high', preset: 'veryfast', qp: 22 },
})
console.log(recorder.encoderOptions()) // frozen copy of admitted policy
// After recording.flushAsync():
await recorder.reconfigureAsync({ encoder: { profile: 'main', qp: 26 } },
  'next.mp4')
```

`profile` selects a compatibility ceiling. AVC accepts `default`, `baseline`,
`constrained-baseline`, `main` and `high`. x264's Baseline implementation is
constrained; simpler streams may signal a lower profile than the requested
ceiling. HEVC accepts `default` and `main` because the adapter supplies 8-bit I420.
Default preserves AVC High / HEVC Main configuration. Inspect emitted headers for
the actual stream profile; `encoderOptions()` reports the admitted policy.

`preset` accepts `ultrafast`, `superfast`, `veryfast`, `faster`, `fast`, `medium`,
`slow`, `slower`, `veryslow` and `placebo`. The default stays `veryfast`. These
select encoder search/compression work, subject to the existing no-B-frame,
no-lookahead, single-thread and fixed HEVC CTU32 policy. HEVC transform depths are
capped to fit CTU32, including slower presets. Presets are not measured Pi FPS,
latency or image-quality guarantees.

`qp: 1..51` selects constant quantization and disables adaptive QP and I/P/B
quantizer offsets. It overrides scalar `quality` and requires `bitrate: 0`.
`qp: 0` or omission preserves the existing behavior: nonzero `bitrate` selects
average bitrate, otherwise numeric `quality: 1..100` selects CRF. Average bitrate
is not a hard per-frame/segment/network rate cap. MJPEG permits only a default
policy; its numeric quality remains a JPEG setting.

Options are snapshotted and frozen at admission. Caller mutation cannot change
prepared headers or a queued transaction. Reconfiguration replaces the encoder
object as a whole; omitted members of that object use defaults. Omit `encoder` to
retain the old policy, or pass `encoder: null` to reset it. A codec change resets
omitted encoder/bitrate/GOP settings, preventing an old AVC-only profile from
leaking into HEVC/MJPEG. A retained fixed QP plus a new nonzero bitrate rejects;
explicitly reset QP/the encoder policy or set bitrate zero.

Invalid policies reject before file creation or custom output start hooks.
Native replacement allocates the new encoder and headers before changing old
state. After output attachment, frame/audio acceptance or producer allocation,
mutation returns BUSY; use a flushed session transaction. Cancellation before
publication preserves previous settings and joins candidate disposal. Existing
post-publication error/owner rules still apply. `encoderOptions()` follows native
serialization and may return BUSY while an async producer owns the recorder.

C adds the separate 16-byte `zc_codec_options`, default/check/set/get helpers and
`zc_producer_job_restart_codec_options`. Existing video configuration structs and
open functions keep their ABI/defaults. A null initial setter restores defaults;
a null restart setter explicitly resets, while omitting it retains the old
policy. Pending recipes copy scalar bytes; final codec/bitrate compatibility is
validated before output construction even when setters arrive in another order.

Home's container writer now accepts Baseline/Main AVC parameter sets and omits
the High-only chroma/bit-depth extension in `avcC`/Matroska CodecPrivate. High
keeps its extension; unsupported profiles reject before writing caller buffers.
Tests inspect actual SPS compatibility flags and AVC PPS QP endpoints, exercise
all presets, delayed IDRs/drains, failed replacement, cancellation, restart,
coordinated modes and AVC/HEVC/AAC recovery. Linux CI independently decodes those
MP4 samples; local tests check headers/container ownership without a local video
decoder. Version 0.71 adds [level ceilings and VBV](encoder-limits.md), including
their current HEVC CTU limits. Full codec conformance, upstream quality-tier
heuristics, repeated in-band parameter sets and hardware encoder paths remain work.
