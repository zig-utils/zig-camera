import { expect, test } from 'bun:test'
import { Camera, type StreamName, type CapturedStreams } from '../../ts'
import { view } from '../../ts/ffi'
const camera = (started = false) => {
  const c = new Camera({
    simulate: true,
    width: 18,
    height: 10,
    fifo: true,
    writable: true,
  })
  if (started) c.start()
  return c
}
const target = {
  width: 34,
  height: 18,
  raw: true,
  unpackedRaw: true,
  fifo: true,
  lores: { width: 16, height: 8 },
}
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
for (const started of [false, true])
  for (const mainFormat of ['BGR888', 'YUV420'] as const)
    test(`temporary ${mainFormat} paired streams restore a ${started ? 'running' : 'stopped'} camera and own compact pixels`, async () => {
      const c = camera(started)
      try {
        let seen = 0,
          captured: CapturedStreams | undefined
        c.preCallback = (request) => {
          if (request.width === 34) {
            request.withMappedStream((map) => map.row(0).fill(11))
            captured = {
              streams: {
                main: request.copyStream(),
                raw: request.copyStream('raw'),
                lores: request.copyStream('lores'),
              },
              metadata: request.metadata(),
            }
            seen++
          }
        }
        c.postCallback = (request) => {
          if (request.width === 34)
            request.withMappedStream((map) => map.row(0).fill(77))
        }
        const job = c.switchModeAndCaptureStreams(
          { ...target, format: mainFormat },
          ['lores', 'main', 'raw'],
        )
        const result = await job
        c.setRequestCallbacks({})
        expect(seen).toBeGreaterThan(0)
        expect(result.metadata).toEqual(captured!.metadata)
        expect(Object.keys(result.streams)).toEqual(['lores', 'main', 'raw'])
        for (const name of ['lores', 'main', 'raw'] as const)
          expect(result.streams[name]).toEqual(captured!.streams[name])
        expect(result.streams.main!.data[0]).toBe(11)
        expect(result.streams.main!.data.length).toBe(
          34 * 18 * (mainFormat === 'BGR888' ? 3 : 1.5),
        )
        expect(result.streams.raw).toMatchObject({
          rowBytes: 68,
          format: 'SRGGB12',
        })
        expect(result.streams.raw!.data.length).toBe(34 * 18 * 2)
        expect(result.streams.lores!.data.length).toBe(16 * 8 * 1.5)
        expect(result.streams.main!.data.buffer).toBe(
          result.streams.lores!.data.buffer,
        )
        expect(c.info()).toMatchObject({ width: 18, height: 10 })
        expect(c.stats().leased).toBe(0)
        if (!started) expect(() => c.acquire()).toThrow()
        const kept = result.streams.main!.data.slice()
        await c.close()
        expect(result.streams.main!.data).toEqual(kept)
      } finally {
        await c.close()
      }
    })
test('stream selector input is copied once at admission without invoking a custom iterator', async () => {
  const c = camera(),
    names: StreamName[] = ['main', 'lores']
  let reads = 0
  Object.defineProperty(names, '0', {
    get() {
      reads++
      return 'raw'
    },
    configurable: true,
  })
  names[Symbol.iterator] = () => {
    throw Error('do not iterate caller input')
  }
  try {
    const job = c.switchModeAndCaptureStreams(target, names)
    names[1] = 'raw'
    const result = await job
    expect(reads).toBe(1)
    expect(Object.keys(result.streams)).toEqual(['raw', 'lores'])
  } finally {
    await c.close()
  }
})
test('empty, duplicate, sparse and unknown stream selections reject before mode admission', async () => {
  const c = camera()
  try {
    for (const names of [
      [],
      ['main', 'main'],
      ['main', 'invalid'],
      Array(1),
      null,
      { 0: 'main', length: 1 },
    ]) {
      expect(() =>
        c.switchModeAndCaptureStreams(target, names as StreamName[]),
      ).toThrow()
      expect(() => c.captureStreamsAsync(names as StreamName[])).toThrow()
    }
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect(c.stats().delivered).toBe(0n)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('unavailable selected streams fail and restore the previous camera without publishing a partial bundle', async () => {
  const c = camera(true)
  try {
    const job = c.switchModeAndCaptureStreams({ width: 34, height: 18 }, [
      'main',
      'raw',
    ])
    expect(await failure(job)).toBeDefined()
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect(c.stats().leased).toBe(0)
    expect((await c.captureRGB()).length).toBe(18 * 10 * 3)
    const result = await c.switchModeAndCaptureStreams(target, ['raw', 'lores'])
    expect(Object.keys(result.streams)).toEqual(['raw', 'lores'])
  } finally {
    await c.close()
  }
})
test('paired captures preserve autofocus revisions and restore continuous preview configuration', async () => {
  const c = camera(true)
  try {
    c.startPreview({ backend: 'headless' })
    const result = await c.switchModeAndCaptureStreams(
      target,
      ['main', 'lores'],
      { autofocus: true, dropFrames: 2 },
    )
    expect(result.metadata.afState).toBe(2)
    expect(result.metadata.controlRevision).toBeGreaterThan(0n)
    expect(c.previewInfo()).toBeDefined()
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect(c.stats().leased).toBe(0)
    await c.stopPreview()
  } finally {
    await c.close()
  }
})
test('cancelled paired mode captures finish restoration and release every temporary lease', async () => {
  const c = camera(true)
  try {
    const job = c.switchModeAndCaptureStreams(target, ['main', 'lores'], {
      dropFrames: 100000,
    })
    expect(job.cancel()).toBe(true)
    expect(await failure(job)).toBeDefined()
    await job.cleanupDone
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect(c.stats().leased).toBe(0)
    expect((await c.captureRGB()).length).toBe(18 * 10 * 3)
  } finally {
    await c.close()
  }
})
test('post callback errors suppress copied bundles and restore the prior camera', async () => {
  const c = camera(true),
    marker = Error('reject prepared streams')
  try {
    c.postCallback = (request) => {
      if (request.width === 34) throw marker
    }
    expect(
      await failure(c.switchModeAndCaptureStreams(target, ['main', 'raw'])),
    ).toMatchObject({ phase: 'post', cause: marker, restoreCode: 0 })
    c.setRequestCallbacks({})
    expect(c.stats().leased).toBe(0)
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
  } finally {
    c.setRequestCallbacks({})
    await c.close()
  }
})
test('mode restoration errors discard the completed bundle', async () => {
  const c = camera(),
    Original = globalThis.Worker
  try {
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      const worker = new Original(url, options),
        post = worker.postMessage.bind(worker)
      Object.assign(worker, {
        postMessage(request: unknown) {
          const value = request as {
            capture?: { kind: string }
            previousConfig: Uint8Array
          }
          if (value.capture?.kind === 'streams') {
            const previous = value.previousConfig.slice()
            view(previous).setUint32(0, 0, true)
            post({ ...value, previousConfig: previous })
          } else post(request)
        },
      })
      return worker
    } as unknown as typeof Worker
    const result = await failure(
      c.switchModeAndCaptureStreams(target, ['main', 'lores']),
    )
    expect(result).toHaveProperty('restoreCode')
    expect((result as { restoreCode: number }).restoreCode).not.toBe(0)
  } finally {
    globalThis.Worker = Original
    await c.close()
  }
})

test('cancellation after paired pixels are copied suppresses publication and joins restoration', async () => {
  const c = camera(true),
    reason = Error('cancel prepared bundle')
  let job: ReturnType<Camera['switchModeAndCaptureStreams']>
  let copied = false
  try {
    c.postCallback = (request) => {
      if (request.width === 34) {
        copied = true
        job.cancel(reason)
      }
    }
    job = c.switchModeAndCaptureStreams(target, ['main', 'raw', 'lores'])
    expect(await failure(job)).toBe(reason)
    await job.cleanupDone
    c.setRequestCallbacks({})
    expect(copied).toBe(true)
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect(c.stats().leased).toBe(0)
    expect((await c.captureRGB()).length).toBe(18 * 10 * 3)
  } finally {
    await c.close()
  }
})
