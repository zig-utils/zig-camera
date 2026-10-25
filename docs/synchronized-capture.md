# Timestamp-matched multi-camera capture

`Camera.captureSynchronizedRequestsAsync(cameras, options)` returns a joined
`BunJob<SynchronizedFrames>`. `captureSynchronizedRequests` waits for the result.
Supply two through eight distinct cameras on one host, using the same backend.
The cameras keep their normal request pumps, callbacks, preview and recordings.

```ts
const left = new Camera({ cameraIndex: 0 })
const right = new Camera({ cameraIndex: 1 })
try {
  left.setSynchronization('server', { frames: 60 })
  right.setSynchronization('client')
  using result = await Camera.captureSynchronizedRequests([left, right], {
    maxSkewNs: 1_000_000n,
    timeoutMs: 5000,
  })
  const images = result.frames.map(frame => frame.copyRGB())
  // Result order follows the camera list. These copies survive release.
} finally {
  await Promise.all([left.close(), right.close()])
}
```

Every candidate requires request-local `SyncReady` by default. Configure the
backend's server/client controls before admission. `syncReady: false` explicitly
allows timestamp matching without backend readiness; it does not synchronize
sensors. Missing readiness waits, while missing SensorTimestamp fails explicitly.
All candidates must have nondecreasing sensor timestamps and strictly increasing
per-camera completion identities. The matcher compares actual first-pixel
SensorTimestamp values, including a valid zero, rather than delivery timestamps
or signed SyncTimer. It rejects mixed native/virtual backend clock domains.
Real SensorTimestamp values use the host boot clock; the virtual backend uses
the clock reported by `captureClockNs`. External hosts/clock translation are
outside this API.

The inclusive `maxSkewNs` defaults to 1 ms and accepts unsigned 64-bit values.
This bounds the span of first-pixel times. It does not establish exposure overlap,
physical sensor synchronization or image quality. `flush` defaults to one clock
threshold captured at group admission, shared by every member. Existing exposure
freshness filtering applies to that threshold. `false` disables freshness or a
bigint supplies an explicit threshold. `dropFrames` applies separately before
each camera's first candidate; it is not repeated during matching.

Home's allocation-free frame_match policy holds no pointers or frames. Camera
keeps one retained candidate per member and asks the policy which candidates are
strictly too old to match the newest timestamp. It releases those candidates
before requesting replacements and preserves newer candidates. The independent
C reference checks 28,672 full-width tuples; Home tests compare streamed matching
against exhaustive small-stream tuple existence. Neither proves hardware timing.

`maxFrames` bounds qualifying candidate acquisitions across all cameras, from
the number of members through 65,536 (default 4,096). The result's
`candidateCount` includes replacements, excluding requests rejected by readiness,
drop or freshness filters. The single group deadline also bounds those filters.
A frame limit or deadline returns an error after all child jobs and held owners
have joined cleanup.

Admission snapshots application options and the bounded camera list before
reserving all members. It rejects active capture, AF, mode, preview-transition,
capture-series or recovery jobs. Ordinary captures, direct acquisition, control
changes and mode transitions are blocked during matching. Stop/close of either
member cancels the entire unpublished group and joins every child before native
camera retirement. Each camera admits at most 32 pending/callback owners.
Callbacks and existing recording/preview consumers still use the shared pump.

A published result owns its `frames` in input order, frozen timestamp snapshots,
`earliestNs`, `latestNs` and `skewNs`. Each frame supports its normal main/raw/lores,
metadata, maps and retain methods. `release`/`Symbol.dispose` release all members;
independently retained frame tokens remain owned by their callers. Publication
seals cancellation before transferring these owners. `Frame.closed` reports
whether that frame wrapper's token has been consumed, independently of camera
start/stop state.

A failed native release is never hidden. `SynchronizedCaptureCleanupError.errors`
retains release failures plus a preceding capture failure when applicable.
`unreleasedFrames` contains wrappers whose tokens remain unconsumed (for example,
a busy native borrow), and `retryCleanup()` retries all of them. Consumed-token
I/O errors remain reported; native camera cleanup still owns quarantined storage.
Published result cleanup may be retried as well. Resolve outstanding maps/owners
and retry camera cleanup through the existing APIs.

This implements bounded software grouping and retained ownership. Cross-camera
physical timing, clocks on each target sensor, sustained multi-camera pipelines
and remaining Picamera2 capability families still require acceptance evidence.
