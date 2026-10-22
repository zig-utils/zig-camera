import { expect, test } from 'bun:test'
import { Camera, type Frame, type CameraOptions } from '../../ts'
const camera = (started = false) => {
  const c = new Camera({
    simulate: true,
    width: 18,
    height: 10,
    buffers: 3,
    writable: true,
    fifo: true,
  })
  if (started) c.start()
  return c
}
const target: CameraOptions = {
  width: 34,
  height: 18,
  raw: true,
  unpackedRaw: true,
  fifo: true,
  lores: { width: 16, height: 8 },
}
const fail = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
for (const started of [false, true])
  for (const format of ['BGR888', 'YUV420'] as const)
    test(`capture-and-stop transfers a live ${format} request from a ${started ? 'running' : 'stopped'} camera`, async () => {
      const c = camera(started),
        previous = c.options
      let request: Frame | undefined, sibling: Frame | undefined
      try {
        c.preCallback = (frame) => {
          if (frame.width === 34)
            frame.withMappedStream((map) => map.row(0).fill(11))
        }
        c.postCallback = (frame) => {
          if (frame.width === 34)
            frame.withMappedStream((map) => map.row(0).fill(77))
        }
        const job = c.switchModeCaptureRequestAndStop({ ...target, format })
        request = await job
        c.setRequestCallbacks({})
        expect(job.cancel()).toBe(false)
        expect(c.info()).toMatchObject({ width: 34, height: 18 })
        expect(c.stats().leased).toBe(1)
        expect(() => c.acquire()).toThrow()
        expect(() => c.start()).toThrow()
        expect(request.referenceCount).toBe(1)
        expect(request.copyStream().data[0]).toBe(77)
        expect(
          request.copyStreams(['main', 'raw', 'lores']).metadata.sequence,
        ).toBe(request.sequence)
        expect(request.encodeImage({ format: 'jpeg' }).length).toBeGreaterThan(
          4,
        )
        sibling = request.retain()
        request.release()
        expect(sibling.referenceCount).toBe(1)
        expect(await fail(c.switchMode(previous))).toMatchObject({ code: -4 })
        expect(await fail(c.close())).toMatchObject({ code: -4 })
        expect(sibling.copyRGB('lores').length).toBe(16 * 8 * 3)
        sibling.release()
        await c.switchMode(previous)
        expect((await c.captureRGB()).length).toBe(18 * 10 * 3)
      } finally {
        request?.release()
        sibling?.release()
        await c.close()
      }
    })
test('successful stopped-request handoff retires preview and preserves focused capture metadata', async () => {
  const c = camera(true)
  let request: Frame | undefined
  try {
    c.startPreview({ backend: 'headless' })
    request = await c.switchModeCaptureRequestAndStop(target, {
      autofocus: true,
      dropFrames: 2,
    })
    expect(c.previewInfo()).toBeUndefined()
    expect(request.metadata().afState).toBe(2)
    expect(request.metadata().controlRevision).toBeGreaterThan(0n)
    expect(request.referenceCount).toBe(1)
    request.release()
    c.start()
    expect((await c.captureMetadata()).sequence).toBeGreaterThan(0n)
  } finally {
    request?.release()
    await c.close()
  }
})
test('cancelled capture-and-stop during post processing releases the private request and restores camera and preview', async () => {
  const c = camera(true),
    reason = Error('cancel candidate')
  let job: ReturnType<Camera['switchModeCaptureRequestAndStop']>,
    selected = false
  try {
    c.startPreview({ backend: 'headless' })
    c.postCallback = (frame) => {
      if (frame.width === 34) {
        selected = true
        job.cancel(reason)
      }
    }
    job = c.switchModeCaptureRequestAndStop(target)
    expect(await fail(job)).toBe(reason)
    await job.cleanupDone
    c.setRequestCallbacks({})
    expect(selected).toBe(true)
    expect(c.stats().leased).toBe(0)
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect(c.previewInfo()?.suspended).toBe(false)
    expect((await c.captureRGB()).length).toBe(18 * 10 * 3)
  } finally {
    await c.close()
  }
})
test('late cancellation between worker response and publication retires the returned private request before rollback', async () => {
  const c = camera(true),
    Original = globalThis.Worker,
    reason = Error('cancel handoff')
  let job: ReturnType<Camera['switchModeCaptureRequestAndStop']>,
    observed = false
  try {
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      const worker = new Original(url, options)
      worker.addEventListener('message', (event) => {
        if (event.data?.requestFrame) {
          observed = true
          job.cancel(reason)
        }
      })
      return worker
    } as unknown as typeof Worker
    job = c.switchModeCaptureRequestAndStop(target)
    expect(await fail(job)).toBe(reason)
    await job.cleanupDone
    expect(observed).toBe(true)
    expect(c.stats().leased).toBe(0)
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect((await c.captureRGB()).length).toBe(18 * 10 * 3)
  } finally {
    globalThis.Worker = Original
    await c.close()
  }
})
test('failed request callbacks restore the previous mode and do not publish the candidate token', async () => {
  const c = camera(),
    cause = Error('reject candidate')
  try {
    c.postCallback = (frame) => {
      if (frame.width === 34) throw cause
    }
    expect(await fail(c.switchModeCaptureRequestAndStop(target))).toMatchObject(
      { phase: 'post', cause, restoreCode: 0 },
    )
    c.setRequestCallbacks({})
    expect(c.stats().leased).toBe(0)
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
    expect(() => c.acquire()).toThrow()
  } finally {
    await c.close()
  }
})
test('pre-aborted and queued stopped-request jobs leave the initial mode untouched', async () => {
  const c = camera(),
    controller = new AbortController(),
    reason = Error('skip')
  controller.abort(reason)
  try {
    expect(
      await fail(
        c.switchModeCaptureRequestAndStop(target, {
          signal: controller.signal,
        }),
      ),
    ).toBe(reason)
    expect(c.stats().delivered).toBe(0n)
    const job = c.switchModeCaptureRequestAndStop(target)
    expect(job.cancel(reason)).toBe(true)
    expect(await fail(job)).toBe(reason)
    expect(c.stats().leased).toBe(0)
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
  } finally {
    await c.close()
  }
})

test('a busy unpublished release preserves an explicit cleanup request and both rollback errors', async () => {
  const { native: ffi, view } = await import('../../ts/ffi')
  const native: {
    zc_release: (...args: Parameters<typeof ffi.zc_release>) => number
  } = ffi
  const c = camera(true),
    previous = c.options,
    Original = globalThis.Worker,
    release = native.zc_release,
    reason = Error('cancel busy handoff')
  let job: ReturnType<Camera['switchModeCaptureRequestAndStop']>,
    cleanup: Frame | undefined
  try {
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      const worker = new Original(url, options)
      worker.addEventListener('message', (event) => {
        if (event.data?.requestFrame) {
          const token = view(event.data.requestFrame).getBigUint64(0, true)
          native.zc_release = (...args) =>
            args[1] === token ? -4 : release(...args)
          job.cancel(reason)
        }
      })
      return worker
    } as unknown as typeof Worker
    job = c.switchModeCaptureRequestAndStop(target)
    const error = (await fail(job)) as AggregateError & {
      requestCleanup: Frame
      restorationError: unknown
    }
    cleanup = error.requestCleanup
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors[0]).toBe(reason)
    expect(error.restorationError).toMatchObject({ code: -4 })
    expect(cleanup).toBeDefined()
    expect(cleanup.width).toBe(34)
    expect(cleanup.referenceCount).toBe(1)
    expect(c.stats().leased).toBe(1)
    native.zc_release = release
    cleanup.release()
    await c.switchMode(previous)
    expect(c.stats().leased).toBe(0)
    expect(c.info()).toMatchObject({ width: 18, height: 10 })
  } finally {
    native.zc_release = release
    globalThis.Worker = Original
    cleanup?.release()
    await c.close()
  }
})

test('stopped target requests save JPEG PNG TIFF and raw DNG through ordinary file paths', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const c = camera(),
    directory = mkdtempSync(join(tmpdir(), 'zc-stopped-files-'))
  let request: Frame | undefined
  try {
    request = await c.switchModeCaptureRequestAndStop(target)
    for (const format of ['jpeg', 'png', 'tiff', 'dng'] as const) {
      const path = join(directory, `still.${format}`)
      request.saveFile(path)
      expect(readFileSync(path).length).toBeGreaterThan(32)
      if (format !== 'dng' && process.env.ZC_IMAGE_DECODER) {
        const result = Bun.spawnSync([
          process.env.ZC_IMAGE_DECODER,
          format,
          path,
        ])
        expect(result.exitCode).toBe(0)
        const pixels = Buffer.from(result.stdout)
        expect([pixels.readUInt32LE(0), pixels.readUInt32LE(4)]).toEqual([
          34, 18,
        ])
      }
      if (format === 'jpeg' && process.env.ZC_EXIF_READER) {
        const result = Bun.spawnSync([process.env.ZC_EXIF_READER, format, path])
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout.toString())).toMatchObject({
          width: 34,
          height: 18,
          software: 'zig-camera',
        })
      }
    }
    expect(request.referenceCount).toBe(1)
  } finally {
    request?.release()
    await c.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
