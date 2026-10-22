import { expect, test } from 'bun:test'
import { Camera, Recorder, type Frame, type ProcessedFormat } from '../../ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeVideoI420, mkvFrames, mp4 } from './media'
const formats = ['BGR888', 'RGB888', 'XBGR8888', 'XRGB8888'] as const
const bpp = (format: string) => (format.length === 8 ? 4 : 3)
function edit(
  frame: Frame,
  stream: 'main' | 'lores',
  format: ProcessedFormat,
  value = [200, 80, 30],
) {
  let row: Uint8Array | undefined
  frame.withMappedStream((map) => {
    map.planes[0].bytes.fill(0xa7)
    for (let y = 0; y < map.height; y++) {
      row = map.row(y)
      expect(row.length).toBe(map.width * bpp(format))
      for (let x = 0; x < map.width; x++) {
        row.set(
          format === 'RGB888' || format === 'XRGB8888'
            ? [value[2], value[1], value[0]]
            : value,
          x * bpp(format),
        )
        // Deliberately non-opaque unused X must never become output alpha.
        if (bpp(format) === 4) row[x * 4 + 3] = 0
      }
    }
  }, stream)
  expect(row!.byteLength).toBe(0)
}
function camera(format: ProcessedFormat) {
  return new Camera({
    simulate: true,
    fifo: true,
    writable: true,
    width: 32,
    height: 24,
    format,
    lores: { width: 16, height: 12, format },
  })
}
function solid(width: number, height: number, value = [200, 80, 30]) {
  return Uint8Array.from({ length: width * height * 3 }, (_, i) => value[i % 3])
}
for (const format of formats)
  for (const stream of ['main', 'lores'] as const) {
    test(`${format} ${stream} copies and stills use byte order and ignore X/pitch padding`, async () => {
      const c = camera(format),
        reference = camera('BGR888'),
        dir = mkdtempSync(join(tmpdir(), 'zc-packed-still-'))
      try {
        c.start()
        reference.start()
        using f = c.acquire()
        using rgb = reference.acquire()
        expect(c.info().format).toBe(format)
        expect(c.colorNegotiation(stream).format).toBe(format)
        expect(c.colorNegotiation(stream).actual).toMatchObject({
          ycbcrEncoding: 'none',
          range: 'full',
        })
        edit(f, stream, format)
        edit(rgb, stream, 'BGR888')
        const width = stream === 'main' ? 32 : 16,
          height = stream === 'main' ? 24 : 12,
          expected = solid(width, height)
        expect(f.copyRGB(stream)).toEqual(expected)
        const packed = f.copyStream(stream)
        expect(packed.format).toBe(format)
        expect(packed.data.length).toBe(width * height * bpp(format))
        const bundle = f.copyStreams(['main', 'lores'])
        expect(bundle.streams[stream]!.data).toEqual(packed.data)
        for (const imageFormat of [
          'jpeg',
          'png',
          'bmp',
          'tiff',
          'ppm',
        ] as const) {
          const bytes = f.encodeImage({
              format: imageFormat,
              stream,
              exif: false,
            }),
            canonical = rgb.encodeImage({
              format: imageFormat,
              stream,
              exif: false,
            })
          expect(bytes).toEqual(canonical)
          const decoder = process.env.ZC_IMAGE_DECODER
          if (decoder && ['jpeg', 'png', 'bmp', 'tiff'].includes(imageFormat)) {
            const path = join(dir, `frame.${imageFormat}`)
            f.saveFile(path, { format: imageFormat, stream, exif: false })
            const decoded = Bun.spawnSync([decoder, imageFormat, path])
            expect(decoded.exitCode).toBe(0)
            const pixels = Buffer.from(decoded.stdout).subarray(8)
            if (imageFormat === 'jpeg') {
              expect(pixels.length).toBe(expected.length)
              expect(
                pixels.every((value, i) => Math.abs(value - expected[i]) <= 3),
              ).toBe(true)
            } else expect(pixels).toEqual(Buffer.from(expected))
          }
        }
        f.release()
        rgb.release()
        expect(packed.data.length).toBe(width * height * bpp(format))
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
        await reference.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
for (const codec of ['mjpeg', 'h264', 'hevc'] as const)
  for (const asyncWrites of [false, true]) {
    const run = codec === 'mjpeg' ? test : media
    run(
      `${codec} ${asyncWrites ? 'producer' : 'sync'} records mixed packed sources with bounded actual byte accounting`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zc-packed-video-')),
          path = join(dir, codec === 'mjpeg' ? 'video.mkv' : 'video.mp4')
        const r = new Recorder(path, {
          width: 32,
          height: 24,
          codec,
          quality: 95,
        })
        const expected: Uint8Array[] = []
        try {
          for (let i = 0; i < formats.length; i++) {
            const format = formats[i],
              c = camera(format)
            try {
              c.start()
              using f = c.acquire()
              edit(f, 'main', format)
              if (asyncWrites) {
                const job = r.writeAsync(f, BigInt(i) * 40_000_000n)
                expect(r.producerStats().ownedBytes).toBe(
                  BigInt(32 * 24 * bpp(format)),
                )
                edit(f, 'main', format, [0, 0, 0])
                f.release()
                await job
              } else r.write(f, BigInt(i) * 40_000_000n)
              const pixels = 32 * 24,
                bytes = new Uint8Array((pixels * 3) / 2)
              bytes.fill(
                ((66 * 200 + 129 * 80 + 25 * 30 + 128) >> 8) + 16,
                0,
                pixels,
              )
              bytes.fill(
                ((-38 * 800 - 74 * 320 + 112 * 120 + 512) >> 10) + 128,
                pixels,
                (pixels * 5) / 4,
              )
              bytes.fill(
                ((112 * 800 - 94 * 320 - 18 * 120 + 512) >> 10) + 128,
                (pixels * 5) / 4,
              )
              expected.push(bytes)
            } finally {
              await c.close()
            }
          }
          await r.close()
          if (codec === 'mjpeg') {
            const packets = mkvFrames(path)
            expect(packets.length).toBe(4)
            for (const packet of packets) expect(packet).toEqual(packets[0])
          } else {
            const video = [...mp4(path).values()].find(
              (t) => t.kind === 'vide',
            )!
            expect(video.samples.length).toBe(4)
            decodeVideoI420(path, video, expected)
          }
          if (asyncWrites)
            expect(r.producerStats().highBytes).toBe(32n * 24n * 4n)
        } finally {
          await r.close()
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )
  }
for (const format of formats.slice(1))
  test(`${format} survives async mode workers and temporary-mode restoration`, async () => {
    const c = camera(format)
    try {
      c.startPreview({ backend: 'headless', stream: 'lores' })
      await c.switchMode({
        format,
        width: 48,
        height: 32,
        lores: { width: 24, height: 16, format },
      })
      expect(c.info().format).toBe(format)
      expect(c.previewStreamInfo()?.format).toBe(format)
      const result = await c.switchModeAndCaptureStreams(
        {
          format: 'XBGR8888',
          width: 40,
          height: 24,
          lores: { width: 20, height: 12, format: 'RGB888' },
        },
        ['main', 'lores'],
      )
      expect(result.streams.main!.format).toBe('XBGR8888')
      expect(result.streams.main!.data.length).toBe(40 * 24 * 4)
      expect(result.streams.lores!.format).toBe('RGB888')
      expect(c.info().format).toBe(format)
      expect(c.previewStreamInfo()?.format).toBe(format)
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
    }
  })
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
for (const format of formats.slice(1))
  preview(
    `${format} async SDL main/lores preview keeps source geometry and ownership`,
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
test('packed format admission rejects unknown names and conflicting legacy lores aliases', () => {
  for (const format of ['RGBA8888', 'RGBX', 3, null, {}, '__proto__'])
    expect(
      () => new Camera({ simulate: true, format: format as never }),
    ).toThrow()
  expect(
    () =>
      new Camera({
        simulate: true,
        lores: { width: 16, height: 12, rgb: true, format: 'XBGR8888' },
      }),
  ).toThrow('conflicts')
  expect(
    () =>
      new Camera({
        simulate: true,
        lores: { width: 16, height: 12, rgb: 'yes' as never },
      }),
  ).toThrow()
})

test('packed alignment and odd source extents retain exact formats and strict RGB color policy', async () => {
  const aligned = Camera.alignConfiguration(
    {
      simulate: true,
      width: 1919,
      height: 1081,
      format: 'XBGR8888',
      lores: { width: 959, height: 541, format: 'XRGB8888' },
    },
    { platform: 'pisp' },
  )
  expect([
    aligned.width,
    aligned.height,
    aligned.lores?.width,
    aligned.lores?.height,
  ]).toEqual([1888, 1080, 928, 540])
  for (const format of formats.slice(1)) {
    const c = new Camera({
      simulate: true,
      width: 19,
      height: 11,
      format,
      lores: { width: 9, height: 5, format },
      colorSpace: 'rec709',
      strictColorSpace: true,
      transform: { rotation: 90 },
    })
    try {
      c.start()
      using f = c.acquire()
      expect(f.copyRGB().length).toBe(19 * 11 * 3)
      expect(f.copyStream().data.length).toBe(19 * 11 * bpp(format))
      expect(c.colorNegotiation()).toMatchObject({
        format,
        strict: true,
        normalized: true,
        adjusted: false,
        actual: {
          primaries: 'rec709',
          transfer: 'rec709',
          ycbcrEncoding: 'none',
          range: 'full',
        },
      })
      f.release()
    } finally {
      await c.close()
    }
  }
})
for (const format of formats.slice(1))
  test(
    format +
      ' coordinated recording changes and fresh recovery preserve processed layouts',
    async () => {
      const c = camera('BGR888'),
        r = new Recorder(null, { width: 32, height: 24 }),
        dir = mkdtempSync(join(tmpdir(), 'zc-packed-mode-'))
      let recovered:
        Awaited<ReturnType<Camera['reconnectRecordingsAsync']>> | undefined
      const until = async (fn: () => boolean) => {
        const end = performance.now() + 5000
        while (!fn()) {
          if (performance.now() > end) throw Error('recording timeout')
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      }
      try {
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
        expect(c.info().format).toBe(format)
        await until(() => next.stats().completed >= 2n)
        c.simulateDisconnect()
        recovered = await c.reconnectRecordingsAsync(
          [{ recording: next, output: join(dir, 'recovered.mkv') }],
          { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 },
        )
        expect(recovered.camera.info().format).toBe(format)
        expect(recovered.camera.colorNegotiation('lores').format).toBe(format)
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
    },
  )
