# Main-stream formats

CameraOptions.format selects the main processed stream: BGR888 (default, RGB byte
order on supported little-endian hosts) or YUV420 (planar I420). Lores retains its
independent rgb option. Raw and sensor mode selection remain independent.

```ts
const camera = new Camera({
  width: 1920, height: 1080, format: 'YUV420',
  lores: { width: 640, height: 360, rgb: true },
})
const recorder = new Recorder('trails.mp4', {
  width: 1920, height: 1080, codec: 'h264', fps: 30, asyncWrites: true,
})
camera.startPreview()
const recording = camera.startRecording(recorder)
console.log(camera.info().format, camera.previewStreamInfo())
const photo = await camera.captureRGB() // explicit owned RGB conversion
await recording.flushAsync()
await recorder.close()
await camera.close()
```

Explicit I420 dimensions must be even. Zero/omitted dimensions select backend
defaults. Native admission rejects invalid formats and odd I420 requests before
opening a device. libcamera requests the selected format and rejects unsupported
substitutions or odd negotiated I420 dimensions/stride. Negotiated dimensions,
stride and color metadata remain authoritative; sizes may adjust as before.
An omitted format in a mode target requests the legacy RGB default, rather than
inheriting the old format. options retains the requested recipe; info().format,
Frame.format and packed stream descriptors report the negotiated format.

The additive C calls are zc_open_formatted_pipeline and
zc_open_id_formatted_pipeline, with main_format ZC_RGB24 or ZC_YUV420, followed
by the existing orientation/strict/selector parameters. Every legacy open call
continues to select RGB. Config, pipeline, info, stream and frame ABI v1 layouts
remain unchanged. Zig exposes Camera.initFormattedPipeline/Id; the CLI adds
--main-format BGR888|YUV420. Lease benchmark JSON reports the actual format.

## Ownership and media behavior

Raw I420 copies retain all Y/U/V samples and omit padding through Home plane_pack.
Writable mappings expose the existing component-row API and exclude readers until
close. RGB copies use Home yuv_rgb with the negotiated matrix/range and allocate
an explicit caller-owned RGB result. C zc_copy_frame_rgb now supports both formats
through that checked conversion path. The standalone descriptor-only zc_copy_rgb
and Zig Frame.rgb remain RGB-only; Frame.rgb rejects I420 instead of interpreting
luma bytes as RGB. Use copyStreamRgb when an owned conversion is needed.

Still capture, encoded images and focus-locked images convert the selected main
stream through the existing checked image path. JPEG file saves validate/convert
before choosing Home or optional system JPEG encoding; RGB input stays borrowed. DNG continues to use paired raw
samples and metadata. SDL preview converts directly into its locked RGB texture;
headless preview keeps its existing request processing. Display transforms and
overlays do not modify capture or encoder input.

AVC/HEVC consume I420 through Home yuv_remap into reused codec planes. They do not
create a full RGB intermediate or discard chroma by decoding/re-subsampling.
Async producers own width*height*3/2 pixel bytes before returning, alongside the
existing bounded job/PCM charges. Camera planes can be released or edited after
successful submission. Main RGB retains its existing fast path. MJPEG still needs
an explicit RGB conversion for Home's JPEG encoder.

libcamera requests sYCC for YUV and encoded RGB with no YCbCr matrix for RGB;
validation can adjust color metadata. Copy/preview interpret negotiated YCbCr
matrix/range. Recording keeps its existing strict gamut/transfer requirements and
rejects unsupported/unknown color before admission. No conversion here changes
primaries or gamma. [Explicit color-space requests](color-configuration.md) now
include strict negotiation and mode restoration. Other formats, general color
conversion and hardware encoding remain parity work.

Camera, temporary capture, single-recorder and recorder-group mode jobs carry
main format through target opening, cancellation and rollback. Preview is recreated
from negotiated input. Format changes do not bypass outstanding lease, runtime
control, autofocus, output preparation or joined shutdown rules.

## Validation

Native tests and C ABI checks cover format admission, exact IDs, three-plane I420,
write/read exclusion, stale tokens, short-output preservation and RGB-view rejection.
Actual SDL readback checks leased main and lores I420 against independent floating
color calculations. Bun tests verify every RGB pixel against a floating reference,
independently decoded PNG and JPEG files, paired RGB/raw streams, transforms, focus-locked PNG/DNG,
format restoration/cancellation, synchronous/asynchronous MJPEG and compact AVC/HEVC
admission. Linux independently decodes all AVC/HEVC planes and loads the real
libcamera backend; shared-audio and mode-group tests exercise both formats.

Synthetic setup generates test I420 via Home encoding; the real backend receives
YUV buffers directly from libcamera. This distinction is not a physical throughput,
optical quality, hardware acceleration or Picamera2 speedup claim. Matched Pi
hardware acceptance remains outstanding.
