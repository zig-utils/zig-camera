# RTP recording output

`RtpOutput` sends AVC or HEVC video and optional AAC-LC audio over UDP, using
Home's allocation-free RTP framing. It is a reusable custom output with the same
bounded host queue, splits, recovery, delayed output and circular snapshot
lifecycle as other recording outputs. There is no Python or FFmpeg dependency.

```ts
import { Camera, Recorder, RtpOutput } from '@zig-utils/camera'

await using camera = new Camera({ width: 1280, height: 720 })
await using output = new RtpOutput({
  address: '192.168.1.50',
  port: 5004,
  rtcpPort: 5005,
  mtu: 1200,
})
const recorder = await Recorder.open(output, {
  width: 1280, height: 720, fps: 30, codec: 'h264',
  asyncWrites: true,
  outputQueue: { maxBytes: 4 * 1024 * 1024, maxOperations: 32, waitMs: 2000 },
})
try {
  console.log(output.sdp()) // give this description to the receiver
  camera.start()
  for (let i = 0; i < 300; i++) {
    using frame = await camera.captureRequest()
    await recorder.writeAsync(frame)
  }
  await recorder.flushAsync()
  await recorder.drain()
} finally {
  await recorder.close()
}
```

The destination is a numeric IPv4 or IPv6 address. RTP and RTCP use distinct
ports, with RTCP defaulting to RTP+1. Dynamic payload types default to video 96
and audio 97. SSRC, sequence and RTP timestamp origins are randomized for each
session unless explicitly supplied. Explicit seeds are useful for deterministic
tests; receivers must treat an explicitly reused SSRC as a new session after BYE.
IPv4 multicast uses TTL 1 and an SDP connection TTL; multicast interfaces/groups
are not managed by this object, and external multicast acceptance remains open.
SDP has a separate random session ID and increasing session version, with an
anonymous loopback origin address. Obtain it
only after streams are prepared. AVC SPS/PPS and HEVC VPS/SPS/PPS are copied from
actual encoder headers. HEVC profile/tier/level and constraint signaling comes
from the bounded shared Home SPS-prefix reader, not an assumed level.

Add an `audio` destination, such as `{ port: 5006, rtcpPort: 5007 }`, and matching
Recorder `audio: { sampleRate: 48000, channels: 2 }` options for A/V. Both peers
must support MPEG4-GENERIC AAC-hbr. Audio accepts the standard AAC sample rates,
mono/stereo, raw access units, and 1024-sample frames. AAC-LC SDP configuration is
explicit; low-rate profiles use AAC Level 2, rates above 48 kHz use Level 5.
RTP transports codec padding in the final complete AU; it does not provide MP4's
sample-exact end edit list. Applications requiring exact gapless file duration
should use the existing MP4 output.

## Packet and clock contracts

`RtpOutput.format` is `packets-aac`. This explicitly selects a new native custom
output mode: video uses the existing header/repeat policy and audio is encoded
through Home's existing AAC boundary. Ordinary `packets` outputs keep receiving
S16LE PCM audio. `OutputStreams.audio.encoding === 'aac'` identifies the encoded
mode, and AAC packets use codec 5. A mismatched PCM packet is rejected.

AAC packet presentation times include the encoder's actual priming delay and may
be negative. They must retain their sign through packet handling and RTP clock
conversion. Video uses a 90 kHz clock; audio uses its sample rate. Both tracks
share one monotonic-to-Unix correlation, one CNAME, and compound RTCP SR + SDES.
Reports map the RTP and NTP timestamps at the same instant. Normal stop sends a
final compound report with BYE after codec tails and queued packets drain. A
receiver must use that correlation and retain required codec priming. Wire-clock
checks and synthetic PCM are not physical microphone/camera synchronization
measurements.

AVC emits single NAL packets or FU-A without interleaving. HEVC emits single NAL
or FU without DONL and advertises sprop-max-don-diff=0. AAC-hbr emits one raw AU
or fragment per packet with 13-bit full AU size and zero 3-bit index. The marker
bit appears only on the final packet of an AU. All fragments preserve SSRC,
timestamp and codec header fields; sequence numbers wrap at 16 bits.

The native `RtpPacketizer` is also exposed in Zig/C/Bun for caller-owned transports.
It copies and validates the entire AU before the first packet. Both Annex B and
four-byte length inputs are supported for video. Bounds are 16 owners, 64 MiB
combined owned storage, 16 MiB/AU, 4096 NALs and 65536 packets. AAC AUs are at most
8191 bytes. MTU includes the 12-byte RTP header, 64–65507 bytes. Size queries and
short destinations never advance or write a prefix. Borrowed Home packetizers
require immutable input through retirement; hosted cursors own their copy.

C callback flag 8 marks `timestamp_ns` as signed int64 presentation nanoseconds;
mailbox flag 16 similarly marks a negative signed source timestamp. Existing
unsigned packet modes retain their behavior. `rtpTimestamp` accepts signed priming
and unsigned positive nanoseconds and deliberately wraps the 32-bit wire clock.
`rtcpSenderReport` and `rtpHevcProfile` expose the same checked shared primitives.

## Bounds, backpressure and ownership

At most 16 RtpOutput sessions may be live, each owning two sockets per track.
The host OutputBridge bounds queued AUs; an output serializes one active copied
AU cursor and one reusable datagram buffer. Overlapping direct writes reject.
Every 32 accepted datagrams yields to the event loop. No list of all datagrams is
allocated for a frame. Successful socket send means local acceptance, without a
receiver delivery guarantee.

A false socket send retains the identical datagram until a writable notification,
error, cancellation or `sendTimeoutMs` deadline (default 2000, at most 60000 ms).
No application queue grows behind that wait. Direct packets must have monotonic
presentation time within each track; B-frame presentation reordering is not
implemented by this camera sender. A normal stop joins the active
write; discard/close wakes it and joins cursor/socket retirement. Close may
escalate an outstanding normal drain. Socket close failures retain ownership for
an explicit close retry. Stale callbacks cannot affect a subsequent session.
Factory-created sockets must be exclusively owned; simultaneous aliasing is
rejected. A supplied socketFactory supports other datagram transports and must
fulfil the same send, writable and joined close contract.

Encoder flush jobs emit every remaining AAC packet before normal output stop.
Failure isolation uses existing Recorder per-output policies; other sinks can
continue and a replacement RtpOutput can be prepared asynchronously. Circular
snapshots encode fresh AAC from the retained PCM interval with independent
priming and clocks. Ring frame limits are upper bounds; a live encoder may still
hold a frame, and GOP alignment can shorten retained history.

This is a managed RTP sender, not a complete RTSP/WebRTC or adaptive multiparty
session. RTCP receiver feedback, retransmission/congestion control, SSRC collision
negotiation, RTSP server/client workflows, SRTP, network pacing/reordering and
broader network output protocols remain parity work. Managed unicast loopback is
validated; physical Pi/LAN loss, throughput and audio/video acceptance remain
open. Users must choose receiver buffering and network capacity appropriate to
encoded bitrate and MTU.

References: [RTP/RTCP RFC 3550](https://www.rfc-editor.org/rfc/rfc3550.html),
[AVC RFC 6184](https://www.rfc-editor.org/rfc/rfc6184.html),
[HEVC RFC 7798](https://www.rfc-editor.org/rfc/rfc7798.html),
[AAC-hbr RFC 3640](https://www.rfc-editor.org/rfc/rfc3640.html), and
[Bun UDP](https://bun.com/docs/runtime/networking/udp).

Validation for 0.102: 529 native tests and nine C ABI programs pass locally;
1,657 Bun tests include actual IPv4/IPv6 UDP, independent receiver reconstruction,
OpenH264/libde265/FAAD2 decode, AAC waveform/priming alignment, queue deadlines,
joined cancellation, failed-close retries, late errors, recovery and circular A/V
snapshots. The minimal build has 521 passes and two explicit skips. Linux x86_64
and aarch64 real-backend Zig objects compile locally; CI retains actual system-STL
bridge compilation, load/no-camera smoke and standard builds. The local standard
build runner still fails linking macOS libSystem before project compilation;
target-qualified builds and all failure logs are retained.

A socketFactory must not wrap one underlying socket in multiple owners. Object
identity checks reject reusing the same returned socket object; hidden descriptor
aliasing inside caller-defined wrappers remains the factory's responsibility.

The 0.102.1 setup correction closes a newly opened default UDP socket when
multicast option setup fails before its owner is published. A deterministic
regression reproduces the leak against 0.102.0, then verifies joined cleanup.
