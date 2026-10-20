import { native as ffi } from '../../ts/ffi'
const native: {
  zc_acquire: (...args: Parameters<typeof ffi.zc_acquire>) => number
  zc_release: (...args: Parameters<typeof ffi.zc_release>) => number
} = ffi
import { expect, test } from 'bun:test'
import { Camera, Recorder, Frame, JobCancelledError } from '../../ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cam = () =>
  new Camera({
    simulate: true,
    width: 34,
    height: 18,
    buffers: 3,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    lores: { width: 16, height: 8 },
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > deadline) throw Error('timeout')
    await pause()
  }
}
test('a retained completed request outlives its pump reference and siblings have independent tokens', async () => {
  const c = cam()
  let parent: Frame | undefined, child: Frame | undefined
  try {
    parent = await c.captureRequestAsync()
    expect(parent.referenceCount).toBe(1)
    child = parent.retain()
    const token = child.token,
      metadata = child.metadata(),
      pixels = child.copyRGB()
    expect(parent.referenceCount).toBe(2)
    expect(child.token).not.toBe(parent.token)
    expect(child.sequence).toBe(parent.sequence)
    parent.release()
    parent.release()
    expect(() => parent!.metadata()).toThrow('released')
    expect(child.referenceCount).toBe(1)
    for (let i = 0; i < 10; i++) await c.captureMetadata()
    expect(child.token).toBe(token)
    expect(child.metadata()).toEqual(metadata)
    expect(child.copyRGB()).toEqual(pixels)
    expect(c.stats().leased).toBe(1)
    child.release()
    expect(c.stats().leased).toBe(0)
  } finally {
    parent?.release()
    child?.release()
    await c.close()
  }
})
test('retained stopped requests remain readable and close/restart wait for every reference', async () => {
  const c = cam()
  const parent = await c.captureRequest(),
    child = parent.retain()
  try {
    await c.stop()
    parent.release()
    expect(child.copyRGB().length).toBe(34 * 18 * 3)
    expect(child.metadata().sequence).toBe(child.sequence)
    expect(() => c.start()).toThrow()
    expect(await failure(c.close())).toMatchObject({ code: -4 })
    expect(child.referenceCount).toBe(1)
    child.release()
    c.start()
    expect((await c.captureMetadata()).sequence).toBeGreaterThan(child.sequence)
  } finally {
    parent.release()
    child.release()
    await c.close()
  }
})
test('one physical buffer can have many references without starving primary references of other buffers', async () => {
  const c = cam(),
    refs: Frame[] = []
  try {
    const first = await c.captureRequest()
    refs.push(first)
    while (true) {
      try {
        refs.push(first.retain())
      } catch (error) {
        expect(error).toMatchObject({ code: -4 })
        break
      }
    }
    expect(refs.length).toBe(254)
    expect(first.referenceCount).toBe(254)
    expect(c.stats().leased).toBe(1)
    const next = await c.captureRequest()
    expect(next.sequence).not.toBe(first.sequence)
    expect(c.stats().leased).toBe(2)
    next.release()
    for (const ref of refs) ref.release()
    expect(c.stats().leased).toBe(0)
  } finally {
    for (const ref of refs) ref.release()
    await c.close()
  }
})
test('bounded completed requests backpressure the camera until released and expired jobs do not leak refs', async () => {
  const c = cam(),
    refs: Frame[] = []
  try {
    for (let i = 0; i < 3; i++) refs.push(await c.captureRequest())
    const timed = c.captureRequestAsync({ timeoutMs: 5 })
    expect(await failure(timed)).toMatchObject({ code: -3 })
    expect(c.stats().leased).toBe(3)
    refs[0].release()
    const next = await c.captureRequest()
    expect(c.stats().leased).toBe(3)
    next.release()
  } finally {
    for (const ref of refs) ref.release()
    await c.close()
  }
})
test('multi-stream captures own main/raw/lores from one request and omit row padding', async () => {
  const c = cam()
  try {
    const streams = ['main', 'raw', 'lores'] as const
    const result = await c.captureStreamsAsync(streams)
    expect(result.streams.main).toMatchObject({
      width: 34,
      height: 18,
      rowBytes: 102,
      format: 'BGR888',
    })
    expect(result.streams.raw).toMatchObject({
      width: 34,
      height: 18,
      rowBytes: 68,
      format: 'SRGGB12',
    })
    expect(result.streams.lores).toMatchObject({
      width: 16,
      height: 8,
      rowBytes: 16,
      format: 'YUV420',
    })
    expect(result.streams.main!.data.length).toBe(1836)
    expect(result.streams.raw!.data.length).toBe(1224)
    expect(result.streams.lores!.data.length).toBe(192)
    expect(result.metadata.sequence).toBe(0n)
    const raw = result.streams.raw!.data.slice()
    for (let i = 0; i < 8; i++) await c.captureRGB()
    expect(result.streams.raw!.data).toEqual(raw)
    expect(c.stats().leased).toBe(0)
    expect(() => c.captureStreamsAsync(['main', 'main'])).toThrow(RangeError)
    expect(() => c.captureStreamsAsync([])).toThrow(RangeError)
  } finally {
    await c.close()
  }
})
test('retained requests preserve JPEG/DNG access and raw buffers after parent release', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-retained-'))
  const parent = await c.captureRequest(),
    child = parent.retain()
  try {
    parent.release()
    const bundle = child.copyStreams(['main', 'raw', 'lores'])
    expect(bundle.metadata.sequence).toBe(child.sequence)
    for (const ext of ['jpg', 'dng']) {
      const path = join(dir, `child.${ext}`)
      if (ext === 'jpg') child.saveJPEG(path)
      else child.saveDNG(path)
      expect(readFileSync(path).length).toBeGreaterThan(100)
    }
  } finally {
    parent.release()
    child.release()
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('ordinary single-stream and file helpers capture the current mode without a mode switch', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-capture-'))
  try {
    expect((await c.captureBuffer('raw')).data.length).toBe(1224)
    expect((await c.captureBufferAsync('lores')).data.length).toBe(192)
    expect((await c.captureRGBAsync()).length).toBe(1836)
    expect((await c.captureMetadataAsync()).sequence).toBeGreaterThan(0n)
    for (const extension of ['jpg', 'dng']) {
      const path = join(dir, `capture.${extension}`),
        metadata = await c.captureFileAsync(path)
      expect(metadata.sequence).toBeGreaterThan(0n)
      expect(readFileSync(path).length).toBeGreaterThan(100)
    }
    expect(c.info().width).toBe(34)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('temporary raw capture uses the shared native sizing and packing path', async () => {
  const c = cam()
  try {
    const result = await c.switchModeAndCaptureBuffer(
      { width: 66, height: 34, raw: true, unpackedRaw: true },
      'raw',
    )
    expect(result).toMatchObject({ width: 66, height: 34, format: 'SRGGB12' })
    expect(result.data.length).toBe(66 * 34 * 2)
    expect(c.info().width).toBe(34)
  } finally {
    await c.close()
  }
})
test('cancellable capture jobs reject async borrowed callbacks and preserve later requests', async () => {
  const c = cam()
  try {
    const cancelled = c.captureAsync((frame) => frame.sequence),
      result = failure(cancelled)
    expect(cancelled.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(
      await failure(
        c.captureAsync(async (frame) => {
          await pause()
          return frame.metadata()
        }),
      ),
    ).toBeInstanceOf(TypeError)
    expect((await c.captureMetadataAsync()).sequence).toBeGreaterThan(0n)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('mode changes reject retained requests until final release and stop cancels queued capture jobs', async () => {
  const c = cam()
  const request = await c.captureRequest(),
    child = request.retain()
  try {
    request.release()
    expect(
      await failure(c.switchMode({ width: 66, height: 34 })),
    ).toMatchObject({ code: -4 })
    child.release()
    await c.switchMode({ width: 66, height: 34 })
    const pending = c.captureRequestAsync(),
      result = failure(pending)
    await c.stop()
    expect(await result).toMatchObject({ code: -2 })
    expect(c.stats().leased).toBe(0)
  } finally {
    request.release()
    child.release()
    await c.close()
  }
})
test('retained request capture shares the recording frame and seals its ownership handoff', async () => {
  const c = new Camera({ simulate: true, width: 64, height: 48, fifo: true }),
    r = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    )
  let request: Frame | undefined
  try {
    const recording = c.startRecording(r)
    await until(() => recording.frames > 1)
    const job = c.captureRequestAsync()
    request = await job
    expect(job.cancel()).toBe(false)
    expect(request.referenceCount).toBe(1)
    const captured = request.metadata()
    await until(() => recording.frames > 5)
    expect(request.metadata()).toEqual(captured)
    request.release()
    await recording.flushAsync()
    expect(recording.error).toBeUndefined()
    expect(BigInt(recording.frames)).toBe(c.stats().delivered)
  } finally {
    request?.release()
    await c.close()
    await r.close()
  }
})
test('pre-aborted and invalid deadline capture jobs do not start a stopped camera', async () => {
  const c = cam(),
    controller = new AbortController()
  try {
    controller.abort(Error('already aborted'))
    expect(
      await failure(c.captureRequestAsync({ signal: controller.signal })),
    ).toBe(controller.signal.reason)
    expect(
      await failure(c.captureRequestAsync({ timeoutMs: 0 })),
    ).toMatchObject({ code: -3 })
    expect(() => c.captureRequestAsync({ timeoutMs: NaN })).toThrow(RangeError)
    expect(() => c.acquire()).toThrow()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})

test('abort between native acquire and ownership publication retires the transferred request', async () => {
  const c = cam(),
    controller = new AbortController()
  const original = native.zc_acquire
  const reason = Error('abort at handoff')
  try {
    native.zc_acquire = (...args: Parameters<typeof original>) => {
      const rc = original(...args)
      if (!rc) controller.abort(reason)
      return rc
    }
    expect(
      await failure(c.captureRequestAsync({ signal: controller.signal })),
    ).toBe(reason)
    expect(c.stats().leased).toBe(0)
  } finally {
    native.zc_acquire = original
    await c.close()
  }
})
test('DMA release errors reject the selected capture without an unhandled pump rejection', async () => {
  const c = cam(),
    original = native.zc_release
  let injected = false
  try {
    native.zc_release = (...args: Parameters<typeof original>) => {
      const rc = original(...args)
      if (!rc && !injected) {
        injected = true
        return -6
      }
      return rc
    }
    expect(await failure(c.captureMetadataAsync())).toMatchObject({ code: -6 })
    expect(injected).toBe(true)
    expect(c.stats().leased).toBe(0)
    native.zc_release = original
    expect((await c.captureMetadata()).sequence).toBeGreaterThan(0n)
  } finally {
    native.zc_release = original
    await c.close()
  }
})
