import { expect, test } from 'bun:test'
import { Camera, Recorder, Frame, captureClockNs } from '../../ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const cam = () =>
  new Camera({
    simulate: true,
    width: 32,
    height: 24,
    buffers: 3,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    lores: { width: 16, height: 12 },
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const guardedTimestamp = (m: Awaited<ReturnType<Camera['captureMetadata']>>) =>
  m.timestampNs - BigInt(m.exposureUs) * 1000n

test('capture frame-drop filters preserve exact FIFO selection and independent queued jobs', async () => {
  const c = cam()
  try {
    const a = c.captureMetadataAsync({ dropFrames: 3 }),
      b = c.captureMetadataAsync({ dropFrames: 1 })
    expect((await a).sequence).toBe(3n)
    expect((await b).sequence).toBe(5n)
    expect(c.stats().leased).toBe(0)
    expect((await c.captureMetadata()).sequence).toBe(6n)
  } finally {
    await c.close()
  }
})
test('dropFrames consumes exactly N delivered requests and zero does not start or acquire', async () => {
  const c = cam()
  try {
    await c.dropFrames(0)
    expect(c.stats().completed).toBe(0n)
    expect(c.stats().delivered).toBe(0n)
    await c.dropFrames(3)
    expect(c.stats().delivered).toBe(3n)
    using request = await c.captureRequest()
    expect(request.sequence).toBe(3n)
  } finally {
    await c.close()
  }
})
test('fresh capture compares the conservative exposure boundary to a matching clock sampled at admission', async () => {
  const c = cam()
  try {
    c.start()
    const before = captureClockNs()
    const m = await c.captureMetadata({ flush: true })
    expect(m.validMask & 80).toBe(80)
    expect(guardedTimestamp(m)).toBeGreaterThanOrEqual(before)
    expect(m.sequence).toBeGreaterThan(0n)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('explicit timestamp thresholds compose with frame dropping and preserve exact bigint limits', async () => {
  const c = cam()
  try {
    const threshold = captureClockNs() + 5_000_000n
    using request = await c.captureRequest({ flush: threshold, dropFrames: 2 })
    expect(guardedTimestamp(request.metadata())).toBeGreaterThanOrEqual(
      threshold,
    )
    expect(request.sequence).toBeGreaterThanOrEqual(2n)
    request.release()
    const impossible = c.captureRequestAsync({
      flush: 0xffffffffffffffffn,
      timeoutMs: 10,
    })
    expect(await failure(impossible)).toMatchObject({ code: -3 })
    await impossible.operationDone
    expect(c.stats().leased).toBe(0)
    using next = await c.captureRequest({ flush: false })
    expect(next.token).not.toBe(0n)
  } finally {
    await c.close()
  }
})
test('flush false preserves queued frames while options are captured once before mutation', async () => {
  const c = cam()
  try {
    c.start()
    const first = await c.captureMetadata({ flush: false })
    expect(first.sequence).toBe(0n)
    const options = { dropFrames: 4, flush: false }
    const job = c.captureMetadataAsync(options)
    options.dropFrames = 0
    options.flush = true
    expect((await job).sequence).toBe(5n)
  } finally {
    await c.close()
  }
})
test('cancelled or expired barriers release all private work and do not starve the following capture', async () => {
  const c = cam()
  try {
    const first = c.captureRequestAsync({ flush: 0xffffffffffffffffn }),
      second = c.captureMetadataAsync({ dropFrames: 1 })
    await Bun.sleep(3)
    first.cancel(Error('cancel barrier'))
    expect(await failure(first)).toMatchObject({ message: 'cancel barrier' })
    await first.operationDone
    expect((await second).sequence).toBeGreaterThan(0n)
    expect(c.stats().leased).toBe(0)
    const expired = c.captureRGBAsync({ dropFrames: 100, timeoutMs: 0 })
    expect(await failure(expired)).toMatchObject({ code: -3 })
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('held caller requests remain readable when a barrier times out under physical buffer pressure', async () => {
  const c = cam(),
    held: Frame[] = []
  try {
    for (let i = 0; i < 3; i++) held.push(await c.captureRequest())
    const old = held.map((frame) => frame.metadata())
    expect(
      await failure(c.captureMetadata({ flush: true, timeoutMs: 10 })),
    ).toMatchObject({ code: -3 })
    expect(c.stats().leased).toBe(3)
    expect(held.map((frame) => frame.metadata())).toEqual(old)
    held.shift()!.release()
    await c.captureMetadata({ flush: true })
    expect(c.stats().leased).toBe(2)
  } finally {
    for (const frame of held) frame.release()
    await c.close()
  }
})
test('frame barriers preserve recording delivery and the shared asynchronous producer', async () => {
  const c = cam(),
    recorder = new Recorder(null, { width: 32, height: 24 })
  try {
    const recording = c.startRecording(recorder)
    const before = recording.frames
    await c.captureMetadata({ dropFrames: 8 })
    expect(recording.frames - before).toBeGreaterThanOrEqual(9)
    await c.captureRGB({ flush: true })
    expect(recording.error).toBeUndefined()
    expect(c.stats().leased).toBe(0)
    await recording.flushAsync()
  } finally {
    await c.close()
    await recorder.close()
  }
})
test('focus-locked capture composes fresh timing and drops only after pause validation, then restores CAF', async () => {
  const c = cam()
  try {
    c.startContinuousAutofocus()
    const threshold = captureClockNs()
    const m = await c.captureFocusLockedMetadata({
      flush: threshold,
      dropFrames: 2,
    })
    expect(m.afState).toBe(2)
    expect(m.afPauseState).toBe(2)
    expect(guardedTimestamp(m)).toBeGreaterThanOrEqual(threshold)
    expect(await c.autofocusResumeAsync()).toBe(3)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('paired streams, raw/lores buffers, files and RGB helpers share native selection', async () => {
  const c = cam(),
    directory = mkdtempSync(join(tmpdir(), 'camera-barriers-'))
  try {
    const streams = await c.captureStreams(['main', 'raw', 'lores'], {
      dropFrames: 2,
    })
    expect(streams.metadata.sequence).toBe(2n)
    expect(streams.streams.lores!.data.length).toBe((16 * 12 * 3) / 2)
    expect(
      (await c.captureBuffer('lores', { dropFrames: 1 })).data.length,
    ).toBe((16 * 12 * 3) / 2)
    expect((await c.captureRGB({ dropFrames: 1 })).length).toBe(32 * 24 * 3)
    const threshold = captureClockNs()
    const m = await c.captureFile(join(directory, 'fresh.dng'), {
      flush: threshold,
      dropFrames: 1,
    })
    expect(guardedTimestamp(m)).toBeGreaterThanOrEqual(threshold)
  } finally {
    await c.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test('invalid thresholds, counts and admission side effects cannot start unsafe capture work', async () => {
  const c = cam()
  let switchJob: ReturnType<Camera['switchMode']> | undefined
  try {
    for (const dropFrames of [-1, 1.5, NaN, 0x100000000])
      expect(() => c.captureMetadataAsync({ dropFrames })).toThrow(RangeError)
    for (const flush of [-1n, 0x10000000000000000n, 1 as unknown as boolean])
      expect(() => c.captureRequestAsync({ flush })).toThrow(RangeError)
    expect(() =>
      c.captureMetadataAsync({
        get flush() {
          switchJob = c.switchMode({ width: 64, height: 48 })
          return true
        },
      }),
    ).toThrow()
    await switchJob
    expect(c.info().width).toBe(64)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
