import { expect, test } from 'bun:test'
import {
  Camera,
  alignStream,
  alignConfiguration,
  type CameraOptions,
} from '../../ts'
import { native as n, storage, ptr, view } from '../../ts/ffi'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
test('PiSP and VC4 stream planning follows planar and wide format recipes', () => {
  for (const [platform, packed, planar, wide] of [
    ['pisp', 1856, 1792, 1888],
    ['vc4', 1888, 1856, 1904],
  ] as const) {
    for (const format of ['BGR888', 'RGB888', 'RGB565', 'YUYV', 'MJPEG'])
      expect(
        alignStream({ width: 1919, height: 1081, format }, { platform }),
      ).toEqual({
        width: packed,
        height: 1080,
        format,
        widthAlignment: platform === 'pisp' ? 64 : 32,
        heightAlignment: 2,
      })
    for (const format of ['YUV420', 'YVU420'])
      expect(
        alignStream({ width: 1919, height: 1081, format }, { platform }).width,
      ).toBe(planar)
    for (const format of ['XBGR8888', 'XRGB8888', 'RGB161616', 'BGR161616'])
      expect(
        Camera.alignStream({ width: 1919, height: 1081, format }, { platform })
          .width,
      ).toBe(wide)
    for (const format of ['BGR888', 'YUV420', 'XRGB8888', 'RGB161616'])
      expect(
        alignStream(
          { width: 1919, height: 1081, format },
          { platform, optimal: false },
        ),
      ).toEqual({
        width: 1918,
        height: 1080,
        format,
        widthAlignment: 2,
        heightAlignment: 2,
      })
  }
  expect(
    alignStream({ width: 1919, height: 1081, format: 'BGR888' }).width,
  ).toBe(1856)
})
test('stream planning remains exact and idempotent at the maximum unsigned extent', () => {
  const plan = alignStream({
    width: 0xffffffff,
    height: 0xffffffff,
    format: 'BGR888',
  })
  expect(plan).toEqual({
    width: 4294967232,
    height: 4294967294,
    format: 'BGR888',
    widthAlignment: 64,
    heightAlignment: 2,
  })
  expect(alignStream(plan)).toEqual(plan)
})
test('configuration planning owns nested values, fixes odd YUV dimensions and preserves raw modes', () => {
  const source: CameraOptions = {
    simulate: true,
    width: 1919,
    height: 1081,
    format: 'YUV420',
    buffers: 6,
    fifo: true,
    raw: true,
    rawFormat: 'SRGGB12',
    unpackedRaw: true,
    role: 'still',
    sensor: { width: 4056, height: 3040, bitDepth: 12 },
    lores: { width: 641, height: 481, rgb: true },
    transform: { rotation: 90, hflip: true, strict: true },
    colorSpace: {
      primaries: 'rec709',
      transfer: 'rec709',
      ycbcrEncoding: 'rec709',
      range: 'limited',
    },
    strictColorSpace: true,
    writable: true,
  }
  const snapshot = structuredClone(source),
    aligned = Camera.alignConfiguration(source)
  expect(source).toEqual(snapshot)
  expect(aligned).toEqual({
    ...snapshot,
    width: 1792,
    height: 1080,
    lores: { width: 640, height: 480, rgb: true },
  })
  expect(aligned.sensor).not.toBe(source.sensor)
  expect(aligned.transform).not.toBe(source.transform)
  expect(aligned.lores).not.toBe(source.lores)
  expect(aligned.colorSpace).not.toBe(source.colorSpace)
  source.sensor!.width = 1024
  source.transform!.rotation = 180
  source.lores!.width = 300
  expect(aligned.sensor!.width).toBe(4056)
  expect(aligned.transform!.rotation).toBe(90)
  expect(aligned.lores!.width).toBe(640)
  expect(alignConfiguration(aligned)).toEqual(aligned)
})
test('automatic dimensions and disabled lores remain automatic while explicit lores can be aligned alone', () => {
  const automatic = alignConfiguration({ raw: true, unpackedRaw: true })
  expect(automatic.width).toBeUndefined()
  expect(automatic.height).toBeUndefined()
  expect(
    alignConfiguration({ width: 0, height: 0, lores: { width: 0, height: 0 } }),
  ).toMatchObject({ width: 0, height: 0, lores: { width: 0, height: 0 } })
  const loresOnly = alignConfiguration({ lores: { width: 641, height: 481 } })
  expect(loresOnly.width).toBeUndefined()
  expect(loresOnly.lores).toEqual({ width: 640, height: 480 })
})
test('planning snapshots documented getters once and does not borrow mutable caller geometry', () => {
  const reads = { width: 0, height: 0, format: 0, platform: 0, optimal: 0 },
    stream = {
      get width() {
        reads.width++
        return 1919
      },
      get height() {
        reads.height++
        return 1081
      },
      get format() {
        reads.format++
        return 'YUV420'
      },
    },
    options = {
      get platform() {
        reads.platform++
        return 'pisp' as const
      },
      get optimal() {
        reads.optimal++
        return true
      },
    }
  expect(alignStream(stream, options).width).toBe(1792)
  expect(reads).toEqual({
    width: 1,
    height: 1,
    format: 1,
    platform: 1,
    optimal: 1,
  })
  const lores = { width: 641, height: 481 }
  const planned = alignConfiguration(
    { width: 1919, height: 1081, lores },
    {
      get platform() {
        lores.width = 1
        return 'pisp' as const
      },
    },
  )
  expect(planned.lores).toEqual({ width: 640, height: 480 })
})
test('static planning is independent of active camera leases and never mutates running geometry', async () => {
  const c = new Camera({ simulate: true, width: 12, height: 8, fifo: true })
  try {
    c.start()
    using frame = c.acquire()
    const stats = c.stats()
    const plan = Camera.alignConfiguration({ width: 1919, height: 1081 })
    expect(plan.width).toBe(1856)
    expect(c.info()).toMatchObject({ width: 12, height: 8 })
    expect(c.stats()).toEqual(stats)
    expect(frame.copyRGB().length).toBe(12 * 8 * 3)
  } finally {
    await c.close()
  }
})
for (const [
  platform,
  optimal,
  format,
  loresWidth,
  expectedWidth,
  expectedLores,
] of [
  ['pisp', true, 'BGR888', 129, 128, 128],
  ['vc4', true, 'YUV420', 97, 128, 64],
  ['pisp', false, 'YUV420', 99, 190, 98],
] as const)
  test(`aligned ${format} ${platform} optimal=${optimal} configurations capture paired streams and decoded PNG`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-aligned-')),
      planned = alignConfiguration(
        {
          simulate: true,
          width: 191,
          height: 101,
          format,
          fifo: true,
          raw: true,
          unpackedRaw: true,
          lores: { width: loresWidth, height: 65 },
        },
        { platform, optimal },
      ),
      c = new Camera(planned)
    try {
      const bundle = await c.captureStreams(['main', 'lores', 'raw'])
      expect(bundle.streams.main).toMatchObject({
        width: expectedWidth,
        height: 100,
        format,
      })
      expect(bundle.streams.lores).toMatchObject({
        width: expectedLores,
        height: 64,
      })
      expect(bundle.streams.raw).toMatchObject({
        width: expectedWidth,
        height: 100,
      })
      const path = join(dir, 'aligned.png')
      await c.captureFile(path)
      const image = readFileSync(path)
      expect(image.readUInt32BE(16)).toBe(expectedWidth)
      expect(image.readUInt32BE(20)).toBe(100)
      if (process.env.ZC_IMAGE_DECODER) {
        const decoded = Bun.spawnSync([
          process.env.ZC_IMAGE_DECODER,
          'png',
          path,
        ])
        expect(decoded.exitCode).toBe(0)
        const bytes = Buffer.from(decoded.stdout)
        expect([bytes.readUInt32LE(0), bytes.readUInt32LE(4)]).toEqual([
          expectedWidth,
          100,
        ])
      }
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
test('aligned target configurations work through temporary mode restoration and retained capture-and-stop', async () => {
  const c = new Camera({ simulate: true, width: 12, height: 8, fifo: true }),
    previous = c.options,
    target = alignConfiguration({
      width: 191,
      height: 101,
      format: 'YUV420',
      fifo: true,
      raw: true,
      unpackedRaw: true,
      lores: { width: 129, height: 65 },
    })
  try {
    const paired = await c.switchModeAndCaptureStreams(target, [
      'main',
      'lores',
      'raw',
    ])
    expect(paired.streams.main).toMatchObject({
      width: 128,
      height: 100,
      format: 'YUV420',
    })
    expect(c.info()).toMatchObject({ width: 12, height: 8 })
    using request = await c.switchModeCaptureRequestAndStop(target)
    expect(request.copyStream('lores')).toMatchObject({
      width: 128,
      height: 64,
    })
    request.release()
    await c.switchMode(previous)
    expect(c.info()).toMatchObject({ width: 12, height: 8 })
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('invalid and empty alignment rejects instead of selecting unintended backend defaults', () => {
  for (const value of [-1, NaN, Infinity, 0x100000000, 1.5]) {
    expect(() =>
      alignStream({ width: value, height: 480, format: 'BGR888' }),
    ).toThrow()
    expect(() =>
      alignStream({ width: 640, height: value, format: 'BGR888' }),
    ).toThrow()
  }
  for (const [width, height] of [
    [0, 480],
    [640, 0],
    [63, 2],
    [640, 1],
  ])
    expect(() => alignStream({ width, height, format: 'BGR888' })).toThrow()
  for (const format of ['', 'x'.repeat(32), '\0', '\ud800'])
    expect(() => alignStream({ width: 640, height: 480, format })).toThrow()
  for (const options of [
    null,
    [],
    true,
    { platform: 'automatic' },
    { optimal: 'yes' },
  ])
    expect(() =>
      alignStream(
        { width: 640, height: 480, format: 'BGR888' },
        options as never,
      ),
    ).toThrow()
  for (const config of [
    { width: 191 },
    { width: 1, height: 3 },
    { width: 191, height: 101, lores: { width: 1, height: 3 } },
    { width: 20000, height: 20000 },
  ])
    expect(() => alignConfiguration(config)).toThrow()
  // A stream planning label does not add that format to camera/encoder support.
  expect(
    alignStream({ width: 1919, height: 1081, format: 'RGB161616' }).width,
  ).toBe(1888)
  expect(() =>
    alignConfiguration({
      width: 1919,
      height: 1081,
      format: 'RGB161616' as never,
    }),
  ).toThrow('invalid main stream format')
})
test('native configuration preflight preserves disjoint and in-place outputs after late errors', () => {
  const config = storage(72),
    pipe = storage(44),
    processed = storage(36),
    outConfig = new Uint8Array(72).fill(0xa5),
    outPipe = new Uint8Array(44).fill(0x5a)
  n.zc_default_config(ptr(config))
  n.zc_default_pipeline_options(ptr(pipe))
  n.zc_default_processed_options(ptr(processed))
  view(config).setUint32(0, 1919, true)
  view(config).setUint32(4, 1081, true)
  view(pipe).setUint32(32, 1, true)
  view(pipe).setUint32(36, 3, true)
  const beforeConfig = config.slice(),
    beforePipe = pipe.slice(),
    configOutput = outConfig.slice(),
    pipeOutput = outPipe.slice()
  expect(
    n.zc_align_camera_configuration(
      ptr(config),
      ptr(pipe),
      ptr(processed),
      1,
      1,
      ptr(outConfig),
      ptr(outPipe),
    ),
  ).toBe(-1)
  expect(outConfig).toEqual(configOutput)
  expect(outPipe).toEqual(pipeOutput)
  expect(
    n.zc_align_camera_configuration(
      ptr(config),
      ptr(pipe),
      ptr(processed),
      1,
      1,
      ptr(config),
      ptr(pipe),
    ),
  ).toBe(-1)
  expect(config).toEqual(beforeConfig)
  expect(pipe).toEqual(beforePipe)
  view(pipe).setUint32(32, 641, true)
  view(pipe).setUint32(36, 481, true)
  expect(
    n.zc_align_camera_configuration(
      ptr(config),
      ptr(pipe),
      ptr(processed),
      1,
      1,
      ptr(config),
      ptr(pipe),
    ),
  ).toBe(0)
  expect(view(config).getUint32(0, true)).toBe(1856)
  expect(view(pipe).getUint32(32, true)).toBe(640)
})
