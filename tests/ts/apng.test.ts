import { expect, test } from 'bun:test'
import { toArrayBuffer } from 'bun:ffi'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  Camera,
  encodePngAnimationAsync,
  savePngAnimationAsync,
  type PngAnimation,
} from '../../ts'
import { native as n, type Pointer } from '../../ts/ffi'
const mutable: { -readonly [K in keyof typeof n]: (typeof n)[K] } = n
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
async function until(predicate: () => boolean) {
  const end = performance.now() + 10000
  while (!predicate()) {
    if (performance.now() > end) throw Error('timeout')
    await pause()
  }
}
const rejected = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
function nativeView(pointer: unknown, length: number) {
  if (typeof pointer !== 'number' && typeof pointer !== 'bigint')
    throw Error('invalid test pointer')
  return new DataView(toArrayBuffer(pointer as Pointer, 0, length))
}
const sample = (): PngAnimation => ({
  width: 2,
  height: 2,
  frames: [
    {
      width: 2,
      height: 2,
      stride: 8,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 222, 222, 7, 8, 9, 10, 11, 12]),
    },
    {
      width: 1,
      height: 1,
      x: 1,
      y: 1,
      data: new Uint8Array([250, 100, 10]),
      delay: { numerator: 7, denominator: 0 },
      dispose: 'previous',
      blend: 'over',
    },
  ],
  plays: 3,
})
function readback(bytes: Uint8Array) {
  const decoder = process.env.ZC_APNG_DECODER
  if (!decoder) return undefined
  const dir = mkdtempSync(join(tmpdir(), 'zc-apng-read-'))
  try {
    const path = join(dir, 'animation.png')
    writeFileSync(path, bytes)
    const result = Bun.spawnSync([decoder, path])
    expect(new TextDecoder().decode(result.stderr)).toBe('')
    expect(result.exitCode).toBe(0)
    const raw = Buffer.from(result.stdout)
    expect(raw.subarray(0, 4).toString()).toBe('ZCAP')
    let at = 4
    const u = () => {
      const value = raw.readUInt32BE(at)
      at += 4
      return value
    }
    const width = u(),
      height = u(),
      count = u(),
      plays = u(),
      poster = u(),
      bits = u(),
      channels = u()
    expect(u()).toBe(0)
    const frames = []
    for (let i = 0; i < count + poster; i++) {
      const w = u(),
        h = u(),
        x = u(),
        y = u(),
        num = u(),
        den = u(),
        dispose = u(),
        blend = u(),
        size = u()
      frames.push({
        width: w,
        height: h,
        x,
        y,
        num,
        den,
        dispose,
        blend,
        data: raw.subarray(at, at + size),
      })
      at += size
    }
    expect(at).toBe(raw.length)
    return { width, height, count, plays, poster, bits, channels, frames }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
test('Bun APNG admission copies padded pixels before return, retaining controls and bounded raw frame readback', async () => {
  const input = sample(),
    original = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const job = encodePngAnimationAsync(input)
  for (const frame of input.frames) frame.data.fill(0)
  const bytes = await job
  const result = readback(bytes)
  if (result) {
    expect([
      result.width,
      result.height,
      result.count,
      result.plays,
      result.bits,
      result.channels,
      result.poster,
    ]).toEqual([2, 2, 2, 3, 8, 3, 0])
    expect(result.frames[0].data).toEqual(original)
    expect(result.frames[1]).toEqual({
      width: 1,
      height: 1,
      x: 1,
      y: 1,
      num: 7,
      den: 0,
      dispose: 2,
      blend: 1,
      data: Buffer.from([250, 100, 10]),
    })
  }
})
for (const format of ['gray', 'rgb', 'rgba'] as const)
  for (const bits of [8, 16] as const)
    test(`APNG owned ${format}${bits} mixed endian frames and separate default image retain exact samples`, async () => {
      const channels = { gray: 1, rgb: 3, rgba: 4 }[format],
        row = 2 * channels * (bits / 8)
      const little = new Uint8Array(row),
        big = new Uint8Array(row),
        expected = new Uint8Array(row)
      for (let i = 0; i < 2 * channels; i++)
        if (bits === 8) {
          little[i] = big[i] = expected[i] = (i * 37 + 13) & 255
        } else {
          little[2 * i] = (i * 17 + 7) & 255
          little[2 * i + 1] = (i * 37 + 13) & 255
          big[2 * i] = expected[2 * i] = little[2 * i + 1]
          big[2 * i + 1] = expected[2 * i + 1] = little[2 * i]
        }
      const bytes = await encodePngAnimationAsync({
        width: 2,
        height: 1,
        defaultImage: {
          width: 2,
          height: 1,
          format,
          bits,
          endian: 'little',
          data: little,
        },
        frames: [
          {
            width: 1,
            height: 1,
            x: 1,
            format,
            bits,
            endian: 'big',
            data: big.subarray(0, row / 2),
            delayMs: 65536,
          },
          { width: 2, height: 1, format, bits, endian: 'little', data: little },
        ],
      })
      const result = readback(bytes)
      if (result) {
        expect(result.poster).toBe(1)
        expect(result.bits).toBe(bits)
        expect(result.channels).toBe(channels)
        expect(result.frames[0].data).toEqual(Buffer.from(expected))
        expect(result.frames[1].data).toEqual(
          Buffer.from(expected.subarray(0, row / 2)),
        )
        expect([result.frames[1].num, result.frames[1].den]).toEqual([
          8192, 125,
        ])
        expect(result.frames[2].data).toEqual(Buffer.from(expected))
      }
    })
test('APNG output cap failure preserves an existing file and removes private temporaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-apng-cap-')),
    path = join(dir, 'old.png')
  writeFileSync(path, 'old')
  try {
    expect(
      await rejected(
        savePngAnimationAsync(path, { ...sample(), maxOutputBytes: 16 }),
      ),
    ).toBeInstanceOf(Error)
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['old.png'])
    await savePngAnimationAsync(path, sample())
    readback(readFileSync(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('ready native APNG jobs retain bounded admission and cancelled jobs join before freeing their slot', async () => {
  const original = mutable.zc_apng_job_state_get
  let held = true,
    seen = 0
  mutable.zc_apng_job_state_get = ((...args: Parameters<typeof original>) => {
    const code = original(...args)
    if (!code && held) {
      seen++
      nativeView(args[1], 32).setUint32(8, 0, true)
    }
    return code
  }) as typeof original
  const jobs = []
  try {
    for (let i = 0; i < 4; i++) jobs.push(encodePngAnimationAsync(sample()))
    await until(() => seen >= 4)
    expect(await rejected(encodePngAnimationAsync(sample()))).toBeInstanceOf(
      Error,
    )
    const reason = Object.freeze({ stop: 'native APNG' })
    expect(jobs[0].cancel(reason)).toBe(true)
    let done = false
    void jobs[0].operationDone.then(() => (done = true))
    await pause()
    expect(done).toBe(false)
    held = false
    expect(await rejected(jobs[0])).toBe(reason)
    await Promise.all(jobs.slice(1).map((job) => job.wait()))
    await encodePngAnimationAsync(sample())
  } finally {
    held = false
    mutable.zc_apng_job_state_get = original
    for (const job of jobs) {
      job.cancel()
      await job.operationDone
    }
  }
})
test('APNG option snapshots reject detached late inputs and reject invalid shapes without native ownership', async () => {
  const input = sample(),
    first = input.frames[0].data
  const later = {
    ...input.frames[1],
    get data() {
      structuredClone(first.buffer, { transfer: [first.buffer] })
      return new Uint8Array([1, 2, 3])
    },
  }
  expect(
    await rejected(
      encodePngAnimationAsync({ ...input, frames: [input.frames[0], later] }),
    ),
  ).toBeInstanceOf(Error)
  for (const invalid of [
    { ...sample(), frames: [] },
    { ...sample(), plays: 0x80000000 },
    { ...sample(), compressLevel: 10 },
    { ...sample(), maxInputBytes: 1 },
  ]) {
    let error: unknown
    try {
      error = await rejected(encodePngAnimationAsync(invalid))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
  }
  await encodePngAnimationAsync(sample())
})
test('abort and zero deadlines reject before APNG admission or filesystem preparation', async () => {
  const controller = new AbortController(),
    reason = { before: true }
  controller.abort(reason)
  const original = mutable.zc_apng_encode_async
  let calls = 0
  mutable.zc_apng_encode_async = ((...args: Parameters<typeof original>) => {
    calls++
    return original(...args)
  }) as typeof original
  try {
    expect(
      await rejected(
        encodePngAnimationAsync(sample(), { signal: controller.signal }),
      ),
    ).toBe(reason)
    expect(
      await rejected(encodePngAnimationAsync(sample(), { timeoutMs: 0 })),
    ).toBeInstanceOf(Error)
    expect(calls).toBe(0)
  } finally {
    mutable.zc_apng_encode_async = original
  }
})
for (const mainFormat of ['BGR888', 'RGB161616', 'YUV420', 'YUYV'] as const)
  for (const stream of ['main', 'lores'] as const)
    test(`camera ${mainFormat} ${stream} animation captures sequential owned frames with native precision`, async () => {
      const wide = mainFormat === 'RGB161616',
        c = new Camera({
          simulate: true,
          width: 18,
          height: 10,
          format: mainFormat,
          fifo: true,
          lores: { width: 8, height: 6, format: wide ? 'BGR161616' : 'NV12' },
        })
      const expected: Uint8Array[] = []
      c.preCallback = (request) => {
        expected.push(
          wide
            ? new Uint8Array(request.copyRGB16(stream).buffer)
            : request.copyRGB(stream),
        )
      }
      try {
        const result = await c.capturePngAnimationAsync(3, { stream })
        expect(result.metadata).toHaveLength(3)
        expect(Object.isFrozen(result.metadata)).toBe(true)
        expect(result.metadata.map((m) => m.sequence)).toEqual([0n, 1n, 2n])
        expect(c.stats().leased).toBe(0)
        const decoded = readback(result.data)
        if (decoded) {
          expect([decoded.width, decoded.height, decoded.bits]).toEqual([
            stream === 'main' ? 18 : 8,
            stream === 'main' ? 10 : 6,
            wide ? 16 : 8,
          ])
          for (let i = 0; i < 3; i++) {
            const bytes = Buffer.from(expected[i])
            if (wide) bytes.swap16()
            expect(decoded.frames[i].data).toEqual(bytes)
          }
        }
      } finally {
        await c.close()
      }
    })
test('camera animation cancellation during native encoding joins stop and blocks mode/acquire until cleanup', async () => {
  const c = new Camera({ simulate: true, width: 16, height: 16, fifo: true }),
    original = mutable.zc_apng_job_state_get
  let held = true,
    entered = false
  mutable.zc_apng_job_state_get = ((...args: Parameters<typeof original>) => {
    const rc = original(...args)
    if (!rc && held) {
      entered = true
      nativeView(args[1], 32).setUint32(8, 0, true)
    }
    return rc
  }) as typeof original
  const job = c.capturePngAnimationAsync(2)
  try {
    await until(() => entered)
    expect(c.stats().leased).toBe(0)
    expect(() => c.acquire()).toThrow()
    expect(() => c.captureRGBAsync()).toThrow()
    expect(() => c.switchMode({ width: 32, height: 32 })).toThrow()
    const stopped = c.stop()
    let done = false
    void stopped.then(() => (done = true))
    await pause()
    expect(done).toBe(false)
    held = false
    await stopped
    expect(await rejected(job)).toBeInstanceOf(Error)
    await c.capturePngAnimationAsync(1)
  } finally {
    held = false
    mutable.zc_apng_job_state_get = original
    await job.operationDone
    await c.close()
  }
})
test('camera animation callbacks and selection are bounded, cancellation never publishes a partial file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-apng-capture-')),
    path = join(dir, 'old.png'),
    c = new Camera({ simulate: true, width: 16, height: 16, fifo: true })
  writeFileSync(path, 'old')
  let called = 0
  try {
    expect(() => c.capturePngAnimationAsync(257)).toThrow()
    expect(() => c.capturePngAnimationAsync(2, { maxInputBytes: 10 })).toThrow()
    expect(() => c.capturePngAnimationAsync(1, { bits: 16 })).toThrow()
    expect(() => c.capturePngAnimationAsync(1, { stream: 'lores' })).toThrow()
    const error = Object.freeze({ callback: 'failed' })
    expect(
      await rejected(
        c.capturePngAnimationFileAsync(path, 3, {
          dropFrames: 1,
          onFrame(frame) {
            called++
            expect(Object.isFrozen(frame.metadata)).toBe(true)
            throw error
          },
        }),
      ),
    ).toBe(error)
    expect(called).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['old.png'])
    expect(c.stats().leased).toBe(0)
    const result = await c.capturePngAnimationFileAsync(path, 2, {
      intervalMs: 2,
      delayMs: 80,
    })
    expect(result.metadata).toHaveLength(2)
    const decoded = readback(readFileSync(path))
    if (decoded)
      expect([decoded.frames[0].num, decoded.frames[0].den]).toEqual([2, 25])
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('atomic APNG publication rejects late cancellation and camera close waits for the joined file result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-apng-publish-')),
    path = join(dir, 'final.png'),
    c = new Camera({ simulate: true, width: 16, height: 16, fifo: true }),
    originalFinish = mutable.zc_image_file_finish,
    originalState = mutable.zc_image_file_state_get
  let claimed = false,
    held = true
  mutable.zc_image_file_finish = ((
    ...args: Parameters<typeof originalFinish>
  ) => {
    const rc = originalFinish(...args)
    if (!rc && args[1] === 1) claimed = true
    return rc
  }) as typeof originalFinish
  mutable.zc_image_file_state_get = ((
    ...args: Parameters<typeof originalState>
  ) => {
    const rc = originalState(...args)
    if (!rc && claimed && held) nativeView(args[1], 32).setUint32(16, 0, true)
    return rc
  }) as typeof originalState
  const job = c.capturePngAnimationFileAsync(path, 2)
  try {
    await until(() => claimed)
    expect(job.cancel({ late: true })).toBe(false)
    const closed = c.close()
    let done = false
    void closed.then(() => (done = true))
    await pause()
    expect(done).toBe(false)
    held = false
    await closed
    expect((await job).metadata).toHaveLength(2)
    readback(readFileSync(path))
  } finally {
    held = false
    mutable.zc_image_file_finish = originalFinish
    mutable.zc_image_file_state_get = originalState
    await job.operationDone
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native APNG state failures join cleanup and preserve an existing destination', async () => {
  const original = mutable.zc_apng_job_state_get,
    dir = mkdtempSync(join(tmpdir(), 'zc-apng-state-')),
    path = join(dir, 'old.png')
  writeFileSync(path, 'old')
  let fail = true
  mutable.zc_apng_job_state_get = ((...args: Parameters<typeof original>) => {
    if (fail) {
      fail = false
      return -6
    }
    return original(...args)
  }) as typeof original
  try {
    expect(
      await rejected(savePngAnimationAsync(path, sample())),
    ).toBeInstanceOf(Error)
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['old.png'])
    await encodePngAnimationAsync(sample())
  } finally {
    mutable.zc_apng_job_state_get = original
    rmSync(dir, { recursive: true, force: true })
  }
})
test('native APNG deadlines join the worker before reporting cancellation and release its slot', async () => {
  const original = mutable.zc_apng_job_state_get
  let held = true,
    entered = false
  mutable.zc_apng_job_state_get = ((...args: Parameters<typeof original>) => {
    const rc = original(...args)
    if (!rc && held) {
      entered = true
      nativeView(args[1], 32).setUint32(8, 0, true)
    }
    return rc
  }) as typeof original
  const job = encodePngAnimationAsync(sample(), { timeoutMs: 10 })
  try {
    await until(() => entered && job.cancelRequested)
    let done = false
    void job.operationDone.then(() => (done = true))
    await pause()
    expect(done).toBe(false)
    held = false
    expect(await rejected(job)).toMatchObject({ code: -3 })
    await encodePngAnimationAsync(sample())
  } finally {
    held = false
    mutable.zc_apng_job_state_get = original
    await job.operationDone
  }
})
test('camera animation capture selection drops requests per frame and keeps metadata aligned with pixels', async () => {
  const c = new Camera({ simulate: true, width: 16, height: 16, fifo: true }),
    expected = new Map<bigint, Uint8Array>()
  c.preCallback = (request) => {
    expected.set(request.sequence, request.copyRGB())
  }
  try {
    const result = await c.capturePngAnimationAsync(3, { dropFrames: 2 })
    expect(result.metadata.map((m) => m.sequence)).toEqual([2n, 5n, 8n])
    const decoded = readback(result.data)
    if (decoded)
      for (let i = 0; i < 3; i++)
        expect(decoded.frames[i].data).toEqual(
          Buffer.from(expected.get(result.metadata[i].sequence)!),
        )
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('camera animation abort between frames joins the interval and leaves the previous file untouched', async () => {
  const c = new Camera({ simulate: true, width: 16, height: 16, fifo: true }),
    dir = mkdtempSync(join(tmpdir(), 'zc-apng-interval-')),
    path = join(dir, 'old.png'),
    controller = new AbortController(),
    reason = Object.freeze({ interval: 'cancel' })
  writeFileSync(path, 'old')
  let completed = 0
  const job = c.capturePngAnimationFileAsync(path, 4, {
    signal: controller.signal,
    intervalMs: 1000,
    onFrame() {
      completed++
    },
  })
  try {
    await until(() => completed === 1)
    controller.abort(reason)
    expect(await rejected(job)).toBe(reason)
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['old.png'])
    expect(c.stats().leased).toBe(0)
    await c.capturePngAnimationAsync(1)
  } finally {
    await job.operationDone
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('pre-aborted camera animation never starts capture and admission accessors cannot use a closing camera', async () => {
  const c = new Camera({ simulate: true, width: 16, height: 16 }),
    controller = new AbortController(),
    reason = { early: 'capture' }
  controller.abort(reason)
  try {
    expect(
      await rejected(
        c.capturePngAnimationAsync(2, { signal: controller.signal }),
      ),
    ).toBe(reason)
    expect(c.stats().completed).toBe(0n)
    let closed: Promise<void> | undefined
    expect(() =>
      c.capturePngAnimationAsync(2, {
        get intervalMs() {
          closed = c.close()
          return 0
        },
      }),
    ).toThrow()
    await closed
  } finally {
    await c.close()
  }
})
test('camera animation post-callback failures prevent encoding and atomic replacement', async () => {
  const c = new Camera({ simulate: true, width: 16, height: 16 }),
    dir = mkdtempSync(join(tmpdir(), 'zc-apng-post-')),
    path = join(dir, 'old.png')
  writeFileSync(path, 'old')
  c.postCallback = () => {
    throw Error('post callback failed')
  }
  try {
    expect(
      await rejected(c.capturePngAnimationFileAsync(path, 2)),
    ).toBeInstanceOf(Error)
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['old.png'])
    expect(c.stats().leased).toBe(0)
    c.postCallback = undefined
    await c.capturePngAnimationFileAsync(path, 1)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('asynchronous animation progress callbacks reject and release capture ownership', async () => {
  const c = new Camera({ simulate: true, width: 16, height: 16 })
  try {
    expect(
      await rejected(c.capturePngAnimationAsync(2, { async onFrame() {} })),
    ).toBeInstanceOf(TypeError)
    expect(c.stats().leased).toBe(0)
    await c.capturePngAnimationAsync(1)
  } finally {
    await c.close()
  }
})
test('scoped request RGB16 and raw16 copies expire with the callback while returned words remain owned', async () => {
  const c = new Camera({
      simulate: true,
      width: 16,
      height: 16,
      format: 'BGR161616',
      raw: true,
    }),
    words: Uint16Array[] = []
  let saved: Parameters<NonNullable<typeof c.preCallback>>[0] | undefined
  c.preCallback = (request) => {
    saved = request
    words.push(request.copyRGB16(), request.copyRaw16())
  }
  try {
    await c.capturePngAnimationAsync(1)
    expect(words[0]).toHaveLength(16 * 16 * 3)
    expect(words[1]).toHaveLength(16 * 16)
    expect(() => saved!.copyRGB16()).toThrow()
    expect(() => saved!.copyRaw16()).toThrow()
    expect(words[0][0]).toBeDefined()
  } finally {
    await c.close()
  }
})

test('burst async file submissions reject bounded pressure and retire every staging owner for reuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-apng-pressure-'))
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 128 }, (_, i) =>
        savePngAnimationAsync(join(dir, `${i}.png`), sample()).wait(),
      ),
    )
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
    expect(results.some((result) => result.status === 'rejected')).toBe(true)
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: -4 })
    await savePngAnimationAsync(join(dir, 'after.png'), sample())
    readback(readFileSync(join(dir, 'after.png')))
    expect(readdirSync(dir).every((path) => path.endsWith('.png'))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('APNG compression and filter options reach native encoding without changing raster samples', async () => {
  const data = new Uint8Array(64 * 32 * 3).fill(71),
    frames = [{ width: 64, height: 32, data }]
  const plain = await encodePngAnimationAsync({
    width: 64,
    height: 32,
    frames,
    compressLevel: 0,
    pngFilter: 'none',
  })
  for (const pngFilter of [
    'adaptive',
    'none',
    'sub',
    'up',
    'average',
    'paeth',
  ] as const) {
    const compressed = await encodePngAnimationAsync({
      width: 64,
      height: 32,
      frames,
      compressLevel: 9,
      pngFilter,
    })
    expect(compressed.length).toBeLessThan(plain.length / 4)
    const decoded = readback(compressed)
    if (decoded) expect(decoded.frames[0].data).toEqual(Buffer.from(data))
  }
  const decoded = readback(plain)
  if (decoded) expect(decoded.frames[0].data).toEqual(Buffer.from(data))
})

test('internal APNG blob transfer stays cancellable until Bun value publication and frees both owners', async () => {
  const state = mutable.zc_apng_job_state_get,
    copy = mutable.zc_image_blob_copy
  let held = true,
    entered = false,
    accepted = false
  const reason = Object.freeze({ blob: 'cancel' })
  mutable.zc_apng_job_state_get = ((...args: Parameters<typeof state>) => {
    const rc = state(...args)
    if (!rc && held) {
      entered = true
      nativeView(args[1], 32).setUint32(8, 0, true)
    }
    return rc
  }) as typeof state
  const job = encodePngAnimationAsync(sample())
  try {
    await until(() => entered)
    mutable.zc_image_blob_copy = ((...args: Parameters<typeof copy>) => {
      if (!accepted) accepted = job.cancel(reason)
      return copy(...args)
    }) as typeof copy
    held = false
    expect(await rejected(job)).toBe(reason)
    expect(accepted).toBe(true)
    expect(job.value).toBeUndefined()
    mutable.zc_image_blob_copy = copy
    await encodePngAnimationAsync(sample())
  } finally {
    held = false
    mutable.zc_apng_job_state_get = state
    mutable.zc_image_blob_copy = copy
    await job.operationDone
  }
})
