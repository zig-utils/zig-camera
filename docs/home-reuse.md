# Home package audit

Reviewed `home-lang/home` at
[8169786c89a997f153ab339a5d1e627046a320d8](https://github.com/home-lang/home/tree/8169786c89a997f153ab339a5d1e627046a320d8/packages).
The top-level recursive GitHub tree is truncated by the large evidence corpus;
the package tree and selected actual sources were inspected separately.
This is a targeted camera-path audit, not a claim that every package was tested.

| Package/source inspected | Finding | Decision |
| --- | --- | --- |
| image/src/simd.zig | Useful integer luma, pixel conversion and histogram primitives; APIs assume tightly packed RGBA | Adapted luma coefficients into borrowed RGB24 views with explicit stride, vector batches, checked lengths and scalar tails. MIT notice preserved. |
| image/src/raw.zig | Bayer patterns and demosaic algorithms exist; raw init computes white level as 2^bits, with a u16 shift unsuitable for 16-bit input | Keep ISP processing in libcamera. Do not silently adopt a demosaicer or invent sensor calibration/DNG colour matrices. Follow-up candidate: validate bit depths and white-level semantics. |
| image/src/analysis.zig | Histograms and blur/sharpness analyses are potential quality tools, but own-image APIs would require camera copies | Keep initial capture independent; adapt small borrowed-view analyses only when a measured workload needs them. |
| memory/src/pool.zig | Block stride was not aligned to free-list nodes, and alloc ignored requested alignment | Reproduced Debug panic for block_size=9; fixed aligned backing allocation, checked stride rounding, and rejection of unsupported alignment. Regression tests added in Home. |
| video/src/core/memory.zig | Buffer pooling/refcounts are relevant concepts; init can leak the header if data allocation fails; several pool APIs use older ArrayList forms | Do not import the whole module into a camera callback. Future work: allocator-failure tests, acquire/release ordering, pool provenance and duplicate release checks. |
| video/src/core/frame.zig | Rich owned frame representation, useful for downstream processing | Capture leases use DMA-BUF descriptors without adopting an owned/copying frame model. A downstream adapter can explicitly copy/import later. |
| video/src/codecs/video/h264_encoder.zig | Contains placeholder macroblock output in a purported encode path | Do not reuse as a production camera encoder. Video encoding is explicitly outside this version; prefer validated system encoders when added. |
| video/IMPLEMENTATION_STATUS.md | Broad production-ready descriptions exceed what the inspected codec/GPU paths establish | Rely on code and conformance evidence, not feature lists. |
| dataplane/src/dataplane.zig | Practical Linux poll/splice architecture, but specific to TCP proxy streams | Reuse the principle of a thin native data path; do not couple camera buffers to proxy-specific sockets. |
| threading/, collections/, queue/, arena/ | Catalogued as potential building blocks | Use Zig's tested mutex/condition and fixed arrays initially; no dependency added solely because the package exists. |

The standalone Home pool fix is deliberately independent of camera functionality
and can be reviewed separately. It preserves the pool's fixed-capacity API;
it guarantees node alignment and refuses larger alignment requests rather than
returning pointers that violate Allocator's contract.

Why no monorepo dependency: Home currently spans several Zig API generations.
Pulling the image/video graph wholesale would introduce unrelated compiler,
codec and platform dependencies into a low-latency capture library. Small,
credited, regression-tested adaptations keep the reusable work while making
ownership and camera row stride explicit. The new library pins Zig 0.15.2 for
reproducible standalone builds; the Home fix is also tested with Home's installed
0.17 development toolchain.

## 0.2 follow-up: native media instead of FFmpeg

The Home JPEG encoder was confirmed to write headers without compressed scan
data. It now has a real, standalone, reusable baseline encoder and corrected
inverse DCT, contributed with a streaming MJPEG/Matroska writer in
[Home #912](https://github.com/home-lang/home/pull/912). zig-camera vendors those
small modules with MIT attribution and uses them by default, with no FFmpeg
build/runtime dependency. Independent JPEG readers validate actual pixels;
Home's own decoder also round-trips the new encoder after its DC scaling fix.

The RAW initialization defect was reproduced and fixed in
[Home #911](https://github.com/home-lang/home/pull/911): invalid dimensions/depths
are rejected and 16-bit white levels no longer panic. Existing pool alignment
work remains separately reviewable in [Home #910](https://github.com/home-lang/home/pull/910).

The new streaming muxer adopts Home's existing EBML/track IDs while replacing
whole-recording accumulation with a sink-based writer. It does not import the
broken broader video graph. H.264/HEVC placeholder slices and the handwritten
x264 ABI remain follow-up work, rather than silently routing through FFmpeg.
