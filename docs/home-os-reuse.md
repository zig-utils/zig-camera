# Home OS media reuse audit

Audit target: `~/Code/Home/os`, home-lang/home-os commit
[151269666bc09aa15a271f1c1f4603f681132e65](https://github.com/home-lang/home-os/tree/151269666bc09aa15a271f1c1f4603f681132e65).
Source inspection only; no kernel or device execution was performed. Include this
repository alongside Home compiler packages in subsequent media/hardware audits.

| Source | Observed implementation | Reuse decision |
| --- | --- | --- |
| docs/adr/ADR-MC3-media-stdlib.md | Accepted architecture places codec/container/image implementation in Home stdlib; OS consumes bindings and keeps OS source in Home | Improve shared Home packages, keep Zig helpers out of the OS tree |
| kernel/src/drivers/camera.home | Allocates a fixed RGB buffer; camera_capture returns a size with an explicit stub comment | No capture backend to import; retain libcamera Linux integration |
| kernel/src/media/video_decoder.home | Software codec entry points return success without producing decoded pixels; hardware selection assumes codec support | Do not use as a codec or conformance oracle; retain independent decoder tests |
| kernel/src/media/audio_codec.home | Header parsing and codec scaffolding; the ADR explicitly records lack of frame decoding | Codec/container work remains in Home audio/video packages; not evidence of usable encoding |
| kernel/src/audio/alsa.home | Minimal playback facade; no capture/read path or usable shared PCM cursor ownership | Cannot supply multi-encoder microphone fan-out; retain existing bounded native audio pipeline |
| kernel/src/audio/mixer.home | Bounded channel volume/pan/mute configuration; no capture or shared sample cursors | No capture fan-out implementation to import; use Home PCM timeline |
| kernel/src/drivers/audio.home | AC97/HDA register and playback descriptor management | Kernel hardware integration candidate, not a Linux/Pi microphone capture adapter |
| kernel/src/drivers/dma.home | Legacy ISA 8237 channel setup with 16 MB / 64 KB transfer bounds | Hardware-specific and incompatible with libcamera DMA-BUF ownership |
| kernel/src/rpi/videocore7.home | Pi display/GPU code; vc7_dma_fill/copy currently use CPU fallbacks | Candidate for later HomeOS display integration; not a working accelerated codec or DMA path |
| kernel/src/drivers/framebuffer_double.home | Fixed double/triple buffer states, pending/display ownership and frame-drop telemetry | Useful design reference for independent display cadence; no portable Linux preview implementation to import |
| kernel/src/ipc/msgqueue.home | Fixed 32 queues, 16 inline 256-byte messages per queue, receive shifts a matching tail | Unsuitable for pixel/PCM ownership or async codec tickets; reuse Home video slots/producer queues |

For multiple encoders, the reusable implementation remains Home video's
`packet_output.Slots` plus the new allocation-free `frame_fanout` admission helper.
It tracks wait/drop policy, identities, exact tickets and telemetry while existing
producer queues own bytes. Home OS's separation of display/video cadence is a
useful architectural reference; it does not establish tested camera throughput.

Future HomeOS camera/preview work must verify actual device paths, allocator/FFI
boundaries, DMA synchronization, buffer lifetimes and conformance. Avoid duplicating
codecs in the OS tree or treating stub success returns as hardware support.

The 0.47 follow-up inspects HomeOS audio/mixer.home as well as the playback ring
and ALSA facade. Their per-channel settings and kernel playback buffers do not
supply userspace capture cursors or sample-accurate consumer windows. The new
shared-microphone implementation therefore reuses and improves Home stdlib's PCM
timeline and stable slots, with one native capture claim and bounded producer
copies. No HomeOS hardware capability or synchronization result is inferred.

The 0.48 audit also inspects kernel/src/fs/journal.home and
kernel/src/sync/spinlock.home. Filesystem journal commits and architecture-specific
kernel lock routines cannot coordinate hosted libcamera recorder workers or
make arbitrary output hooks transactional. Shared publication therefore improves
Home stdlib async with bounded ordering/readiness preflight, while the camera
keeps its existing userspace mutexes, owned producer workers and joined cleanup.
No OS implementation was copied or modified for this feature.

The 0.49 audit inspects kernel/src/video/compositor.home, including color_blend
and per-window source alpha/opacity handling. Its packed framebuffer colors,
kernel window buffers and GPU imports cannot directly supply a Linux/macOS SDL
preview. Preview keeps its hosted renderer and camera lease boundary, and improves
Home image with reusable checked RGBA row validation/copying. The overlay is a
separate uploaded texture, preserving captured pixels. No HomeOS kernel code was
copied, executed or treated as evidence of Pi display performance.

The 0.50 follow-up rechecks framebuffer_double.home's buffer-state/display cadence
and compositor ownership against headless request processing. Both remain kernel
rendering facilities; importing them would introduce a second display buffer owner
for an operation that needs no display. Headless preview therefore reuses the
existing bounded libcamera queue/leases and Home job gates. origin/main still
matches the audited Home OS commit above; no OS code or hardware was executed.

The 0.51 audit inspects compositor.home's rect_intersect/rect_contains_point and
window/dirty-region geometry. Those signed kernel rectangles and framebuffer
ownership are not a portable SDL view contract. The hosted implementation reuses
Home image's checked unsigned regions/orientation and contributes a standalone
viewport plan for aspect fitting and texture coordinates. No kernel allocator,
framebuffer copy or device execution is introduced into camera display controls.

The 0.52 follow-up again reads the media-stdlib ADR, compositor.home's packed
color_blend and VC7 DMA fill/copy CPU fallbacks, and searches both for I420/YUV
conversion. Neither supplies a portable planar converter or hosted preview owner.
The ADR places media algorithms in Home stdlib; the shared I420 block improvement
therefore lands in Home video before camera reuse. Home OS remains unchanged at
the audited commit. No kernel/device execution or acceleration claim is made.

The same audit reads docs/adr/ADR-MC5-display.md and apps/media_player.home.
The display ADR specifies independent native-YUV video and ARGB UI/OSD planes,
with display interrupts pacing UI independently of video. This is a useful design
reference for the outstanding DRM/KMS preview backend. The ADR records unverified
Pi register/bring-up work and freezes OpenGL/Vulkan for its v1; its bandwidth
figures are estimates, not measured performance. The media-player app delegates
to the kernel decoder above and does not add a standalone converter or container.
A future hosted backend must use Linux display/DMA ownership and validate format,
stride, fences and lease lifetime rather than importing kernel physical pointers.

The 0.53 audit rechecks camera.home's CAMERA_FORMAT_YUV constant and fixed RGB
allocation/capture stub against main I420 configuration. It does not implement
a usable format-negotiated capture path. ADR-MC5's separate native-YUV display
plane is a future integration reference, while current hosted capture uses
libcamera and Home stdlib conversions/packing. Source revision remains
151269666bc09aa15a271f1c1f4603f681132e65; no Home OS code was executed or copied.

The 0.54 audit searches kernel/media, camera.home and videocore7.home for color
metadata/transfer negotiation and inspects VC7 gamma_table/vc7_set_gamma. That code
constructs approximate display LUTs for hardware register output; it does not
describe camera format normalization or query negotiated libcamera color metadata.
The camera stub also supplies no such contract. No LUT or kernel state is imported
into hosted capture policy. Shared description/negotiation policy therefore lands
in Home video. The audited Home OS revision remains unchanged; no kernel or
physical display code was executed, and no gamma accuracy claim is made.

The encoder-signaling follow-up fetches origin/main and confirms the same revision
above. It rereads ADR-MC3, the camera capture stub, decoder stubs and VC7 gamma
handling for an existing VUI/nclx implementation. The OS tree provides no usable
encoder/container implementation to import, and its display LUT is a different
stage from encoded sample signaling. ISO mapping, header-checked AVC/HEVC metadata
and MP4 nclx therefore improve Home's shared video package. The new tests inspect
real encoded headers and container bytes; they do not rely on stub success or
on architectural claims as conformance evidence. No OS code was changed or run.

The 0.55 integration rechecks camera.home and video_decoder.home at the same
151269666bc09aa15a271f1c1f4603f681132e65 revision. Their stubs still supply no
encoded-color session contract or hosted output ownership to import. ADR-MC3's
stdlib boundary remains applicable: reuse Home's tested color descriptions,
pixel conversion and codecs, with camera-specific lifecycle ownership in Zig.
No VC7 gamma LUT is used as a substitute for transfer conversion or encoder
metadata. The OS tree remains unchanged; no physical color result is inferred.

The bitrate follow-up also reads audio_codec.home's AAC/header handling at that
same revision. It supplies no hosted recording-session encoder recipe to reuse.
The fix uses the camera's existing native scalar query and Home audio validation;
no OS bitrate policy or decoder stub is used as encoding evidence.

The still-metadata audit fetches origin/main and confirms HEAD and origin/main
remain 151269666bc09aa15a271f1c1f4603f681132e65. It reads
kernel/src/container/image.home, the camera/media stubs, VC7 gamma handling and
ADR-MC3-media-stdlib.md, and searches for ICC/Exif profile/container metadata.
The tree supplies no hosted ICC serializer, Exif writer or color-management
engine to reuse. Display gamma LUT approximations are not ICC image metadata.
ADR-MC3 assigns media algorithms to Home standard-library image/audio/video
packages while OS source stays Home. Accordingly the shared ICC correctness and
ownership fixes land in Home image, then are reused verbatim by camera tests.
No OS source is changed, no kernel allocator/register path is imported, and no
hardware or display-calibration result is asserted. Camera ICC embedding and
Exif capture metadata remain implementation work.

The 0.56 audit again fetches origin/main at
151269666bc09aa15a271f1c1f4603f681132e65 and searches media/camera and ADR-MC3
for ICC/Exif embedding. The camera/decoder stubs and display gamma LUTs supply
no hosted profile container implementation. The shared image-library ownership
specified by ADR-MC3 remains the applicable boundary: JPEG/PNG/TIFF ICC embedding
and the zlib owner cleanup are contributed to Home image and reused in camera.
No kernel state or device pointer is imported; the OS stays unchanged. Independent
hosted container/image checks do not establish Pi display/sensor calibration.

The 0.57 audit fetches Home OS at the unchanged
151269666bc09aa15a271f1c1f4603f681132e65 and reads kernel/src/fs/journal.home
plus ADR-MC3. Its transaction states and journal commit/checkpoint operate on
kernel blocks, drivers and serial output. They do not supply a hosted staged
image-file transaction, descriptor lifetime or Bun/native publication barrier.
The camera therefore reuses Home async's preparation gate and its existing
hosted Zig atomic-file layer, keeping native handles and image/frame ownership
outside the kernel. No OS code is copied or changed, and no kernel journaling,
crash-durability or hardware result is asserted.

The Exif foundation audit fetches Home OS main and confirms the same
151269666bc09aa15a271f1c1f4603f681132e65 revision. It rereads camera.home,
video_decoder.home, container/image.home and ADR-MC3, then searches for Exif and
JPEG metadata writers. The capture/decoder stubs and display LUT code offer no
hosted TIFF-directory serializer or metadata ownership contract to reuse.
ADR-MC3 explicitly places media algorithms in Home's shared image/audio/video
packages. Exif bounds/ownership and typed serialization therefore improve Home
image, with verbatim reuse in camera. The OS stays unchanged; kernel/device
allocators and stub return values supply no capture or codec acceptance evidence.

The combined Exif/ICC embedding audit rechecks Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65. camera.home, container/image.home,
video_decoder.home and ADR-MC3 still supply no hosted JPEG APP1/PNG eXIf writer,
TIFF metadata merger or independent image-container acceptance path. The shared
image-library boundary remains applicable: Home image gains combined embedding,
directory relocation and reader tests; camera reuses those sources. OS/device
state is neither copied nor executed, and no stub is counted as working capture,
codec or image-quality evidence.

The 0.58 capture-Exif audit fetches Home OS main and confirms
151269666bc09aa15a271f1c1f4603f681132e65. It rereads camera.home,
video_decoder.home, container/image.home and ADR-MC3. The camera stub allocates
a fixed RGB buffer and only returns a nominal capture size; its resolution setter
does not supply a hosted request/metadata ownership contract. container/image.home
is OCI image management, not photography. Decoder stubs provide no metadata
serializer. Per ADR-MC3, missing-default Exif merging and inline JPEG markers
therefore improve Home image first and are reused here. OS stays unchanged;
no kernel, optical or capture-hardware claims are inferred from these files.

The 0.59 paired-stream audit fetches Home OS main at unchanged
151269666bc09aa15a271f1c1f4603f681132e65 and rechecks camera.home plus ADR-MC3.
The fixed RGB buffer and nominal capture-size return do not supply multi-stream
request association, validated source planes or hosted copy ownership. Per the
media-stdlib boundary, aggregate plane preflight therefore improves Home video
first and is reused verbatim here. No kernel allocator, stub capture or decoder
return is treated as a working implementation or hardware acceptance result.

The 0.60 request-handoff audit fetches unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rechecks its camera stub plus the
media-stdlib boundary. A fixed RGB allocation and nominal byte-count return do
not implement retained request generations, stopped DMA access, publication
ownership or recoverable handoff. Existing Home video leases/access gates and
Home async publication gates remain the reusable hosted components. No kernel
source is copied, modified or executed, and no physical sensor/DMA result is
inferred from a stub.

The 0.61 burst-capture audit reads clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65. camera.home still allocates one fixed RGB
buffer and returns a nominal size; video_decoder.home has placeholder decode
returns, and container/image.home manages OCI images. These files supply no
hosted burst queue, checked idle deadline, multi-mode request ownership or staged
file publication to reuse. ADR-MC3 explicitly places working media algorithms in
the Home shared libraries. Relative interval arithmetic therefore improves Home
async, while mode selection, serial file ownership and cancellation stay in
zig-camera. OS stays unmodified and unexecuted. Its stubs are not capture, codec,
optical-quality or physical timing evidence.

The 0.62 sync-readiness audit fetches Home OS main and rechecks unchanged
151269666bc09aa15a271f1c1f4603f681132e65. camera.home has no per-request sync
metadata or server/client implementation. time/clocksource.home exposes kernel
clock/TSC routines and saturation; time/hrtimer.home owns kernel timer queues,
callbacks and clock bases. Neither supplies libcamera's request-local SyncReady
or signed SyncTimer contract, and a host clock cannot stand in for that contract.
The media-stdlib ADR still directs shared algorithms into Home packages. Home
video's existing frame barrier is therefore extended with explicit observation
readiness. Kernel pointers, allocators, timers and device state are not copied or
executed, and no physical cross-camera synchronization result is inferred.

The 0.63 alignment audit fetches unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads camera.home, the HVS source-pitch
setup in rpi/videocore7.home and ADR-MC5-display.md. The camera stub's resolution
setter stores dimensions; HVS computes an XRGB pitch from width*4. Neither supplies
VC4/PiSP processed capture recipes, planar chroma geometry or hosted structural
preflight. The display ADR records uncompiled/unverified register work and
separates display ownership from shared media algorithms. Home video's planner
therefore supplies the reusable arithmetic, with camera-specific configuration
publication here. OS remains unmodified and unexecuted. Kernel pitch/register
code is not evidence of libcamera alignment, working Pi display or a speedup.

The 0.64 tuning-document audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads camera.home, the media-stdlib
ADR and JSON/tuning-related paths. The camera driver is still a fixed RGB
allocation with nominal capture-size return, without IPA configuration, tuning
JSON ownership or manager discovery lifecycle. The identified sdmmc/zram tuning
code concerns storage/memory; container/image.home concerns OCI images. None
supplies a hosted ISP tuning document implementation. ADR-MC3 places shared media
algorithms in Home's libraries, so the portable bounded editor improves Home
image, then is copied here with attribution. OS remains unmodified and unexecuted.
Data edits are not evidence of working sensor tuning, Pi quality or performance.

The 0.65 manager-tuning audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rechecks camera.home and ADR-MC3.
The camera stub has no hosted libcamera manager, IPA profile ownership or
environment restoration boundary. Its kernel pointers/allocator cannot supply
the process-level lease needed across Bun worker reopens. Per the shared-media
boundary, the portable environment ownership primitive improves Home env and is
reused here with the existing Home tuning editor and job gates. No OS source is
copied, changed or executed. The fixed-buffer stub is not hardware acceptance,
and the new real-backend no-camera smoke proves manager cleanup, not sensor IPA
parameters, optics, hotplug behavior or Pi throughput.

The 0.66 device-loss audit fetches unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65, rechecks camera.home/ADR-MC3 and reads
the xHCI/HID/mass-storage ownership boundary in drivers/usb.home. Kernel device
contexts, command/event rings and register access do not supply hosted libcamera
signal retirement or completion-lease/DMA ownership. The camera stub has no such
disconnect notification. Existing Home lease/access/completion gates therefore
remain the portable pieces to reuse. No OS source is changed, copied or executed,
and no physical unplug, kernel-camera or recovery acceptance is inferred.

The 0.67 manager-watch audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ipc/msgqueue.home, the USB event
ring/context ownership and ADR-MC3. The kernel queue holds 16 inline 256-byte
messages, rejects full sends and shifts matching receive tails. It cannot preserve
4096-byte hosted SDK IDs or supply a libcamera manager subscription. USB rings own
kernel/controller state, not hosted SDK signal retirement. Existing Home stdlib
owned_fifo/device_identity therefore remain the reusable pieces, with camera
manager/tuning lifetime and rescan policy in zig-camera. No OS code is copied,
modified or executed; no physical hotplug or reconnect result is asserted.

The 0.68 reconnect audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rereads camera.home, time/clocksource.home,
time/hrtimer.home and ADR-MC3. The fixed RGB capture stub has no manager/device
reopen or retained userspace frame generations. Kernel timer queues and the
clocksource's explicitly approximate TSC conversion cannot supply hosted monotonic
retry admission or Bun/native cancellation. Existing Home stdlib Retry therefore
supplies shared portable arithmetic, while the camera owns SDK discovery, fresh
handle adoption and joined disposal. No kernel sources are copied, changed or
executed, and no clock calibration, USB reconnect, sensor or DMA result is claimed.

The 0.69 recorder/preview-recovery audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads camera.home,
framebuffer_double.home, audio/mixer.home and ADR-MC3. The camera stub still
returns a nominal capture size. The framebuffer manager owns fixed physical and
virtual kernel buffers with free/drawing/ready/displayed states; the mixer stores
channel volume/pan/mute state. Neither supplies independent hosted RGBA snapshots,
libcamera generations, shared encoder publication or a retained PCM sample
cursor across reconnect. ADR-MC3 puts shared media algorithms in Home packages.
Existing Home publication_batch, pcm_fanout/pcm_timeline and rgba_view therefore
remain the reusable implementation, with fresh camera/preview/native lifetime
coordination here. No OS source is copied, changed or executed. The kernel files
are not evidence of working camera/audio hardware, decoded media, physical A/V
continuity or a performance improvement.

The 0.70 encoder-policy audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rereads media/video_decoder.home,
drivers/camera.home and ADR-MC3. The decoder source's hardware check/nominal success
returns do not supply hosted AVC encoder profile/rate-control/preset behavior or
valid MP4 sample descriptions; the camera stub has no encoding path. ADR-MC3
places these algorithms in Home's shared media packages. Native adapter policy
and Baseline/Main container fixes therefore improve Home first and are reused
verbatim here. No OS file is copied, modified or executed; kernel capability
assertions are not evidence of a working codec, GPU acceleration or Pi throughput.

The 0.71 level/VBV audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads camera.home,
media/video_decoder.home and ADR-MC3. The nominal camera/decoder returns and kernel
hardware-capability declarations do not supply a hosted encoder-level table,
transactional parameter recipe, CPB rate control or validated SPS output.
Bitrate fields in kernel state are not an implemented VBV controller. Per the
shared-media boundary, the working Home adapter gains the reusable limits policy
first. No OS source is copied, changed or executed, and no hardware encoding,
physical quality, clock or throughput result is inferred from these files.

The 0.71.1 AVC-level follow-up rechecks clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65. Its camera/decoder stubs do not supply
userspace SPS level selection or independent decoder acceptance. The correction
therefore stays in Home's working codec bridge, with the copied camera fixture
and existing decoder oracle. No OS source or hardware claim is changed.

The 0.72 HEVC geometry audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65, searches the tree for codec/HEVC/bitstream
implementations and rereads drivers/camera.home, media/video_decoder.home and
ADR-MC3. The nominal capture result and success-returning H.265 decoder do not
provide SPS conformance-window edits, a hosted encoder or mixed-size CTU lifetime
management. ADR-MC3 explicitly puts media algorithms in Home's shared libraries
and requires corpus results rather than source size for codec claims. Therefore
the shared bit-reader/SPS/encoder improvements go to Home and are reused here;
no kernel code is copied, modified or executed. Kernel capability declarations
are not evidence of physical 4K capture, decoding, acceleration or performance.

The 0.73 counted-keyframe audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and searches media sources for encoder,
IDR and keyframe implementations. Its camera stub and nominal video decode path
do not supply a hosted IDR request queue or encoder-input accounting. ADR-MC3
continues to put media algorithms in Home's shared library. The reusable counted
ledger therefore improves Home first; zig-camera retains hosted producer and
session lifetime coordination. No kernel code is copied, modified or executed,
and these checks do not establish physical camera timing, decoding or acceleration.

The 0.74 repeated-header audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and checks camera/video media sources for
SPS/PPS/VPS, NAL, Annex B and encoder support. Its nominal camera/decoder routines
do not implement parameter-set extraction, hosted packet assembly or encoder
header lifetimes. ADR-MC3 retains the shared-media-library boundary, so the checked
filter/assembly improvements go to Home and are reused verbatim here. No OS code
is copied, modified or executed, and no hardware decode, camera timing or Pi
throughput result follows from these inspections.

The 0.75 named-quality audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and checks camera/media sources and
ADR-MC3. The decoder's bitrate field and nominal camera capture routine do not
supply software encoder quality tiers, bitrate control or a rational scaling
implementation. Per the shared-media boundary, the reusable policy belongs in
Home's library; hosted session negotiation and owner publication remain here.
No OS code is copied, modified or executed, and no physical image quality,
rate-control conformance, hardware acceleration or Pi throughput is inferred.

The 0.76 packed-RGB audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads drivers/camera.home,
drivers/framebuffer_double.home, media/video_decoder.home and ADR-MC3. The
framebuffer manager tracks pitch/bpp and kernel buffer states/addresses, but
initializes pitch from width/bpp; it does not supply a checked hosted borrowed
RGB/BGR/RGBX/BGRX converter or libcamera lease handling. The camera capture path
remains a nominal size-returning stub, and the decoder declarations are not
working format/capture support. Per ADR-MC3, shared pixel algorithms improve Home's
standard library and are reused here; kernel physical addresses and framebuffer
owners stay out of the hosted camera boundary. No OS source is copied, changed or
executed. Synthetic/decoder tests do not establish physical Pi format acceptance,
DMA coherency, kernel video acceleration or performance.

The 0.77 planar/semi-planar audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and searches camera, media and VideoCore7
sources for NV12/NV21/YUV conversion. The nominal camera driver defines a YUV
format constant, but its capture routine only returns a size; it does not provide
pitched UV views, chroma averaging, checked layout conversion or hosted libcamera
ownership. Video decoder declarations do not implement a substitute. ADR-MC3's
media-stdlib boundary still applies, so checked sample views and codec conversion
improve Home's Zig library and are reused here. No OS code is copied, changed or
executed, and no kernel decode or physical camera result is inferred.

The 0.78 packed-422 audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and searches camera, media and VideoCore7
sources for YUYV/YVYU/UYVY/VYUY. The nominal YUV camera constant and size-returning
capture stub provide no packed-pair processing, checked row spans or hosted
4:2:2-to-I420 conversion. ADR-MC3 keeps these algorithms in Home stdlib; the shared
converter is improved there and reused here. Kernel buffers/addresses and
unimplemented decoder declarations do not substitute for libcamera ownership.
No OS code is copied, changed or executed, and no physical result is inferred.

The 0.79 RGB16 audit checks unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65. Camera, framebuffer and VideoCore7 gamma
sources do not supply a checked hosted RGB48 word view. RGB565 bitfield packing
and kernel framebuffer bpp/pitch are different from three 16-bit channel words;
gamma LUT control does not implement word-order conversion or lossless still
encoding. Camera capture remains a size-returning stub and nominal decoder
interfaces do not provide working libcamera support. ADR-MC3 keeps shared media
algorithms in Home stdlib, so rgb16_view is contributed there and reused here.
No OS source is copied, changed or executed. Physical Pi format/bit-depth,
DMA/coherency, hardware encoding and performance remain hardware acceptance work.

The 0.80 sensor-raw audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and searches camera, media and VideoCore7
sources for CSI-2 packing, Bayer/mono and PiSP COMP1 decompression. No checked
hosted sensor-row decoder exists there; camera_capture remains a size-returning
stub and gamma/display format declarations do not implement raw reconstruction.
Per ADR-MC3, the std-only sensor decoder is contributed to Home's image package
and reused here, while libcamera leases/DMA/calibration remain camera ownership.
No OS source is copied, changed or executed. Software fixtures do not prove
physical Pi compressed raw, mono metadata, sensor quality or hardware throughput.
