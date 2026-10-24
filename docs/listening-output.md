# Listening TCP outputs

Version 0.106 adds `ListeningSocketSink` and `ListeningSocketOutput`. Each
session binds a numeric IPv4/IPv6 endpoint, accepts one peer, and stops accepting
new connections. The accepted connection remains owned until joined retirement.
Use the raw output for JPEG/Annex B AVC/HEVC, or wrap the sink with
`MuxedOutput(sink, 'mkv' | 'fmp4')` for Home audio/video containers.

```ts
import { ListeningSocketOutput, Recorder } from '@zig-utils/camera'

const output = new ListeningSocketOutput({
  address: '127.0.0.1', port: 5000,
  acceptTimeoutMs: 15000, writeTimeoutMs: 2000,
})
// A consumer connects to this port while asynchronous preparation waits.
const recorder = await Recorder.open(output, {
  width: 1920, height: 1080, fps: 25, codec: 'h264',
})
// Submit camera frames with writeAsync, then close the recorder to flush,
// finish accepted bytes and join the peer and listener.
await recorder.close()
```

`port: 0` requests an ephemeral port. During preparation,
`sink.listenerStats().local` contains the immutable bound endpoint when available;
`listening` indicates readiness to accept. `accepted` and `peer` record the single
admitted peer, and `session` matches the shared transport generation. The endpoint
is retained as historical telemetry after closing; it does not mean the port is
still listening. A new session clears the old endpoints immediately. Closing a
pending sink directly cancels preparation, including an in-progress bind.

The accept deadline covers bind and waiting for a peer, defaults to 5 seconds,
and accepts values up to 60 seconds. One peer is admitted per recording segment;
there is no application queue of waiting clients or automatic midstream peer
replacement. The listener uses `maxConnections = 1` and a requested backlog of 1;
actual TCP handshake/backlog behavior is controlled by the OS. It is stopped on
first accept. Recover/split with another listener output to supply fresh media
headers and clocks to a replacement consumer. Factories can choose new ports;
a failed peer's owned listener/connection must retire before reusing its port.

Both dialing and accepted TCP use the same checked Home send cursor and bounded
socket adapter. There is one borrowed submitted write (maximum 16 MiB), one owned
runtime chunk, and the existing native mailbox/producer bounds. Listening,
dialing and process sinks share the 16 active/preparing-session budget. Chunk,
write and finish limits and counters are inherited from `TransportSink`; no new
media queue or camera-buffer owner is introduced. Normal stop drains and finishes;
discard cancels pending setup/write/flush and joins cleanup. A peer may half-close
its sending side while receiving media. Incoming bytes are drained and discarded;
this output is not a bidirectional application protocol.

Listener close and connection close are distinct: stopping acceptance does not
wait for the live consumer before returning a usable output. Final retirement
joins both. If cancellation occurs before bind completes, cleanup waits for the
bind/error event before closing the server, avoiding a late live port after an
early `ERR_SERVER_NOT_RUNNING` result. Session telemetry and callbacks do not
retain a previous peer as the next session begins.

The implementation follows the pinned Bun 1.4.3 runtime and its
[`net.Server.close`](https://bun.com/reference/node/net/Server/close) and
[`maxConnections`](https://bun.com/reference/node/net/Server/maxConnections)
contracts. Home's kernel/network stacks are separate owners; see the reuse audits.
Python, FFmpeg, a media subprocess and OS-source imports are not used.

Validation covers IPv4/IPv6, byte-exact partial chunks, half-close, competing
clients, bind errors, accept/write deadlines, repeated pre-bind cancellation,
blocked-write discard, reuse and global admission. Actual recorder tests verify
raw codec bytes/shared PTS, decoded AVC/HEVC/AAC fMP4 before retirement, timestamped
PCM Matroska, async splits and isolated recovery after a reset peer. Arbitrary
borrowed socket adoption, multiple consumers, TLS/DNS/Unix sockets, session
protocols, physical Pi/LAN validation and matched performance remain open.
