import { expect, test } from 'bun:test'
import { Camera, Recorder, AudioCapture, type CameraOptions } from '../../ts'
import { native } from '../../ts/ffi'
import { decodeVideoI420, mp4 } from './media'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const options = {
  simulate: true,
  width: 64,
  height: 48,
  format: 'YUV420',
  fifo: true,
  lores: { width: 16, height: 12, rgb: true },
} as const
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('main format timeout')
    await pause()
  }
}
const failed = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (e) => e,
  )
function rgb(y: number, u: number, v: number) {
  return [
    y + 1.402 * (v - 128),
    y - 0.3441362862 * (u - 128) - 0.7141362862 * (v - 128),
    y + 1.772 * (u - 128),
  ].map((x) => Math.min(255, Math.max(0, Math.round(x))))
}
test('I420 main capture exposes negotiated format and independent paired RGB/raw streams', async () => {
  const c = new Camera({ ...options, raw: true, unpackedRaw: true }),
    original = native.zc_copy_rgb
  Object.assign(native, {
    zc_copy_rgb: () => {
      throw Error('RGB-only copy path')
    },
  })
  try {
    expect(c.options.format).toBe('YUV420')
    expect(c.info().format).toBe('YUV420')
    expect(c.colorSpace()).toMatchObject({
      ycbcrEncoding: 'rec601',
      range: 'full',
    })
    c.start()
    const f = c.acquire(1000)
    try {
      expect(f.format).toBe('YUV420')
      const main = f.copyStream(),
        lores = f.copyStream('lores'),
        raw = f.copyStream('raw'),
        converted = f.copyRGB()
      expect([main.format, main.data.length, main.rowBytes]).toEqual([
        'YUV420',
        (64 * 48 * 3) / 2,
        64,
      ])
      expect([lores.format, lores.data.length]).toEqual(['BGR888', 16 * 12 * 3])
      expect(raw.format).toMatch(/^S/)
      for (let y = 0; y < 48; y++)
        for (let x = 0; x < 64; x++) {
          const index = y * 64 + x,
            chroma = Math.floor(y / 2) * 32 + Math.floor(x / 2)
          expect(
            Array.from(converted.subarray(index * 3, index * 3 + 3)),
          ).toEqual(
            rgb(
              main.data[index],
              main.data[3072 + chroma],
              main.data[3840 + chroma],
            ),
          )
        }
      expect(Array.from(f.copyRGB('lores').subarray(0, 6))).toEqual([
        0, 0, 0, 4, 0, 0,
      ])
    } finally {
      f.release()
    }
  } finally {
    await c.close()
    Object.assign(native, { zc_copy_rgb: original })
  }
})
test('main I420 writable planes retain exclusion and propagate exact encoded luma/chroma to RGB and PNG', async () => {
  const c = new Camera({
    ...options,
    width: 4,
    height: 2,
    lores: undefined,
    writable: true,
  })
  try {
    c.start()
    const f = c.acquire(1000)
    try {
      const map = f.mapStream()
      try {
        for (let y = 0; y < 2; y++) map.row(y, 0).fill(100)
        map.row(0, 1).fill(64)
        map.row(0, 2).fill(192)
        expect(() => f.copyRGB()).toThrow('(-4)')
        expect(() => f.copyStream()).toThrow('(-4)')
      } finally {
        map.close()
      }
      const expected = new Uint8Array(
        Array.from({ length: 8 }, () => rgb(100, 64, 192)).flat(),
      )
      expect(f.copyRGB()).toEqual(expected)
      const encoded = f.encodeImage({ format: 'png' })
      expect(encoded.length).toBeGreaterThan(32)
      if (process.env.ZC_IMAGE_DECODER) {
        const dir = mkdtempSync(join(tmpdir(), 'main-i420-png-'))
        try {
          const path = join(dir, 'image.png')
          writeFileSync(path, encoded)
          const decoded = Bun.spawnSync([
            process.env.ZC_IMAGE_DECODER,
            'png',
            path,
          ])
          expect(decoded.exitCode).toBe(0)
          expect(Buffer.from(decoded.stdout).subarray(8)).toEqual(
            Buffer.from(expected),
          )
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    } finally {
      f.release()
    }
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('invalid main formats and odd I420 geometry reject without weakening legacy odd RGB capture', async () => {
  for (const format of [
    'NV12',
    'raw',
    '',
    0,
    null,
  ] as unknown as CameraOptions['format'][])
    expect(() => new Camera({ ...options, format })).toThrow(
      'main stream format',
    )
  for (const size of [
    { width: 3, height: 2 },
    { width: 4, height: 3 },
  ])
    expect(
      () => new Camera({ ...options, lores: undefined, ...size }),
    ).toThrow()
  const c = new Camera({ simulate: true, width: 3, height: 2 })
  try {
    expect((await c.captureRGB()).length).toBe(18)
    expect(c.info().format).toBe('BGR888')
  } finally {
    await c.close()
  }
})
test('I420 main exact-ID selection and all orthogonal transforms preserve paired-source semantics', async () => {
  for (const transform of [
    {},
    { hflip: true },
    { vflip: true },
    { hflip: true, vflip: true },
    { rotation: 90 },
    { rotation: 90, hflip: true },
    { rotation: 90, vflip: true },
    { transpose: true },
  ] as const) {
    const c = new Camera({ ...options, cameraId: 'synthetic', transform })
    try {
      expect(c.info().cameraId).toBe('synthetic')
      const result = await c.captureStreams(['main', 'lores'])
      expect(result.streams.main?.format).toBe('YUV420')
      expect(result.streams.lores?.format).toBe('BGR888')
      expect((await c.captureRGB()).length).toBe(64 * 48 * 3)
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
    }
  }
  expect(() => new Camera({ ...options, cameraId: 'absent' })).toThrow()
})
test('main format follows ordinary/temporary/cancelled mode jobs and invalid-target rollback', async () => {
  const c = new Camera(options)
  try {
    c.startPreview({ backend: 'headless' })
    await c.switchMode({ width: 80, height: 48, format: 'YUV420' })
    expect(c.previewStreamInfo()?.format).toBe('YUV420')
    const temporary = await c.switchModeAndCaptureRGB({ width: 17, height: 9 })
    expect(temporary.length).toBe(17 * 9 * 3)
    expect(c.info().format).toBe('YUV420')
    expect(c.options.format).toBe('YUV420')
    expect(
      await failed(c.switchMode({ width: 63, height: 48, format: 'YUV420' })),
    ).toBeInstanceOf(Error)
    expect(c.info()).toMatchObject({ width: 80, format: 'YUV420' })
    const job = c.switchMode(
        { width: 64, height: 48 },
        { dropFrames: 1_000_000, timeoutMs: 10000 },
      ),
      result = failed(job),
      reason = Error('cancel format switch')
    await until(() => c.previewInfo()?.suspended === true)
    expect(job.cancel(reason)).toBe(true)
    expect(await result).toBe(reason)
    expect(c.info()).toMatchObject({ width: 80, format: 'YUV420' })
    expect(c.previewStreamInfo()?.format).toBe('YUV420')
    expect((await c.captureRGB()).length).toBe(80 * 48 * 3)
  } finally {
    await c.close()
  }
})
for (const asyncWrites of [false, true])
  test(`main I420 MJPEG recording admits ${asyncWrites ? 'async' : 'sync'} writes without RGB-only APIs`, async () => {
    const c = new Camera(options),
      r = await Recorder.open(
        { outputframe() {} },
        { width: 64, height: 48, asyncWrites },
      ),
      legacy = {
        sync: native.zc_video_write,
        async: native.zc_video_producer_frame,
      }
    Object.assign(native, {
      zc_video_write: () => {
        throw Error('legacy RGB write')
      },
      zc_video_producer_frame: () => {
        throw Error('legacy RGB producer')
      },
    })
    try {
      c.start()
      for (let i = 0; i < 3; i++) {
        const frame = c.acquire(1000)
        let write: PromiseLike<void> | undefined
        try {
          if (asyncWrites) write = r.writeAsync(frame, BigInt(i) * 40_000_000n)
          else r.write(frame, BigInt(i) * 40_000_000n)
        } finally {
          frame.release()
        }
        if (write) await write
      }
      await r.flushAsync()
      expect(r.stats().outputFrames).toBe(3n)
      expect(c.stats().leased).toBe(0)
    } finally {
      Object.assign(native, {
        zc_video_write: legacy.sync,
        zc_video_producer_frame: legacy.async,
      })
      await c.close()
      await r.close()
    }
  })
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview(
  'I420 main SDL preview follows format changes and retains overlay while capture and recording remain usable',
  async () => {
    const c = new Camera(options),
      r = await Recorder.open(
        { outputframe() {} },
        { width: 64, height: 48, asyncWrites: true },
      )
    try {
      c.startPreview()
      c.setOverlay({
        data: new Uint8Array([0, 255, 0, 128]),
        width: 1,
        height: 1,
      })
      expect(c.previewStreamInfo()?.format).toBe('YUV420')
      c.startRecording(r)
      await c.switchRecordingModeAsync(
        r,
        { width: 80, height: 48 },
        {},
        { outputframe() {} },
      )
      expect(c.info().format).toBe('BGR888')
      await c.switchRecordingModeAsync(
        r,
        { width: 64, height: 48, format: 'YUV420' },
        {},
        { outputframe() {} },
      )
      expect(c.previewStreamInfo()?.format).toBe('YUV420')
      await c.captureMetadata()
      expect(c.previewError).toBeUndefined()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      await r.close()
    }
  },
)
for (const codec of ['h264', 'hevc'] as const)
  (process.env.ZC_TEST_CODECS ? test : test.skip)(
    `${codec} main I420 MP4 preserves each plane through sync/async compact producer admission`,
    async () => {
      const c = new Camera({ ...options, writable: true }),
        dir = mkdtempSync(join(tmpdir(), 'main-yuv-codec-')),
        path = join(dir, 'main.mp4'),
        expected: Uint8Array[] = []
      const r = new Recorder(path, {
        width: 64,
        height: 48,
        codec,
        quality: 100,
        gop: 2,
        fps: 25,
        producerQueue: { maxBytes: (64 * 48 * 3) / 2, maxOperations: 1 },
      })
      try {
        c.start()
        for (let frameIndex = 0; frameIndex < 4; frameIndex++) {
          const frame = c.acquire(1000)
          let pending: PromiseLike<void> | undefined
          try {
            frame.withMappedStream((map) => {
              for (const plane of map.planes) plane.bytes.fill(0xee)
              for (let y = 0; y < 48; y++)
                for (let x = 0; x < 64; x++)
                  map.row(y)[x] = 40 + frameIndex * 10 + Math.floor(x / 4) + y
              for (let y = 0; y < 24; y++)
                for (let x = 0; x < 32; x++) {
                  map.row(y, 1)[x] = 50 + frameIndex * 8 + x * 2
                  map.row(y, 2)[x] = 140 + frameIndex * 5 + y * 2
                }
            })
            const source = frame.copyStream().data,
              remapped = new Uint8Array(source.length),
              pixels = 64 * 48
            for (let i = 0; i < source.length; i++)
              remapped[i] = Math.round(
                i < pixels
                  ? 16 + (source[i] * 219) / 255
                  : 128 + ((source[i] - 128) * 224) / 255,
              )
            expected.push(remapped)
            if (frameIndex % 2) {
              pending = r.writeAsync(frame, BigInt(frameIndex) * 40_000_000n)
              expect(r.producerStats().ownedBytes).toBe(
                BigInt((64 * 48 * 3) / 2),
              )
              frame.withMappedStream((map) => {
                for (const plane of map.planes) plane.bytes.fill(0)
              })
            } else r.write(frame, BigInt(frameIndex) * 40_000_000n)
          } finally {
            frame.release()
          }
          if (pending) await pending
        }
        await r.close()
        const video = mp4(path).get(1)!
        expect([video.width, video.height, video.samples.length]).toEqual([
          64, 48, 4,
        ])
        decodeVideoI420(path, video, expected)
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
        await r.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
test('focus-locked RGB/encoded/DNG captures and group recording modes retain main format', async () => {
  const c = new Camera({ ...options, raw: true, unpackedRaw: true }),
    a = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    ),
    b = await Recorder.open(
      { outputframe() {} },
      { width: 64, height: 48, asyncWrites: true },
    )
  try {
    c.startContinuousAutofocus()
    expect((await c.captureFocusLockedRGB()).length).toBe(64 * 48 * 3)
    const png = await c.captureFocusLockedEncodedImage({ format: 'png' }),
      dng = await c.captureFocusLockedEncodedImage({ format: 'dng' })
    expect(Array.from(png.subarray(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ])
    expect(Array.from(dng.subarray(0, 4))).toEqual([73, 73, 42, 0])
    c.startPreview({ backend: 'headless' })
    let running = [c.startRecording(a), c.startRecording(b)]
    for (const format of ['BGR888', 'YUV420'] as const) {
      running = [
        ...(await c.switchRecordingsModeAsync(
          { width: 80, height: 48, format },
          running.map((recording) => ({
            recording,
            output: { outputframe() {} },
          })),
        )),
      ]
      await until(() => running.every((r) => r.stats().completed >= 2n))
      expect(c.info().format).toBe(format)
      expect(c.previewStreamInfo()?.format).toBe(format)
      expect(c.options.format).toBe(format)
      expect(running.every((r) => r.error === undefined)).toBe(true)
    }
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    await a.close()
    await b.close()
  }
})
for (const asyncWrites of [false, true])
  test(`main I420 and RGB lores share synchronized audio with ${asyncWrites ? 'async' : 'sync'} producers`, async () => {
    const c = new Camera(options),
      audio = new AudioCapture({
        simulate: true,
        channels: 2,
        blockFrames: 480,
      }),
      settings = {
        width: 64,
        height: 48,
        fps: 25,
        asyncWrites,
        audio: { sampleRate: 48000, channels: 2 as const, bufferFrames: 48000 },
      },
      a = await Recorder.open({ outputframe() {} }, settings),
      b = await Recorder.open(
        { outputframe() {} },
        { ...settings, width: 16, height: 12, stream: 'lores' },
      )
    try {
      const main = c.startRecording(a, { audio }),
        lores = c.startRecording(b, { audio })
      await until(
        () => main.stats().completed >= 4n && lores.stats().completed >= 4n,
      )
      await Promise.all([main.flushAsync(), lores.flushAsync()])
      for (const recording of [main, lores]) {
        expect(recording.audioStats()?.admittedFrames).toBe(
          BigInt(recording.frames * 1920),
        )
        expect(recording.error).toBeUndefined()
      }
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      await a.close()
      await b.close()
      audio.close()
    }
  })
