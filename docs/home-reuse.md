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
| video/src/codecs/video/h264_encoder.zig | Contains placeholder macroblock output in a purported encode path | Do not reuse as a production camera encoder. Use the new header-checked Home x264/x265 adapter for actual compressed recording. |
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
broken broader video graph. The placeholder pure-Zig slice paths remain unused.
The 0.3 integration below supersedes handwritten vendor ABI declarations.

## 0.3: AVC/HEVC and fragmented MP4

The existing x264/x265 integrations were inspected. Their vendor structure
layouts and some function declarations are hand-written and do not match modern
headers reliably. The new Home `codecs/video/native_encoder.{c,h,zig}` integration
compiles the vendor boundary against installed headers and exposes only Home-owned
fixed scalar structs. It works with pinned Zig 0.15.2 and Home's 0.17 development
toolchain, including after @cImport removal. Its VFR buffering, original timestamps,
flush lifecycle, plane geometry and failure handling have focused regression tests.

Home's existing FragmentedMp4Muxer also had an incorrect ftyp size, incorrect
fragment header sizes, zero tfdt, incomplete mdia and a missing real sample
description. The standalone `containers/mp4_stream.zig` uses those box conventions
with checked fixed-size header storage, real avcC/hvcC, complete video track metadata,
exact offsets and bounded sink writes. `rgb_i420.zig` improves the existing RGB
conversion approach with stride/length checks and actual 2x2 chroma averaging.

These modules are vendored verbatim into zig-camera; the Home contribution is
kept independently reviewable in [Home #913](https://github.com/home-lang/home/pull/913),
source commit cf7cd358fd051f1634281adf0596e21e704472ea. Independent Apple AVFoundation decoded H.264 and
HEVC MP4s; Linux CI uses OpenH264/libde265 plus MP4 parsing and MKVToolNix recognition.
The existing whole-library codec paths are not represented as validated by these
focused tests. No FFmpeg is used as an encoder, muxer or validation dependency.


## 0.4: event-driven jobs and cancellation

Home async/task, async/channel, runtime/threading/channel and video/perf/threading
were inspected for camera control/preview work. The general video pool passes
addresses of init-local queue/shutdown state into workers before returning a copy;
its waitEmpty also does not account for executing work. It is not reused here.
The channel/runtime graphs add different ownership/allocation contracts, so the
camera path retains bounded request slots and explicit synchronization.

Home's Task.cancel unconditionally replaced completed state; an in-flight poll
could also overwrite Cancelled with Completed or Pending. JoinHandle.await did
not handle Failed and could spin forever. [Home #914](https://github.com/home-lang/home/pull/914) fixes those
transitions and adds deterministic tests for both in-flight poll outcomes, late
cancellation and failed joins. Fourteen task/future/state tests and the complete
41-test async root suite pass in Debug/ReleaseSafe with Home's 0.17 toolchain;
focused task/gate tests also pass with camera's pinned Zig 0.15.2.

The new allocation-free Home CompletionGate applies these terminal-state principles
to revisioned event jobs. zig-camera vendors it verbatim for native autofocus,
rejecting stale/pre-scan outcomes while keeping callbacks bounded. The display
handoff uses one fixed shared RGB slot with nonblocking publication; the Python
capture worker is shared by recording, preview and autofocus, with explicit joins
before reuse/destruction. It does not import a general executor into a callback.

## 0.5: sensor streams and owned plane copies

Rechecked Home async result futures/job state, image resize and video pixel
conversion. Existing async cancellation improvements remain in #914; camera
capture jobs use the same immutable-terminal-state rules, with Python locks and
bounded submission around the existing capture pump. No whole-runtime dependency
is introduced. ISP-generated lores avoids importing a CPU resize graph on the
hardware path; synthetic YUV fixtures reuse Home rgb_i420 with chroma averaging.

Home pixel conversion assumes caller-provided plane geometry and includes broader
conversion paths beyond the tested camera scope. The new standalone
`video/src/core/plane_pack.zig` adds checked active-row copies and I420 packing,
validates all planes before writes, accepts omitted final-row padding and preserves
caller ownership. It is exported from Home video, documented, and vendored verbatim
here at source commit 9d5a70a00. Independent U/V strides are supported in Home;
the libcamera adapter derives half-Y chroma strides for YUV420 and handles either
one contiguous physical plane or three planes. Focused tests pass on Zig 0.15.2
and Home's 0.17 development toolchain; the camera C/Python suites exercise both
physical layouts and stale/stop lease behavior. The wider Home video graph is not
represented as validated by these module tests.

Canonical Home plane packing contribution: [Home #915](https://github.com/home-lang/home/pull/915).

## 0.6: pre-roll and independent recording segments

Rechecked video/core/memory.zig RingBuffer and RefCountedBuffer, plus the Home
streaming Matroska/MP4 and native encoder modules. The general RingBuffer blocks
on fullness and accepts zero capacity, which cannot suit a capture-history
consumer. It neither owns encoded byte payloads nor preserves GOP dependencies.
[Home #916](https://github.com/home-lang/home/pull/916) adds a focused packet ring
with a fixed arena/entry array, checked capacities, nonblocking push, byte/frame/
time eviction through the next key and explicit wrap-safe copies. Three module
tests pass on Zig 0.15.2/0.17, including allocation failure cleanup. It is vendored
verbatim at 2dab097b2. Broad memory-pool ownership issues remain outside this scope.

The Home header-checked encoder adapter now requests actual AVC/HEVC IDRs for
segment boundaries, contributed as 5e6d256f4 to the existing [Home #913](https://github.com/home-lang/home/pull/913).
A standalone eight-frame regression checks actual IDR NAL types under GOP100,
forced boundaries, delayed AVC drain and post-drain rejection on Zig 0.15.2/0.17.
zig-camera splits using emitted packet timestamps, remuxes each file with Home's
fresh sample description, and snapshots encoded history without restarting the
codec. Python codec CI independently decodes each new segment and snapshot via
OpenH264/libde265, including frame order and capture gaps. No FFmpeg/Libav is used.

Mode jobs retain the existing bounded capture pump and explicit lease guards.
They serialize lifecycle work at the facade and restore prior configuration after
owned captures. No general Home executor or CPU resize graph is imported into
native camera callbacks. The wider Home video/runtime graph is not represented
as tested by these focused additions.

## 0.7: bounded PCM input, synchronized Matroska and rotation

Audited Home audio/io/recorder.zig, audio/io/alsa.zig, the audio and video AAC
encoders, PCM representations and Matroska muxer. The older capture backends and
AAC coding contain placeholders; the existing muxer accumulates the full output.
These were not treated as working production dependencies.

[Home #917](https://github.com/home-lang/home/pull/917) adds standalone checked
ALSA capture with the system headers, sample-count/BOOTTIME timestamps, a fixed
PCM arena/entry queue, streaming video+PCM Matroska and soft rotation policy.
The modules are vendored verbatim at bad4882f9; their focused tests run on Zig
0.15.2 and Home's development toolchain. The broader Home audio graph remains
outside this validation. Home #913 also exposes its existing avcC/hvcC builder
for Matroska CodecPrivate, preserving the checked AVC/HEVC configuration path.

zig-camera adds explicit source ownership, bounded background audio reads,
coverage waits, sample-clipped split timelines and exclusive indexed output
rotation. Linux acceptance uses ALSA null input, independent mkvtoolnix WAV
extraction, exact synthetic sample checks and OpenH264/libde265 decoding. No
FFmpeg is used. Physical input latency, long-run drift, compressed audio and
adaptive resampling remain gaps; see [A/V semantics](audio-rotation.md).

## 0.8: real AAC-LC and synchronized MP4

Rechecked both Home AAC prototypes. One emitted quantized amplitude envelopes;
the other used fixed-width spectral coefficients and placeholder Huffman tables.
Neither was an interoperable AAC implementation. [Home #918](https://github.com/home-lang/home/pull/918)
adds a bounded header-checked native AAC-LC adapter around the standalone FDK
library, matching Home's existing native video adapter pattern. The old encode
entry points now reject unsupported encoding rather than returning invalid audio;
legacy partial-allocation cleanup is fixed. Five legacy/configuration/allocation
checks plus partial PCM/drain/state tests pass on Zig 0.15.2 and Home's development
toolchain. The new adapter/tests are vendored verbatim at 53c1b108f. This is not
represented as a pure Zig AAC codec or validation of Home's broader audio graph.

[Home #913](https://github.com/home-lang/home/pull/913) now extends its bounded
fragmented MP4 writer with AAC `mp4a`/`esds`, independent sample clocks, finite
64-bit duration/edit patches, initial offset, explicit roll associations and
short final AAC durations. It uses actual FDK delay, not an assumed constant.
One packet per encoded track is staged; no file-sized table is built. The muxer
is vendored verbatim at 27f5fe0e2; four focused tests pass on both toolchains.

Independent Apple playback exposed extra legacy priming and padded tail playback
that raw packet parsing would miss. The complete roll/edit/final-duration path
now passes FAAD2 and AVFoundation waveform/count checks for 44.1/48kHz, mono/
stereo, offsets, short input, gaps, splits and rotation. Linux x86/ARM CI additionally
decodes video with OpenH264/libde265 and identifies MP4 tracks with mkvtoolnix.
The optional FDK codec is built directly at pinned 2.0.3; no FFmpeg/Libav is used.
See [AAC synchronization and limits](aac-mp4.md). Hardware timing, drift and Pi
throughput remain unmeasured.

## 0.9: non-consuming circular PCM windows

Rechecked Home's PCM timeline, encoded GOP ring and AAC/MP4 modules alongside
Picamera2's CircularOutput2. The packet ring already supplies key-safe encoded
history; the PCM timeline only supported consuming live output. Home #917 now
adds validated rolling eviction and independent sample-window cursors at
41b071c04. The updated PCM module is vendored verbatim. Five focused tests pass
on Zig 0.15.2 and Home's development toolchain, including wrap, descriptor limits,
repeated replay, fractional sample clipping and rejected-input state preservation.
Targeted pickier passes.

zig-camera uses those PCM windows for snapshots and a separate live audio
watermark. Encoded video is reused; retained PCM is encoded with fresh Home AAC
state per MP4 snapshot. Existing MP4 delay/edit/tail machinery handles rebasing
without a second muxer or FFmpeg. Current tests independently decode AAC with
FAAD2/AVFoundation and exercise live splits, PCM Matroska and background capture.
Snapshots serialize consumer work; performance and physical synchronization are
not inferred from synthetic tests. See [circular A/V semantics](circular-av.md).

## 0.10: owned worker windows and delayed FIFO

Rechecked Home's async executor/task queues, threading primitives, packet ring,
PCM timeline and existing completion gate. The general async executor is tied to
its wider runtime (including queue/task allocation and lifecycle assumptions);
importing it into capture would add an unrelated execution graph. Python's
existing bounded job contract now schedules only independently owned native
snapshots. Camera/queue ownership remains in Zig; no borrowed lease crosses to
a worker and no manager callback runs media work.

Home #916 at 07b94d268 adds bounded FIFO enqueue/maturity/pop and minimal owned
suffix cloning to the existing packet ring. Home #917 at 860a2ab5a adds PCM
window cloning, including a wrapped block in a full 4096-descriptor source. Both
modules are vendored verbatim. Five packet tests and seven PCM tests pass on Zig
0.15.2 and Home's development toolchain; allocation-failure, wrap, EOF, overflow
and rejected-state cases are included. Targeted pickier passes.

Existing Home AAC/MP4 and PCM Matroska writers supply all output encoding and
muxing. zig-camera adds two-handle ownership limits, file-identity reservations,
independent worker lifetimes and a delayed shared-clock consumer. Picamera2's
CircularOutput2 source informed keyframe/open/close/stop semantics; its PyAV output
path is not imported. See [behavior and differences](async-delayed.md). Synthetic
and independent decoder tests do not establish physical timing or Pi throughput.

## 0.11: packet output conversion and exact PTS

Audited Home's video sink vtables, decoded/encoded frame collections and codec
bitstream/container helpers alongside Picamera2 Output/FileOutput/CircularOutput2.
The broader sink graph accumulates packets and has dependencies outside the
camera's focused streaming path. Existing Home AAC/MP4/Matroska sink callbacks
already provide the needed muxing boundary; they now accept native caller sinks.

[Home #919](https://github.com/home-lang/home/pull/919) adds standalone checked
length-prefixed NAL to Annex B conversion, exact integer PTS formatting and a
monotonic sink-backed PTS writer. It is vendored verbatim at 9b281486b. Three
focused tests pass on Zig 0.15.2 and Home's development toolchain; targeted pickier
passes. Rejected input is checked before destination mutation; sink failures
poison the writer. The broader Home sink graph is not represented as validated.

zig-camera uses these helpers for first-key parameter sets, elementary output and
Python/C PTS. Home's existing streaming writers supply MP4/MKV to file-like
streams. Zig keeps native ownership, identity guards and callback lifetimes;
Python adds reusable object claims, borrowed stream ownership and failure cleanup.
See [interfaces and limits](output-objects.md). No FFmpeg/Libav is introduced;
independent decoder checks remain separate from unmeasured Pi/hardware timing.
