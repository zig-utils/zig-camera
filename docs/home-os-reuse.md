# Home OS media reuse audit

## 0.119.1 shared media compatibility audit

Rechecked clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65 at
~/Code/Home/os, ADR-MC3/MC5, media/video_decoder.home and compositor.home.
ADR-MC3 places reusable codecs in Home stdlib and requires corpus evidence.
Placeholder decoder success returns and unverified Pi register paths cannot
replace hosted codec/container tests. The operator-grouping and RTMP fixes
therefore improve Home image/video; camera checks their exact revision on both
production and pinned development Zig. No OS kernel code is copied, modified,
translated or executed. Physical Pi and GPU acceptance remain open.

## 0.119 straight-alpha raster composition

Rechecked Home OS 151269666bc09aa15a271f1c1f4603f681132e65, ADR-MC3/MC5 and
compositor.home::color_blend. Its opaque-target RGB arithmetic floors 8-bit
channels and does not implement native-word straight RGBA ownership. Home stdlib
image therefore receives the shared compositor, reusing its APNG/PixelView
math; camera consumes it with existing image-job admission and owned results.
No kernel code is copied, modified, translated or executed. This is software
image evidence, not GPU or physical Pi acceptance.

## 0.118.2 process configuration ownership

Rechecked Home OS 151269666bc09aa15a271f1c1f4603f681132e65 and the already
audited kernel IPC/hosted-media boundary. Kernel message slots cannot transfer
a parent application's allocator owner. Camera keeps that owner in the parent
and reuses existing descriptor exports/ACKs for frame lifetime. Only its copied
initial process configuration omits the owner. OS source stays unchanged and
Home; no kernel code is copied, translated or executed.

## 0.118 compact hosted capture metadata

Rechecked clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65, ADR-MC3
and ipc/msgqueue.home. Its inline kernel message slots do not own hosted FD
resources or retryable user mappings. The shared Home video owner therefore
keeps its primary resource inline and allocates extra metadata only for actual
multi-plane imports, retaining that metadata through failed cleanup. No Home OS
source is copied, modified, translated or executed. This host memory improvement
does not establish Pi frame rate or hardware acceptance.

## 0.118 physical plane ownership audit

Rechecked Home OS origin/main 151269666bc09aa15a271f1c1f4603f681132e65 and its
camera, ISA DMA and framebuffer owners, with ADR-MC3/MC5. Independent video/UI
planes and display cadence are useful architectural guidance. Their kernel
addresses and fixed buffer states do not supply hosted DMA-BUF identity/extent
checks, alias-safe component maps or libcamera SharedFD/FrameBuffer ownership.
The camera capture path still explicitly contains a stub.

The reusable object/window planner and backing changes therefore improve Home
stdlib video and consume its existing IO provider and YUV encoders. Camera owns
its SDK/Bun coordination; Home OS stays Home. No OS source is copied, translated,
modified or executed. Neither display architecture nor GPU detection scaffolding
is treated as physical capture/import/coherency or throughput evidence.


## 0.117 factory notifications and native thread retirement

Checked current Home OS origin/main 151269666bc09aa15a271f1c1f4603f681132e65
at ~/Code/Home/os and re-read ADR-MC3/MC5, camera.home, drivers/dma.home,
framebuffer_double.home and media/video_decoder.home. The camera capture and
software codec success stubs do not implement configured libcamera buffer
factories. ISA DMA channels and display FREE/DRAWING/READY/DISPLAYED bookkeeping
cannot prove a hosted Bun callback or pthread has retired.

The explicit kernel/device versus hosted media ownership boundary is retained.
Home stdlib async/IO gain joined callback handoffs and stable POSIX attachment
ownership, while Home video gains pending-only cleanup to preserve source
profiles during rollback. Camera consumes those shared helpers and its existing
hosted FD imports. No Home OS source is copied, translated, modified or executed;
OS source remains Home. Hardware acceleration and physical Pi acceptance are
not inferred from architecture or stub returns.


Audit target: `~/Code/Home/os`, home-lang/home-os commit
[151269666bc09aa15a271f1c1f4603f681132e65](https://github.com/home-lang/home-os/tree/151269666bc09aa15a271f1c1f4603f681132e65).
Source inspection only; no kernel or device execution was performed. Include this
repository alongside Home compiler packages in subsequent media/hardware audits.

The persistent-allocation follow-up re-fetches this revision and re-reads
camera.home, drivers/dma.home and ADR-MC3. The camera owns one fixed RGB allocation
and capture remains an explicit stub; the DMA driver programs legacy ISA 8237
channels with 16 MB/64 KB restrictions. Neither supplies Linux DMA heap allocation,
libcamera FrameBuffer import, persistent userspace maps or retained cleanup.
Their kernel pointer ownership must not be used as a hosted DMA-BUF contract.
The new bounded allocation-cache ownership policy therefore improves Home video's
shared package and composes its existing leases/admission. Device allocation and
Camera/Bun integration remain open. No OS code was copied, modified, translated
or executed; no hardware or speedup acceptance is inferred from this audit.

## 0.115 hosted capture allocation

Re-fetched ~/Code/Home/os at 151269666bc09aa15a271f1c1f4603f681132e65 and
rechecked ADR-MC3, camera.home and drivers/dma.home. The fixed camera allocation
and stub capture, and ISA 8237 physical channel/16 MB/64 KB constraints, do not
provide Linux DMA heap allocation, SDK FrameBuffer imports or userspace coherency.
Home compiler packages/drivers and packages/kernel DMA helpers also use placeholder
physical pointer assumptions; neither replaces the hosted kernel UAPI.

The shared persistent owner/provider therefore improves Home video, while camera
owns SDK imports, request/map/export lifetimes and worker pins. This follows MC3's
shared-stdlib boundary. No OS code is copied, modified, translated or run. The
independent Linux memfd peer and system SDK tests validate hosted ownership and
cleanup; they do not establish physical Pi DMA, coherence or FPS.

## 0.115.1 shared mapping retirement

Re-fetched the audited 151269666bc09aa15a271f1c1f4603f681132e65 revision and
inspected kernel/src/core/vfs_buffer_cache.home, kernel/src/mm/user_alloc.home,
kernel/src/drivers/framebuffer_double.home and ADR-MC3. The page cache uses
256 fixed 4 KiB file blocks, inode/block identities and refcount/LRU state.
User allocation tracks kernel brk/mmap regions; framebuffer storage tracks
drawing/ready/displayed buffers. These are kernel memory owners, with no hosted
FD/unmap failure protocol or shared-libcamera mapping retirement to import.

The reusable implementation stays in Home IO: fix Mapping.close to retain a
failed mapping, then compose its owners with Home video's bounded admission in
camera. Deferred slots preserve budget until physical cleanup succeeds, without
repeating camera writeback or closing recycled FDs. This follows the ADR's
shared-package boundary. No OS code was modified, copied, translated or run.

## 0.116 caller-provided capture storage

Re-fetched 151269666bc09aa15a271f1c1f4603f681132e65 and inspected camera.home,
drivers/dma.home, framebuffer_double.home and ADR-MC3. The fixed kernel camera
allocation/stub capture, ISA 8237 DMA restrictions and display-owned buffer states
do not supply hosted FD duplication, inode/extent admission, sealed memfd storage,
Linux DMA-BUF synchronization or SDK FrameBuffer offset imports.

Reuse therefore extends Home video's existing backing/cache policy and Home IO's
mapping/descriptor helpers. Native Linux import remains an explicit host module;
portable ownership works on both Home compiler versions. Physical ownership must
still be verified on Pi hardware. No kernel code was copied, translated, modified
or executed, and no OS acceleration or throughput claim follows from these tests.

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

The 0.80.1 PNG ownership audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ADR-MC3, kernel boot/initramfs,
container/image and media/video_decoder sources. initramfs has a restricted
stored-block gzip read path; it is not a hosted deflate encoder or pinned zlib
owner. container/image manages OCI layers, not raster images. These sources do
not replace the checked Home streaming adapter. The owner cleanup fix improves
Home stdlib and is reused here; no OS source is copied, changed or executed.

The 0.81 APNG audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and searches camera/media/drivers/RPi
sources plus ADR-MC3 for GIF, PNG, palettes and LZW. Mailbox palette tags and VGA
palette writes control displays, not raster image encoding. Camera capture and
nominal media decoder routines supply no working APNG encoder or hosted frame
ownership. ADR-MC3 keeps shared media algorithms in Home stdlib; checked animation
encoding improves Home and is reused verbatim here. No OS source is copied,
modified or executed. Kernel buffers/hardware support remain distinct from
libcamera leases and borrowed host raster views, and no hardware acceptance or
performance result follows from these software tests.

The 0.82 APNG-job audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and inspects camera/media sources,
compositor animation state and ADR-MC3. The compositor's window opacity/progress
loop is a display animation policy, not a checked PNG/APNG encoder, hosted job
admission, libcamera request owner or atomic file publisher. Per ADR-MC3, row
checkpoint support improves the shared Home codec; camera job/input/file owners
remain hosted Zig/Bun. No OS source is copied, modified or executed, and none of
these software checks proves physical Pi image quality or throughput.

The 0.83 GIF audit again fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ADR-MC3 plus camera/media
sources. Searches for GIF, LZW, median cut and quantization find a file-preview
extension mention and unrelated PCI/network names, not a working raster codec.
Camera capture still returns a nominal size and nominal video routines still
return status without decoding. Per ADR-MC3, the checked GIF/palette algorithms
improve Home stdlib and are reused in camera; hosted file jobs/libcamera leases
remain camera ownership. No OS source is copied, changed or executed, and no
physical support or throughput result is inferred.

The 0.84 image-object audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ADR-MC3, camera/media,
framebuffer and VideoCore7 sources. Kernel RGB565, packed framebuffer format
constants, nominal capture and container image-name copying do not implement a
checked hosted gray/RGB/RGBA16 owner/converter. The reusable pixel primitive and
Image ownership fixes improve Home stdlib per ADR-MC3; libcamera leases, borrowed
FFI input and staged native I/O remain hosted camera ownership. No OS code is
copied, changed or executed, and no physical acceptance/performance follows.

The 0.85 resize audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and inspects ADR-MC3, camera,
framebuffer, VideoCore7 and media decoder sources, plus repository-wide
resample/resize/bilinear/bicubic/Lanczos searches. Framebuffer pixel/scroll/format
operations and the nominal camera capture do not implement a checked hosted
integer image resampler. The math library's Lanczos approximation concerns gamma,
not image filtering. Per ADR-MC3, the reusable algorithm improves Home stdlib and
is reused by camera; kernel/device ownership stays separate. No OS source is
copied, changed or executed, and no hardware support/performance is inferred.

The 0.86 temporary-mode image audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rechecks camera_capture and ADR-MC3.
The nominal kernel capture routine supplies no hosted libcamera reconfiguration,
request metadata owner or Bun worker-transfer path. Shared checked pixels and
resampling stay in Home stdlib; this chunk reuses them and existing camera
leases/mode jobs. No OS source is copied, modified or executed. Hardware mode
switching/optics/performance require separate Pi acceptance evidence.

The 0.87 descriptor-ownership audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ipc/shm_posix.home,
ipc/shm.home, camera_capture and ADR-MC3. Kernel named-object tables, permissions
and counts are distinct from hosted SCM_RIGHTS/DMA request ownership; ftruncate's
old-data copy remains a placeholder. No hosted descriptor export/peer lifecycle
implementation is available to copy there. Shared POSIX helpers and admission
resizing improve Home, while libcamera maps/leases stay in camera. No OS code is
copied, modified or executed, and no hardware IPC/DMA performance is inferred.

The 0.88 local-process transport audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ADR-MC3 and kernel/src/ipc/
shm_posix.home, shm.home and msgqueue.home. Repository searches find no hosted
SCM_RIGHTS/sendmsg/recvmsg transport. The kernel named-object reference counts,
small inline messages and placeholder ftruncate data copy cannot implement
Linux/Darwin descriptor passing or retain a libcamera request. The generic
hosted channel improves Home's IO package and is reused verbatim; camera owns
device exports, checked imports and eventual process supervision. No OS source
is copied, changed or executed. Kernel/hosted ownership remains separate, and
no physical Pi DMA, IPC throughput or codec acceleration is claimed.

The 0.89 supervised-process audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ADR-MC3, kernel IPC,
core/process.home, arch/x86_64/usermode.home and init/init.home. The kernel's
sys_kill marks zombie state; sys_waitpid polls that table and currently writes
CPU time as status. The usermode fork path eagerly copies and runs a child when
the parent waits, explicitly documenting that it does not provide concurrent
parent/child progress. Init's shutdown path still notes missing timed wait.
These are kernel-specific lifecycle references, not hosted Linux/Darwin join
proof or a libcamera lease owner. The shared bounded dispatch policy improves
Home video; Bun/OS process exit verification and camera ownership stay hosted.
No OS code is copied, changed or executed, and no hardware throughput is inferred.

The 0.90 remote-media audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65, rereads ADR-MC3, camera.home and
container/image.home, and searches the media tree for raw/DNG/TIFF algorithms.
The camera still has an explicit capture stub; container/image.home manages
container/Docker layers rather than pixel images. There is no hosted calibrated
DNG writer or request-safe tight row copy to import. ADR-MC3's stdlib boundary
applies: reuse Home image sensor_raw and video plane_pack unchanged, while camera
keeps request calibration, native handles and process/atomic-file ownership.
No OS code is copied, changed or run; kernel state is not used as DMA, camera
quality, codec or synchronization evidence.

The 0.91 remote Exif audit again fetches Home OS main and confirms clean
151269666bc09aa15a271f1c1f4603f681132e65. Searches of kernel media/camera code
and ADR-MC3 find no hosted Exif/ICC or typed request-metadata reader to reuse;
the capture stub remains explicit. ADR-MC3 assigns shared media algorithms to
Home stdlib. Strict scalar catalog reads therefore improve Home video and are
reused verbatim, alongside existing Home image Exif/ICC/codec implementations.
Request clock/provenance, camera maps and atomic-file ownership remain hosted.
No OS code is copied, changed or run, and no kernel stub, register path or
architectural statement supplies physical sensor or color acceptance evidence.

The 0.92 configuration audit confirms clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rereads camera.home and ADR-MC3.
`camera_set_resolution` changes global width/height while the fixed RGB allocation
and explicit capture stub remain; there is no immutable completed-request or
hosted process configuration snapshot to import. Home stdlib therefore gains the
bounded exact catalog projection used here. Native camera session negotiation,
lease ownership and source-request provenance stay in zig-camera. No OS source
is changed or executed, and no stub success is counted as hardware acceptance.

The 0.93 asynchronous-still audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and inspects camera.home,
media/video_decoder.home, fs/journal.home and ADR-MC3. The capture/codec stubs and
kernel journal ownership do not supply a hosted copied-image worker or joined
user-file publication primitive. Shared allocation budgets and zlib workspace
ownership therefore improve Home stdlib; existing camera staged files retain
hosted identity/publication/cleanup policy. No OS source is copied, changed or
executed, and no kernel result is treated as camera or performance evidence.

The 0.94 parent-publication audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rereads camera.home and the journal's
WAL modes, transaction lifecycle and bounded kernel records. Those filesystem
block transactions do not own hosted child-process results or libcamera leases.
Home's existing admission/dispatch/preparation helpers are reused unchanged;
camera retains hosted ACK/exit proof, parent temporary identity and joined I/O.
No OS source is copied, changed or run, and namespace atomicity is not presented
as power-failure durability or hardware acceptance.

The 0.95 sequential-output audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads ADR-MC3, camera.home,
fs/homefs.home and fs/tmpfs.home. Camera capture remains explicitly stubbed.
Homefs documents whole-write-or-zero filesystem object semantics; tmpfs bounds
writes to remaining allocated extent. Neither owns a hosted asynchronous sink
promise, a libcamera request or a partial-write cancellation join. ADR-MC3 places
the checked image algorithms in Home stdlib, which camera reuses unchanged.
Camera owns native copied-input jobs, caller-owned output methods and joined I/O;
no OS source is copied, changed or run, and no kernel write success is treated as
sensor, storage durability or codec-performance acceptance evidence.

The 0.96 restored-output audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and reads CLAUDE.md, ADR-MC3 and
drivers/camera.home. The explicit capture stub and global resolution configuration
do not implement a hosted request handoff, CAF acknowledgement, libcamera mode
restoration or joined sink promise. The documented stdlib boundary therefore
continues to apply: Home supplies codecs/admission/preparation primitives and
camera owns its hosted transactions. No OS source is copied, changed or executed;
kernel stubs and architecture policy do not supply physical acceptance evidence.

The 0.97 source-property audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rereads drivers/camera.home and
ADR-MC3, with targeted camera-property/catalog searches. Global camera geometry
and the explicit capture stub are not a typed hosted property snapshot or a
libcamera request owner. Home stdlib gains the checked nested-catalog helper;
camera owns its source-session cache, namespace and exported lifetime. No OS code
is copied, changed or executed, and no kernel state proves physical acceptance.

The 0.98 still-model audit checks clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65, CLAUDE.md, ADR-MC3 and
kernel/src/drivers/camera.home, with targeted Exif/DNG/UniqueCameraModel searches
in media, drivers and ADRs. The explicit camera_capture stub and global geometry
do not implement a hosted Model/property catalog or calibrated DNG metadata.
ADR-MC3 assigns shared hosted codecs/containers to Home stdlib, so the strict
string reader is improved there; camera owns its libcamera model policy and async
lifetimes. No OS code is copied, changed or executed, and the OS stub is not
physical camera or Pi 5 acceptance evidence.

The 0.99 exact-transform audit fetches clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rereads CLAUDE.md, camera.home and
ADR-MC3. The capture stub and kernel/device display paths do not provide hosted
owned gray/RGB/RGBA word transforms or Image palette/animation ownership.
The shared exact-pixel and public Image fixes therefore live in Home stdlib;
zig-camera owns its borrowed C boundary, bounded owned results and Bun lifecycle.
No OS source is copied, changed or executed, and no kernel declaration supplies
Pi 5 physical capture, image quality or performance acceptance.

The 0.100 PNG-loading audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and inspects camera_capture, media
video/audio decoder entry points and ADR-MC3. The ADR explicitly records that no
image decoder exists there and assigns hosted shared media work to Home stdlib.
The kernel capture stub and display paths do not supply a bounded PNG/APNG
loader or hosted worker owner. The exact PNG/streaming-inflate improvement lives
in Home; camera supplies bounded native/Bun ownership and file integration.
Home OS stays in its existing language and no OS source is copied, changed or
executed. Its declarations do not establish physical Pi quality or throughput.

The 0.101 sensor-HDR audit checks unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65, CLAUDE.md, ADR-MC3 and
kernel/src/drivers/camera.home, with targeted V4L2/HDR/media searches. The
camera_capture stub and global geometry do not implement Linux subdevice
controls, exclusive SDK manager lifetimes or a mode-catalog refresh. Pixel HDR
and codec work belongs to Home's shared stdlib under the ADR; hardware decode
remains a separate Home kernel driver. The portable gate, exact identity matcher
and observed boolean control operation are therefore added to Home first and
reused by zig-camera's hosted boundary. No OS source is copied, edited or
executed; the kernel stub is not evidence of physical Pi HDR support.

The 0.102 RTP audit checks clean unchanged Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65, CLAUDE.md, ADR-MC3, camera.home,
media/video_decoder.home, net/udp.home and net/rtsp.home. UDP has kernel-owned
socket queues and device/network dependencies; the RTSP module explicitly serves
AirPlay-shaped control messages and states that negotiated media transports are
not implemented. Those are not a hosted AVC/HEVC/AAC packetizer or Bun socket
owner. QoS RTP-port heuristics do not implement RTP framing or clocks. Shared
framing and parsing improvements therefore live in Home's video stdlib under the
ADR, with Bun using OS UDP facilities and camera retaining hosted ownership. No
OS source is copied, edited or executed. No kernel declaration supplies physical
Pi capture, packet-loss, network throughput or A/V synchronization evidence.

The subsequent current-Zig list-alias and deterministic admission-test corrections
retain that same Home OS revision and boundary; they do not alter kernel UDP,
AirPlay control code or camera drivers.

The 0.103 raw-socket audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and rechecks CLAUDE.md, ADR-MC3 and
kernel/src/net/udp.home. Its finite kernel queues/65507-byte payload bound are
useful boundary references but rely on the kernel network/device stack. They are
not a hosted TCP connection owner or Bun ByteSink. Home packages/net socket and
io buffered helpers have separate ownership dependencies as well. The checked
allocation-free send-progress primitive is therefore implemented in Home video
stdlib and copied verbatim into camera; hosted queues remain in camera's native
mailbox and Bun owns OS sockets. No Home OS source is copied, changed or executed;
no kernel declaration establishes physical networking or Pi capture acceptance.

The 0.104 process-output audit fetches unchanged clean Home OS main at
151269666bc09aa15a271f1c1f4603f681132e65 and inspects CLAUDE.md, ADR-MC3,
kernel/src/ipc/pipe.home and kernel/src/core/process.home. Its finite kernel pipe
and PCB/PGID tables are useful ownership references, not a hosted Bun media stdin
sink, exec handshake or POSIX child-group wait owner. Home basics process I/O and
video pipe wrappers were checked too. The bounded tail/wire and standalone host
are implemented in Home video stdlib, while camera retains native queue ownership
and Bun transport hooks. No OS source is copied, changed or executed. Kernel
process declarations do not supply Pi capture, microphone sync or process-output
performance acceptance evidence.

The 0.105 forward-MP4 audit fetches clean Home OS origin/main and confirms the
unchanged 151269666bc09aa15a271f1c1f4603f681132e65 revision. It rechecks
ADR-MC3 and searches kernel/src/media and kernel/src/container for MP4 muxing,
AAC priming, edit lists and fragmented output. The OS audio module supplies ADTS
header parsing/scaffolding; no hosted fragmented muxer or output-clock owner is
available there. Per ADR-MC3, forward-only AAC timing and bounded prefix release
therefore improve Home video's existing MP4 writer. No OS code is copied, changed
or executed. General container/loopback tests do not establish Pi sensor or
microphone synchronization, player interoperability or camera performance.

The 0.106 listening-output audit fetches clean main at the unchanged
151269666bc09aa15a271f1c1f4603f681132e65 revision. It inspects
kernel/src/net/tcp.home's bounded connection table, tcp_listen, TCPConnectionInfo
and current tcp_accept implementation, as well as ADR-MC3. tcp_accept searches
established child connections while the listener handle remains separate;
older neighboring comments describe a different receive-path design and are
not used as proof of current backlog behavior. These kernel connection IDs,
allocator buffers and device/packet handlers cannot own a hosted Bun server or
POSIX socket lifetime. The useful boundary is separate listener/peer identities;
the hosted implementation retains Home stdlib send progress and camera mailbox
ownership, then joins both Bun resources. No OS source is copied, edited or
executed, and no hardware/network-performance acceptance is inferred.

The process-group startup follow-up also rechecks core/process.home's pid/pgid
fields, process_get_pgid and default PCB group assignment at that same revision.
These refer to the kernel process table, not hosted POSIX fork/exec or a joined
consumer group. The actual postcondition fix therefore lands in Home video's
standalone POSIX supervisor, with independent after-exec group verification.
No Home OS source is modified or executed, and kernel declarations are not used
as proof of hosted process retirement.

The 0.106.1 control-channel follow-up retains the same inspected Home OS revision
and kernel/host ownership boundary. The hosted POSIX helper now separates proof
records from cancellation sockets; Home OS IPC pipes and PCB groups do not supply
a Bun fd owner or supervisor-result transport. The shared implementation and
controlled IPC tests stay in Home stdlib/camera. No OS source is changed or run.

## 0.107 APNG composition audit

Re-fetched origin/main and inspected clean Home OS
151269666bc09aa15a271f1c1f4603f681132e65. Read ADR-MC3, the media decoder path
and `kernel/src/video/compositor.home::color_blend` plus its compositor callsites.
`kernel/src/container/image.home` is OCI container-image management, not a raster
codec; its name is not evidence of reusable image decoding. Video decode stubs
and the ADR explicitly do not establish working image/animation decoding.

The OS compositor blends packed 8-bit RGB against an opaque target and sets
output alpha to 255. That kernel display contract cannot preserve APNG's
straight-alpha canvas, native 16-bit samples or PREVIOUS/BACKGROUND disposal.
Do not transplant it into a hosted image operation. ADR-MC3 explicitly places
media algorithms in Home stdlib; the checked two-canvas APNG renderer therefore
lands in Home's image package and is reused by camera. Kernel display/device
ownership remains separate. No Home OS files are changed, copied or executed;
this audit provides no physical display/GPU/camera acceptance.

## 0.108 hosted KMS catalog audit

Re-fetched clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65 and inspected
ADR-MC5 plus `kernel/src/drivers/framebuffer.home`, `framebuffer_double.home` and
the existing compositor boundary. ADR-MC5 assigns HVS hardware planes and kernel
mode setting to Home OS; it explicitly distinguishes architectural bandwidth
arithmetic and unverified Pi register paths from working hardware evidence.
Those Home kernel framebuffer pointers, dirty regions and swap/IRQ ownership do
not implement hosted Linux connector/CRTC/plane enumeration or POSIX FD cleanup.

The Linux read-only catalog therefore lands in Home stdlib video's hosted display
helpers and is reused verbatim by camera, following the ADR-MC3/MC5 boundary.
It queries public Linux UAPI identities and changes only its own temporary
client-capability visibility, without master acquisition or device modesets.
No Home OS files are copied, modified or executed. Actual DRM rendering and Pi
display/stride/modifier/color acceptance still require implementations/evidence.

## 0.109 direct display plane audit

Rechecked clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65 and ADR-MC5.
Its HVS plane architecture supports keeping video at native resolution with
hardware scaling and independent UI ownership, but its unverified Pi register
paths do not implement hosted Linux PRIME import, atomic KMS or flip-event
retirement. ADR-MC3/MC5 place hosted algorithms in Home stdlib and device drivers
in the kernel. The new atomic renderer therefore improves Home video and is
reused by camera, without copying, modifying or executing OS kernel sources.
This review supplies architectural guidance, not physical hardware evidence.

## 0.110 hosted serial display execution

Rechecked Home OS 151269666bc09aa15a271f1c1f4603f681132e65 and its message queues,
framebuffer_double.home page_flip and ADR-MC5. The message queue owns kernel
message bytes; it does not supply hosted callback contexts, joined POSIX threads
or camera-export cleanup fences. page_flip currently updates bookkeeping and
explicitly defers actual hardware programming. IRQ/display architecture guides
the device boundary but supplies no tested Linux event-loop executor.

The bounded native worker therefore lands in Home stdlib video, preserving the
ADR-MC3/MC5 split. No OS kernel code is copied, modified or executed; OS source
remains Home. This audit is not physical display or performance evidence.

## 0.111 Camera worker lifecycle audit

Re-fetched clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65 and re-read
ADR-MC3/MC5, framebuffer_double.home::page_flip and ipc/msgqueue.home. Kernel
queue messages and framebuffer bookkeeping do not provide hosted Linux joined
callback execution or camera-export retirement. Their ownership boundary stays
separate. Camera reuses the existing Home stdlib executor/KMS implementation
and adds its application lifecycle coordination in Bun. No OS source is copied,
modified, translated or executed. No unverified Pi register path is claimed as
working camera/display hardware.

## 0.112 CPU-converted scanout storage

Re-fetched clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65 and rechecked
ADR-MC3/MC5 plus framebuffer_double.home::page_flip. Kernel framebuffer addresses
and bookkeeping do not allocate hosted Linux KMS buffers or provide dma-buf CPU
coherency fences. The Home stdlib host therefore receives driver-owned CPU
scanout storage and explicit word conversion, reused by camera. OS source stays
Home; no kernel files are copied, modified, translated or executed. The OS
hardware-plane design guides the ownership boundary and does not substitute for
physical Pi scanout/color/performance acceptance.

## 0.113 hardware overlay ownership audit

Re-fetched clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65 from
~/Code/Home/os. Re-read ADR-MC3/MC5, framebuffer_double.home and
video/compositor.home, including the separate UI/video plane design. Keeping
video native while uploading independent ARGB UI directly follows MC5's display
architecture. Its bandwidth figures are calculations, and its Pi register paths
remain explicitly unverified; they are not hardware acceptance evidence.

Kernel framebuffer addresses/swaps and opaque-target RGB blending cannot own
hosted Linux master/event FDs, dma-buf CPU fences or per-pixel alpha conventions.
The reusable conversion, strict stacking and shared atomic plane retirement
therefore improve Home stdlib image/video under ADR-MC3. Camera consumes those
helpers and owns its Bun lifecycle. No Home OS source is copied, modified,
translated or executed; the OS stays Home. Physical Pi color/scanout and camera
performance remain acceptance work.

## 0.114 hosted JPEG decoder audit

Re-fetched clean Home OS 151269666bc09aa15a271f1c1f4603f681132e65. Re-read
ADR-MC3 and the media/video_decoder.home and audio_codec.home entry points. Their
placeholder success/sample-count returns do not implement JPEG parsing, entropy
scans or validated hosted image ownership. The compositor consumes opaque-target
RGB; it is not an image decoder. ADR-MC3 explicitly places software image/codec
work in Home stdlib and requires corpus evidence. The bounded JPEG decoder and
independent reference corpus therefore improve Home's image package and are
consumed by camera. No Home OS kernel code is copied, modified, translated or
executed; the OS remains Home. This audit is not physical hardware acceptance.
