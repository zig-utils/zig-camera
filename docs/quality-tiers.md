# Named software recording quality

Version 0.75 accepts `quality: 'very-low' | 'low' | 'medium' | 'high' | 'very-high'`
in recorder/session options. Numeric quality 1..100 and the default numeric 90
retain their previous JPEG/CRF/ABR behavior. A named tier is an explicit opt-in.

```ts
import { Recorder, QualityTier, planRecordingQuality } from '@zig-utils/camera'
const settings = {
  width: 3840, height: 2160, fps: 30, codec: 'h264' as const,
  quality: QualityTier['very-high'],
}
console.log(planRecordingQuality(settings))
const recorder = await Recorder.open('trail.mp4', settings)
console.log(recorder.qualityPolicy())
```

| Tier | Software JPEG quality | AVC reference target at 1080p30 |
| --- | ---: | ---: |
| very-low | 25 | 3 Mbps |
| low | 35 | 4 Mbps |
| medium | 50 | 7 Mbps |
| high | 65 | 10 Mbps |
| very-high | 80 | 14 Mbps |

These are the inspected Picamera2 software JpegEncoder/LibavH264Encoder tier
policies, implemented through Home without Python or Libav/FFmpeg. HEVC deliberately
shares the same Home bitrate heuristic; upstream supplies no matching HEVC table.
Hardware H.264/MJPEG use different linear policies and remain separate work. No
optical-quality, actual bitrate, encoder speed or physical Pi FPS claim is made.

AVC/HEVC use `reference * sqrt(width * height * fps / (1920 * 1080 * 30))`.
Home computes an exact integer/rational estimate with u128 math and integer square
root, floors it to vendor 1000 bit/sec units and imposes a minimum 1000 bit/sec.
Overflow or an unsupported session shape rejects without mutation. The C helper
also accepts rational fps_num/fps_den. JPEG tier values do not scale with size/fps.

A named video tier selects ABR and overrides a supplied target `bitrate`. Numeric
quality keeps the existing rule: a nonzero bitrate selects ABR, fixed QP selects
CQP, otherwise quality selects CRF. Named video tiers conflict with nonzero
`encoder.qp`; choose a numeric quality policy to use fixed QP. JPEG has no target
bitrate control, so nonzero MJPEG bitrate/GOP remain invalid. Combined level/VBV
limits are validated against the derived target before files or output hooks.
ABR is not a hard per-frame, packet, file-size or network rate cap.

`planRecordingQuality` uses the pure Home/C policy without opening an encoder,
camera, file or sink. Its returned numeric recipe has `quality: 90` under video
ABR, where that scalar is inactive. `qualityPolicy()` reports a frozen copy of the
requested tier, native scalar quality, target bitrate and control mode; it is not
measured vendor statistics. Queries reject active producer ownership. Preserve
the named request if future geometry/fps changes should derive a new target.

Requested options are copied before native admission and output hooks. Session
reconfiguration and coordinated mode/recovery jobs resolve the actual recording
stream geometry first, then apply the tier and validate limits. A tier is retained
across codec changes; changing to MJPEG uses its JPEG value and changing back derives
a new video rate. Cancelled/failed preparation preserves the old policy. Omit
`quality` to inherit, or use `quality: null` to restore legacy numeric default 90.
For example, `{ quality: null, bitrate: 10000000 }` leaves tier mode for explicit
ABR. Fully resolved coordinated resets are passed explicitly at publication.

C adds the five ZC_QUALITY_* IDs and transactional
`zc_video_apply_quality_tier(zc_video_config *, tier)`. Existing 32-byte video
configuration and open defaults remain unchanged. Resolve geometry first when it
can adjust, apply the tier, then validate codec options/limits before opening.
Zig exposes the shared helper as `camera.capture_quality`. CLI recording accepts
`--quality-tier NAME`; it overrides numeric `--quality`/video target bitrate.
The tier flag rejects non-record commands before creating an output.

Tests check reference values, rational rates, exact scaling, bounds/overflow and
immutable failure. JPEG packets and CLI recordings match the corresponding
numeric quality bytes. Video fixtures independently decode MP4 on Linux and cover
limits/QP conflicts, copied options, rollback, codec changes, reset semantics,
negotiated geometry before VBV checks, and fresh-camera recovery.
