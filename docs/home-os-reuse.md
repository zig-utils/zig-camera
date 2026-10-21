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
