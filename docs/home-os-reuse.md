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
