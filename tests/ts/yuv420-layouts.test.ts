import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  type Frame,
  type ProcessedFormat,
  type RecoveredRecordingSession,
} from '../../ts'
import { native as n, storage, ptr, view } from '../../ts/ffi'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeVideoI420, mkvFrames, mp4 } from './media'
const formats = ['YUV420', 'YVU420', 'NV12', 'NV21'] as const
const semi = (format: string) => format === 'NV12' || format === 'NV21'
const camera = (format: ProcessedFormat) =>
  new Camera({
    simulate: true,
    width: 32,
    height: 24,
    format,
    lores: { width: 16, height: 16, format },
    fifo: true,
    writable: true,
  })
function paint(f: Frame, stream: 'main' | 'lores', format: string, index = 0) {
  let alias: Uint8Array | undefined
  f.withMappedStream((map) => {
    expect(map.planes.length).toBe(semi(format) ? 2 : 3)
    map.planes.forEach((p) => p.bytes.fill(0xee))
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++)
        map.row(y)[x] = 20 + ((x * 7 + y * 11 + index * 13) % 210)
    for (let y = 0; y < map.height / 2; y++)
      for (let x = 0; x < map.width / 2; x++) {
        const u = 32 + ((x * 31 + y * 17 + index * 3) % 192),
          v = 32 + ((x * 13 + y * 29 + index * 19) % 192)
        if (semi(format)) {
          alias = map.row(y, 1)
          alias[x * 2] = format === 'NV12' ? u : v
          alias[x * 2 + 1] = format === 'NV12' ? v : u
        } else {
          map.row(y, 1)[x] = u
          alias = map.row(y, 2)
          alias[x] = v
        }
      }
    expect(() => f.copyRGB(stream)).toThrow()
    if (semi(format)) expect(() => map.row(0, 2)).toThrow()
  }, stream)
  expect(alias!.byteLength).toBe(0)
}
function fromI420(
  format: string,
  canonical: Uint8Array,
  width: number,
  height: number,
) {
  const pixels = width * height,
    out = canonical.slice()
  if (format === 'YVU420') {
    out.set(canonical.subarray(pixels + pixels / 4), pixels)
    out.set(
      canonical.subarray(pixels, pixels + pixels / 4),
      pixels + pixels / 4,
    )
  }
  if (semi(format))
    for (let i = 0; i < pixels / 4; i++) {
      out[pixels + i * 2] =
        canonical[pixels + (format === 'NV12' ? 0 : pixels / 4) + i]
      out[pixels + i * 2 + 1] =
        canonical[pixels + (format === 'NV12' ? pixels / 4 : 0) + i]
    }
  return out
}
for (const format of formats)
  for (const stream of ['main', 'lores'] as const)
    test(`${format} ${stream} strided mappings raw copies stills and RGB retain correct chroma order`, async () => {
      const c = camera(format),
        reference = camera('YUV420'),
        dir = mkdtempSync(join(tmpdir(), 'zc-yuv-layout-'))
      try {
        c.start()
        reference.start()
        using f = c.acquire()
        using canonical = reference.acquire()
        paint(f, stream, format)
        paint(canonical, stream, 'YUV420')
        const width = stream === 'main' ? 32 : 16,
          height = stream === 'main' ? 24 : 16
        expect(c.info().format).toBe(format)
        expect(c.colorNegotiation(stream)).toMatchObject({
          format,
          actual: { ycbcrEncoding: 'rec601', range: 'full' },
        })
        const original = canonical.copyStream(stream).data,
          packed = f.copyStream(stream)
        expect(packed.format).toBe(format)
        expect(packed.data).toEqual(fromI420(format, original, width, height))
        expect(f.copyStreams(['main', 'lores']).streams[stream]!.data).toEqual(
          packed.data,
        )
        const expected = canonical.copyRGB(stream)
        expect(f.copyRGB(stream)).toEqual(expected)
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
            canonical.encodeImage({ format: imageFormat, stream, exif: false }),
          )
          if (imageFormat === 'jpeg') {
            const actualPath = join(dir, 'frame.jpeg'),
              referencePath = join(dir, 'reference.jpeg')
            f.saveFile(actualPath, { format: 'jpeg', stream, exif: false })
            canonical.saveFile(referencePath, {
              format: 'jpeg',
              stream,
              exif: false,
            })
            expect(readFileSync(actualPath)).toEqual(
              readFileSync(referencePath),
            )
          }
          const decoder = process.env.ZC_IMAGE_DECODER
          if (decoder && ['png', 'bmp', 'tiff'].includes(imageFormat)) {
            const path = join(dir, `image.${imageFormat}`)
            f.saveFile(path, { format: imageFormat, stream })
            const result = Bun.spawnSync([decoder, imageFormat, path])
            expect(result.exitCode).toBe(0)
            expect(Buffer.from(result.stdout).subarray(8)).toEqual(
              Buffer.from(expected),
            )
          }
        }
        f.release()
        canonical.release()
        expect(packed.data.length).toBe((width * height * 3) / 2)
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
        `${codec} ${stream} ${asyncWrites ? 'producer' : 'sync'} records all planar and semi-planar sources with exact I420 queue ownership`,
        async () => {
          const width = stream === 'main' ? 32 : 16,
            height = stream === 'main' ? 24 : 16,
            pixels = width * height
          const dir = mkdtempSync(join(tmpdir(), 'zc-yuv-record-')),
            path = join(dir, codec === 'mjpeg' ? 'video.mkv' : 'video.mp4')
          const r = new Recorder(path, {
              width,
              height,
              codec,
              stream,
              producerQueue: { maxBytes: (pixels * 3) / 2, maxOperations: 1 },
            }),
            expected: Uint8Array[] = [],
            jpeg: Uint8Array[] = []
          try {
            for (let i = 0; i < formats.length; i++) {
              const format = formats[i],
                c = camera(format),
                canonical = camera('YUV420')
              try {
                c.start()
                canonical.start()
                using f = c.acquire()
                using ref = canonical.acquire()
                paint(f, stream, format, i)
                paint(ref, stream, 'YUV420', i)
                const bytes = ref.copyStream(stream).data
                expected.push(
                  Uint8Array.from(bytes, (value, idx) =>
                    idx < pixels
                      ? 16 + Math.round((value * 219) / 255)
                      : 128 + Math.round(((value - 128) * 224) / 255),
                  ),
                )
                jpeg.push(
                  ref.encodeImage({
                    format: 'jpeg',
                    stream,
                    quality: 90,
                    exif: false,
                  }),
                )
                if (asyncWrites) {
                  const job = r.writeAsync(f, BigInt(i) * 40_000_000n)
                  expect(r.producerStats().ownedBytes).toBe(
                    BigInt((pixels * 3) / 2),
                  )
                  paint(f, stream, format, i + 20)
                  f.release()
                  await job
                } else r.write(f, BigInt(i) * 40_000_000n)
              } finally {
                await c.close()
                await canonical.close()
              }
            }
            await r.close()
            if (codec === 'mjpeg')
              expect(mkvFrames(path)).toEqual(jpeg.map((b) => Buffer.from(b)))
            else {
              const video = [...mp4(path).values()].find(
                (t) => t.kind === 'vide',
              )!
              decodeVideoI420(path, video, expected)
            }
            if (asyncWrites)
              expect(r.producerStats().highBytes).toBe(BigInt((pixels * 3) / 2))
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
    if (performance.now() > end) throw Error('YUV job timeout')
    await pause()
  }
}
for (const format of formats.slice(1))
  test(`${format} mode workers restoration coordinated recording and recovery preserve layouts`, async () => {
    const c = camera(format),
      r = new Recorder(null, { width: 32, height: 24 }),
      dir = mkdtempSync(join(tmpdir(), 'zc-yuv-modes-'))
    let recovered: RecoveredRecordingSession | undefined
    try {
      c.startPreview({ backend: 'headless', stream: 'lores' })
      const target = await c.switchModeAndCaptureStreams(
        {
          width: 48,
          height: 32,
          format,
          lores: { width: 24, height: 16, format },
        },
        ['main', 'lores'],
      )
      expect(target.streams.main?.format).toBe(format)
      expect(target.streams.main?.data.length).toBe((48 * 32 * 3) / 2)
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
for (const format of formats.slice(1))
  preview(
    `${format} SDL main and lores display retain ownership and negotiate YUV color`,
    async () => {
      const c = camera(format)
      try {
        c.startPreview({ stream: 'lores' })
        await c.captureMetadata()
        expect(c.previewError).toBeUndefined()
        expect(c.previewStreamInfo()?.format).toBe(format)
        c.setPreviewStream('main')
        await c.captureMetadata()
        expect(c.previewError).toBeUndefined()
        expect(c.previewStreamInfo()?.width).toBe(32)
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
      }
    },
  )
test('YUV formats reject odd dimensions and matrix-free color while alignment keeps source layout', () => {
  for (const format of formats.slice(1)) {
    expect(
      () => new Camera({ simulate: true, width: 31, height: 24, format }),
    ).toThrow()
    expect(
      () => new Camera({ simulate: true, width: 32, height: 23, format }),
    ).toThrow()
    expect(
      () => new Camera({ simulate: true, format, colorSpace: 'srgb' }),
    ).toThrow()
    expect(
      () =>
        new Camera({
          simulate: true,
          lores: { width: 15, height: 12, format },
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
    ]).toEqual(
      format === 'YVU420' ? [1792, 1080, 896, 540] : [1856, 1080, 896, 540],
    )
    expect(aligned.format).toBe(format)
  }
  const config = storage(72),
    pipeline = storage(44),
    processed = storage(36),
    out = storage(72),
    outPipeline = storage(44)
  n.zc_default_config(ptr(config))
  n.zc_default_pipeline_options(ptr(pipeline))
  n.zc_default_processed_options(ptr(processed))
  view(processed).setUint32(4, 0xffffffff, true)
  out.fill(71)
  outPipeline.fill(73)
  expect(
    n.zc_align_camera_configuration(
      ptr(config),
      ptr(pipeline),
      ptr(processed),
      1,
      1,
      ptr(out),
      ptr(outPipeline),
    ),
  ).toBe(-1)
  expect(out.every((b) => b === 71)).toBe(true)
  expect(outPipeline.every((b) => b === 73)).toBe(true)
})
