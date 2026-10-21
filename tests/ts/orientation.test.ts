import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  type CameraTransform,
  type ImageOrientation,
} from '../../ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const vectors: {
  transform: CameraTransform
  orientation: ImageOrientation
  width: number
  height: number
  pixels: number[][]
}[] = [
  {
    transform: {},
    orientation: 1,
    width: 3,
    height: 2,
    pixels: [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  },
  {
    transform: { hflip: true },
    orientation: 2,
    width: 3,
    height: 2,
    pixels: [
      [2, 0],
      [1, 0],
      [0, 0],
      [2, 1],
      [1, 1],
      [0, 1],
    ],
  },
  {
    transform: { rotation: 180 },
    orientation: 3,
    width: 3,
    height: 2,
    pixels: [
      [2, 1],
      [1, 1],
      [0, 1],
      [2, 0],
      [1, 0],
      [0, 0],
    ],
  },
  {
    transform: { vflip: true },
    orientation: 4,
    width: 3,
    height: 2,
    pixels: [
      [0, 1],
      [1, 1],
      [2, 1],
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  },
  {
    transform: { rotation: 90, hflip: true },
    orientation: 5,
    width: 2,
    height: 3,
    pixels: [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ],
  },
  {
    transform: { rotation: 270 },
    orientation: 6,
    width: 2,
    height: 3,
    pixels: [
      [2, 0],
      [2, 1],
      [1, 0],
      [1, 1],
      [0, 0],
      [0, 1],
    ],
  },
  {
    transform: { rotation: 90, vflip: true },
    orientation: 7,
    width: 2,
    height: 3,
    pixels: [
      [2, 1],
      [2, 0],
      [1, 1],
      [1, 0],
      [0, 1],
      [0, 0],
    ],
  },
  {
    transform: { rotation: 90 },
    orientation: 8,
    width: 2,
    height: 3,
    pixels: [
      [0, 1],
      [0, 0],
      [1, 1],
      [1, 0],
      [2, 1],
      [2, 0],
    ],
  },
]
for (const vector of vectors) {
  test(`orientation ${vector.orientation} exposes exact rectangular RGB pixels with padded mapped rows`, async () => {
    const c = new Camera({
      simulate: true,
      width: vector.width,
      height: vector.height,
      fifo: true,
      writable: true,
      transform: { ...vector.transform, strict: true },
    })
    try {
      expect(c.orientation()).toEqual({
        requested: vector.orientation,
        actual: vector.orientation,
        adjusted: false,
      })
      c.start()
      using frame = c.acquire()
      expect([...frame.copyRGB()]).toEqual(
        vector.pixels.flatMap(([r, g]) => [r, g, 0]),
      )
      frame.withMappedStream((mapped) => {
        for (let y = 0; y < vector.height; y++)
          expect([...mapped.row(y)]).toEqual(
            vector.pixels
              .slice(y * vector.width, (y + 1) * vector.width)
              .flatMap(([r, g]) => [r, g, 0]),
          )
      })
      expect(c.info()).toMatchObject({
        width: vector.width,
        height: vector.height,
      })
    } finally {
      await c.close()
    }
  })
}

test('rotation composes with output flips and invalid options reject before native ownership', async () => {
  const c = new Camera({
    simulate: true,
    width: 8,
    height: 6,
    transform: { rotation: 180, hflip: true, vflip: true },
  })
  try {
    expect(c.orientation().actual).toBe(1)
  } finally {
    await c.close()
  }
  for (const transform of [
    null,
    2,
    [],
    { rotation: 45 },
    { rotation: 360 },
    { hflip: 1 },
    { vflip: 'yes' },
    { strict: 1 },
  ]) {
    // @ts-expect-error Exercise JavaScript admission too.
    expect(() => new Camera({ simulate: true, transform })).toThrow(RangeError)
  }
})

test('Picamera2-style source flips followed by transpose map to all eight orientations', async () => {
  const expected = [1, 2, 4, 3, 5, 6, 8, 7] as const
  for (let bits = 0; bits < 8; bits++) {
    const c = new Camera({
      simulate: true,
      width: 6,
      height: 4,
      transform: {
        hflip: !!(bits & 1),
        vflip: !!(bits & 2),
        transpose: !!(bits & 4),
      },
    })
    try {
      expect(c.orientation().actual).toBe(expected[bits])
    } finally {
      await c.close()
    }
  }
})
function clockwise(bytes: Uint8Array, width: number, height: number, bpp = 1) {
  return Uint8Array.from(
    Array.from({ length: width }, (_, row) =>
      Array.from({ length: height }, (_, col) => [
        ...bytes.subarray(
          ((height - 1 - col) * width + row) * bpp,
          ((height - 1 - col) * width + row + 1) * bpp,
        ),
      ]).flat(),
    ).flat(),
  )
}
for (const rgb of [false, true]) {
  test(`paired ${rgb ? 'RGB' : 'I420'} lores planes rotate consistently with the main image`, async () => {
    const source = new Camera({
      simulate: true,
      width: 48,
      height: 64,
      fifo: true,
      lores: { width: 8, height: 16, rgb },
    })
    const output = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      fifo: true,
      lores: { width: 16, height: 8, rgb },
      transform: { rotation: 90 },
    })
    try {
      source.start()
      output.start()
      using a = source.acquire(),
        b = output.acquire()
      expect(b.copyRGB()).toEqual(clockwise(a.copyRGB(), 48, 64, 3))
      const from = a.copyStream('lores'),
        to = b.copyStream('lores')
      expect([to.width, to.height]).toEqual([16, 8])
      if (rgb) expect(to.data).toEqual(clockwise(from.data, 8, 16, 3))
      else {
        expect(to.data.subarray(0, 128)).toEqual(
          clockwise(from.data.subarray(0, 128), 8, 16),
        )
        expect(to.data.subarray(128, 160)).toEqual(
          clockwise(from.data.subarray(128, 160), 4, 8),
        )
        expect(to.data.subarray(160)).toEqual(
          clockwise(from.data.subarray(160), 4, 8),
        )
      }
    } finally {
      await source.close()
      await output.close()
    }
  })
}

test('Bayer flips update samples and CFA phase; DNG stores transformed pixels with orientation 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-orientation-'))
  const c = new Camera({
    simulate: true,
    width: 6,
    height: 4,
    raw: true,
    unpackedRaw: true,
    fifo: true,
    transform: { hflip: true },
  })
  try {
    c.start()
    using frame = c.acquire()
    const raw = frame.copyStream('raw')
    expect(raw.format).toBe('SGRBG12')
    expect(new DataView(raw.data.buffer).getUint16(0, true)).toBe(64 + 5 * 17)
    const path = join(dir, 'flipped.dng')
    frame.saveDNG(path)
    const bytes = readFileSync(path),
      offset = bytes.readUInt32LE(4),
      tags = new Map<number, number>()
    for (let i = 0; i < bytes.readUInt16LE(offset); i++) {
      const pos = offset + 2 + i * 12
      tags.set(bytes.readUInt16LE(pos), pos + 8)
    }
    expect(bytes.readUInt16LE(tags.get(274)!)).toBe(1)
    expect([...bytes.subarray(tags.get(33422)!, tags.get(33422)! + 4)]).toEqual(
      [1, 0, 2, 1],
    )
    const strip = bytes.readUInt32LE(tags.get(273)!)
    expect(bytes.subarray(strip, strip + raw.data.length)).toEqual(
      Buffer.from(raw.data),
    )
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit physical sensor modes preserve sensor geometry and negotiate transposed raw dimensions', async () => {
  const c = new Camera({
    simulate: true,
    width: 64,
    height: 48,
    raw: true,
    unpackedRaw: true,
    sensor: { width: 640, height: 480, bitDepth: 12 },
    transform: { rotation: 90 },
  })
  try {
    using request = await c.captureRequest()
    const raw = request.copyStream('raw')
    expect([raw.width, raw.height, raw.format]).toEqual([480, 640, 'SGRBG12'])
    expect(c.info()).toMatchObject({ width: 64, height: 48 })
  } finally {
    await c.close()
  }
})

test('mode jobs snapshot and inherit transforms, temporary captures restore them and explicit empty transforms reset them', async () => {
  const requested: CameraTransform = { hflip: true, strict: true }
  const c = new Camera({
    simulate: true,
    width: 16,
    height: 8,
    transform: requested,
  })
  try {
    requested.hflip = false
    c.options.transform!.hflip = false
    expect(c.orientation().actual).toBe(2)
    const target: CameraTransform = { rotation: 180, strict: true }
    const job = c.switchModeAndCaptureRGB({
      width: 32,
      height: 24,
      transform: target,
    })
    target.rotation = 0
    expect([...(await job).subarray(0, 2)]).toEqual([31, 23])
    expect(c.orientation()).toEqual({
      requested: 2,
      actual: 2,
      adjusted: false,
    })
    await c.switchMode({ width: 32, height: 24 })
    expect(c.orientation().actual).toBe(2)
    expect([...(await c.captureRGB()).subarray(0, 2)]).toEqual([31, 0])
    await c.switchMode({ width: 16, height: 8, transform: {} })
    expect(c.orientation().actual).toBe(1)
  } finally {
    await c.close()
  }
})

test('failed and cancelled mode jobs restore the prior orientation and strict policy', async () => {
  const c = new Camera({
    simulate: true,
    width: 16,
    height: 8,
    transform: { vflip: true, strict: true },
  })
  try {
    expect(
      await failure(
        c.switchMode({
          width: 32,
          height: 24,
          transform: { rotation: 90 },
          sensor: { width: 10, height: 10, bitDepth: 12 },
        }),
      ),
    ).toMatchObject({ code: -8 })
    expect(c.orientation().actual).toBe(4)
    expect(c.options.transform).toEqual({ vflip: true, strict: true })
    const cancelled = c.switchModeAndCaptureRGB({
      width: 32,
      height: 24,
      transform: { rotation: 180 },
    })
    const result = failure(cancelled)
    cancelled.cancel()
    expect(await result).toBeInstanceOf(Error)
    await cancelled.operationDone
    expect(c.orientation().actual).toBe(4)
    expect([...(await c.captureRGB()).subarray(0, 2)]).toEqual([0, 7])
  } finally {
    await c.close()
  }
})

test('coordinated recording mode switches preserve inherited orientation and accept an explicit new transform', async () => {
  const c = new Camera({
      simulate: true,
      width: 32,
      height: 24,
      transform: { hflip: true },
    }),
    r = new Recorder(null, { width: 32, height: 24 })
  try {
    const first = c.startRecording(r)
    const second = await first.switchModeAsync(
      { width: 64, height: 48 },
      {},
      null,
    )
    expect(c.orientation().actual).toBe(2)
    const third = await second.switchModeAsync(
      { width: 48, height: 64, transform: { rotation: 90 } },
      {},
      null,
    )
    expect(c.orientation().actual).toBe(8)
    expect([...(await c.captureRGB()).subarray(0, 2)]).toEqual([0, 47])
    await third.flushAsync()
    expect(third.error).toBeUndefined()
  } finally {
    await c.close()
    await r.close()
  }
})

const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview(
  'preview recreation and request hooks observe the same transformed pixels after a mode capture',
  async () => {
    const c = new Camera({
      simulate: true,
      width: 32,
      height: 24,
      transform: { hflip: true },
    })
    try {
      c.startPreview('orientation')
      let observed = false
      c.preCallback = (request) => {
        const pixels = request.copyRGB()
        if (request.width === 64 && request.height === 48) {
          expect([...pixels.subarray(0, 2)]).toEqual([63, 47])
          observed = true
        }
      }
      await c.switchModeAndCaptureRGB({
        width: 64,
        height: 48,
        transform: { rotation: 180 },
      })
      expect(observed).toBe(true)
      expect(c.orientation().actual).toBe(2)
    } finally {
      await c.close()
    }
  },
)
