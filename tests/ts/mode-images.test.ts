import { test, expect } from 'bun:test'
import {
  Camera,
  CapturedImage,
  RequestCallbackError,
  type CaptureImageOptions,
} from '../../ts'
import { view } from '../../ts/ffi'
const fail = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const cam = () =>
  new Camera({
    simulate: true,
    fifo: true,
    width: 18,
    height: 10,
    writable: true,
    colorSpace: 'rec2020',
  })
const target = {
  width: 34,
  height: 18,
  fifo: true,
  writable: true,
  colorSpace: 'rec709' as const,
}
const formats = [
  'BGR888',
  'RGB888',
  'XBGR8888',
  'XRGB8888',
  'YUV420',
  'YVU420',
  'NV12',
  'NV21',
  'YUYV',
  'YVYU',
  'UYVY',
  'VYUY',
  'BGR161616',
  'RGB161616',
] as const
for (const format of formats)
  for (const stream of ['main', 'lores'] as const)
    for (const started of [false, true])
      test(`temporary ${format} ${stream} image owns precision and target provenance after ${started ? 'running' : 'stopped'} mode restoration`, async () => {
        const c = cam()
        let expected: CapturedImage | undefined
        try {
          if (started) c.start()
          c.preCallback = (request) => {
            if (request.width !== 34) return
            expected?.close()
            expected = request.makeImage({
              stream,
              width: 7,
              height: 3,
              resample: 'lanczos3',
            })
          }
          using result = await c.switchModeAndCaptureImage(
            { ...target, format, lores: { width: 16, height: 8, format } },
            { stream, width: 7, height: 3, resample: 'lanczos3' },
          )
          c.setRequestCallbacks({})
          expect(result).toBeInstanceOf(CapturedImage)
          expect(result.copyPixels()).toEqual(expected!.copyPixels())
          expect(result.sourceMetadata).toEqual(expected!.sourceMetadata)
          expect(result.colorSpace).toEqual(expected!.colorSpace)
          expect(result.colorSpace!.primaries).toBe('rec709')
          expect([result.width, result.height, result.bits]).toEqual([
            7,
            3,
            format.endsWith('161616') ? 16 : 8,
          ])
          expect(c.info()).toMatchObject({ width: 18, height: 10 })
          expect(c.colorSpace().primaries).toBe('rec2020')
          expect(c.stats().leased).toBe(0)
          if (!started) expect(() => c.acquire()).toThrow()
          const before = result.copyPixels()
          await c.close()
          Bun.gc(true)
          expect(result.copyPixels()).toEqual(before)
          expect(result.getPixel16(6, 2)[3]).toBe(65535)
        } finally {
          expected?.close()
          await c.close()
        }
      })

test('image mode snapshots properties once and keeps explicit byte reduction and partial dimensions', async () => {
  const c = cam(),
    reads = { stream: 0, bits: 0, width: 0, height: 0, resample: 0 }
  try {
    const options: CaptureImageOptions = {
      get stream() {
        reads.stream++
        return 'lores' as const
      },
      get bits() {
        reads.bits++
        return 8 as const
      },
      get width() {
        reads.width++
        return 5
      },
      get height() {
        reads.height++
        return undefined
      },
      get resample() {
        reads.resample++
        return 'nearest' as const
      },
    }
    const job = c.switchModeAndCaptureImage(
      { ...target, lores: { width: 16, height: 8, format: 'BGR161616' } },
      options,
    )
    Object.defineProperty(options, 'width', {
      get() {
        throw Error('reread')
      },
    })
    using image = await job
    expect(reads).toEqual({
      stream: 1,
      bits: 1,
      width: 1,
      height: 1,
      resample: 1,
    })
    expect([image.width, image.height, image.bits]).toEqual([5, 8, 8])
    expect(c.info().width).toBe(18)
  } finally {
    await c.close()
  }
})
test('image mode validates early and restores after missing streams precision errors and heap limits', async () => {
  const c = cam()
  try {
    const original = c.handle
    for (const options of [
      { width: 0 },
      { height: NaN },
      { bits: 12 },
      { stream: 'raw' },
      { resample: 'box' },
    ])
      expect(() =>
        c.switchModeAndCaptureImage(target, options as CaptureImageOptions),
      ).toThrow()
    expect(c.handle).toBe(original)
    expect(c.stats().leased).toBe(0)
    for (const options of [
      { stream: 'lores' as const },
      { bits: 16 as const },
      { width: 3000000, resample: 'bilinear' as const },
    ]) {
      expect(
        await fail(c.switchModeAndCaptureImage(target, options)),
      ).toBeDefined()
      expect(c.info().width).toBe(18)
      expect(c.stats().leased).toBe(0)
    }
    using good = await c.switchModeAndCaptureImage(target)
    expect([good.width, good.height]).toEqual([34, 18])
  } finally {
    await c.close()
  }
})
test('image mode capture freezes the pre-copy pixels before post hooks mutate or throw', async () => {
  const c = cam(),
    marker = Error('post failed')
  let expected: CapturedImage | undefined
  try {
    c.preCallback = (request) => {
      if (request.width === 34) {
        request.withMappedStream((map) => map.row(0).fill(11))
        expected?.close()
        expected = request.makeImage()
      }
    }
    c.postCallback = (request) => {
      if (request.width === 34)
        request.withMappedStream((map) => map.row(0).fill(77))
    }
    using result = await c.switchModeAndCaptureImage(target)
    expect(result.copyPixels()).toEqual(expected!.copyPixels())
    expect(result.getPixel(0, 0)).toEqual([11, 11, 11, 255])
    c.postCallback = (request) => {
      if (request.width === 34) throw marker
    }
    const job = c.switchModeAndCaptureImage(target)
    expect(await fail(job)).toBeInstanceOf(RequestCallbackError)
    expect(job.value).toBeUndefined()
    expect(c.info().width).toBe(18)
    expect(c.stats().leased).toBe(0)
  } finally {
    expected?.close()
    c.setRequestCallbacks({})
    await c.close()
  }
})
test('fresh target autofocus and persistent intent survive image mode restoration with preview', async () => {
  const c = cam()
  try {
    c.start()
    c.startContinuousAutofocus()
    c.startPreview({ backend: 'headless' })
    c.setControls([
      { id: 2, type: 'int', values: [4567] },
      { id: 3, type: 'float', values: [2] },
    ])
    using image = await c.switchModeAndCaptureImage(target, {
      autofocus: true,
      dropFrames: 2,
      width: 7,
      height: 3,
    })
    expect(image.sourceMetadata!.afState).toBe(2)
    expect(image.sourceMetadata!.exposureUs).toBe(4567)
    expect(image.sourceMetadata!.analogueGain).toBe(2)
    expect(c.info().width).toBe(18)
    expect(c.previewInfo()).toBeDefined()
    using restored = c.acquire()
    expect(restored.metadata().afPauseState).toBe(0)
    expect(restored.metadata().exposureUs).toBe(4567)
  } finally {
    await c.close()
  }
})
test('active image mode cancellation joins copying and camera restoration before rejection and reuse', async () => {
  const c = cam(),
    reason = Error('cancel image')
  let job: ReturnType<Camera['switchModeAndCaptureImage']>,
    entered = false
  try {
    c.postCallback = (request) => {
      if (request.width === 34) {
        entered = true
        setTimeout(() => job.cancel(reason), 0)
      }
    }
    job = c.switchModeAndCaptureImage(target, {
      width: 2048,
      height: 2048,
      timeoutMs: 10000,
    })
    expect(await fail(job)).toBe(reason)
    await job.operationDone
    expect(entered).toBe(true)
    expect(job.value).toBeUndefined()
    expect(c.info().width).toBe(18)
    expect(c.stats().leased).toBe(0)
    c.setRequestCallbacks({})
    using next = await c.switchModeAndCaptureImage(target)
    expect(next.width).toBe(34)
  } finally {
    c.setRequestCallbacks({})
    await c.close()
  }
})
test('camera close cancels and joins an active copied image job without publishing its result', async () => {
  const c = cam()
  let closing: Promise<void> | undefined,
    job: ReturnType<Camera['switchModeAndCaptureImage']>
  try {
    c.postCallback = (request) => {
      if (request.width === 34)
        queueMicrotask(() => {
          closing = c.close()
        })
    }
    job = c.switchModeAndCaptureImage(target)
    expect(await fail(job)).toBeDefined()
    await closing
    await job.operationDone
    expect(job.value).toBeUndefined()
    expect(() => c.info()).toThrow()
  } finally {
    await closing
    await c.close()
  }
})
test('image publication waits for preview restoration and rechecks a synchronously elapsed deadline', async () => {
  for (const failure of [true, false]) {
    const c = cam(),
      marker = Error('preview failed'),
      owner = c as unknown as {
        openPreviewOwned: (options: unknown) => void
      },
      open = owner.openPreviewOwned
    try {
      c.startPreview({ backend: 'headless' })
      Object.assign(c, {
        openPreviewOwned: (options: unknown) => {
          if (failure) throw marker
          open.call(c, options)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
        },
      })
      const job = c.switchModeAndCaptureImage(target, { timeoutMs: 1000 })
      const error = await fail(job)
      if (failure) expect(error).toBe(marker)
      else expect(error).toMatchObject({ code: -3 })
      expect(job.value).toBeUndefined()
      expect(c.info().width).toBe(18)
      expect(c.stats().leased).toBe(0)
    } finally {
      Object.assign(c, { openPreviewOwned: open })
      await c.close()
    }
  }
})
test('image mode result is sealed before completion hooks, whose failures do not retire the image', async () => {
  const c = cam(),
    marker = Error('completion failed')
  let observed = false
  try {
    const job = c.switchModeAndCaptureImage(target, {
      signalFunction: (completed) => {
        observed = true
        expect(completed.value).toBeInstanceOf(CapturedImage)
        expect(c.info().width).toBe(18)
        expect(completed.cancel()).toBe(false)
        throw marker
      },
    })
    using image = await job
    await job.cleanupDone
    expect(observed).toBe(true)
    expect(job.callbackError).toBe(marker)
    expect(image.getPixel(0, 0)[3]).toBe(255)
  } finally {
    await c.close()
  }
})
test('permanent mode deadline after preview startup stops the target preview and restores the previous owner', async () => {
  const c = cam(),
    owner = c as unknown as {
      openPreviewOwned: (options: unknown) => void
    },
    open = owner.openPreviewOwned
  let delayed = false
  try {
    c.startPreview({ backend: 'headless' })
    Object.assign(c, {
      openPreviewOwned: (options: unknown) => {
        open.call(c, options)
        if (!delayed) {
          delayed = true
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
        }
      },
    })
    const job = c.switchMode(target, { timeoutMs: 1000 })
    expect(await fail(job)).toMatchObject({ code: -3 })
    expect(delayed).toBe(true)
    expect(c.info().width).toBe(18)
    expect(c.previewInfo()).toBeDefined()
    await c.stopPreview()
    using frame = c.acquire()
    expect(frame.width).toBe(18)
  } finally {
    Object.assign(c, { openPreviewOwned: open })
    await c.close()
  }
})
test('native image snapshots use authoritative request metadata and geometry', async () => {
  const c = cam()
  try {
    c.start()
    using frame = c.acquire()
    Object.assign(frame, {
      metadata: () => {
        throw Error('public method override')
      },
      colorSpace: () => {
        throw Error('public method override')
      },
    })
    view(frame.descriptor).setUint32(40, 999, true)
    using image = frame.makeImage()
    expect([image.width, image.height]).toEqual([18, 10])
    expect(image.sourceMetadata!.sequence).toBe(frame.sequence)
  } finally {
    await c.close()
  }
})
