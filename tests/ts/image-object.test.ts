import { test, expect } from 'bun:test'
import { Camera, CapturedImage, type ImageRaster } from '../../ts'
import { native as n } from '../../ts/ffi'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fail = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
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
    test(`${format} ${stream} image pixels metadata clones and crops outlive camera ownership`, async () => {
      const c = new Camera({
        simulate: true,
        fifo: true,
        width: 18,
        height: 10,
        format,
        lores: { width: 10, height: 6, format },
      })
      try {
        c.start()
        using f = c.acquire()
        const rgb = f.copyRGB(stream),
          image = f.makeImage({ stream }),
          width = stream === 'main' ? 18 : 10,
          height = stream === 'main' ? 10 : 6
        expect([image.width, image.height]).toEqual([width, height])
        expect(image.bits).toBe(format.endsWith('161616') ? 16 : 8)
        expect(image.sourceMetadata!.sequence).toBe(f.sequence)
        expect(Object.isFrozen(image.sourceMetadata!.crop)).toBe(true)
        f.release()
        await c.close()
        using clone = image.clone()
        using reduced = image.convert({ bits: 8 })
        using rgba = image.convert({
          format: 'rgba',
          bits: 16,
          endian: 'big',
        })
        using crop = image.crop(1, 1, 3, 2)
        expect(Buffer.from(reduced.copyPixels())).toEqual(Buffer.from(rgb))
        expect(clone.copyPixels()).toEqual(image.copyPixels())
        expect(crop.getPixel16(0, 0)).toEqual(image.getPixel16(1, 1))
        expect(rgba.getPixel16(1, 1)).toEqual(image.getPixel16(1, 1))
        const before = clone.copyPixels()
        const mutable = image.copyPixels()
        mutable.fill(0)
        image.close()
        expect(clone.copyPixels()).toEqual(before)
        expect(() => image.encode({ format: 'png' })).toThrow(
          'closed image',
        )
        expect(crop.getPixel(0, 0)).toEqual(rgba.getPixel(1, 1))
      } finally {
        await c.close()
      }
    })
test('raw raster conversion handles all color/depth/word orders and owns admission pixels', () => {
  for (const format of ['gray', 'rgb', 'rgba'] as const)
    for (const bits of [8, 16] as const)
      for (const endian of ['little', 'big'] as const) {
        const ch = format === 'gray' ? 1 : format === 'rgb' ? 3 : 4,
          stride = ch * (bits / 8) * 2 + 3,
          data = new Uint8Array(stride + ch * (bits / 8) * 2),
          d = new DataView(data.buffer)
        const samples = [
          [0x1234, 0x8001, 0xfedc, 0x4567],
          [1, 255, 256, 65535],
          [0x2345, 0x6789, 0xabcd, 0x0123],
          [65535, 0, 0xdead, 0xbeef],
        ]
        for (let i = 0; i < 4; i++)
          for (let c = 0; c < ch; c++) {
            const at =
              Math.floor(i / 2) * stride + ((i % 2) * ch + c) * (bits / 8)
            if (bits === 8) data[at] = samples[i][c] >> 8
            else d.setUint16(at, samples[i][c], endian === 'little')
          }
        using image = CapturedImage.fromRaster({
          data,
          width: 2,
          height: 2,
          stride,
          format,
          bits,
          endian,
        })
        data.fill(0)
        for (const target of ['gray', 'rgb', 'rgba'] as const)
          for (const targetBits of [8, 16] as const)
            for (const targetOrder of ['little', 'big'] as const) {
              using out = image.convert({
                format: target,
                bits: targetBits,
                endian: targetOrder,
              })
              for (let i = 0; i < 4; i++) {
                const source = Array.from({ length: 4 }, (_, c) =>
                  c === 3 && format !== 'rgba'
                    ? 65535
                    : bits === 8
                      ? (samples[i][format === 'gray' ? 0 : c] >> 8) * 257
                      : samples[i][format === 'gray' ? 0 : c],
                )
                if (target === 'gray') {
                  const shift = bits === 8 ? 8 : 0
                  const gray =
                    Math.floor(
                      ((source[0] >> shift) * 299 +
                        (source[1] >> shift) * 587 +
                        (source[2] >> shift) * 114) /
                        1000,
                    ) * (bits === 8 ? 257 : 1)
                  source[0] = source[1] = source[2] = gray
                }
                if (target !== 'rgba') source[3] = 65535
                const expected =
                  targetBits === 8
                    ? source.map((v) => (v >> 8) * 257)
                    : source
                expect(
                  Array.from(out.getPixel16(i % 2, Math.floor(i / 2))),
                ).toEqual(expected)
              }
            }
      }
})
const decoded = process.env.ZC_PIXEL_DECODER ? test : test.skip
decoded(
  'independent libpng retains every gray/RGB/RGBA sample alpha and word across image-object encoding',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-object-png-'))
    try {
      for (const format of ['gray', 'rgb', 'rgba'] as const)
        for (const bits of [8, 16] as const)
          for (const endian of ['little', 'big'] as const) {
            const channels =
                format === 'gray' ? 1 : format === 'rgb' ? 3 : 4,
              data = new Uint8Array(6 * channels * (bits / 8)),
              d = new DataView(data.buffer)
            for (let i = 0; i < 6 * channels; i++) {
              const value = (i * 7919 + 0x1234) & 65535
              if (bits === 8) data[i] = value >> 8
              else d.setUint16(i * 2, value, endian === 'little')
            }
            using image = CapturedImage.fromRaster({
              data,
              width: 3,
              height: 2,
              format,
              bits,
              endian,
            })
            const path = join(dir, `${format}-${bits}-${endian}.png`)
            image.save(path)
            const result = Bun.spawnSync([
              process.env.ZC_PIXEL_DECODER!,
              path,
            ])
            expect(new TextDecoder().decode(result.stderr)).toBe('')
            expect(result.exitCode).toBe(0)
            const out = Buffer.from(result.stdout)
            expect(out.subarray(0, 4).toString()).toBe('ZCPI')
            expect([
              out.readUInt32BE(4),
              out.readUInt32BE(8),
              out.readUInt32BE(12),
              out.readUInt32BE(16),
            ]).toEqual([3, 2, bits, channels])
            const expected = Buffer.from(data)
            if (bits === 16 && endian === 'little') expected.swap16()
            expect(out.subarray(20)).toEqual(expected)
          }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
test('captured image jobs and scoped callback copies retain private pixels through CAF restoration', async () => {
  const c = new Camera({
    simulate: true,
    width: 18,
    height: 10,
    fifo: true,
  })
  let callbackImage: CapturedImage | undefined,
    scope: Parameters<NonNullable<Camera['postCallback']>>[0] | undefined
  try {
    c.postCallback = (request) => {
      scope = request
      callbackImage ??= request.makeImage()
    }
    using image = await c.captureImage()
    expect(c.stats().leased).toBe(0)
    expect(() => scope!.makeImage()).toThrow()
    c.setRequestCallbacks({})
    c.startContinuousAutofocus()
    using locked = await c.captureFocusLockedImage()
    expect(locked.sourceMetadata!.afState).toBe(2)
    await c.close()
    expect(image.getPixel(0, 0).length).toBe(4)
    expect(callbackImage!.getPixel(0, 0).length).toBe(4)
  } finally {
    callbackImage?.close()
    await c.close()
  }
})
test('image object admission rejects detached inputs bounds unsupported metadata and accessor closure', async () => {
  const data = new Uint8Array([1, 2, 3])
  const source: ImageRaster = {
    data,
    width: 1,
    height: 1,
    get endian() {
      structuredClone(data.buffer, { transfer: [data.buffer] })
      return 'little' as const
    },
  }
  expect(() => CapturedImage.fromRaster(source)).toThrow()
  using image = CapturedImage.fromRaster({
    data: new Uint8Array([1, 2, 3]),
    width: 1,
    height: 1,
  })
  expect(() => image.crop(1, 0, 1, 1)).toThrow()
  expect(() => image.getPixel(1, 0)).toThrow()
  expect(() => image.encode({ format: 'dng' })).toThrow()
  expect(() => image.encode({ exif: true })).toThrow()
  using rgba = image.convert({ format: 'rgba' })
  expect(() => rgba.encode()).toThrow()
  expect(() =>
    image.encode({
      get quality() {
        image.close()
        return 98
      },
    }),
  ).toThrow('closed image')
})
test('image save jobs cancel before staging and remain independent after source close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-image-save-')),
    path = join(dir, 'photo.png'),
    marker = Error('cancel image save')
  using image = CapturedImage.fromRaster({
    data: new Uint8Array([1, 2, 3]),
    width: 1,
    height: 1,
  })
  try {
    writeFileSync(path, 'original')
    const cancelled = image.saveAsync(path)
    expect(cancelled.cancel(marker)).toBe(true)
    expect(await fail(cancelled)).toBe(marker)
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['photo.png'])
    const job = image.saveAsync(path)
    image.close()
    Bun.gc(true)
    await job
    expect(readFileSync(path).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    expect(readdirSync(dir)).toEqual(['photo.png'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('image native publication rejects late cancellation and joins I/O before completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-image-claim-')),
    path = join(dir, 'photo.png'),
    finish = n.zc_image_file_finish
  using image = CapturedImage.fromRaster({
    data: new Uint8Array([1, 2, 3]),
    width: 1,
    height: 1,
  })
  let job: ReturnType<CapturedImage['saveAsync']>,
    observed = false
  try {
    Object.assign(n, {
      zc_image_file_finish: (...args: Parameters<typeof finish>) => {
        const rc = finish(...args)
        if (args[1] === 1 && rc === 0) {
          observed = true
          expect(job.cancel()).toBe(false)
          image.close()
        }
        return rc
      },
    })
    job = image.saveAsync(path)
    await job
    expect(observed).toBe(true)
    expect(readFileSync(path).length).toBeGreaterThan(20)
  } finally {
    Object.assign(n, { zc_image_file_finish: finish })
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!process.env.ZC_EXIF_READER)(
  'image objects embed explicit Exif and declared RGB ICC without inventing request fields',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-object-exif-'))
    using image = CapturedImage.fromRaster({
      data: new Uint8Array([1, 2, 3, 4, 5, 6]),
      width: 2,
      height: 1,
      colorSpace: {
        present: true,
        primaries: 'rec709',
        transfer: 'srgb',
        ycbcrEncoding: 'none',
        range: 'full',
      },
    })
    try {
      for (const format of ['jpeg', 'png', 'tiff'] as const) {
        const path = join(dir, `explicit.${format}`)
        image.save(path, {
          format,
          iccProfile: 'srgb',
          exif: { artist: 'Image Object', description: 'Owned pixels' },
        })
        const result = Bun.spawnSync([
          process.env.ZC_EXIF_READER!,
          format,
          path,
        ])
        expect(result.exitCode).toBe(0)
        const meta = JSON.parse(result.stdout.toString())
        expect(meta.artist).toBe('Image Object')
      }
      using gray = image.convert({ format: 'gray' })
      expect(() =>
        gray.encode({ format: 'png', iccProfile: 'srgb' }),
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
test('image objects encode all compatible still formats and preserve destinations on format rejection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-object-still-')),
    path = join(dir, 'kept.jpg')
  using base = CapturedImage.fromRaster({
    data: new Uint8Array([1, 2, 3, 4, 5, 6]),
    width: 2,
    height: 1,
  })
  try {
    for (const mode of ['gray', 'rgb', 'rgba'] as const)
      for (const bits of [8, 16] as const) {
        using image = base.convert({ format: mode, bits, endian: 'big' })
        for (const format of [
          'jpeg',
          'png',
          'bmp',
          'tiff',
          'ppm',
          'gif',
        ] as const) {
          if (mode === 'rgba' && (format === 'jpeg' || format === 'ppm'))
            continue
          const bytes = image.encode({ format })
          expect(bytes.length).toBeGreaterThan(12)
          const output = join(dir, `${mode}-${bits}.${format}`)
          image.save(output, { format })
          expect(readFileSync(output)).toEqual(Buffer.from(bytes))
        }
      }
    writeFileSync(path, 'keep')
    using rgba = base.convert({ format: 'rgba' })
    expect(() => rgba.save(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('keep')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('image save bursts reuse bounded native file admission without orphan temporaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-image-pressure-'))
  using image = CapturedImage.fromRaster({
    data: new Uint8Array([1, 2, 3]),
    width: 1,
    height: 1,
  })
  try {
    const jobs = Array.from({ length: 64 }, (_, i) =>
      image.saveAsync(join(dir, `${i}.png`)),
    )
    const results = await Promise.all(jobs.map(fail))
    expect(results.filter((error) => error === undefined).length).toBe(32)
    expect(results.filter((error) => error?.code === -4).length).toBe(32)
    expect(readdirSync(dir).every((name) => name.endsWith('.png'))).toBe(
      true,
    )
    await image.saveAsync(join(dir, 'reused.png'))
    expect(readFileSync(join(dir, 'reused.png')).length).toBeGreaterThan(20)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('owned capture uses native geometry rather than mutable public request bytes', async () => {
  const c = new Camera({
    simulate: true,
    width: 18,
    height: 10,
    fifo: true,
  })
  try {
    c.start()
    using frame = c.acquire()
    new DataView(
      frame.descriptor.buffer,
      frame.descriptor.byteOffset,
      frame.descriptor.byteLength,
    ).setUint32(40, 1000, true)
    using image = frame.makeImage()
    expect([
      image.width,
      image.height,
      image.copyPixels().byteLength,
    ]).toEqual([18, 10, 540])
    frame.release()
    await c.close()
    expect(image.getPixel(1, 1).length).toBe(4)
  } finally {
    await c.close()
  }
})
