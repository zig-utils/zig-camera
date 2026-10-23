import { expect, test } from 'bun:test'
import {
  Camera,
  type ImageFormat,
  type PngFilter,
  type ImageOptions,
} from '../../ts'
import { native as ffi } from '../../ts/ffi'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cam = (width = 17, height = 9) =>
  new Camera({
    simulate: true,
    width,
    height,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    writable: true,
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const formats: ImageFormat[] = ['jpeg', 'png', 'bmp', 'tiff', 'ppm', 'dng', 'gif']
function signature(bytes: Uint8Array, format: ImageFormat) {
  const expected: Record<string, number[]> = {
    jpeg: [255, 216],
    png: [137, 80, 78, 71, 13, 10, 26, 10],
    bmp: [66, 77],
    tiff: [73, 73, 42, 0],
    ppm: [80, 54, 10],
    dng: [73, 73, 42, 0],
    gif: [71, 73, 70, 56, 57, 97],
  }
  expect([...bytes.subarray(0, expected[format].length)]).toEqual(
    expected[format],
  )
  expect(bytes.length).toBeGreaterThan(expected[format].length)
}
for (const format of formats) {
  test(`owned ${format} bytes and file output survive request/camera release`, async () => {
    const c = cam(),
      dir = mkdtempSync(join(tmpdir(), 'zc-image-'))
    try {
      c.start()
      using frame = c.acquire()
      const bytes = frame.encodeImage({ format }),
        path = join(dir, `photo.${format}`)
      frame.saveFile(path, { format })
      signature(bytes, format)
      signature(readFileSync(path), format)
      if (format !== 'jpeg')
        expect(Buffer.from(bytes)).toEqual(readFileSync(path))
      const copy = bytes.slice()
      frame.release()
      await c.close()
      expect(bytes).toEqual(copy)
      expect(() => frame.encodeImage({ format })).toThrow()
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
const decoder = process.env.ZC_IMAGE_DECODER
test('retained requests remain encodable after camera stop without restarting or recycling their input', async () => {
  const c = cam()
  const request = await c.captureRequest()
  try {
    await c.stop()
    expect(c.stats().leased).toBe(1)
    signature(request.encodeImage({ format: 'png' }), 'png')
    expect(request.referenceCount).toBe(1)
    request.release()
    expect(c.stats().leased).toBe(0)
  } finally {
    request.release()
    await c.close()
  }
})
const independent = decoder ? test : test.skip
for (const format of ['png', 'bmp', 'tiff'] as const) {
  independent(
    `independent ${format} decoding preserves edited strided RGB pixels exactly`,
    async () => {
      const c = cam(),
        dir = mkdtempSync(join(tmpdir(), 'zc-decode-'))
      try {
        c.start()
        using frame = c.acquire()
        frame.withMappedStream((mapped) => {
          mapped.planes[0].bytes.fill(0xa7)
          for (let y = 0; y < frame.height; y++) {
            const row = mapped.row(y)
            for (let x = 0; x < frame.width; x++) {
              row[x * 3] = (x * 31 + y * 7) & 255
              row[x * 3 + 1] = (y * 29 + x * 3) & 255
              row[x * 3 + 2] = (x * 17 + y * 19) & 255
            }
          }
        })
        const path = join(dir, `frame.${format}`),
          expected = frame.copyRGB()
        const filters: PngFilter[] =
          format === 'png'
            ? ['adaptive', 'none', 'sub', 'up', 'average', 'paeth']
            : ['adaptive']
        for (const filter of filters)
          for (const level of format === 'png' ? [0, 1, 6, 9] : [1]) {
            frame.saveFile(path, {
              format,
              compressLevel: level,
              pngFilter: filter,
            })
            const result = Bun.spawnSync([decoder!, format, path])
            expect(result.exitCode).toBe(0)
            const data = Buffer.from(result.stdout)
            expect([data.readUInt32LE(0), data.readUInt32LE(4)]).toEqual([
              frame.width,
              frame.height,
            ])
            expect(data.subarray(8)).toEqual(Buffer.from(expected))
          }
      } finally {
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
}
independent(
  'large uncompressed PNG streams across multiple IDAT chunks and deflate blocks',
  async () => {
    const c = cam(169, 129),
      dir = mkdtempSync(join(tmpdir(), 'zc-idat-'))
    try {
      c.start()
      using frame = c.acquire()
      const path = join(dir, 'large.png')
      frame.saveFile(path, { compressLevel: 0, pngFilter: 'none' })
      const bytes = readFileSync(path)
      let at = 8,
        idats = 0
      while (at < bytes.length) {
        const n = bytes.readUInt32BE(at)
        if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') idats++
        at += 12 + n
      }
      expect(idats).toBeGreaterThan(2)
      const result = Bun.spawnSync([decoder!, 'png', path])
      expect(result.exitCode).toBe(0)
      expect(Buffer.from(result.stdout).subarray(8)).toEqual(
        Buffer.from(frame.copyRGB()),
      )
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
test('extension aliases and explicit formats share owned option snapshots in capture jobs', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-formats-'))
  try {
    const source: ImageOptions = {
      format: 'png',
      compressLevel: 0,
      pngFilter: 'up',
    }
    const job = c.captureEncodedImageAsync(source)
    source.format = 'bmp'
    source.compressLevel = 10
    signature(await job, 'png')
    expect(c.stats().leased).toBe(0)
    for (const suffix of [
      'png',
      'BMP',
      'tif',
      'tiff',
      'ppm',
      'jpg',
      'jpeg',
      'dng',
    ]) {
      const path = join(dir, `capture.${suffix}`)
      const meta = await c.captureFile(path)
      expect(meta.sequence).toBeGreaterThan(0n)
      expect(readFileSync(path).length).toBeGreaterThan(10)
    }
    const path = join(dir, 'explicit.data')
    await c.captureFile(path, { format: 'PNG' })
    signature(readFileSync(path), 'png')
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('invalid formats, PNG settings and pre-aborted capture jobs do not acquire frames or change files', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-invalid-image-'))
  try {
    const path = join(dir, 'safe.png')
    writeFileSync(path, 'sentinel')
    const before = c.stats().delivered
    for (const settings of [
      { compressLevel: -1 },
      { compressLevel: 10 },
      { compressLevel: NaN },
      { pngFilter: 'unknown' },
      { format: 'webp' },
      { format: 'jpeg', quality: 0 },
    ]) {
      // @ts-expect-error Exercise JavaScript validation too.
      expect(() => c.captureFileAsync(path, settings)).toThrow()
    }
    expect(() => c.captureFileAsync(join(dir, 'unknown.ext'))).toThrow(
      'image format',
    )
    const controller = new AbortController()
    controller.abort(Error('no capture'))
    expect(
      await failure(
        c.captureEncodedImageAsync({
          format: 'png',
          signal: controller.signal,
        }),
      ),
    ).toBe(controller.signal.reason)
    expect(c.stats().delivered).toBe(before)
    expect(readFileSync(path, 'utf8')).toBe('sentinel')
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('exclusive pixel mappings block image reads without publishing files; releasing the map restores encoding', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-mapped-image-'))
  try {
    c.start()
    using frame = c.acquire()
    frame.withMappedStream(() => {
      expect(() => frame.encodeImage({ format: 'png' })).toThrow('(-4)')
      expect(() => frame.saveFile(join(dir, 'blocked.bmp'))).toThrow('(-4)')
    })
    expect(readdirSync(dir)).toEqual([])
    signature(frame.encodeImage({ format: 'png' }), 'png')
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('focus-locked file and encoded captures restore continuous AF before result publication', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-focus-image-'))
  try {
    c.startContinuousAutofocus()
    for (const format of formats) {
      const metadata = await c.captureFocusLockedFile(
        join(dir, `focus.${format}`),
      )
      expect([metadata.afState, metadata.afPauseState]).toEqual([2, 2])
      signature(await c.captureFocusLockedEncodedImage({ format }), format)
    }
    expect(await c.autofocusPause()).toBe(3)
    expect(await c.autofocusResume()).toBe(3)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('temporary mode file/encoded captures restore orientation, raw configuration and reusable jobs', async () => {
  const c = new Camera({
      simulate: true,
      width: 17,
      height: 9,
      transform: { hflip: true },
    }),
    dir = mkdtempSync(join(tmpdir(), 'zc-mode-image-'))
  try {
    for (const format of formats) {
      const result = await c.switchModeAndCaptureEncodedImage(
        { width: 32, height: 24, transform: { rotation: 180 } },
        { format, dropFrames: 2 },
      )
      signature(result, format)
      await c.switchModeAndCaptureFile(
        { width: 32, height: 24 },
        join(dir, `mode.${format}`),
      )
      expect(c.info()).toMatchObject({ width: 17, height: 9 })
      expect(c.orientation().actual).toBe(2)
      expect(c.options.raw).toBeUndefined()
      expect(c.stats().leased).toBe(0)
    }
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('file failures preserve existing outputs and release camera/worker ownership', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-failed-image-'))
  try {
    const target = join(dir, 'parent-missing', 'image.png')
    expect(await failure(c.captureFileAsync(target))).toMatchObject({
      code: -6,
    })
    expect(
      await failure(
        c.switchModeAndCaptureFile({ width: 32, height: 24 }, target),
      ),
    ).toMatchObject({ code: -6 })
    expect(c.info()).toMatchObject({ width: 17, height: 9 })
    expect(c.stats().leased).toBe(0)
    expect(readdirSync(dir)).toEqual([])
    signature(await c.captureEncodedImage({ format: 'bmp' }), 'bmp')
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('atomic replacement failures retire temporary files for every encoder including system JPEG', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-image-commit-'))
  try {
    c.start()
    using frame = c.acquire()
    const expected: string[] = []
    for (const format of formats) {
      const name = `directory.${format}`,
        path = join(dir, name)
      mkdirSync(path)
      expected.push(name)
      expect(() => frame.saveFile(path, { format })).toThrow('(-6)')
      expect(readdirSync(dir).sort()).toEqual([...expected].sort())
    }
    expect(frame.referenceCount).toBe(1)
    signature(frame.encodeImage({ format: 'jpeg' }), 'jpeg')
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('request callbacks can save and encode owned images while scoped views still expire', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-hook-image-'))
  let escaped: Parameters<NonNullable<typeof c.preCallback>>[0] | undefined,
    encoded: Uint8Array | undefined
  try {
    c.preCallback = (request) => {
      escaped = request
      encoded = request.encodeImage({ format: 'png' })
      request.saveFile(join(dir, 'hook.bmp'))
    }
    await c.captureMetadata()
    signature(encoded!, 'png')
    signature(readFileSync(join(dir, 'hook.bmp')), 'bmp')
    expect(() => escaped!.encodeImage()).toThrow()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('owned image copying disposes its native blob if the copy operation fails', async () => {
  const c = cam(),
    native: {
      zc_image_blob_copy: (
        ...args: Parameters<typeof ffi.zc_image_blob_copy>
      ) => number
      zc_image_blob_close: (
        ...args: Parameters<typeof ffi.zc_image_blob_close>
      ) => void
    } = ffi
  const copy = native.zc_image_blob_copy,
    close = native.zc_image_blob_close
  let calls = 0,
    closed = 0
  try {
    c.start()
    using frame = c.acquire()
    native.zc_image_blob_copy = (...args) =>
      ++calls === 2 ? -6 : copy(...args)
    native.zc_image_blob_close = (...args) => {
      closed++
      close(...args)
    }
    expect(() => frame.encodeImage({ format: 'png' })).toThrow()
    expect(closed).toBe(1)
    expect(frame.referenceCount).toBe(1)
    native.zc_image_blob_copy = copy
    native.zc_image_blob_close = close
    signature(frame.encodeImage({ format: 'png' }), 'png')
  } finally {
    native.zc_image_blob_copy = copy
    native.zc_image_blob_close = close
    await c.close()
  }
})
