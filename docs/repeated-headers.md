# Repeated packet parameter sets

Version 0.74 defaults AVC/HEVC **packet outputs** to repeating cached parameter
sets at every keyframe. This lets a new decoder start at a later IDR without
receiving a separate stream-header message. It applies to FileOutput and custom
packet sinks. MP4/MKV samples and their container configuration stay unchanged.
MJPEG is unchanged.

```ts
const recorder = await Recorder.open(new FileOutput('trail.h264'), {
  width: 1920, height: 1080, codec: 'h264', repeatHeaders: true,
})
console.log(recorder.repeatedHeaders()) // admitted policy
```

Omit `repeatHeaders` for the new default, or use `false` for the previous
first-only packet behavior. A new output always receives the full cached headers
on its first keyframe. Later keyframes receive only AVC SPS/PPS (plus any SPS
extension) or HEVC VPS/SPS/PPS, preserving order and exact bytes. Informational
header SEI/AUD NALs are excluded from this repeated prefix. The encoded access unit
is preserved, including any per-picture NALs. Non-keyframes receive no prefix.
The existing Home IDR operation supplies `requestKeyframe` and normal GOP keys.

The policy is copied with recorder settings before file creation or output hooks.
It is immutable once outputs, input or producer allocation exist. It propagates
through output preparation/splits, recovery, frozen history and supported snapshot
or delayed-replay paths. Ordinary historical snapshots and CircularOutput2 delayed
outputs retain their existing distinct lifecycle rules. A flushed session may use
`reconfigureAsync({ repeatHeaders: false }, output)`; omission inherits across
codec changes too, and `null` explicitly resets to the default. Cancellation before
session publication preserves the previous setting. Coordinated camera/recorder
mode changes and recorder recovery use the resolved session setting.

Home extracts parameter sets once during packet-output construction. Its checked
allocation-free helpers validate every framing length, required set types and
applicable NAL header bits; they do not parse complete parameter-set syntax. The
output owns the cached full and filtered prefixes. Prefix + packet assembly checks
both inputs/capacity before writing and uses a separate reusable output buffer.
No encoder is reopened and the cropped HEVC SPS from tiny-input encoding is reused
verbatim. The vendor's repeated-header mode stays disabled, preserving consistent
container samples and Home's cached crop policy.

Expanded bytes count toward native/host output bounds, I/O byte counters, and
output size/rotation accounting. Repetition stays inside the video
packet and adds no separate packet or PTS event. Extra prefixes are output overhead;
codec VBV settings are not a hard cap on the complete raw stream or container.
Existing overflow/failure-isolation and borrowed-packet lifetime rules apply.

C adds `zc_video_set_repeat_headers`, `zc_video_get_repeat_headers` and
`zc_producer_job_restart_repeat_headers`; enabled is strictly 0 or 1. The initial
setter requires a pristine unattached recorder, queries reject active producer
ownership, and restart setters require an unstarted restart job. Existing public
struct layouts remain unchanged. Direct C opens also use the new true default.

Tests inspect required NAL sets, unchanged parameter bytes, header-free muxed
samples, PTS and byte accounting. Linux independently decodes full raw streams
and clips starting at a later IDR without separately supplied headers. Coverage
includes false/default/true policy, raw files, snapshots, delayed outputs,
prepared splits, recovered sinks, rollback/null reset and coordinated mode changes.
These are software stream checks, not physical camera or Pi performance results.
