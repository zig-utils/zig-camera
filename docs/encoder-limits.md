# Decoder-level ceilings and VBV policies

Version 0.71 adds `RecorderOptions.limits` for Home's AVC/HEVC adapter. The copied
policy is applied before output headers and persists through flushed session
restart, reconfiguration, coordinated modes and fresh-camera recording recovery.

```ts
const recorder = await Recorder.open('trails.mp4', {
  width: 1920, height: 1080, codec: 'h264', fps: 30,
  bitrate: 6000000,
  limits: { level: 41, maxBitrate: 8000000, bufferBits: 16000000 },
})
console.log(recorder.encoderLimits()) // admitted policy, not a measured bitrate
// After recording.flushAsync():
await recorder.reconfigureAsync({ limits: null }, 'unrestricted-next.mp4')
```

`level` is a decoder-requirement ceiling multiplied by ten: 41 means level 4.1;
zero keeps automatic behavior. AVC accepts 1.0, 1.1, 1.2, 1.3, 2.0, 2.1, 2.2,
3.0, 3.1, 3.2, 4.0, 4.1, 4.2, 5.0, 5.1, 5.2, 6.0, 6.1 and 6.2. Level 1b is
not represented by a decimal integer and is rejected. HEVC accepts 1.0, 2.0,
2.1, 3.0, 3.1, 4.0, 4.1, 5.0, 5.1, 5.2, 6.0, 6.1 and 6.2 as ceilings,
using Main tier. A simpler stream can signal a lower level; this does not force
an exact SPS label. Construction checks that the actual emitted requirement is
positive, recognizable by the supported path, and within the selected ceiling.

AVC checks macroblock-rounded geometry, nominal rational frame rate, per-axis
limits, profile-aware bitrate/CPB capacity, reference count and motion range
against x264's exported level table. HEVC checks picture size, per-axis limits,
nominal rational sample rate and Main-tier rate/CPB bounds before vendor calls.
Integer cross-multiplication avoids truncating fractional frame rates or wrapping
extreme sample rates. The checks use configured rate; applications must still
supply truthful timestamps and pace/capture within the declared envelope.

The existing shared HEVC adapter uses CTU16 for simultaneous small-stream
encoders. x265 changes that to CTU32 for a level 5+ request, conflicting with the
shared instance policy. Higher ceilings therefore construct a stream constrained
to at most 4.1; they do not lift the existing geometry/rate capacity. Inputs that
need CTU32/higher effective levels reject before output publication. A separate
safe higher-resolution HEVC path remains required parity work. This restriction
is explicit rather than silently allowing vendor CTU mutation or a Level-NONE
header.

`maxBitrate` is bits/sec and `bufferBits` is coded-picture-buffer capacity in
bits. Both are zero/default, or both are positive multiples of 1000 so conversion
to vendor kbit units is exact. The capacity must hold at least one nominal frame
at the maximum rate; undersized buffers reject rather than being enlarged by the
vendor. A nonzero scalar target bitrate cannot exceed `maxBitrate`.
VBV requires ordinary quality/average-bitrate control (`encoder.qp` zero).
HEVC also rejects an explicit level combined with fixed QP. AVC allows fixed QP
with a level ceiling and no VBV; no hard coded-rate guarantee follows from that
combination.

VBV constrains codec rate control, not container overhead, per-packet/network
bandwidth or end-to-end latency. It can reduce quality on complex frames.
HEVC may supply its level's default VBV settings when an explicit level is used
with CRF and no caller buffer/rate. `encoderLimits()` reports the copied requested
policy, so zeros are not an effective-vendor-parameter query. These APIs do not
establish full codec/HRD conformance or physical-camera throughput.

Omit `limits` in session settings to retain it. Supply a new object to replace
it as a whole, or `limits: null` to reset to defaults. Codec changes reset an
omitted limit policy along with encoder/bitrate/GOP defaults. Coordinated jobs
carry fully resolved resets explicitly; they do not reinterpret a resolved
undefined value as retaining the previous session. Caller mutation cannot change
an admitted transaction. Query results and admitted option objects are frozen.

The C ABI adds a separate 16-byte `zc_codec_limits`, default/check/set/get helpers
and `zc_producer_job_restart_codec_limits`. Earlier video/codec layouts and open
functions keep their defaults and sizes. Pristine setters allocate the new
encoder and headers before changing color, codec policy or limits; failure keeps
the old encoder/headers. Output attachment, accepted input or producer allocation
forbids direct mutation. Pending restart recipes copy scalar data; final combined
configuration and resource checks happen before candidate output creation.

Shape/unit/policy failures reject before file creation or host start hooks.
Resource-level rejection may occur during codec construction after coordinated
old-session flush; accepted terminal tails cannot be undone. The previous session
remains stopped/reusable, and candidate output paths remain uncreated. Cancellation
joins prepared output cleanup before returning; source/replacement ownership and
post-publication failure rules remain those of the existing transaction APIs.

Tests inspect emitted AVC/HEVC levels, exact/fractional nominal-rate boundaries,
malformed C recipes, unchanged headers after failure, copied and cancelled jobs,
explicit resets, restart, modes and AVC/HEVC/AAC recovery. High-complexity synthetic
streams compare bounded/unbounded encoding, a cumulative buffer/rate envelope,
and preservation of all 60 accepted frames. Linux independently decodes every
frame; the pressure test checks geometry/count because rate-limited pixels are
expected to differ. Local tests have independent AAC/image readers but no video
decoder. Physical rate/quality, complete HRD conformance, quality-tier heuristics,
repeated in-band headers and hardware encoding remain required work.

Primary implementation references:
[x264 level table](https://github.com/mirror/x264/blob/master/common/tables.c),
[x265 level enforcement](https://github.com/videolan/x265/blob/master/source/encoder/level.cpp).
