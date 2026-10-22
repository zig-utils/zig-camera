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
import { inflateSync } from 'node:zlib'
import { mp4, mkvFrames, decodeVideoI420 } from './media'
const formats = ['BGR161616', 'RGB161616'] as const
const values = [
  1, 255, 256, 257, 0x1234, 0x8001, 0xfe02, 0xffff, 0x2345, 0x4567, 0xabcd,
  0xdead,
]
const camera = (format: ProcessedFormat) =>
  new Camera({
    simulate: true,
    width: 32,
    height: 24,
    format,
    lores: { width: 16, height: 16, format },
    writable: true,
    fifo: true,
  })
function expected(width: number, height: number, index = 0) {
  return Uint16Array.from(
    { length: width * height * 3 },
    (_, i) => values[(i + index) % values.length],
  )
}
function paint(
  f: Frame,
  stream: 'main' | 'lores',
  format: (typeof formats)[number],
  index = 0,
) {
  let alias: Uint8Array | undefined
  f.withMappedStream((map) => {
    map.planes[0].bytes.fill(0xa7)
    const data = expected(map.width, map.height, index)
    for (let y = 0; y < map.height; y++) {
      alias = map.row(y)
      expect(alias.length).toBe(map.width * 6)
      const d = new DataView(alias.buffer, alias.byteOffset, alias.byteLength)
      for (let x = 0; x < map.width; x++)
        for (let c = 0; c < 3; c++)
          d.setUint16(
            x * 6 + c * 2,
            data[
              (y * map.width + x) * 3 + (format === 'RGB161616' ? 2 - c : c)
            ],
            true,
          )
    }
    expect(() => f.copyRGB16(stream)).toThrow()
  }, stream)
  expect(alias!.byteLength).toBe(0)
}
function pngWords(bytes: Uint8Array) {
  const b = Buffer.from(bytes)
  expect(b[24]).toBe(16)
  expect(b[25]).toBe(2)
  const w = b.readUInt32BE(16),
    h = b.readUInt32BE(20),
    parts: Buffer[] = []
  for (let p = 8; p < b.length;) {
    const n = b.readUInt32BE(p)
    if (b.toString('ascii', p + 4, p + 8) === 'IDAT')
      parts.push(b.subarray(p + 8, p + 8 + n))
    p += n + 12
  }
  const rows = inflateSync(Buffer.concat(parts)),
    out = Buffer.alloc(w * h * 6),
    stride = w * 6
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c)
    return da <= db && da <= dc ? a : db <= dc ? b : c
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < stride; x++) {
      const f = rows[y * (stride + 1)],
        a = x >= 6 ? out[y * stride + x - 6] : 0,
        b = y ? out[(y - 1) * stride + x] : 0,
        c = y && x >= 6 ? out[(y - 1) * stride + x - 6] : 0
      const predict = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][f]
      expect(predict).toBeDefined()
      out[y * stride + x] = (rows[y * (stride + 1) + 1 + x] + predict) & 255
    }
  return Uint16Array.from({ length: w * h * 3 }, (_, i) =>
    out.readUInt16BE(i * 2),
  )
}
function tiffWords(bytes: Uint8Array) {
  const b = Buffer.from(bytes)
  expect(b.toString('ascii', 0, 2)).toBe('II')
  const at = b.readUInt32LE(4),
    count = b.readUInt16LE(at),
    tags = new Map<number, number>()
  for (let i = 0; i < count; i++) {
    const p = at + 2 + i * 12
    tags.set(b.readUInt16LE(p), b.readUInt32LE(p + 8))
  }
  const w = tags.get(256)!,
    h = tags.get(257)!,
    bits = tags.get(258)!,
    start = tags.get(273)!
  expect([
    b.readUInt16LE(bits),
    b.readUInt16LE(bits + 2),
    b.readUInt16LE(bits + 4),
  ]).toEqual([16, 16, 16])
  expect(tags.get(279)).toBe(w * h * 6)
  return Uint16Array.from({ length: w * h * 3 }, (_, i) =>
    b.readUInt16LE(start + i * 2),
  )
}
function ppmWords(bytes: Uint8Array) {
  const b = Buffer.from(bytes)
  let p = 0
  for (let i = 0; i < 3; i++) p = b.indexOf(10, p) + 1
  expect(b.toString('ascii', 0, p)).toContain('65535')
  return Uint16Array.from({ length: (b.length - p) / 2 }, (_, i) =>
    b.readUInt16BE(p + i * 2),
  )
}
for (const format of formats)
  for (const stream of ['main', 'lores'] as const)
    test(`${format} ${stream} owned words raw layouts and 16-bit stills retain low bits through metadata`, async () => {
      const c = camera(format),
        dir = mkdtempSync(join(tmpdir(), 'zc-rgb16-'))
      try {
        c.start()
        using f = c.acquire()
        paint(f, stream, format)
        const width = stream === 'main' ? 32 : 16,
          height = stream === 'main' ? 24 : 16,
          want = expected(width, height),
          words = f.copyRGB16(stream)
        expect(words).toEqual(want)
        expect(f.copyRGB(stream)).toEqual(Uint8Array.from(want, (x) => x >> 8))
        const raw = f.copyStream(stream)
        expect(raw.format).toBe(format)
        expect(raw.data.length).toBe(width * height * 6)
        const d = new DataView(
          raw.data.buffer,
          raw.data.byteOffset,
          raw.data.byteLength,
        )
        for (let i = 0; i < width * height; i++)
          for (let channel = 0; channel < 3; channel++)
            expect(d.getUint16(i * 6 + channel * 2, true)).toBe(
              want[i * 3 + (format === 'RGB161616' ? 2 - channel : channel)],
            )
        for (const imageFormat of ['png', 'tiff', 'ppm'] as const)
          for (const metadata of imageFormat === 'ppm'
            ? [false]
            : [false, true]) {
            const options = {
              format: imageFormat,
              stream,
              ...(metadata
                ? { iccProfile: 'srgb' as const, exif: true }
                : { exif: false }),
            }
            const bytes = f.encodeImage(options),
              path = join(dir, `frame.${imageFormat}`)
            f.saveFile(path, options)
            if (!metadata)
              expect(readFileSync(path)).toEqual(Buffer.from(bytes))
            const decode =
              imageFormat === 'png'
                ? pngWords
                : imageFormat === 'tiff'
                  ? tiffWords
                  : ppmWords
            expect(decode(bytes)).toEqual(want)
            expect(decode(readFileSync(path))).toEqual(want)
            if (imageFormat !== 'ppm' && process.env.ZC_RGB16_DECODER) {
              const result = Bun.spawnSync([
                process.env.ZC_RGB16_DECODER!,
                imageFormat,
                path,
              ])
              expect(result.exitCode).toBe(0)
              expect(Buffer.from(result.stdout).subarray(8)).toEqual(
                Buffer.from(want.buffer),
              )
            }
          }
        // Eight-bit destinations use the documented high-byte reduction.
        const jpeg = f.encodeImage({ format: 'jpeg', stream, exif: false }),
          bmp = f.encodeImage({ format: 'bmp', stream }),
          ref = camera('BGR888')
        try {
          ref.start()
          using rgb = ref.acquire()
          const reduced = f.copyRGB(stream)
          rgb.withMappedStream((map) => {
            for (let y = 0; y < height; y++)
              map
                .row(y)
                .set(reduced.subarray(y * width * 3, (y + 1) * width * 3))
          }, stream)
          expect(jpeg).toEqual(
            rgb.encodeImage({ format: 'jpeg', stream, exif: false }),
          )
          expect(bmp).toEqual(rgb.encodeImage({ format: 'bmp', stream }))
          const path = join(dir, 'high-byte.jpeg'),
            other = join(dir, 'reference.jpeg')
          f.saveFile(path, { format: 'jpeg', stream, exif: false })
          rgb.saveFile(other, { format: 'jpeg', stream, exif: false })
          expect(readFileSync(path)).toEqual(readFileSync(other))
        } finally {
          await ref.close()
        }
        f.release()
        expect(words).toEqual(want)
        expect(c.stats().leased).toBe(0)
        expect(c.colorNegotiation(stream).format).toBe(format)
      } finally {
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
test('RGB16 async convenience copies and source capability checks retain no camera lease', async () => {
  const c = camera('RGB161616'),
    plain = camera('BGR888')
  try {
    const words = await c.captureRGB16({ stream: 'lores' })
    expect(words.length).toBe(16 * 16 * 3)
    await c.captureRGB16Async()
    expect(c.stats().leased).toBe(0)
    await c.close()
    expect(words.length).toBe(16 * 16 * 3)
    await expect(plain.captureRGB16()).rejects.toThrow('RGB16 source required')
    expect(plain.stats().leased).toBe(0)
  } finally {
    await c.close()
    await plain.close()
  }
})
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
for (const codec of ['mjpeg', 'h264', 'hevc'] as const)
  for (const stream of ['main', 'lores'] as const)
    for (const asyncWrites of [false, true]) {
      const run = codec === 'mjpeg' ? test : media
      run(
        `${codec} ${stream} ${asyncWrites ? 'producer' : 'sync'} RGB16 queues six bytes per pixel and encodes explicit high bytes`,
        async () => {
          const width = stream === 'main' ? 32 : 16,
            height = stream === 'main' ? 24 : 16,
            pixels = width * height,
            dir = mkdtempSync(join(tmpdir(), 'zc-rgb16-video-')),
            path = join(dir, codec === 'mjpeg' ? 'movie.mkv' : 'movie.mp4')
          const r = new Recorder(path, {
              width,
              height,
              codec,
              stream,
              producerQueue: { maxBytes: pixels * 6, maxOperations: 1 },
            }),
            jpeg: Buffer[] = [],
            i420: Uint8Array[] = []
          try {
            for (let index = 0; index < 4; index++) {
              const format = formats[index % 2],
                c = camera(format)
              try {
                c.start()
                using f = c.acquire()
                paint(f, stream, format, index)
                const rgb = f.copyRGB(stream)
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
                const yuv = new Uint8Array((pixels * 3) / 2)
                for (let y = 0; y < height; y += 2)
                  for (let x = 0; x < width; x += 2) {
                    let red = 0,
                      green = 0,
                      blue = 0
                    for (let dy = 0; dy < 2; dy++)
                      for (let dx = 0; dx < 2; dx++) {
                        const p = ((y + dy) * width + x + dx) * 3,
                          rv = rgb[p],
                          gv = rgb[p + 1],
                          bv = rgb[p + 2]
                        yuv[(y + dy) * width + x + dx] =
                          ((66 * rv + 129 * gv + 25 * bv + 128) >> 8) + 16
                        red += rv
                        green += gv
                        blue += bv
                      }
                    const at = (y / 2) * (width / 2) + x / 2
                    yuv[pixels + at] =
                      ((-38 * red - 74 * green + 112 * blue + 512) >> 10) + 128
                    yuv[(pixels * 5) / 4 + at] =
                      ((112 * red - 94 * green - 18 * blue + 512) >> 10) + 128
                  }
                i420.push(yuv)
                if (asyncWrites) {
                  const job = r.writeAsync(f, BigInt(index) * 40_000_000n)
                  expect(r.producerStats().ownedBytes).toBe(BigInt(pixels * 6))
                  paint(f, stream, format, index + 5)
                  f.release()
                  await job
                } else r.write(f, BigInt(index) * 40_000_000n)
              } finally {
                await c.close()
              }
            }
            await r.close()
            if (codec === 'mjpeg') expect(mkvFrames(path)).toEqual(jpeg)
            else
              decodeVideoI420(
                path,
                [...mp4(path).values()].find((t) => t.kind === 'vide')!,
                i420,
              )
            if (asyncWrites)
              expect(r.producerStats().highBytes).toBe(BigInt(pixels * 6))
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
    if (performance.now() > end) throw Error('RGB16 timeout')
    await pause()
  }
}
for (const format of formats)
  test(`${format} mode workers coordinated sessions and fresh recovery retain word layouts`, async () => {
    const c = camera(format),
      r = new Recorder(null, { width: 32, height: 24 }),
      dir = mkdtempSync(join(tmpdir(), 'zc-rgb16-mode-'))
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
      expect(target.streams.main?.data.length).toBe(48 * 33 * 6)
      expect(c.info().format).toBe(format)
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
    `${format} SDL main and lores preview reduce words and preserve owners`,
    async () => {
      const c = camera(format)
      try {
        c.startPreview({ stream: 'lores' })
        await c.captureMetadata()
        expect(c.previewError).toBeUndefined()
        c.setPreviewStream('main')
        await c.captureMetadata()
        expect(c.previewError).toBeUndefined()
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
      }
    },
  )
