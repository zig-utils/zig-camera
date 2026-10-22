# Planar and semi-planar 4:2:0 streams

Version 0.77 adds YVU420, NV12 and NV21 for main and lores, alongside existing
YUV420 and packed RGB formats. Libcamera must negotiate the requested format;
unsupported adjustments reject. Explicit YUV dimensions and negotiated strides
must be even. Physical Pi support still requires device validation.

| Format | C selector | Physical bytes/planes |
| --- | --- | --- |
| YUV420 | ZC_YUV420 = 0 | Y, U, V (I420) |
| YVU420 | ZC_YVU420 = 5 | Y, V, U (YV12) |
| NV12 | ZC_NV12 = 6 | Y, interleaved U/V |
| NV21 | ZC_NV21 = 7 | Y, interleaved V/U |

The three-planar formats accept three DMA planes or one contiguous plane.
Semi-planar formats accept two DMA planes or one contiguous plane. Contiguous
chroma starts after the full pitched Y allocation; final chroma row padding may
be absent. Checked views verify all source lengths before reading or writing.
No ownership of DMA or camera requests is transferred into the Home helper.

```ts
const camera = new Camera({
  width: 1920, height: 1080, format: 'NV12',
  lores: { width: 640, height: 360, format: 'NV21' },
  colorSpace: 'sycc',
})
const rawLayout = await camera.captureStream('main')
const rgb = await camera.captureRGB() // tight RGB24, copied/converting as needed
```

`copyStream`/`copyStreams` preserve physical format, plane order and active bytes,
excluding pitch padding. `copyRGB`, still formats and scoped image jobs interpret
U/V order correctly. I420/YV12 mapped `row(y, component)` uses logical 0=Y, 1=U,
2=V; YV12 maps those to the appropriate physical plane. NV12/NV21 mapped rows use
0=Y and 1=interleaved UV/VU, both width bytes; component 2 rejects. The raw
`planes` array always keeps physical DMA plane order. Existing exclusive mapping,
frame retention, detached views and release rules apply.

The shared Home `I420` view now has a default `chroma_step=1`; checked semi-planar
constructors borrow logical U/V aliases at step 2. RGB decode computes chroma
terms once per 2x2 block. The shared RGB-to-NV encoder averages all four pixels
instead of choosing a corner. Home public RGB24/NV12/NV21 converters use those
checked paths. `Remap.apply` reads either chroma step directly into planar codec
input without an intermediate RGB image; gamut and transfer must still match.
No new gamut, gamma or HDR conversion is implied by rearranging chroma bytes.

MJPEG, AVC and HEVC accept the selected main/lores layout. Async producer jobs
preserve the physical format and copy active rows directly into bounded owned
storage, avoiding a producer-side chroma shuffle. Queue accounting charges 1.5
bytes per pixel. Workers read the borrowed logical chroma view from that owned
copy, so mutation/release of the original camera request cannot change it.
Capture bundles and producer admission use the same checked raw-copy plans.
Synchronous writes retain the caller's lease through conversion/encoding.

Headless/SDL preview, temporary modes, mode restoration, coordinated recorder
changes and fresh-camera recording recovery retain format/color selection. SDL
copies decoded RGB directly into its checked locked texture. PiSP/VC4 alignment
uses the upstream doubled-width recipe for YUV420/YVU420 and the base recipe for
NV12/NV21. Invalid C alignment format codes reject before planning without
changing either output. Structure sizes and previous format IDs remain stable.

CLI accepts the names with `--main-format` and `--lores-format`; image/recording
stream selection is independent. Lores raw sidecars use `.lores.i420`,
`.lores.yv12`, `.lores.nv12` or `.lores.nv21`, and JSON retains the negotiated
format and stride. Image bytes and MJPEG output are compared across layouts.

Tests cover split/contiguous planes, missing final padding, truncated tails,
U/V order, chroma averaging, matrix/range combinations, overlap and unchanged
outputs on failure, owned bundles, mapped rows, producer physical bytes and
source destruction, every media encoder, independent still/video decoding,
exact SDL readback, mode/recovery and C/Bun/CLI behavior. Linux CI builds/loads
real libcamera on x86/ARM and checks expected no-camera discovery/cleanup.
Camera/ISP/DMA format acceptance, sustained Pi throughput and sensor image quality
remain unmeasured; software equivalence is not physical camera evidence.
