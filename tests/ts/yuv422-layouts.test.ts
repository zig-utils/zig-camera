import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  type Frame,
  type ProcessedFormat,
  type RecoveredRecordingSession,
} from '../../ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mp4, mkvFrames, decodeVideoI420 } from './media'
const formats = ['YUYV', 'YVYU', 'UYVY', 'VYUY'] as const
const offsets = {
  YUYV: [0, 1, 2, 3],
  YVYU: [0, 3, 2, 1],
  UYVY: [1, 0, 3, 2],
  VYUY: [1, 2, 3, 0],
} as const
function pair(x: number, y: number, index = 0) {
  return [
    90 + x * 2 + index,
    80 + (y % 2) * 80 + x + index,
    100 + x * 2 + index,
    100 + (y % 2) * 40 + x + index,
  ]
}
const camera = (format: ProcessedFormat, height = 24) =>
  new Camera({
    simulate: true,
    width: 32,
    height,
    format,
    lores: { width: 16, height: height % 2 ? 13 : 16, format },
    writable: true,
    fifo: true,
  })
function paint(
  frame: Frame,
  stream: 'main' | 'lores',
  format: (typeof formats)[number],
  index = 0,
) {
  let alias: Uint8Array | undefined
  frame.withMappedStream((map) => {
    expect(map.planes.length).toBe(1)
    map.planes[0].bytes.fill(0xee)
    for (let y = 0; y < map.height; y++) {
      alias = map.row(y)
      expect(alias.length).toBe(map.width * 2)
      for (let x = 0; x < map.width / 2; x++) {
        const p = pair(x, y, index)
        for (let i = 0; i < 4; i++) alias[x * 4 + offsets[format][i]] = p[i]
      }
    }
    expect(() => map.row(0, 1)).toThrow()
    expect(() => frame.copyRGB(stream)).toThrow()
  }, stream)
  expect(alias!.byteLength).toBe(0)
}
function rgbReference(width: number, height: number, index = 0) {
  const out = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width / 2; x++) {
      const p = pair(x, y, index),
        u = p[1] - 128,
        v = p[3] - 128
      for (let dx = 0; dx < 2; dx++) {
        const l = p[dx * 2],
          rgb = [
            l + 1.402 * v,
            l - 0.3441362862 * u - 0.7141362862 * v,
            l + 1.772 * u,
          ]
        rgb.forEach(
          (value, c) =>
            (out[(y * width + x * 2 + dx) * 3 + c] = Math.max(
              0,
              Math.min(255, Math.round(value)),
            )),
        )
      }
    }
  return out
}
function studioI420(width: number, height: number, index = 0) {
  const pixels = width * height,
    out = new Uint8Array((pixels * 3) / 2)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width / 2; x++)
      for (let dx = 0; dx < 2; dx++)
        out[y * width + x * 2 + dx] =
          16 + Math.round((pair(x, y, index)[dx * 2] * 219) / 255)
  for (let y = 0; y < height / 2; y++)
    for (let x = 0; x < width / 2; x++) {
      const a = pair(x, y * 2, index),
        b = pair(x, y * 2 + 1, index),
        u = (a[1] + b[1] + 1) >> 1,
        v = (a[3] + b[3] + 1) >> 1
      out[pixels + (y * width) / 2 + x] =
        128 + Math.round(((u - 128) * 224) / 255)
      out[(pixels * 5) / 4 + (y * width) / 2 + x] =
        128 + Math.round(((v - 128) * 224) / 255)
    }
  return out
}
for (const format of formats)
  for (const stream of ['main', 'lores'] as const)
    test(`${format} ${stream} mapped capture raw bundles and stills preserve packed bytes and odd height`, async () => {
      const c = camera(format, 25),
        reference = camera('BGR888', 25),
        dir = mkdtempSync(join(tmpdir(), 'zc-422-still-'))
      try {
        c.start()
        reference.start()
        using f = c.acquire()
        using ref = reference.acquire()
        paint(f, stream, format)
        const width = stream === 'main' ? 32 : 16,
          height = stream === 'main' ? 25 : 13
        const bytes = f.copyStream(stream).data
        expect(bytes.length).toBe(width * height * 2)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width / 2; x++) {
            const values = pair(x, y)
            for (let i = 0; i < 4; i++)
              expect(
                bytes[((y * width) / 2 + x) * 4 + offsets[format][i]],
              ).toBe(values[i])
          }
        expect(f.copyStreams(['main', 'lores']).streams[stream]!.data).toEqual(
          bytes,
        )
        const actual = f.copyRGB(stream),
          expected = rgbReference(width, height)
        expect(
          actual.every((value, i) => Math.abs(value - expected[i]) <= 1),
        ).toBe(true)
        ref.withMappedStream((map) => {
          for (let y = 0; y < height; y++)
            map.row(y).set(actual.subarray(y * width * 3, (y + 1) * width * 3))
        }, stream)
        for (const imageFormat of [
          'jpeg',
          'png',
          'bmp',
          'tiff',
          'ppm',
        ] as const) {
          expect(
            f.encodeImage({ format: imageFormat, stream, exif: false }),
          ).toEqual(
            ref.encodeImage({ format: imageFormat, stream, exif: false }),
          )
          const path = join(dir, `frame.${imageFormat}`),
            refPath = join(dir, `reference.${imageFormat}`)
          f.saveFile(path, { format: imageFormat, stream, exif: false })
          ref.saveFile(refPath, { format: imageFormat, stream, exif: false })
          expect(readFileSync(path)).toEqual(readFileSync(refPath))
          const decoder = process.env.ZC_IMAGE_DECODER
          if (decoder && ['png', 'bmp', 'tiff'].includes(imageFormat)) {
            const decoded = Bun.spawnSync([decoder, imageFormat, path])
            expect(decoded.exitCode).toBe(0)
            expect(Buffer.from(decoded.stdout).subarray(8)).toEqual(
              Buffer.from(actual),
            )
          }
        }
        expect(c.colorNegotiation(stream)).toMatchObject({
          format,
          actual: { ycbcrEncoding: 'rec601', range: 'full' },
        })
        f.release()
        ref.release()
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
        await reference.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
for (const codec of ['mjpeg', 'h264', 'hevc'] as const)
  for (const stream of ['main', 'lores'] as const)
    for (const asyncWrites of [false, true]) {
      const run = codec === 'mjpeg' ? test : media
      run(
        `${codec} ${stream} ${asyncWrites ? 'producer' : 'sync'} packed 422 inputs downsample adjacent rows with bounded physical ownership`,
        async () => {
          const width = stream === 'main' ? 32 : 16,
            height = stream === 'main' ? 24 : 16,
            pixels = width * height
          const dir = mkdtempSync(join(tmpdir(), 'zc-422-video-')),
            path = join(dir, codec === 'mjpeg' ? 'movie.mkv' : 'movie.mp4')
          const r = new Recorder(path, {
              width,
              height,
              codec,
              stream,
              producerQueue: { maxBytes: pixels * 2, maxOperations: 1 },
            }),
            expected: Uint8Array[] = [],
            jpeg: Buffer[] = []
          try {
            for (let i = 0; i < formats.length; i++) {
              const format = formats[i],
                c = camera(format)
              try {
                c.start()
                using f = c.acquire()
                paint(f, stream, format, i)
                expected.push(studioI420(width, height, i))
                jpeg.push(
                  Buffer.from(
                    f.encodeImage({
                      format: 'jpeg',
                      stream,
                      quality: 90,
                      exif: false,
                    }),
                  ),
                )
                if (asyncWrites) {
                  const job = r.writeAsync(f, BigInt(i) * 40_000_000n)
                  expect(r.producerStats().ownedBytes).toBe(BigInt(pixels * 2))
                  paint(f, stream, format, i + 20)
                  f.release()
                  await job
                } else r.write(f, BigInt(i) * 40_000_000n)
              } finally {
                await c.close()
              }
            }
            await r.close()
            if (codec === 'mjpeg') expect(mkvFrames(path)).toEqual(jpeg)
            else {
              const video = [...mp4(path).values()].find(
                (t) => t.kind === 'vide',
              )!
              decodeVideoI420(path, video, expected)
            }
            if (asyncWrites)
              expect(r.producerStats().highBytes).toBe(BigInt(pixels * 2))
          } finally {
            await r.close()
            rmSync(dir, { recursive: true, force: true })
          }
        },
      )
    }
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('422 timeout')
    await pause()
  }
}
for (const format of formats)
  test(`${format} async modes recording and fresh recovery preserve layout and paired previews`, async () => {
    const c = camera(format),
      r = new Recorder(null, { width: 32, height: 24 }),
      dir = mkdtempSync(join(tmpdir(), 'zc-422-mode-'))
    let recovered: RecoveredRecordingSession | undefined
    try {
      c.startPreview({ backend: 'headless', stream: 'lores' })
      const target = await c.switchModeAndCaptureStreams(
        {
          width: 48,
          height: 33,
          format,
          lores: { width: 24, height: 17, format },
        },
        ['main', 'lores'],
      )
      expect(target.streams.main?.format).toBe(format)
      expect(target.streams.main?.data.length).toBe(48 * 33 * 2)
      expect(c.info().format).toBe(format)
      expect(c.previewStreamInfo()?.format).toBe(format)
      const old = c.startRecording(r)
      await until(() => old.stats().completed >= 2n)
      const next = await c.switchRecordingModeAsync(
        r,
        {
          width: 48,
          height: 32,
          format,
          lores: { width: 24, height: 16, format },
        },
        {},
        join(dir, 'mode.mkv'),
      )
      await until(() => next.stats().completed >= 2n)
      c.simulateDisconnect()
      recovered = await c.reconnectRecordingsAsync(
        [{ recording: next, output: join(dir, 'recovered.mkv') }],
        { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 },
      )
      expect(recovered.camera.info().format).toBe(format)
      expect(recovered.camera.previewStreamInfo()?.format).toBe(format)
      await until(() => recovered!.recordings[0].stats().completed >= 2n)
      await recovered.recordings[0].flushAsync()
      expect(
        mkvFrames(join(dir, 'recovered.mkv')).length,
      ).toBeGreaterThanOrEqual(2)
    } finally {
      await Promise.allSettled([
        recovered?.camera.close(),
        c.close(),
        r.close(),
      ])
      rmSync(dir, { recursive: true, force: true })
    }
  })
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
for (const format of formats)
  preview(
    `${format} SDL handles odd-height main and lores before source replacement`,
    async () => {
      const c = camera(format, 25)
      try {
        c.startPreview({ stream: 'lores' })
        await c.captureMetadata()
        expect(c.previewError).toBeUndefined()
        expect(c.previewStreamInfo()?.format).toBe(format)
        c.setPreviewStream('main')
        await c.captureMetadata()
        expect(c.previewError).toBeUndefined()
        expect(c.previewStreamInfo()?.height).toBe(25)
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
      }
    },
  )
test('packed 422 admission rejects odd width and matrix-free color before opening outputs', async () => {
  for (const format of formats) {
    expect(
      () => new Camera({ simulate: true, width: 31, height: 25, format }),
    ).toThrow()
    expect(
      () => new Camera({ simulate: true, format, colorSpace: 'srgb' }),
    ).toThrow()
    expect(
      () =>
        new Camera({
          simulate: true,
          lores: { width: 15, height: 11, format },
        }),
    ).toThrow()
    const aligned = Camera.alignConfiguration({
      width: 1919,
      height: 1081,
      format,
      lores: { width: 959, height: 541, format },
    })
    expect([
      aligned.width,
      aligned.height,
      aligned.lores?.width,
      aligned.lores?.height,
    ]).toEqual([1856, 1080, 896, 540])
    const c = camera(format, 25)
    try {
      expect(
        () => new Recorder(null, { width: 32, height: 25, codec: 'h264' }),
      ).toThrow()
      using f = await c.captureRequest()
      expect(f.copyRGB().length).toBe(32 * 25 * 3)
      f.release()
    } finally {
      await c.close()
    }
  }
})
