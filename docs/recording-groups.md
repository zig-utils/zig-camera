# Coordinated recording group mode jobs

`Camera.switchRecordingsModeAsync(options, members, jobOptions)` switches the
camera and every active encoder under one shared media publication decision.
Supply each active Recording exactly once, with one to eight members. Pending
camera capture/mode work, live frame leases and conflicting recorder work reject.
An idle recorder cannot be added through this operation.

For device loss, [reconnectRecordingsAsync](reconnection.md) uses the shared
publication gate to recover into a separate camera owner, keeping old retained
frames valid and preserving shared microphone history. It also restores the
admitted preview and owned overlay unless opted out.

```ts
const next = await camera.switchRecordingsModeAsync(
  { width: 1920, height: 1080, role: 'video',
    lores: { width: 640, height: 360 } },
  [
    { recording: archive, output: 'archive-next.mp4',
      settings: { codec: 'h265', fps: 25 } },
    { recording: preview, output: previewOutput,
      settings: { stream: 'lores', fps: 25 }, backpressure: 'drop' },
  ],
  { timeoutMs: 10000 },
)
// Returned members preserve the order of the supplied array.
```

Member settings merge with that recorder's previous media settings. Omitted
width/height adapt to the selected stream's negotiated geometry; explicit sizes
must match. Main and lores may be exchanged. The camera identity/backend stays
fixed. Settings, geometry, source format and output paths are checked before
reservation. Native negotiation validates the actual target before codec setup.
The usual runtime-control replay, autofocus policy, optional fresh autofocus,
dropFrames and preview restoration apply to the single shared camera switch.

An omitted audio field preserves the member's current AudioCapture when audio
remains enabled in its proposed settings. Pass null to detach it or another
AudioCapture to replace it. Consumers sharing a microphone must have equal
recording FPS; separate microphones may use distinct cadences. Omitted/null output
means no primary output for the new session. Pass a fresh path or custom output
explicitly; finalized files are not implicitly appended.

## Preparation and publication

The job reserves every recorder and holds each old shared microphone in native
code. It waits cancellably for copied producers, reserves every flush job before
detaching any old Recording, then joins all terminal codec/output drains. Flush
admission failure leaves the old set active. Once flushing begins, accepted bytes
and terminal codec tails cannot be undone; later failure leaves all old members
stopped with their old settings rather than resuming finalized codecs.

The camera reopens once. Every candidate codec, container, output header and host
start hook must be ready before publication. Every new capture/audio owner is
reserved first. Native code locks recorder owners in stable order, validates all
candidates, and sets every irrevocable commit flag before releasing any lock.
Workers install prepared sessions independently; Bun joins all and installs all
public recorder settings and camera configuration in one synchronous barrier.
Old output retirement hooks run after that barrier. New Recording objects become
visible together after the hooks finish. No user callback observes sequential
installation of individual recorder settings.

A held microphone retains its capture claim, bounded PCM history and future input
block while consumers retire. The synthetic offered-frame epoch rebases at the
last completed sample-window cut when FPS changes. Existing sample phase is
preserved, including nonaligned 44.1 kHz block boundaries. New consumers receive
fresh IDs; an old Recording cannot detach its replacement. Holds are released
once cleanup finishes. If no replacement uses an old source, its last hold closes
it. A new caller source stays open and unconsumed if publication fails.

## Cancellation, errors and limits

Before publication, cancellation cancels and joins every prepared child, discards
candidate outputs and restores the camera, controls and preview. Exclusive newly
created files are removed using the existing identity-safe cleanup. Arbitrary
host hooks and filesystem writes are not transactional. A hook that does not
settle can delay cancellation or close.

After publication the group is uncancellable. Cleanup/retirement errors may reject
the job while every new session remains installed. Such errors carry
`published: true` and `recordings` with the replacement set. Camera/recorder
close joins the published job and retires reserved owners instead of exposing a
partially attached group. Subsequent runtime I/O failures retain normal
per-recorder/output isolation.

Existing producer byte/count limits persist across reconfiguration. Provision for
the largest target pixels and audio catch-up burst. A successful switch cannot
guarantee later input admission, output delivery or physical A/V synchronization.
Native C callers of `zc_producer_jobs_restart_publish` must join every job before
accessing media state. Audio holds are bounded to eight, use nonreused IDs and must
all be released before native fan-out close. ABI v1 layouts remain unchanged.

Tests cover eight encoders, all-member validation, admission/cancellation rollback,
held hooks and close races, shared/replaced microphones, fractional PCM cuts,
main/lores exchange, AVC/HEVC changes and independently decoded AAC MP4 segments.
No Pi camera/microphone is attached; physical drift, switching latency and sustained
throughput remain hardware acceptance work.
