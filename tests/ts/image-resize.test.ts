import { test, expect } from 'bun:test'
import {
  Camera,
  CapturedImage,
  type CaptureImageOptions,
  type ImageResample,
} from '../../ts'
const filters = [
  'nearest',
  'bilinear',
  'bicubic',
  'lanczos2',
  'lanczos3',
] as const
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
  test(`${format} main and lores capture-time image resizing retains independent pixels and provenance`, async () => {
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
      using frame = c.acquire()
      for (const stream of ['main', 'lores'] as const) {
        using original = frame.makeImage({ stream })
        for (const resample of filters) {
          using direct = original.resize(7, 3, { resample })
          using selected = frame.makeImage({
            stream,
            width: 7,
            height: 3,
            resample,
          })
          expect(selected.copyPixels()).toEqual(direct.copyPixels())
          expect(selected.sourceMetadata).toEqual(original.sourceMetadata)
          expect(selected.colorSpace).toEqual(original.colorSpace)
          expect(selected.bits).toBe(format.endsWith('161616') ? 16 : 8)
          expect(selected.stride).toBe((7 * 3 * selected.bits) / 8)
        }
        using widthOnly = frame.makeImage({
          stream,
          width: 7,
          resample: 'nearest',
        })
        using heightOnly = frame.makeImage({
          stream,
          height: 3,
          resample: 'nearest',
        })
        expect([widthOnly.width, widthOnly.height]).toEqual([
          7,
          original.height,
        ])
        expect([heightOnly.width, heightOnly.height]).toEqual([
          original.width,
          3,
        ])
        using explicitSame = frame.makeImage({
          stream,
          width: original.width,
          height: original.height,
        })
        expect(explicitSame.copyPixels()).toEqual(original.copyPixels())
      }
      using result = frame.makeImage({ width: 7, height: 3 })
      const before = result.copyPixels()
      frame.release()
      await c.close()
      Bun.gc(true)
      expect(result.copyPixels()).toEqual(before)
      expect(result.getPixel16(6, 2)[3]).toBe(65535)
    } finally {
      await c.close()
    }
  })

test('all resize filters preserve identity every low word and declared endian without aliasing', () => {
  for (const format of ['gray', 'rgb', 'rgba'] as const)
    for (const bits of [8, 16] as const)
      for (const endian of ['little', 'big'] as const) {
        const channels = format === 'gray' ? 1 : format === 'rgb' ? 3 : 4,
          data = new Uint8Array((2 * 3 * channels * bits) / 8)
        data.forEach((_, i) => {
          data[i] = (i * 37 + 13) % 256
        })
        using original = CapturedImage.fromRaster({
          data,
          width: 2,
          height: 3,
          format,
          bits,
          endian,
        })
        for (const resample of filters) {
          using identity = original.resize(2, 3, { resample })
          expect(identity.copyPixels()).toEqual(original.copyPixels())
          using nearest = original.resize(7, 5, { resample: 'nearest' })
          expect([nearest.bits, nearest.format, nearest.endian]).toEqual([
            bits,
            format,
            endian,
          ])
          for (let y = 0; y < 5; y++)
            for (let x = 0; x < 7; x++)
              expect(nearest.getPixel16(x, y)).toEqual(
                original.getPixel16(
                  Math.floor(((x + 0.5) * 2) / 7),
                  Math.floor(((y + 0.5) * 3) / 5),
                ),
              )
          const copy = identity.copyPixels()
          copy.fill(0)
          expect(identity.copyPixels()).toEqual(original.copyPixels())
        }
      }
})

test('resizing works at native integer precision and keeps transparent color out of visible edges', () => {
  for (const endian of ['little', 'big'] as const) {
    const words = new Uint8Array(4),
      d = new DataView(words.buffer)
    d.setUint16(0, 12345, endian === 'little')
    d.setUint16(2, 54321, endian === 'little')
    using image = CapturedImage.fromRaster({
      data: words,
      width: 2,
      height: 1,
      format: 'gray',
      bits: 16,
      endian,
    })
    for (const resample of filters.filter(
      (filter) => filter !== 'nearest',
    )) {
      using out = image.resize(1, 1, { resample })
      expect(out.getPixel16(0, 0)).toEqual([33333, 33333, 33333, 65535])
      using expand = out.resize(3, 7, { resample })
      expect(expand.getPixel16(2, 6)[0]).toBe(33333)
    }
  }
  using transparent = CapturedImage.fromRaster({
    data: new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255]),
    width: 2,
    height: 1,
    format: 'rgba',
  })
  for (const resample of filters.filter((filter) => filter !== 'nearest')) {
    using small = transparent.resize(1, 1, { resample })
    expect(small.getPixel(0, 0)).toEqual([0, 0, 255, 128])
  }
})

test('resize property admission validates limits before native copies and observes accessor closure', async () => {
  const c = new Camera({
    simulate: true,
    fifo: true,
    width: 18,
    height: 10,
  })
  try {
    c.start()
    using frame = c.acquire()
    for (const width of [0, -1, NaN, Infinity, 1.5, 0x80000000])
      expect(() => frame.makeImage({ width })).toThrow()
    expect(() => frame.makeImage({ width: 0x7fffffff })).toThrow()
    expect(() =>
      frame.makeImage({ resample: 'invalid' as ImageResample }),
    ).toThrow()
    let reads = 0
    using admitted = frame.makeImage({
      get width() {
        reads++
        return 3
      },
      height: 2,
    })
    expect(reads).toBe(1)
    expect(admitted.width).toBe(3)
    expect(() =>
      frame.makeImage({
        get width() {
          frame.release()
          return 3
        },
      }),
    ).toThrow()
    expect(() => c.captureImageAsync({ width: 0 })).toThrow()
    using image = CapturedImage.fromRaster({
      data: new Uint8Array([1, 2, 3]),
      width: 1,
      height: 1,
    })
    expect(() =>
      image.resize(3000000, 1, { resample: 'bilinear' }),
    ).toThrow()
    expect(image.getPixel(0, 0)).toEqual([1, 2, 3, 255])
    expect(() =>
      image.resize(2, 2, {
        get resample() {
          image.close()
          return 'bilinear' as const
        },
      }),
    ).toThrow('closed image')
  } finally {
    await c.close()
  }
})

test('async and focus-locked image capture snapshot dimensions once and return resized owned results', async () => {
  const c = new Camera({
    simulate: true,
    fifo: true,
    width: 18,
    height: 10,
    lores: { width: 10, height: 6, format: 'BGR161616' },
  })
  try {
    c.start()
    const reads = { width: 0, height: 0, resample: 0 }
    const options: CaptureImageOptions = {
      stream: 'lores',
      get width() {
        reads.width++
        return 5
      },
      get height() {
        reads.height++
        return 3
      },
      get resample() {
        reads.resample++
        return 'lanczos3' as const
      },
    }
    using image = await c.captureImageAsync(options)
    expect(reads).toEqual({ width: 1, height: 1, resample: 1 })
    expect([image.width, image.height, image.bits]).toEqual([5, 3, 16])
    c.startContinuousAutofocus()
    using locked = await c.captureFocusLockedImage({
      width: 3,
      height: 2,
      resample: 'bilinear',
    })
    expect([
      locked.width,
      locked.height,
      locked.sourceMetadata!.afState,
    ]).toEqual([3, 2, 2])
    await c.close()
    expect(locked.getPixel(2, 1)[3]).toBe(255)
  } finally {
    await c.close()
  }
})
