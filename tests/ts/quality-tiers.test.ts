import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  QualityTier,
  planRecordingQuality,
  CameraError,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
  type QualityTierName,
  type RecoveredRecordingSession,
} from '../../ts'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, decodeVideoI420 } from './media'
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
const tiers = ['very-low', 'low', 'medium', 'high', 'very-high'] as const
const rates = [3000000, 4000000, 7000000, 10000000, 14000000],
  jpeg = [25, 35, 50, 65, 80]
class Tape implements CustomOutput {
  packets: OutputPacket[] = []
  outputframe(p: OutputPacket) {
    if (!p.audio) this.packets.push({ ...p, data: p.data.slice() })
  }
}
function camera(width = 64, height = 48) {
  const c = new Camera({
    simulate: true,
    writable: true,
    width,
    height,
    format: 'YUV420',
    colorSpace: 'sycc',
    fifo: true,
  })
  c.start()
  return c
}
function fill(c: Camera) {
  c.preCallback = (f) =>
    f.withMappedStream((m) => {
      for (let p = 0; p < 3; p++)
        for (let y = 0; y < (p ? m.height / 2 : m.height); y++)
          m.row(y, p).fill(p ? 128 : 100)
    })
}
function input(c: Camera, r: Recorder, index: number) {
  using f = c.acquire()
  f.withMappedStream((m) => {
    for (let p = 0; p < 3; p++)
      for (let y = 0; y < (p ? m.height / 2 : m.height); y++)
        m.row(y, p).fill(p ? 128 : 100)
  })
  r.write(f, BigInt(index) * 33333333n)
}
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('quality timeout')
    await Bun.sleep(1)
  }
}
function checkVideo(path: string, frames?: number) {
  const v = mp4(path).get(1)!
  if (frames !== undefined) expect(v.samples.length).toBe(frames)
  expect(v.samples.length).toBeGreaterThan(0)
  const bytes = new Uint8Array((v.width! * v.height! * 3) / 2)
  bytes.fill(100, 0, v.width! * v.height!)
  bytes.fill(128, v.width! * v.height!)
  decodeVideoI420(
    path,
    v,
    v.samples.map(() => bytes),
  )
}

test('named quality planning matches software reference rates, exact scaling and JPEG values without an encoder', () => {
  for (const [tier, index] of tiers.map((t, i) => [t, i] as const)) {
    for (const codec of ['h264', 'hevc'] as const) {
      expect(
        planRecordingQuality({
          width: 1920,
          height: 1080,
          codec,
          quality: tier,
        }).bitrate,
      ).toBe(rates[index])
      expect(
        planRecordingQuality({ width: 960, height: 540, codec, quality: tier })
          .bitrate,
      ).toBe(rates[index] / 2)
      expect(
        planRecordingQuality({
          width: 3840,
          height: 2160,
          codec,
          quality: tier,
        }).bitrate,
      ).toBe(rates[index] * 2)
      const p = planRecordingQuality({
        width: 128,
        height: 96,
        fps: 24,
        codec,
        quality: tier,
      })
      expect(p.bitrate).toBe(
        Math.floor(
          (rates[index] * Math.sqrt((128 * 96 * 24) / (1920 * 1080 * 30))) /
            1000,
        ) * 1000,
      )
      expect(p.mode).toBe('abr')
      expect(Object.isFrozen(p)).toBe(true)
    }
    expect(
      planRecordingQuality({ width: 33, height: 25, quality: tier }).quality,
    ).toBe(jpeg[index])
  }
  expect(QualityTier.high).toBe('high')
  expect(() =>
    planRecordingQuality({
      width: 8192,
      height: 8192,
      fps: 1000000,
      codec: 'hevc',
      quality: 'very-high',
    }),
  ).toThrow(CameraError)
})

test('JPEG tiers select the actual Home quantizer quality with unchanged numeric defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-jpeg-tier-')),
    c = camera()
  try {
    for (const [tier, index] of tiers.map((t, i) => [t, i] as const)) {
      const a = new Tape(),
        b = new Tape(),
        r = await Recorder.open(a, { width: 64, height: 48, quality: tier }),
        control = await Recorder.open(b, {
          width: 64,
          height: 48,
          quality: jpeg[index],
        })
      try {
        using f = c.acquire()
        r.write(f, 0n)
        control.write(f, 0n)
        await r.close()
        await control.close()
        expect(a.packets[0].data).toEqual(b.packets[0].data)
        if (process.env.ZC_IMAGE_DECODER) {
          const path = join(dir, `${tier}.jpg`)
          writeFileSync(path, a.packets[0].data)
          const d = Bun.spawnSync([process.env.ZC_IMAGE_DECODER, 'jpeg', path])
          expect(d.exitCode, new TextDecoder().decode(d.stderr)).toBe(0)
        }
      } finally {
        await r.close()
        await control.close()
      }
    }
    const r = new Recorder(null, { width: 64, height: 48 })
    try {
      expect(r.qualityPolicy()).toEqual({
        tier: undefined,
        numericQuality: 90,
        targetBitrate: 0,
        mode: 'jpeg',
      })
    } finally {
      await r.close()
    }
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tier and numeric validation rejects before paths/hooks, including unsupported JPEG rate control', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-tier-invalid-')),
    path = join(dir, 'never.mkv')
  let starts = 0
  try {
    for (const quality of [
      null,
      0,
      101,
      1.5,
      NaN,
      Infinity,
      'HIGH',
      'lossless',
      {},
      [],
    ]) {
      const options = { width: 64, height: 48, quality: quality as never }
      expect(() => new Recorder(path, options)).toThrow()
      expect(existsSync(path)).toBe(false)
      await expect(
        Recorder.open(
          {
            start() {
              starts++
            },
            outputframe() {},
          },
          options,
        ),
      ).rejects.toThrow()
    }
    expect(
      () =>
        new Recorder(path, {
          width: 64,
          height: 48,
          quality: 'high',
          bitrate: 1000,
        }),
    ).toThrow()
    expect(starts).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const codec of ['h264', 'hevc'] as const)
  media(
    `${codec} named tiers override target rates and produce independently decoded MP4`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-video-tier-')),
        c = camera()
      try {
        for (const tier of tiers) {
          const path = join(dir, `${tier}.mp4`),
            options = {
              width: 64,
              height: 48,
              codec,
              quality: tier as QualityTierName,
              bitrate: 1000,
              colorSpace: 'sycc' as const,
            },
            r = new Recorder(path, options)
          try {
            options.quality = 'very-low'
            expect(r.qualityPolicy()).toEqual({
              tier,
              numericQuality: 90,
              targetBitrate: planRecordingQuality({
                width: 64,
                height: 48,
                codec,
                quality: tier,
              }).bitrate,
              mode: 'abr',
            })
            for (let i = 0; i < 6; i++) input(c, r, i)
            await r.close()
            checkVideo(path, 6)
          } finally {
            await r.close()
          }
        }
      } finally {
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

media(
  'derived tier rates participate in QP/VBV admission before output side effects',
  async () => {
    let starts = 0
    const sink = {
      start() {
        starts++
      },
      outputframe() {},
    }
    for (const codec of ['h264', 'hevc'] as const) {
      await expect(
        Recorder.open(sink, {
          width: 64,
          height: 48,
          codec,
          quality: 'high',
          encoder: { qp: 26 },
        }),
      ).rejects.toThrow()
      await expect(
        Recorder.open(sink, {
          width: 64,
          height: 48,
          codec,
          quality: 'high',
          limits: { maxBitrate: 64000, bufferBits: 128000 },
        }),
      ).rejects.toThrow()
      const numeric = new Recorder(null, {
        width: 64,
        height: 48,
        codec,
        quality: 97,
        encoder: { qp: 26 },
      })
      try {
        expect(numeric.qualityPolicy().mode).toBe('cqp')
      } finally {
        await numeric.close()
      }
    }
    expect(starts).toBe(0)
  },
)

media(
  'tier sessions recalculate geometry/fps, preserve rollback and explicit null restores legacy numeric control',
  async () => {
    const r = new Recorder(null, {
      width: 64,
      height: 48,
      codec: 'h264',
      quality: 'high',
    })
    try {
      const old = r.qualityPolicy()
      await r.flushAsync()
      const cancelled = r.reconfigureAsync({
          width: 128,
          height: 96,
          quality: 'low',
        }),
        error = Promise.resolve(cancelled).catch((e) => e)
      expect(cancelled.cancel()).toBe(true)
      expect(await error).toBeInstanceOf(JobCancelledError)
      await cancelled.operationDone
      expect(r.qualityPolicy()).toEqual(old)
      await r.reconfigureAsync({ width: 128, height: 96, fps: 60 })
      expect(r.qualityPolicy().targetBitrate).toBe(
        planRecordingQuality({
          width: 128,
          height: 96,
          fps: 60,
          codec: 'h264',
          quality: 'high',
        }).bitrate,
      )
      await r.flushAsync()
      await r.reconfigureAsync({ codec: 'mjpeg' })
      expect(r.qualityPolicy()).toEqual({
        tier: 'high',
        numericQuality: 65,
        targetBitrate: 0,
        mode: 'jpeg',
      })
      await r.flushAsync()
      await r.reconfigureAsync({ codec: 'hevc' })
      expect(r.qualityPolicy().mode).toBe('abr')
      await r.flushAsync()
      await r.reconfigureAsync({ quality: null })
      expect(r.qualityPolicy()).toEqual({
        tier: undefined,
        numericQuality: 90,
        targetBitrate: 0,
        mode: 'crf',
      })
      await r.flushAsync()
      await r.reconfigureAsync({ quality: 96, bitrate: 123000 })
      expect(r.qualityPolicy()).toEqual({
        tier: undefined,
        numericQuality: 96,
        targetBitrate: 123000,
        mode: 'abr',
      })
    } finally {
      await r.close()
    }
  },
)

media(
  'coordinated modes and fresh-camera recovery derive tier bitrate from each negotiated session',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-tier-modes-')),
      c = camera(64, 48),
      path = (s: string) => join(dir, `${s}.mp4`)
    const r = new Recorder(path('old'), {
      width: 64,
      height: 48,
      codec: 'h264',
      quality: 'medium',
      colorSpace: 'sycc',
    })
    fill(c)
    let recovered: RecoveredRecordingSession | undefined
    try {
      const recording = c.startRecording(r)
      await until(() => recording.stats().completed >= 4n)
      const switched = await c.switchRecordingModeAsync(
        r,
        {
          width: 32,
          height: 24,
          format: 'YUV420',
          colorSpace: 'sycc',
          writable: true,
        },
        { limits: { maxBitrate: 250000, bufferBits: 500000 } },
        path('mode'),
      )
      expect(r.qualityPolicy().targetBitrate).toBe(
        planRecordingQuality({
          width: 32,
          height: 24,
          codec: 'h264',
          quality: 'medium',
        }).bitrate,
      )
      await until(() => switched.stats().completed >= 4n)
      const reset = await c.switchRecordingModeAsync(
        r,
        {
          width: 32,
          height: 24,
          format: 'YUV420',
          colorSpace: 'sycc',
          writable: true,
        },
        { quality: null, limits: null },
        path('reset'),
      )
      expect(r.qualityPolicy().mode).toBe('crf')
      expect(r.qualityPolicy().tier).toBeUndefined()
      await until(() => reset.stats().completed >= 4n)
      c.simulateDisconnect()
      recovered = await c.reconnectRecordingsAsync(
        [
          {
            recording: reset,
            settings: { fps: 60, quality: 'medium' },
            output: path('recovered'),
          },
        ],
        { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 },
      )
      expect(r.qualityPolicy().targetBitrate).toBe(
        planRecordingQuality({
          width: 32,
          height: 24,
          fps: 60,
          codec: 'h264',
          quality: 'medium',
        }).bitrate,
      )
      await until(() => recovered!.recordings[0].stats().completed >= 4n)
      await recovered.recordings[0].flushAsync()
      for (const name of ['old', 'mode', 'reset', 'recovered'])
        checkVideo(path(name))
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

test('quality getters are snapshotted once for construction and reconfiguration', async () => {
  let reads = 0
  const r = new Recorder(null, {
    width: 64,
    height: 48,
    get quality() {
      reads++
      return 'medium' as const
    },
  })
  try {
    expect(reads).toBe(1)
    await r.flushAsync()
    reads = 0
    await r.reconfigureAsync({
      get quality() {
        reads++
        return 'high' as const
      },
    })
    expect(reads).toBe(1)
    expect(r.qualityPolicy().numericQuality).toBe(65)
  } finally {
    await r.close()
  }
})
