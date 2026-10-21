# Recording color profiles

`RecorderOptions.colorSpace` selects an AVC/HEVC output description, using the
same presets/custom fields as [camera color configuration](color-configuration.md).
The encoder's SPS/VUI, MP4 `colr/nclx`, sample conversion and custom-output
`OutputStreams.colorSpace` share one copied native recipe. `rec709`, `rec2020`,
`smpte170m` and `sycc` presets are supported; `srgb` has no YCbCr matrix and is
therefore invalid as an I420 output profile. A custom profile can choose linear,
sRGB or Rec.709 transfer, any supported processed primaries, BT.601/709/2020
nonconstant-luminance YCbCr and full/limited range.

```ts
const camera = new Camera({
  width: 1920, height: 1080, format: 'YUV420',
  colorSpace: 'rec709', strictColorSpace: true,
})
const recorder = await Recorder.open('trails.mp4', {
  width: 1920, height: 1080, codec: 'hevc', colorSpace: 'rec709',
  fps: 30, quality: 90,
})
const recording = camera.startRecording(recorder)
console.log(recorder.colorSpace()) // copied encoded YCbCr description
// Later: await recording.flushAsync(), then restart/reconfigure or close.
```

An omitted recording profile retains the legacy Rec.709 primaries, sRGB transfer,
BT.601 limited-range output. RGB input to that profile retains the existing
integer conversion/rounding. Other RGB profiles use Home's checked `encode420`.
I420 input uses Home's direct matrix/range remap into the existing codec buffer,
without a full RGB intermediate or chroma resampling. Input primaries/transfer
must already match the output profile; unknown metadata or a mismatch rejects
before frame/PCM admission. Untagged legacy C RGB writes assume Rec.709/sRGB.
This feature performs no gamut/transfer conversion and cannot make an ISP support
a color request. Query actual camera metadata; strict camera negotiation is useful
when a recording requires a specific gamut/transfer. No ICC profile, HDR/PQ/HLG,
physical color accuracy or hardware encoder capability is implied.

Explicit profiles are unsupported for MJPEG; its JPEG/container signaling needs
separate work. MP4 gets an explicit nclx description and matching VUI. Elementary
packets and AVC/HEVC-in-Matroska retain VUI in the encoded stream; this feature does
not add Matroska Colour elements or a color-managed preview/still-image path.

## Sessions and outputs

Profiles and nested custom descriptions are snapshotted at admission and frozen
in `recorder.options`. Host stream hooks receive an independent observation;
changing it cannot change encoded samples or headers. Splits, rotation/recovery
factories, independent outputs/delays, CircularOutput2 and frozen file/custom A/V
snapshots preserve the same recipe. Prepared outputs and snapshots hold their own
copies, including when their source recorder closes before output work finishes.

`restartAsync()` inherits the current profile. `reconfigureAsync({ colorSpace })`
changes it after flush; omitted fields retain their value, while
`colorSpace: null` restores legacy defaults. Reset explicitly when changing to
MJPEG from a configured profile. Invalid recipes reject before output lifecycle
work; failed/cancelled preparation preserves the current profile and normal
session failure semantics. Coordinated camera/recorder mode changes preflight
actual source metadata before publishing media. Group mode changes can use
independent matrices/ranges, provided every encoder's gamut/transfer matches its
selected source. General mode rollback rules still apply to flushed sessions.

## Native API and CLI

Existing ABI v1 layouts remain unchanged, including 32-byte `zc_video_config`,
24-byte `zc_recording_options` and `zc_color_space`. `zc_default_video_color` gives
the legacy output recipe. `zc_video_check_color` validates an optional explicit
recipe against the codec, and `zc_video_check_input_color_for` checks source
metadata against a target (null target uses defaults). `zc_video_get_color`
returns the active AVC/HEVC profile; MJPEG returns unsupported.

Create an unattached recorder with `zc_video_create` or a circular constructor,
then `zc_video_set_color` before attaching an output. Setting is transactional and
allowed only before any frame/PCM, output attachment or producer allocation.
A null recipe selects defaults. Use `zc_producer_job_restart_color` before a
restart job starts to copy its replacement profile; null resets and omission
inherits. Configure and color setters may be called in either order. The worker
validates final codec/profile compatibility before candidate/output construction.
Caller serialization and existing producer ownership rules still apply.

```sh
zig-camera record --codec hevc --main-format YUV420 \
  --color-space rec709 --strict-color-space --video-color-space rec709 \
  --width 1920 --height 1080 --output trails.mp4
```

The camera and output options are separate: selecting an output profile does not
change camera pixels. CLI admission checks happen before output file construction,
so a mismatched source does not truncate or create a recording file.

Tests inspect actual SPS/VUI and MP4 fields independently, including linear/full
and SMPTE 170M, copied producer inputs and all session/output families above.
Linux x86/ARM tests independently decode all Y/U/V planes against floating-point
matrix/range references. A/V fixtures retain synchronized AAC tracks. Synthetic
coverage is not a substitute for Pi ISP/color-chart and sustained hardware tests.
