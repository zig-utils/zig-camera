import { test, expect } from 'bun:test'
import { Camera, RequestCallbackError, type ImageFormat } from '../../ts'
import { native, view, toArrayBuffer, type Pointer } from '../../ts/ffi'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cam = () =>
  new Camera({ simulate: true, width: 18, height: 10, fifo: true })
const fail = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const formats: ImageFormat[] = ['jpeg', 'png', 'bmp', 'tiff', 'ppm', 'dng']
for (const format of formats)
  test(`temporary ${format} stays unpublished through post-capture callbacks and rolls back errors`, async () => {
    const c = cam(),
      dir = mkdtempSync(join(tmpdir(), 'zc-stage-post-')),
      path = join(dir, `photo.${format}`),
      marker = new Error('post failed')
    writeFileSync(path, 'original')
    let visited = 0
    try {
      c.postCallback = (request) => {
        if (request.width !== 32) return
        visited++
        expect(readFileSync(path, 'utf8')).toBe('original')
        expect(readdirSync(dir).length).toBe(2)
        throw marker
      }
      const result = await fail(
        c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, { format }),
      )
      expect(result).toBeInstanceOf(RequestCallbackError)
      expect(String(result)).toContain('post')
      expect(visited).toBe(1)
      expect(readFileSync(path, 'utf8')).toBe('original')
      expect(readdirSync(dir)).toEqual([`photo.${format}`])
      c.setRequestCallbacks({})
      expect(c.info()).toMatchObject({ width: 18, height: 10 })
      const meta = await c.switchModeAndCaptureFile(
        { width: 32, height: 24 },
        path,
        { format },
      )
      expect(meta.sequence).toBeGreaterThan(0n)
      expect(readFileSync(path).length).toBeGreaterThan(20)
      expect(readdirSync(dir)).toEqual([`photo.${format}`])
      expect(c.stats().leased).toBe(0)
    } finally {
      c.setRequestCallbacks({})
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
test('cancellation after staging waits for callback, camera restoration and native disposal before rejection', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-cancel-')),
    path = join(dir, 'photo.png'),
    reason = new Error('cancel staged file')
  writeFileSync(path, 'keep')
  let job: ReturnType<Camera['switchModeAndCaptureFile']>,
    called = false
  try {
    c.postCallback = (request) => {
      if (request.width !== 32) return
      called = true
      expect(readFileSync(path, 'utf8')).toBe('keep')
      expect(job.cancel(reason)).toBe(true)
      expect(readdirSync(dir).length).toBe(2)
    }
    job = c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
      iccProfile: 'srgb',
    })
    expect(await fail(job)).toBe(reason)
    expect(called).toBe(true)
    expect(job.phase).toBe(4)
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['photo.png'])
    expect(c.info().width).toBe(18)
    expect(c.stats().leased).toBe(0)
  } finally {
    c.setRequestCallbacks({})
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('deadline expiry inside a post callback never publishes the staged file', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-deadline-')),
    path = join(dir, 'photo.png')
  writeFileSync(path, 'keep')
  let entered = false
  try {
    c.postCallback = (request) => {
      if (request.width === 32) {
        entered = true
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
      }
    }
    const error = await fail(
      c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        timeoutMs: 1000,
      }),
    )
    expect(error).toMatchObject({ code: -3 })
    expect(entered).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['photo.png'])
    expect(c.info().width).toBe(18)
  } finally {
    c.setRequestCallbacks({})
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('restoration failure leaves the destination unchanged and discards the worker-owned temporary', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-restore-')),
    path = join(dir, 'photo.png'),
    Original = globalThis.Worker
  writeFileSync(path, 'keep')
  try {
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      const worker = new Original(url, options),
        post = worker.postMessage.bind(worker)
      Object.assign(worker, {
        postMessage: (request: unknown) => {
          const value = request as {
            capture?: { kind: string }
            previousConfig: Uint8Array
          }
          if (value.capture?.kind === 'file') {
            const previous = value.previousConfig.slice()
            view(previous).setUint32(0, 0, true)
            post({ ...value, previousConfig: previous })
          } else post(request)
        },
      })
      return worker
    } as unknown as typeof Worker
    const error = await fail(
      c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        exif: { artist: 'Chris' },
      }),
    )
    expect(error).toHaveProperty('restoreCode')
    expect((error as { restoreCode: number }).restoreCode).not.toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['photo.png'])
  } finally {
    globalThis.Worker = Original
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('worker construction failure releases the reserved I/O thread and keeps the previous camera reusable', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-worker-')),
    path = join(dir, 'photo.png'),
    Original = globalThis.Worker
  writeFileSync(path, 'keep')
  try {
    c.start()
    globalThis.Worker = class {
      constructor() {
        throw Error('worker unavailable')
      }
    } as unknown as typeof Worker
    expect(
      String(
        await fail(c.switchModeAndCaptureFile({ width: 32, height: 24 }, path)),
      ),
    ).toContain('worker unavailable')
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['photo.png'])
    expect(c.info().width).toBe(18)
    using frame = c.acquire()
    expect(frame.width).toBe(18)
  } finally {
    globalThis.Worker = Original
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('rename failure is reported after restoration and joined disposal without deleting the destination directory', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-rename-')),
    path = join(dir, 'directory')
  mkdirSync(path)
  writeFileSync(join(path, 'keep'), 'keep')
  try {
    const error = await fail(
      c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        format: 'png',
      }),
    )
    expect(error).toMatchObject({ code: -6 })
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['directory'])
    expect(c.info().width).toBe(18)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('native publication claim rejects late cancellation and camera close waits for the joined file result', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-claim-')),
    path = join(dir, 'photo.png'),
    finish = native.zc_image_file_finish
  let job: ReturnType<Camera['switchModeAndCaptureFile']>,
    observed = false,
    closed: Promise<void> | undefined
  try {
    Object.assign(native, {
      zc_image_file_finish: (...args: Parameters<typeof finish>) => {
        const result = finish(...args)
        if (args[1] === 1 && result === 0) {
          observed = true
          expect(c.info().width).toBe(18)
          expect(job.cancel(new Error('too late'))).toBe(false)
          closed = c.close()
        }
        return result
      },
    })
    job = c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
      iccProfile: 'srgb',
    })
    expect(((await job) as { sequence: bigint }).sequence).toBeGreaterThan(0n)
    expect(observed).toBe(true)
    await closed
    expect(readFileSync(path).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    expect(readdirSync(dir)).toEqual(['photo.png'])
  } finally {
    Object.assign(native, { zc_image_file_finish: finish })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preview restoration failure discards the prepared file before reporting the job error', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-preview-')),
    path = join(dir, 'photo.png'),
    marker = new Error('preview restore failed')
  const owner = c as unknown as {
      openPreviewOwned: (options: unknown) => void
    },
    open = owner.openPreviewOwned
  writeFileSync(path, 'keep')
  try {
    c.startPreview({ backend: 'headless' })
    Object.assign(c, {
      openPreviewOwned: () => {
        throw marker
      },
    })
    expect(
      await fail(c.switchModeAndCaptureFile({ width: 32, height: 24 }, path)),
    ).toBe(marker)
    expect(c.info().width).toBe(18)
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['photo.png'])
  } finally {
    Object.assign(c, { openPreviewOwned: open })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('completion callbacks observe a committed file after native ownership retires and can start another file job', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-completion-')),
    path = join(dir, 'photo.png'),
    marker = new Error('completion failed')
  try {
    const job = c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
      signalFunction: async (completed) => {
        expect(completed.error).toBeUndefined()
        expect(c.info().width).toBe(18)
        expect(readFileSync(path).length).toBeGreaterThan(20)
        await c.switchModeAndCaptureFile({ width: 24, height: 16 }, path)
        throw marker
      },
    })
    expect((await job).sequence).toBeGreaterThan(0n)
    await job.cleanupDone
    expect(job.callbackError).toBe(marker)
    expect(readFileSync(path).length).toBeGreaterThan(20)
    expect(readdirSync(dir)).toEqual(['photo.png'])
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deadline is rechecked after synchronous preview restoration before publication is claimed', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-preview-deadline-')),
    path = join(dir, 'photo.png')
  const owner = c as unknown as {
      openPreviewOwned: (options: unknown) => void
    },
    open = owner.openPreviewOwned
  let entered = false
  writeFileSync(path, 'keep')
  try {
    c.startPreview({ backend: 'headless' })
    Object.assign(c, {
      openPreviewOwned: (options: unknown) => {
        open.call(c, options)
        entered = true
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
      },
    })
    const error = await fail(
      c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        timeoutMs: 1000,
      }),
    )
    expect(entered).toBe(true)
    expect(error).toMatchObject({ code: -3 })
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['photo.png'])
    expect(c.info().width).toBe(18)
  } finally {
    Object.assign(c, { openPreviewOwned: open })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const format of ['BGR888', 'YUV420'] as const)
  (process.env.ZC_IMAGE_DECODER ? test : test.skip)(
    `independent decoders preserve staged ${format} captures across all processed containers`,
    async () => {
      const c = cam(),
        dir = mkdtempSync(join(tmpdir(), 'zc-stage-decode-'))
      const target = {
        width: 32,
        height: 24,
        format,
        colorSpace:
          format === 'YUV420' ? ('rec709' as const) : ('srgb' as const),
      }
      try {
        const expected = await c.switchModeAndCaptureRGB(target)
        for (const image of ['png', 'bmp', 'tiff', 'jpeg'] as const) {
          const path = join(dir, `photo.${image}`)
          await c.switchModeAndCaptureFile(target, path)
          const result = Bun.spawnSync([
            process.env.ZC_IMAGE_DECODER!,
            image,
            path,
          ])
          expect(result.exitCode).toBe(0)
          const decoded = Buffer.from(result.stdout)
          expect([decoded.readUInt32LE(0), decoded.readUInt32LE(4)]).toEqual([
            32, 24,
          ])
          if (image === 'jpeg') {
            let error = 0
            for (let i = 0; i < expected.length; i++)
              error += Math.abs(decoded[i + 8] - expected[i])
            expect(error / expected.length).toBeLessThan(3)
          } else expect(decoded.subarray(8)).toEqual(Buffer.from(expected))
        }
        expect(c.info().width).toBe(18)
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

test('capture and cleanup failures are both reported after the native owner retires', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-cleanup-error-')),
    path = join(dir, 'directory'),
    get = native.zc_image_file_state_get
  mkdirSync(path)
  writeFileSync(join(path, 'keep'), 'keep')
  try {
    Object.assign(native, {
      zc_image_file_state_get: (...args: Parameters<typeof get>) => {
        const result = get(...args),
          bytes = new DataView(toArrayBuffer(args[1] as Pointer, 0, 32))
        if (
          result === 0 &&
          bytes.getUint32(16, true) &&
          bytes.getInt32(24, true) === -6
        )
          bytes.setInt32(28, -6, true)
        return result
      },
    })
    const error = await fail(
      c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        format: 'png',
      }),
    )
    expect(error).toBeInstanceOf(AggregateError)
    const errors = (error as AggregateError).errors as { code: number }[]
    expect(errors.length).toBe(2)
    expect(errors.map((error) => error.code)).toEqual([-6, -6])
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['directory'])
    Object.assign(native, { zc_image_file_state_get: get })
    await c.switchModeAndCaptureFile(
      { width: 24, height: 16 },
      join(dir, 'next.png'),
    )
    expect(readFileSync(join(dir, 'next.png')).length).toBeGreaterThan(20)
  } finally {
    Object.assign(native, { zc_image_file_state_get: get })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mode option accessors cannot close the camera between admission and native ownership', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-accessor-')),
    path = join(dir, 'photo.png'),
    create = native.zc_image_file_create
  let closed: Promise<void> | undefined,
    created = 0
  writeFileSync(path, 'keep')
  try {
    Object.assign(native, {
      zc_image_file_create: (...args: Parameters<typeof create>) => {
        created++
        return create(...args)
      },
    })
    expect(() =>
      c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        get timeoutMs() {
          closed = c.close()
          return 5000
        },
      }),
    ).toThrow('camera unavailable')
    await closed
    expect(created).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['photo.png'])
  } finally {
    Object.assign(native, { zc_image_file_create: create })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('mode-file image accessors are snapshotted once without spreading them into scheduling options', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-accessor-copy-')),
    path = join(dir, 'photo.png')
  let reads = 0
  try {
    const job = c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
      get iccProfile() {
        reads++
        return 'srgb' as const
      },
    })
    expect(reads).toBe(1)
    await job
    expect(reads).toBe(1)
    expect(readFileSync(path).toString('ascii', 37, 41)).toBe('iCCP')
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('reentrant scheduling accessors cannot overbook the bounded mode queue', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stage-admission-')),
    path = join(dir, 'photo.png'),
    queued: ReturnType<Camera['switchMode']>[] = []
  let reads = 0
  try {
    expect(() =>
      c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        get timeoutMs() {
          reads++
          for (let i = 0; i < 32; i++)
            queued.push(c.switchMode({ width: 24, height: 16 }))
          return 5000
        },
      }),
    ).toThrow('mode queue')
    expect(reads).toBe(1)
    expect(queued.length).toBe(32)
    for (const job of queued) job.cancel()
    await Promise.all(queued.map((job) => fail(job)))
    expect(readdirSync(dir)).toEqual([])
    expect(c.info().width).toBe(18)
  } finally {
    for (const job of queued) job.cancel()
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
