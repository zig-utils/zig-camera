# Owned JPEG loading

```ts
import {decodeJpegAsync,loadJpegAsync} from '@zig-utils/camera'

using photo=await loadJpegAsync('trail.jpg',{upsampling:'linear'})
using resized=photo.image.resize(1280,720)
await resized.saveAsync('trail.png')
using copied=await decodeJpegAsync(encodedBytes)
```

Home decodes 8-bit Huffman sequential/progressive JPEG with component sampling,
interleaved/separate scans, progressive bands/refinements, restarts and 8/16-bit
quantization tables. Arithmetic, lossless, higher-precision and hierarchical
coding reject explicitly. Strict complete-input validation rejects truncated
entropy, invalid progression/tables/restarts and trailing bytes after EOI.

`decodeJpeg(bytes,limits)` is synchronous. `decodeJpegAsync` snapshots encoded
input into a native worker before returning. `loadJpegAsync` performs a bounded
Bun file read and joins a native worker. All return DecodedJpeg with an independent
CapturedImage, usable after source bytes/camera retirement and for clone, crop,
resize, transforms, conversion and encoding/saves. Source grayscale stays gray8;
other supported colors produce RGB8. There is no invented camera metadata.

`upsampling: 'linear'` uses centered bilinear component reconstruction. Nearest
sampling is explicit. Adobe RGB/YCbCr/CMYK/YCCK interpretation and conventional
CMYK ink conversion are supported. Source ICC and Exif TIFF bytes are copied into
`metadata`; they do not trigger color management or Exif orientation. A source
CMYK ICC profile describes CMYK data and should not be attached to converted RGB
without an appropriate profile transform. The image colorSpace stays unknown.

The result reports sourceComponents, sourceColorModel, progressive, scans,
independent sampling factors, adobeTransform, upsampling, workingPeak and
workUnits. `close()` releases the image pixels; metadata copies remain owned JS
values. C adds independent 56-byte limits and 96-byte info with owned pixel and
metadata copies, plus take-once jobs using the existing 48-byte image job state.
Zig exposes the same API through `jpeg_image`.

Defaults cap encoded/output bytes at 64 MiB each, working allocations at 128 MiB,
metadata at 16 MiB, scans at 256, markers at 16384 and 1,073,741,824 work units.
Overrides are explicit: encoded/output up to 256 MiB, working up to 448 MiB,
scans up to 1024, markers up to 65536 and work units up to 17,179,869,184. All are positive.
Gray/RGB output size is checked before coefficient allocation. Workspace accounts
coefficient arrays, two cached block rows per component, pixels and metadata.
Coefficients use checked i16 arithmetic; the existing Home inverse DCT is reused.

JPEG/PNG decoding and existing image jobs share at most four native reservations
and 512 MiB aggregate input-plus-working admission. The reservation survives
result transfer until both copied job inputs and result allocations retire.
PNG/JPEG file reads additionally share four readers/512 MiB charged input limits,
held through worker join. Actual reads stop at maxInputBytes+1 and reject growth.
Shared/detached encoded buffers reject. Cancellation joins native checkpoints;
no partial image publishes. Worker close joins before callbacks/cleanup complete.
Default job timeout is 30000 ms, including reads/admission/decoding.

Independent libjpeg generates and decodes 1,212 cases: grayscale, RGB, YCbCr,
CMYK/YCCK, odd dimensions, multiple sampling layouts, separate sequential scans,
custom progressive bands/refinements, coarse quantization, restarts, split ICC,
Exif and truncated input. Maximum observed sample difference against JDCT_FLOAT
is 2/255. Bun additionally checks owned objects against generated reference files,
source mutation, shared budgets, cancellation and timer-starved deadlines. These
are software tests; physical Pi throughput, optics, profile accuracy and full
Picamera2 capability parity remain unverified/open work.
