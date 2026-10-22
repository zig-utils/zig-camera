import { expect, test } from 'bun:test'
import {
  Camera,
  CameraError,
  CameraDisconnectedError,
  Control,
  Recorder,
  getTuningState,
  type Frame,
  type MappedStream,
} from '../../ts'
import { native as n } from '../../ts/ffi'
const cam = () =>
  new Camera({
    simulate: true,
    writable: true,
    width: 16,
    height: 16,
    buffers: 2,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    lores: { width: 8, height: 8, rgb: true },
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw Error('device loss deadline')
    await Bun.sleep(1)
  }
}
test('device loss before start is terminal and async observation is distinct from stopping', async () => {
  const c = cam()
  try {
    expect(c.deviceState()).toMatchObject({
      connected: true,
      running: false,
      leased: 0,
      status: 0,
    })
    const wait = c.waitDisconnected()
    c.simulateDisconnect()
    const state = await wait
    expect(state).toMatchObject({
      connected: false,
      running: false,
      leased: 0,
      ready: 0,
      status: -11,
      disconnectEvent: 0n,
    })
    expect(Object.isFrozen(state)).toBe(true)
    expect(() => c.start()).toThrow(CameraDisconnectedError)
    expect(() => c.acquire()).toThrow(CameraDisconnectedError)
    await c.stop()
    expect(c.deviceState().connected).toBe(false)
    expect(await c.waitDisconnected()).toEqual(state)
  } finally {
    await c.close()
  }
})
test('completed raw main lores and metadata leases remain readable and cannot be requeued', async () => {
  const c = cam()
  let frame: Frame | undefined, retained: Frame | undefined
  try {
    c.start()
    frame = c.acquire()
    retained = frame.retain()
    const bundle = frame.copyStreams(['main', 'raw', 'lores']),
      metadata = frame.metadata()
    const event = c.stats().completed
    c.simulateDisconnect()
    c.simulateDisconnect()
    expect(frame.copyStreams(['main', 'raw', 'lores'])).toEqual(bundle)
    expect(retained.metadata()).toEqual(metadata)
    expect(c.deviceState()).toMatchObject({
      connected: false,
      leased: 1,
      disconnectEvent: event,
    })
    expect(c.stats().errors).toBe(1n)
    frame.release()
    frame = undefined
    await expect(c.close()).rejects.toMatchObject({ code: -4 })
    retained.release()
    retained = undefined
    expect(c.stats().completed).toBe(event)
    expect(() => c.switchMode({ width: 32, height: 24 })).toThrow(
      CameraDisconnectedError,
    )
  } finally {
    frame?.release()
    retained?.release()
    await c.close()
  }
})
test('mapped owners survive device loss and source release until joined close', async () => {
  const c = cam()
  let frame: Frame | undefined, map: MappedStream | undefined
  try {
    c.start()
    frame = c.acquire()
    map = frame.mapStream()
    const row = map.row(0),
      first = row[0]
    c.simulateDisconnect()
    frame.release()
    frame = undefined
    expect(row[0]).toBe(first)
    await expect(c.close()).rejects.toMatchObject({ code: -4 })
    expect(c.deviceState().leased).toBe(1)
    map.close()
    map = undefined
    expect(row.length).toBe(0)
    expect(c.deviceState().leased).toBe(0)
  } finally {
    map?.close()
    frame?.release()
    await c.close()
  }
})
test('pending capture jobs fail promptly with typed device loss instead of their timeout', async () => {
  const c = cam()
  try {
    const job = c.captureMetadataAsync({
      dropFrames: 1_000_000,
      timeoutMs: 5000,
    })
    await until(() => job.state === 'running')
    c.simulateDisconnect()
    const error = await failure(job)
    expect(error).toBeInstanceOf(CameraDisconnectedError)
    expect(error).toMatchObject({ code: -11 })
    expect(c.deviceError).toBeInstanceOf(CameraDisconnectedError)
    expect(c.stats().leased).toBe(0)
    expect(() => c.start()).toThrow(CameraDisconnectedError)
  } finally {
    await c.close()
  }
})
test('32 lifecycle jobs share a poll and independent cancellation does not consume the loss event', async () => {
  const c = cam()
  const original = n.zc_wait_disconnected
  let calls = 0
  const mutable = n as unknown as {
    zc_wait_disconnected: (...args: Parameters<typeof original>) => number
  }
  mutable.zc_wait_disconnected = (...args) => {
    calls++
    return original(...args)
  }
  try {
    const jobs = Array.from({ length: 32 }, () => c.waitDisconnected())
    expect(() => c.waitDisconnected()).toThrow('queue')
    await Bun.sleep(12)
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThan(32)
    jobs[0].cancel(Error('only this subscriber'))
    c.simulateDisconnect()
    expect(await failure(jobs[0])).toMatchObject({
      message: 'only this subscriber',
    })
    const states = await Promise.all(
      jobs.slice(1).map((job) => Promise.resolve(job)),
    )
    expect(
      states.every((state) => !state.connected && state.status === -11),
    ).toBe(true)
    expect(await c.waitDisconnected()).toMatchObject({ connected: false })
  } finally {
    mutable.zc_wait_disconnected = original
    await c.close()
  }
})
test('observation survives stop and mode reopen but close cancels and joins pending observers', async () => {
  const c = cam()
  const wait = c.waitDisconnected()
  c.start()
  await c.stop()
  expect(wait.done).toBe(false)
  await c.switchMode({ width: 32, height: 24 })
  expect(wait.done).toBe(false)
  await c.close()
  expect(wait.done).toBe(true)
  expect(await failure(wait)).toMatchObject({ code: -2 })
  expect(() => c.deviceState()).toThrow(CameraError)
})
test('observation options own cancellation deadlines and caller reentry before native access', async () => {
  const c = cam()
  try {
    const controller = new AbortController()
    controller.abort(Error('pre-aborted'))
    expect(
      await failure(c.waitDisconnected({ signal: controller.signal })),
    ).toMatchObject({ message: 'pre-aborted' })
    expect(await failure(c.waitDisconnected({ timeoutMs: 0 }))).toMatchObject({
      code: -3,
    })
    expect(c.deviceState().connected).toBe(true)
    const job = c.waitDisconnected()
    job.cancel(Error('manual cancel'))
    expect(await failure(job)).toMatchObject({ message: 'manual cancel' })
  } finally {
    await c.close()
  }
})
test('autofocus jobs retire their control ownership after a disconnection', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync({ timeoutMs: 5000 })
    await until(() => focus.state === 'running')
    c.simulateDisconnect()
    const error = await failure(focus)
    expect(error).toMatchObject({ code: -11 })
    expect(() =>
      c.setControls([{ id: Control.brightness, type: 'float', values: [0.1] }]),
    ).toThrow(CameraDisconnectedError)
    expect(c.deviceState().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('a reentrant options getter cannot query a camera after initiating close', async () => {
  const c = cam()
  let closing: Promise<void> | undefined,
    reads = 0
  try {
    expect(() =>
      c.waitDisconnected({
        get timeoutMs() {
          reads++
          closing = c.close()
          return 5000
        },
      }),
    ).toThrow(CameraError)
    expect(reads).toBe(1)
  } finally {
    await closing
    await c.close()
  }
})
test('preview and multiple encoder producers stop on loss while recorder cleanup remains joined', async () => {
  const c = cam()
  const a = await Recorder.open(
      { outputframe() {} },
      { width: 16, height: 16, asyncWrites: true },
    ),
    b = await Recorder.open(
      { outputframe() {} },
      { width: 8, height: 8, stream: 'lores', asyncWrites: true },
    )
  try {
    c.startPreview({ backend: 'headless' })
    const first = c.startRecording(a),
      second = c.startRecording(b)
    await until(() => first.frames > 0 && second.frames > 0)
    c.simulateDisconnect()
    await until(() => c.activeRecordings.length === 0)
    expect(first.error).toMatchObject({ code: -11 })
    expect(second.error).toMatchObject({ code: -11 })
    expect(c.previewInfo()).toMatchObject({
      backend: 'headless',
      suspended: true,
    })
    expect(c.deviceError).toBeInstanceOf(CameraDisconnectedError)
  } finally {
    const outcomes = await Promise.allSettled([c.close(), a.close(), b.close()])
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({ code: -11 })
    expect(Number(c.handle)).toBe(0)
  }
})
test('tuning reservations remain owned across loss and retire only after camera teardown', async () => {
  const c = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: '{"one":1}',
  })
  try {
    c.start()
    c.simulateDisconnect()
    expect(getTuningState({ simulate: true })).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
  } finally {
    await c.close()
  }
  expect(getTuningState({ simulate: true })).toMatchObject({
    custom: false,
    sessionUsers: 0,
    managerUsers: 0,
  })
})
test('focus-locked capture reports loss and restoration failure without retaining a request', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const job = c.captureFocusLockedMetadata({
      dropFrames: 1_000_000,
      timeoutMs: 5000,
    })
    await until(() => job.state === 'running')
    c.simulateDisconnect()
    const error = await failure(job)
    const errors = error instanceof AggregateError ? error.errors : [error]
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((item) => item?.code === -11)).toBe(true)
    expect(c.deviceState().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('mode workers preserve a reported target loss even after restoring a healthy source handle', async () => {
  const c = cam(),
    original = n.zc_frame_map_open
  const mutable = n as unknown as {
    zc_frame_map_open: (...args: Parameters<typeof original>) => number
  }
  let injected = false
  try {
    mutable.zc_frame_map_open = (...args) => {
      if (!injected) {
        injected = true
        expect(n.zc_simulate_disconnect(args[0])).toBe(0)
      }
      return original(...args)
    }
    c.preCallback = (request) => request.withMappedStream(() => {})
    const observed = c.waitDisconnected()
    c.start()
    const error = await failure(
      c.switchModeAndCaptureRGB({ width: 32, height: 24 }, { dropFrames: 1 }),
    )
    expect(injected).toBe(true)
    expect(error).toMatchObject({ code: -11 })
    expect(await observed).toMatchObject({ connected: false, status: -11 })
    expect(c.deviceState().connected).toBe(true)
    expect(c.info().width).toBe(16)
    c.preCallback = undefined
    expect((await c.captureMetadata()).eventId).toBeGreaterThan(0n)
  } finally {
    mutable.zc_frame_map_open = original
    await c.close()
  }
})
