import { expect, test } from 'bun:test'
import { Camera, Recorder, type CaptureFilesJob } from '../../ts'
import { native as ffi, toArrayBuffer, type Pointer } from '../../ts/ffi'
import { prepareImageFactory } from '../../ts/images'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cam = () =>
  new Camera({ simulate: true, width: 12, height: 8, fifo: true })
const root = () => mkdtempSync(join(tmpdir(), 'zc-series-'))
const settings = {
  preview: false,
  initialDelayMs: 0,
  intervalMs: 0,
  captureMode: { width: 18, height: 10, fifo: true },
  captureTimeoutMs: 10000,
} as const
const fail = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > end) throw Error('timed out')
    await Bun.sleep(1)
  }
}
async function countModes<T>(
  operation: (requests: Array<{ kind?: string; width: number }>) => Promise<T>,
) {
  const Original = globalThis.Worker,
    requests: Array<{ kind?: string; width: number }> = []
  try {
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      const worker = new Original(url, options),
        post = worker.postMessage.bind(worker)
      Object.assign(worker, {
        postMessage: (request: unknown) => {
          const value = request as {
            config?: Uint8Array
            capture?: { kind: string }
          }
          if (value.config)
            requests.push({
              kind: value.capture?.kind,
              width: new DataView(
                value.config.buffer,
                value.config.byteOffset,
                value.config.byteLength,
              ).getUint32(0, true),
            })
          post(request)
        },
      })
      return worker
    } as unknown as typeof Worker
    return await operation(requests)
  } finally {
    globalThis.Worker = Original
  }
}
function inspect(path: string, format: string) {
  const result = Bun.spawnSync([process.env.ZC_EXIF_READER!, format, path])
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString())
}
function decode(path: string, format: string, width: number, height: number) {
  if (!process.env.ZC_IMAGE_DECODER) return
  const result = Bun.spawnSync([process.env.ZC_IMAGE_DECODER, format, path])
  expect(result.exitCode).toBe(0)
  const bytes = Buffer.from(result.stdout)
  expect([bytes.readUInt32LE(0), bytes.readUInt32LE(4)]).toEqual([
    width,
    height,
  ])
}
const rawExif = () =>
  Uint8Array.from([
    77, 77, 0, 42, 0, 0, 0, 8, 0, 1, 1, 59, 0, 2, 0, 0, 0, 2, 65, 0, 0, 0, 0, 0,
    0, 0,
  ])
test('a parent deadline cancels preview warmup and joins stop without publishing a file', async () => {
  const c = cam(),
    dir = root()
  try {
    const job = c.startAndCaptureFiles([join(dir, 'never.png')], {
      ...settings,
      initialDelayMs: 60_000,
      timeoutMs: 100,
    })
    expect(await fail(job)).toMatchObject({ code: -3 })
    await job.cleanupDone
    expect(job.partial).toMatchObject({
      completed: 0,
      stopped: true,
      stage: 'finished',
    })
    expect(readdirSync(dir)).toEqual([])
    expect(c.stats().leased).toBe(0)
    c.start()
    using frame = c.acquire()
    expect(frame.width).toBe(12)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
for (const intervalMs of [0, 2])
  test(`mixed raw/processed series select unpacked Bayer and autofocus with interval ${intervalMs}`, async () => {
    const c = cam(),
      dir = root()
    try {
      const raw = join(dir, 'raw.dng'),
        processed = join(dir, 'processed.png')
      const result = await c.startAndCaptureFiles([raw, processed], {
        ...settings,
        intervalMs,
        autofocus: true,
      })
      expect(result.completed).toBe(2)
      expect(
        result.recentFiles.every((file) => file.metadata.afState === 2),
      ).toBe(true)
      const bytes = readFileSync(raw),
        offset = bytes.readUInt32LE(4),
        tags = new Map<number, number>()
      expect(bytes.toString('ascii', 0, 2)).toBe('II')
      expect(bytes.readUInt16LE(2)).toBe(42)
      for (let i = 0; i < bytes.readUInt16LE(offset); i++) {
        const entry = offset + 2 + i * 12
        tags.set(bytes.readUInt16LE(entry), bytes.readUInt32LE(entry + 8))
      }
      expect(tags.get(256)).toBe(18)
      expect(tags.get(257)).toBe(10)
      expect(tags.get(50717)).toBe(4095)
      const samples = tags.get(273)!
      // The synthetic AF scan consumes the first three FIFO buffers.
      expect(bytes.readUInt16LE(samples + (7 * 18 + 5) * 2)).toBe(405)
      decode(processed, 'png', 18, 10)
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
test('burst admission preserves outstanding requests and active recording ownership', async () => {
  const c = cam(),
    dir = root(),
    recorder = new Recorder(join(dir, 'recording.mkv'), {
      width: 12,
      height: 8,
    })
  try {
    c.start()
    using frame = c.acquire()
    expect(() =>
      c.startAndCaptureFiles([join(dir, 'never.png')], settings),
    ).toThrow()
    expect(frame.copyRGB().length).toBe(12 * 8 * 3)
    frame.release()
    const recording = c.startRecording(recorder)
    expect(() =>
      c.startAndCaptureFiles([join(dir, 'never.png')], settings),
    ).toThrow()
    await recording.close()
    expect(existsSync(join(dir, 'never.png'))).toBe(false)
  } finally {
    await recorder.close()
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('back-to-back captures configure once, preserve ordered metadata and bound progress history', async () => {
  const c = cam(),
    dir = root()
  let job: CaptureFilesJob
  try {
    await countModes(async (requests) => {
      const seen: number[] = []
      job = c.startAndCaptureFiles(
        {
          pattern: join(dir, 'shot-{index}.png'),
          count: 4,
          startIndex: 7,
          padTo: 4,
        },
        {
          ...settings,
          retainResults: 2,
          onFile: (file) => {
            seen.push(file.index)
            expect(Object.isFrozen(file.metadata.crop)).toBe(true)
            expect(job.partial.completed).toBe(file.index + 1)
            expect(() => c.acquire()).toThrow('series active')
            expect(() => c.captureMetadataAsync()).toThrow()
            expect(() => c.switchMode({ width: 8, height: 6 })).toThrow(
              'series active',
            )
          },
        },
      )
      const result = await job
      expect(result.completed).toBe(4)
      expect(result.stopped).toBe(true)
      expect(result.stage).toBe('finished')
      expect(seen).toEqual([0, 1, 2, 3])
      expect(result.recentFiles.map((file) => file.index)).toEqual([2, 3])
      expect(result.recentFiles[1].metadata.sequence).toBeGreaterThan(
        result.recentFiles[0].metadata.sequence,
      )
      expect(requests).toEqual([{ kind: undefined, width: 18 }])
      for (let i = 7; i < 11; i++)
        decode(
          join(dir, `shot-${String(i).padStart(4, '0')}.png`),
          'png',
          18,
          10,
        )
      expect(c.info()).toMatchObject({ width: 18, height: 10 })
      expect(c.stats().leased).toBe(0)
      expect(() => c.acquire()).toThrow()
      expect(job.cancel()).toBe(false)
    })
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('paced series capture in still mode and restore preview before each completed file callback', async () => {
  const c = cam(),
    dir = root()
  const widths: number[] = [],
    completedWidths: number[] = []
  try {
    await countModes(async (requests) => {
      c.preCallback = (request) => widths.push(request.width)
      const started = performance.now()
      const result = await c.startAndCaptureFiles(
        { pattern: join(dir, 'paced-{index}.jpeg'), count: 3 },
        {
          ...settings,
          initialDelayMs: 15,
          intervalMs: 8,
          preview: { backend: 'headless' },
          previewMode: { width: 10, height: 6, fifo: true },
          onFile: () => {
            completedWidths.push(c.info().width)
            expect(c.previewInfo()?.suspended).toBe(false)
          },
        },
      )
      c.setRequestCallbacks({})
      expect(result.completed).toBe(3)
      expect(performance.now() - started).toBeGreaterThanOrEqual(30)
      expect(completedWidths).toEqual([10, 10, 10])
      expect(widths).toContain(10)
      expect(widths).toContain(18)
      expect(requests.map((request) => request.kind)).toEqual([
        undefined,
        'file',
        'file',
        'file',
      ])
      expect(c.info()).toMatchObject({ width: 10, height: 6 })
      expect(c.previewInfo()).toBeUndefined()
      expect(result.stopped).toBe(true)
      expect(c.stats().leased).toBe(0)
      for (let i = 0; i < 3; i++)
        decode(
          join(dir, `paced-${String(i).padStart(3, '0')}.jpeg`),
          'jpeg',
          18,
          10,
        )
    })
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('zero-delay burst warms up in preview, then keeps one capture configuration', async () => {
  const c = cam(),
    dir = root()
  try {
    await countModes(async (requests) => {
      const result = await c.startAndCaptureFiles(
        [join(dir, 'one.jpg'), join(dir, 'two.jpg')],
        {
          ...settings,
          initialDelayMs: 5,
          preview: { backend: 'headless' },
          previewMode: { width: 10, height: 6 },
        },
      )
      expect(result.completed).toBe(2)
      expect(requests).toEqual([
        { kind: undefined, width: 10 },
        { kind: undefined, width: 18 },
      ])
      expect(c.info().width).toBe(18)
      expect(c.previewInfo()).toBeUndefined()
    })
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('large lazy patterns cancel after one completed file without retaining a bulk queue', async () => {
  const c = cam(),
    dir = root(),
    controller = new AbortController(),
    reason = Error('one is enough')
  try {
    const job = c.startAndCaptureFiles(
      { pattern: join(dir, 'lazy-{index}.jpg'), count: 1_000_000_000_000 },
      {
        ...settings,
        signal: controller.signal,
        retainResults: 1,
        onFile: () => controller.abort(reason),
      },
    )
    expect(await fail(job)).toBe(reason)
    await job.cleanupDone
    expect(job.partial).toMatchObject({
      completed: 1,
      stopped: true,
      stage: 'finished',
    })
    expect(job.partial.recentFiles.length).toBe(1)
    expect(readdirSync(dir)).toEqual(['lazy-000.jpg'])
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('cancellation after a completed file preserves progress and prevents the next file', async () => {
  const c = cam(),
    dir = root(),
    reason = Error('cancel burst')
  let job: CaptureFilesJob
  try {
    job = c.startAndCaptureFiles(
      { pattern: join(dir, 'cancel-{index}.png'), count: 5 },
      {
        ...settings,
        retainResults: 1,
        onFile: (file) => {
          if (file.index === 1) job.cancel(reason)
        },
      },
    )
    expect(await fail(job)).toBe(reason)
    await job.cleanupDone
    expect(job.partial.completed).toBe(2)
    expect(job.partial.recentFiles[0].index).toBe(1)
    expect(job.phase).toBe(4)
    expect(readdirSync(dir).sort()).toEqual([
      'cancel-000.png',
      'cancel-001.png',
    ])
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('cancelled paced capture discards prepared output before publication and stops after restoration', async () => {
  const c = cam(),
    dir = root(),
    path = join(dir, 'keep.jpg'),
    reason = Error('cancel prepared photo')
  let job: CaptureFilesJob,
    selected = false
  writeFileSync(path, 'keep')
  try {
    c.postCallback = (request) => {
      if (request.width === 18) {
        selected = true
        job.cancel(reason)
      }
    }
    job = c.startAndCaptureFiles([path], {
      ...settings,
      intervalMs: 1,
      previewMode: { width: 10, height: 6 },
    })
    expect(await fail(job)).toBe(reason)
    await job.cleanupDone
    c.setRequestCallbacks({})
    expect(selected).toBe(true)
    expect(job.partial.completed).toBe(0)
    expect(job.partial.stopped).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['keep.jpg'])
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('ordinary stop and close cancel idle series and join their camera cleanup', async () => {
  for (const close of [false, true]) {
    const c = cam(),
      dir = root()
    try {
      const job = c.startAndCaptureFiles([join(dir, 'never.jpg')], {
        ...settings,
        initialDelayMs: 60_000,
        preview: { backend: 'headless' },
      })
      await until(() => job.partial.stage === 'waiting')
      if (close) await c.close()
      else await c.stop()
      expect(await fail(job)).toMatchObject({ code: -2 })
      await job.cleanupDone
      expect(job.partial.stopped).toBe(true)
      expect(readdirSync(dir)).toEqual([])
      if (!close) {
        expect(c.stats().leased).toBe(0)
        expect(c.previewInfo()).toBeUndefined()
      }
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
test('I/O failure reports prior completed files and leaves later destinations untouched', async () => {
  const c = cam(),
    dir = root(),
    paths = [
      join(dir, 'one.png'),
      join(dir, 'missing', 'bad.png'),
      join(dir, 'last.png'),
    ]
  try {
    const job = c.startAndCaptureFiles(paths, settings)
    expect(await fail(job)).toMatchObject({ code: -6 })
    await job.cleanupDone
    expect(job.partial).toMatchObject({
      completed: 1,
      currentIndex: 1,
      currentPath: paths[1],
      stopped: true,
    })
    expect(existsSync(paths[0])).toBe(true)
    expect(existsSync(paths[2])).toBe(false)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('invalid series options and paths reject before camera lifecycle changes', async () => {
  const c = cam(),
    dir = root()
  c.start()
  try {
    const targets = [
      [],
      ['bad.webp'],
      Array(1),
      { pattern: 'out.jpg', count: 0 },
      { pattern: 'out.jpg', count: NaN },
      {
        pattern: 'out-{index}.jpg',
        count: 2,
        startIndex: Number.MAX_SAFE_INTEGER,
      },
    ]
    for (const paths of targets)
      expect(() => c.startAndCaptureFiles(paths as never, settings)).toThrow()
    for (const extra of [
      { intervalMs: -1 },
      { initialDelayMs: Infinity },
      { retainResults: 4097 },
      { dropFrames: -1 },
      { preview: null },
      { captureMode: { width: 0, height: 6 } },
      { captureMode: { cameraIndex: 1 } },
      { onFile: 3 },
    ])
      expect(() =>
        c.startAndCaptureFiles([join(dir, 'no.jpg')], {
          ...settings,
          ...extra,
        } as never),
      ).toThrow()
    expect(c.stats().delivered).toBe(0n)
    expect(c.info()).toMatchObject({ width: 12, height: 8 })
    using frame = c.acquire()
    expect(frame.width).toBe(12)
    expect(readdirSync(dir)).toEqual([])
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('pre-aborted series do not stop a running camera or create files', async () => {
  const c = cam(),
    dir = root(),
    controller = new AbortController(),
    reason = Error('skip')
  c.start()
  controller.abort(reason)
  try {
    const job = c.startAndCaptureFiles([join(dir, 'no.jpg')], {
      ...settings,
      signal: controller.signal,
    })
    expect(await fail(job)).toBe(reason)
    expect(job.partial.stage).toBe('queued')
    expect(c.stats().delivered).toBe(0n)
    using frame = c.acquire()
    expect(frame.width).toBe(12)
    expect(readdirSync(dir)).toEqual([])
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('progress callback failures preserve the completed file and always stop the session', async () => {
  const c = cam(),
    dir = root(),
    reason = Error('progress failed')
  try {
    const job = c.startAndCaptureFiles(
      [join(dir, 'saved.jpg'), join(dir, 'never.jpg')],
      {
        ...settings,
        onFile: () => {
          throw reason
        },
      },
    )
    expect(await fail(job)).toBe(reason)
    expect(job.partial.completed).toBe(1)
    expect(job.partial.stopped).toBe(true)
    expect(readdirSync(dir)).toEqual(['saved.jpg'])
    expect(c.stats().leased).toBe(0)
    const asyncJob = c.startAndCaptureFiles([join(dir, 'async.jpg')], {
      ...settings,
      onFile: async () => {},
    })
    expect(await fail(asyncJob)).toBeInstanceOf(TypeError)
    expect(asyncJob.partial.completed).toBe(1)
    const stopJob = c.startAndCaptureFiles([join(dir, 'stop.jpg')], {
      ...settings,
      onFile: () => {
        void c.stop()
      },
    })
    expect(await fail(stopJob)).toMatchObject({ code: -4 })
    expect(stopJob.partial.stopped).toBe(true)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('repeated explicit destinations replace in order and zero retention keeps only the count', async () => {
  const c = cam(),
    dir = root(),
    path = join(dir, 'latest.jpg')
  try {
    let count = 0
    const result = await c.startAndCaptureFiles([path, path, path], {
      ...settings,
      retainResults: 0,
      onFile: () => {
        count++
      },
    })
    expect(result.completed).toBe(3)
    expect(count).toBe(3)
    expect(result.recentFiles).toEqual([])
    expect(readdirSync(dir)).toEqual(['latest.jpg'])
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test.skipIf(!process.env.ZC_EXIF_READER)(
  'owned Exif metadata and path arrays are snapshotted once for mixed image formats',
  async () => {
    const c = cam(),
      dir = root(),
      raw = rawExif(),
      paths = [
        join(dir, 'first.jpg'),
        join(dir, 'second.png'),
        join(dir, 'third.tiff'),
      ]
    let reads = 0,
      pathReads = 0
    Object.defineProperty(paths, '0', {
      get() {
        pathReads++
        return join(dir, 'first.jpg')
      },
    })
    paths[Symbol.iterator] = () => {
      throw Error('caller iterator must not run')
    }
    try {
      const job = c.startAndCaptureFiles(paths, {
        ...settings,
        get exif() {
          reads++
          return raw
        },
      })
      raw.fill(0)
      paths[1] = join(dir, 'wrong.png')
      const result = await job
      expect(result.completed).toBe(3)
      expect(reads).toBe(1)
      expect(pathReads).toBe(1)
      for (const [name, format] of [
        ['first.jpg', 'jpeg'],
        ['second.png', 'png'],
        ['third.tiff', 'tiff'],
      ])
        expect(inspect(join(dir, name), format).artist).toBe('A')
      expect(existsSync(join(dir, 'wrong.png'))).toBe(false)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
test.skipIf(!process.env.ZC_EXIF_READER)(
  'per-format default Exif policy survives shared image template preparation',
  async () => {
    const c = cam(),
      dir = root()
    try {
      await c.startAndCaptureFiles(
        ['first.png', 'second.jpg', 'third.tiff'].map((name) =>
          join(dir, name),
        ),
        settings,
      )
      expect(inspect(join(dir, 'first.png'), 'png').hasExif).toBe(false)
      expect(inspect(join(dir, 'second.jpg'), 'jpeg').software).toBe(
        'zig-camera',
      )
      expect(inspect(join(dir, 'third.tiff'), 'tiff').hasExif).toBe(false)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
test('relative idle clock regression aborts without capturing a file', async () => {
  const native: {
    zc_capture_clock_ns: (
      ...args: Parameters<typeof ffi.zc_capture_clock_ns>
    ) => number
  } = ffi
  const original = native.zc_capture_clock_ns,
    c = cam(),
    dir = root(),
    clocks = [100n, 500n, 499n]
  let at = 0
  try {
    native.zc_capture_clock_ns = (out) => {
      new BigUint64Array(toArrayBuffer(out as Pointer, 0, 8))[0] =
        clocks[Math.min(at++, 2)]
      return 0
    }
    const job = c.startAndCaptureFiles([join(dir, 'never.jpg')], {
      ...settings,
      initialDelayMs: 0.001,
    })
    expect(await fail(job)).toMatchObject({ code: -1 })
    expect(job.partial.completed).toBe(0)
    expect(job.partial.stopped).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  } finally {
    native.zc_capture_clock_ns = original
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('a known publication followed by cleanup failure reports its actual file outcome', async () => {
  const native: {
    zc_image_file_state_get: (
      ...args: Parameters<typeof ffi.zc_image_file_state_get>
    ) => number
  } = ffi
  const original = native.zc_image_file_state_get,
    c = cam(),
    dir = root(),
    path = join(dir, 'published.jpg')
  try {
    native.zc_image_file_state_get = (handle, out) => {
      const rc = original(handle, out)
      if (!rc) {
        const state = new DataView(toArrayBuffer(out as Pointer, 0, 32))
        if (state.getUint32(16, true) && state.getUint32(20, true))
          state.setInt32(28, -6, true)
      }
      return rc
    }
    const job = c.startAndCaptureFiles([path], settings)
    const error = await fail(job)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toHaveProperty('imageFilePublished', true)
    expect(existsSync(path)).toBe(true)
    expect(job.partial.completed).toBe(0)
    expect(job.partial.stopped).toBe(true)
    expect(c.stats().leased).toBe(0)
  } finally {
    native.zc_image_file_state_get = original
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('image factory owns metadata even when the original buffer detaches before a new format', () => {
  const source = rawExif(),
    factory = prepareImageFactory({ exif: source })
  const first = factory('first.jpg')
  structuredClone(source, { transfer: [source.buffer] })
  const second = factory('second.png')
  expect(second.exif?.data).toEqual(first.exif?.data)
  expect(second.exif?.data).toBe(first.exif?.data)
})
