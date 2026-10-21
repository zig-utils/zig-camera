import { expect, test } from 'bun:test'
import { Camera, Recorder, type ImageFormat, type RequestFrame } from '../../ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const decoder = process.env.ZC_IMAGE_DECODER
const camera = (rgb = false) =>
  new Camera({
    simulate: true,
    width: 64,
    height: 48,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    writable: true,
    lores: { width: 18, height: 10, rgb },
  })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
function ppm(bytes: Uint8Array, width = 18, height = 10) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`)
  expect(Buffer.from(bytes.subarray(0, header.length))).toEqual(header)
  return bytes.subarray(header.length)
}
function reference(y: number, u: number, v: number) {
  return [
    y + 1.402 * (v - 128),
    y - 0.3441362862 * (u - 128) - 0.7141362862 * (v - 128),
    y + 1.772 * (u - 128),
  ].map((n) => Math.max(0, Math.min(255, Math.round(n))))
}
for (const rgb of [false, true])
  test(`named ${rgb ? 'RGB' : 'I420'} lores images decode with correct colors and preserve main`, async () => {
    const c = camera(rgb),
      dir = mkdtempSync(join(tmpdir(), 'zc-stream-image-'))
    try {
      expect(c.colorSpace()).toMatchObject({
        present: true,
        primaries: 'rec709',
        transfer: 'srgb',
        ycbcrEncoding: 'none',
        range: 'full',
      })
      expect(c.colorSpace('lores')).toMatchObject({
        ycbcrEncoding: rgb ? 'none' : 'rec601',
        range: 'full',
      })
      expect(c.colorSpace('raw')).toMatchObject({
        primaries: 'raw',
        transfer: 'linear',
      })
      c.start()
      using frame = c.acquire()
      const main = frame.copyRGB(),
        expected = new Uint8Array(18 * 10 * 3)
      frame.withMappedStream((mapped) => {
        for (const plane of mapped.planes) plane.bytes.fill(0xee)
        for (let y = 0; y < 10; y++)
          for (let x = 0; x < 18; x++) {
            const values = rgb
              ? [
                  (x * 23 + y * 7) & 255,
                  (y * 39 + x * 3) & 255,
                  (x * 31 + y * 13) & 255,
                ]
              : reference(
                  60 + x * 7,
                  64 + Math.floor(x / 2) * 12,
                  80 + Math.floor(y / 2) * 24,
                )
            expected.set(values, (y * 18 + x) * 3)
            if (rgb) mapped.row(y).set(values, x * 3)
            else {
              mapped.row(y)[x] = 60 + x * 7
              mapped.row(Math.floor(y / 2), 1)[Math.floor(x / 2)] =
                64 + Math.floor(x / 2) * 12
              mapped.row(Math.floor(y / 2), 2)[Math.floor(x / 2)] =
                80 + Math.floor(y / 2) * 24
            }
          }
      }, 'lores')
      expect(frame.copyRGB('lores')).toEqual(expected)
      expect(
        ppm(frame.encodeImage({ format: 'ppm', stream: 'lores' })),
      ).toEqual(expected)
      expect(frame.copyRGB()).toEqual(main)
      for (const format of ['png', 'bmp', 'tiff', 'jpeg'] as ImageFormat[]) {
        const path = join(dir, `lores.${format}`),
          bytes = frame.encodeImage({ format, stream: 'lores' })
        frame.saveFile(path, { format, stream: 'lores' })
        expect(readFileSync(path)).toEqual(Buffer.from(bytes))
        if (decoder) {
          const result = Bun.spawnSync([decoder, format, path])
          expect(result.exitCode).toBe(0)
          const decoded = Buffer.from(result.stdout)
          expect([decoded.readUInt32LE(0), decoded.readUInt32LE(4)]).toEqual([
            18, 10,
          ])
          if (format !== 'jpeg')
            expect(decoded.subarray(8)).toEqual(Buffer.from(expected))
          else {
            let error = 0
            for (let i = 0; i < expected.length; i++)
              error += Math.abs(decoded[i + 8] - expected[i])
            expect(error / expected.length).toBeLessThan(5)
          }
        }
      }
      const kept = frame.encodeImage({ format: 'png', stream: 'lores' })
      frame.release()
      await c.close()
      expect(kept.subarray(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]))
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

test('named stream APIs reject disabled sources, incompatible raw encodings and active writers', async () => {
  const c = camera(),
    absent = new Camera({ simulate: true, width: 64, height: 48 })
  const dir = mkdtempSync(join(tmpdir(), 'zc-source-reject-')),
    path = join(dir, 'preserved.png')
  try {
    writeFileSync(path, 'preserve')
    for (const bad of [
      { format: 'dng', stream: 'main' },
      { format: 'dng', stream: 'lores' },
      { format: 'png', stream: 'raw' },
      { format: 'png', stream: '__proto__' },
    ]) {
      const revision = c.controlSnapshot().revision
      // @ts-expect-error Exercise untyped invalid source combinations too.
      expect(() => c.captureEncodedImageAsync(bad)).toThrow()
      expect(c.controlSnapshot().revision).toBe(revision)
    }
    // @ts-expect-error Raw RGB conversion requires demosaicing; never reinterpret.
    expect(() => c.captureRGBAsync({ stream: 'raw' })).toThrow()
    expect(() => absent.colorSpace('lores')).toThrow()
    expect(
      await failure(
        absent.captureEncodedImageAsync({ format: 'png', stream: 'lores' }),
      ),
    ).toMatchObject({ code: -8 })
    expect(absent.stats().leased).toBe(0)
    c.start()
    using frame = c.acquire()
    const mapping = frame.mapStream('lores')
    try {
      expect(() =>
        frame.encodeImage({ format: 'png', stream: 'lores' }),
      ).toThrow()
      expect(() => frame.copyRGB('lores')).toThrow()
      expect(() =>
        frame.saveFile(path, { format: 'png', stream: 'lores' }),
      ).toThrow()
    } finally {
      mapping.close()
    }
    expect(readFileSync(path, 'utf8')).toBe('preserve')
    expect(
      ppm(frame.encodeImage({ format: 'ppm', stream: 'lores' })).length,
    ).toBe(540)
    frame.release()
    expect(() => frame.copyRGB('lores')).toThrow()
    expect(() => frame.colorSpace('lores')).toThrow()
  } finally {
    await c.close()
    await absent.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('synthetic lores uses full-range sYCC and capture jobs snapshot their source', async () => {
  const c = camera()
  try {
    const expected = await c.captureAsync((frame) => {
      const raw = frame.copyStream('lores').data
      // First Y code is RGB black for the first buffer, not studio black 16.
      expect(raw[0]).toBe(0)
      return frame.copyRGB('lores')
    })
    expect(expected.length).toBe(540)
    const options = {
        format: 'ppm' as const,
        stream: 'lores' as 'main' | 'lores',
      },
      job = c.captureEncodedImageAsync(options)
    options.stream = 'main'
    expect(ppm(await job).length).toBe(540)
    expect((await c.captureRGB({ stream: 'lores' })).length).toBe(540)
    c.startContinuousAutofocus()
    expect(
      ppm(
        await c.captureFocusLockedEncodedImage({
          format: 'ppm',
          stream: 'lores',
        }),
      ).length,
    ).toBe(540)
    expect((await c.captureFocusLockedRGB({ stream: 'lores' })).length).toBe(
      540,
    )
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})

test('temporary modes carry selected sources and color metadata through request callbacks and rollback', async () => {
  const c = camera(),
    dir = mkdtempSync(join(tmpdir(), 'zc-mode-stream-'))
  let observed: RequestFrame | undefined,
    colors = 0
  try {
    c.setRequestCallbacks({
      pre(request) {
        observed = request
        expect(request.colorSpace('lores').range).toBe('full')
        colors++
      },
    })
    const target = {
      width: 80,
      height: 60,
      lores: { width: 20, height: 12, rgb: true },
    }
    const bytes = await c.switchModeAndCaptureEncodedImage(target, {
      format: 'ppm',
      stream: 'lores',
    })
    expect(ppm(bytes, 20, 12).length).toBe(720)
    expect(c.info().width).toBe(64)
    expect(c.colorSpace('lores').ycbcrEncoding).toBe('rec601')
    const path = join(dir, 'lores.ppm')
    await c.switchModeAndCaptureFile(target, path, { stream: 'lores' })
    expect(ppm(readFileSync(path), 20, 12).length).toBe(720)
    expect(
      (await c.switchModeAndCaptureRGB(target, { stream: 'lores' })).length,
    ).toBe(720)
    expect(colors).toBeGreaterThan(0)
    expect(() => observed!.colorSpace()).toThrow()
    c.setRequestCallbacks({})
    expect(
      await failure(
        c.switchModeAndCaptureEncodedImage(
          { width: 80, height: 60, lores: { width: 0, height: 0 } },
          { format: 'png', stream: 'lores' },
        ),
      ),
    ).toMatchObject({ code: -8 })
    expect(c.info().width).toBe(64)
    expect(c.colorSpace('lores').ycbcrEncoding).toBe('rec601')
    expect(c.stats().leased).toBe(0)
  } finally {
    c.setRequestCallbacks({})
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lores image capture shares the recording pump without changing encoder geometry', async () => {
  const c = camera(),
    r = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    )
  try {
    c.startContinuousAutofocus()
    const recording = c.startRecording(r)
    expect(
      ppm(
        await c.captureFocusLockedEncodedImage({
          format: 'ppm',
          stream: 'lores',
        }),
      ).length,
    ).toBe(540)
    expect(
      ppm(await c.captureEncodedImage({ format: 'ppm', stream: 'lores' }))
        .length,
    ).toBe(540)
    await recording.flushAsync()
    expect(recording.frames).toBeGreaterThan(1)
    expect(recording.error).toBeUndefined()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    await r.close()
  }
})

test('combined image and focus job options are each read once during admission', async () => {
  const c = camera(),
    reads = {
      stream: 0,
      immediate: 0,
      requireFocused: 0,
      timeout: 0,
      signal: 0,
      callback: 0,
    }
  try {
    c.startContinuousAutofocus()
    const job = c.captureFocusLockedEncodedImage({
      format: 'ppm',
      get stream() {
        reads.stream++
        return 'lores' as const
      },
      get immediate() {
        reads.immediate++
        return false
      },
      get requireFocused() {
        reads.requireFocused++
        return true
      },
      get timeoutMs() {
        reads.timeout++
        return 5000
      },
      get signal() {
        reads.signal++
        return undefined
      },
      get signalFunction() {
        reads.callback++
        return undefined
      },
    })
    expect(ppm(await job).length).toBe(540)
    expect(reads).toEqual({
      stream: 1,
      immediate: 1,
      requireFocused: 1,
      timeout: 1,
      signal: 1,
      callback: 1,
    })
  } finally {
    await c.close()
  }
})
