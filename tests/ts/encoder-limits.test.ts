import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  type EncoderLimits,
  type RecorderOptions,
  type RecoveredRecordingSession,
} from '../../ts'
import { native as n, ptr } from '../../ts/ffi'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, units, decodeVideoI420, type Track } from './media'
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
const defaults = { level: 0, maxBitrate: 0, bufferBits: 0 }
const fast = { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 }
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('limits timeout')
    await Bun.sleep(1)
  }
}
function level(video: Track) {
  return video.codec === 'avc1'
    ? video.config[3] === 9
      ? 10.5
      : video.config[3]
    : video.config[12] / 3
}
function checkVideo(path: string, ceiling: number, frames?: number) {
  const video = mp4(path).get(1)!
  expect(level(video)).toBeGreaterThan(0)
  expect(level(video)).toBeLessThanOrEqual(ceiling)
  if (frames !== undefined) expect(video.samples.length).toBe(frames)
  const bytes = new Uint8Array((video.width! * video.height! * 3) / 2)
  bytes.fill(100, 0, video.width! * video.height!)
  bytes.fill(128, video.width! * video.height!)
  decodeVideoI420(
    path,
    video,
    video.samples.map(() => bytes),
  )
  return video
}
function fill(camera: Camera) {
  camera.preCallback = (frame) =>
    frame.withMappedStream((map) => {
      for (let p = 0; p < 3; p++)
        for (let y = 0; y < (p ? map.height / 2 : map.height); y++)
          map.row(y, p).fill(p ? 128 : 100)
    })
}
function decoder(path: string, video: Track) {
  const tool = process.env.ZC_INDEPENDENT_DECODER
  if (!tool) return
  const result = Bun.spawnSync([
    tool,
    video.codec === 'avc1' ? 'h264' : 'hevc',
    units(path, video),
    String(video.samples.length),
    '--decode-only',
    String(video.width),
    String(video.height),
  ])
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
}
test('invalid limits reject before file creation and host hook admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-limits-invalid-')),
    path = join(dir, 'rejected.mp4')
  let starts = 0
  try {
    const invalid = [
      { limits: { level: 9 } },
      { limits: { level: -1 } },
      { limits: { level: 40.5 } },
      { limits: { level: 2 ** 32 } },
      { limits: { maxBitrate: 64000 } },
      { limits: { bufferBits: 128000 } },
      { limits: { maxBitrate: 64000, bufferBits: 1000 } },
      { limits: { maxBitrate: 64001, bufferBits: 128000 } },
      { limits: { maxBitrate: 64000, bufferBits: 128001 } },
      { bitrate: 100000, limits: { maxBitrate: 64000, bufferBits: 128000 } },
      {
        encoder: { qp: 26 },
        limits: { maxBitrate: 64000, bufferBits: 128000 },
      },
      { codec: 'hevc', encoder: { qp: 26 }, limits: { level: 20 } },
      { codec: 'hevc', limits: { level: 42 } },
      { codec: 'mjpeg', limits: { level: 40 } },
      { limits: [] },
      { limits: 'slow' },
      { limits: null },
    ]
    for (const options of invalid) {
      const all = {
        width: 64,
        height: 48,
        codec: 'h264',
        ...options,
      } as RecorderOptions
      expect(() => new Recorder(path, all)).toThrow()
      await expect(
        Recorder.open(
          {
            start() {
              starts++
            },
            outputframe() {},
          },
          all,
        ),
      ).rejects.toThrow()
      expect(existsSync(path)).toBe(false)
    }
    expect(starts).toBe(0)
    const r = new Recorder(null, { width: 32, height: 24 })
    expect(r.encoderLimits()).toEqual(defaults)
    await r.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
for (const codec of ['h264', 'hevc'] as const)
  media(
    `${codec} level ceilings and VBV own copied policies and emit independently decoded bounded-level MP4`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-limits-stream-')),
        camera = new Camera({
          simulate: true,
          writable: true,
          width: 64,
          height: 48,
          format: 'YUV420',
          colorSpace: 'sycc',
          fifo: true,
        })
      fill(camera)
      try {
        for (const ceiling of [10, 20, 40, 41, 50, 62]) {
          const path = join(dir, `${ceiling}.mp4`),
            limits: EncoderLimits = {
              level: ceiling,
              maxBitrate: 64000,
              bufferBits: 128000,
            },
            r = new Recorder(path, {
              width: 64,
              height: 48,
              codec,
              colorSpace: 'sycc',
              limits,
            })
          limits.level = 99
          limits.maxBitrate = 2 ** 32
          expect(r.encoderLimits()).toEqual({
            level: ceiling,
            maxBitrate: 64000,
            bufferBits: 128000,
          })
          expect(Object.isFrozen(r.options.limits)).toBe(true)
          const recording = camera.startRecording(r)
          await until(() => recording.stats().completed >= 3n)
          await recording.flushAsync()
          const video = checkVideo(path, ceiling, recording.frames)
          if (codec === 'h264' && ceiling >= 50)
            expect(level(video)).toBeLessThanOrEqual(20)
          await r.close()
        }
      } finally {
        await camera.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
media(
  'resource ceilings reject too-large pictures, nominal rates and excessive CPB without creating a path',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-limits-resource-')),
      path = join(dir, 'rejected.mp4')
    try {
      for (const codec of ['h264', 'hevc'] as const)
        for (const opts of [
          { width: 1920, height: 1080, fps: 30, limits: { level: 10 } },
          { width: 64, height: 48, fps: 1000000, limits: { level: 10 } },
          {
            width: 64,
            height: 48,
            limits: { level: 10, maxBitrate: 1000000, bufferBits: 2000000 },
          },
        ]) {
          expect(() => new Recorder(path, { ...opts, codec })).toThrow()
          expect(existsSync(path)).toBe(false)
        }
      expect(
        () =>
          new Recorder(path, {
            width: 3840,
            height: 2160,
            fps: 60,
            codec: 'hevc',
            limits: { level: 50 },
          }),
      ).toThrow()
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
media(
  'native rejected limit replacement keeps headers and options, and attachment forbids mutation',
  async () => {
    const r = new Recorder(null, {
      width: 64,
      height: 48,
      codec: 'h264',
      limits: { level: 20, maxBitrate: 64000, bufferBits: 128000 },
    })
    const headers = () => {
      const size = new BigUint64Array(1)
      expect(n.zc_video_get_headers(r.handle, null, 0n, ptr(size))).toBe(0)
      const bytes = new Uint8Array(Number(size[0]))
      expect(
        n.zc_video_get_headers(
          r.handle,
          ptr(bytes),
          BigInt(bytes.length),
          ptr(size),
        ),
      ).toBe(0)
      return bytes
    }
    try {
      const before = headers(),
        bad = new Uint32Array([16, 10, 1000000, 2000000])
      expect(n.zc_video_set_codec_limits(r.handle, ptr(bad))).toBe(-1)
      expect(headers()).toEqual(before)
      expect(r.encoderLimits().level).toBe(20)
      const qp = new Uint32Array([16, 0, 0, 26])
      expect(n.zc_video_set_codec_options(r.handle, ptr(qp))).toBe(-1)
      expect(headers()).toEqual(before)
      await r.addOutput({ outputframe() {} })
      expect(n.zc_video_set_codec_limits(r.handle, null)).toBe(-4)
    } finally {
      await r.close()
    }
  },
)
for (const codec of ['h264', 'hevc'] as const)
  media(
    `${codec} VBV constrains a high-complexity stream without dropping accepted frames`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-limits-pressure-')),
        camera = new Camera({
          simulate: true,
          writable: true,
          width: 128,
          height: 96,
          format: 'YUV420',
          colorSpace: 'sycc',
          fifo: true,
        })
      camera.start()
      try {
        const sizes: number[] = []
        for (const bounded of [false, true]) {
          const path = join(dir, `${bounded}.mp4`),
            r = new Recorder(path, {
              width: 128,
              height: 96,
              codec,
              colorSpace: 'sycc',
              quality: 100,
              limits: bounded
                ? { level: 20, maxBitrate: 64000, bufferBits: 128000 }
                : undefined,
            })
          for (let i = 0; i < 60; i++) {
            using frame = camera.acquire()
            let seed = (i + 1) * 1234567
            frame.withMappedStream((map) => {
              for (let p = 0; p < 3; p++)
                for (let y = 0; y < (p ? map.height / 2 : map.height); y++) {
                  const row = map.row(y, p)
                  for (let x = 0; x < row.length; x++) {
                    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
                    row[x] = (seed >>> 24) & 255
                  }
                }
            })
            r.write(frame, BigInt(i) * 33333333n)
          }
          await r.close()
          const video = mp4(path).get(1)!,
            bits = video.samples.reduce((n, s) => n + s.length * 8, 0)
          expect(video.samples.length).toBe(60)
          sizes.push(bits)
          decoder(path, video)
          if (bounded) {
            expect(level(video)).toBeLessThanOrEqual(20)
            const duration =
              Number(video.times.at(-1)! - video.times[0]) +
              video.durations.at(-1)!
            expect(bits).toBeLessThanOrEqual(128000 + (64000 * duration) / 1e6)
          }
        }
        expect(sizes[1]).toBeLessThan(sizes[0] / 2)
      } finally {
        await camera.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    // This exercises 120 encoded frames plus independent decoders. The bounded
    // framework budget is not a camera/codec latency or bitrate assertion.
    30_000,
  )

media(
  'failed and cancelled limit reconfiguration preserves the flushed session for an explicit restart',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-limits-session-')),
      path = (s: string) => join(dir, `${s}.mp4`),
      r = new Recorder(null, {
        width: 64,
        height: 48,
        codec: 'h264',
        colorSpace: 'sycc',
        limits: { level: 20 },
      }),
      camera = new Camera({
        simulate: true,
        writable: true,
        width: 64,
        height: 48,
        format: 'YUV420',
        colorSpace: 'sycc',
        fifo: true,
      })
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve)),
      start = new Promise<void>((resolve) => (entered = resolve))
    fill(camera)
    try {
      await r.flushAsync()
      await expect(
        r
          .reconfigureAsync(
            { width: 1920, height: 1080, limits: { level: 10 } },
            path('rejected'),
          )
          .wait(),
      ).rejects.toThrow()
      expect(existsSync(path('rejected'))).toBe(false)
      expect(r.width).toBe(64)
      expect(r.encoderLimits().level).toBe(20)
      const proposed: EncoderLimits = {
          level: 40,
          maxBitrate: 64000,
          bufferBits: 128000,
        },
        job = r.reconfigureAsync(
          { limits: proposed },
          {
            async start() {
              entered()
              await hold
            },
            outputframe() {},
          },
        )
      proposed.level = 99
      await start
      expect(job.cancel()).toBe(true)
      release()
      await expect(job.wait()).rejects.toThrow()
      expect(r.encoderLimits()).toEqual({
        level: 20,
        maxBitrate: 0,
        bufferBits: 0,
      })
      await r.restartAsync(path('retained'))
      const recording = camera.startRecording(r)
      await until(() => recording.stats().completed >= 3n)
      await recording.flushAsync()
      checkVideo(path('retained'), 20, recording.frames)
      await r.reconfigureAsync({ limits: null }, path('reset'))
      expect(r.encoderLimits()).toEqual(defaults)
      const reset = camera.startRecording(r)
      await until(() => reset.stats().completed >= 3n)
      await reset.flushAsync()
      checkVideo(path('reset'), 62, reset.frames)
    } finally {
      release()
      await camera.close()
      await r.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
media(
  'coordinated modes and fresh-camera recovery preserve independent limits and reset explicitly omitted codec state',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-limits-group-')),
      path = (s: string) => join(dir, `${s}.mp4`),
      camera = new Camera({
        simulate: true,
        writable: true,
        width: 64,
        height: 48,
        format: 'YUV420',
        colorSpace: 'sycc',
        fifo: true,
      }),
      a = new Recorder(path('a0'), {
        width: 64,
        height: 48,
        codec: 'h264',
        colorSpace: 'sycc',
        encoder: { profile: 'baseline' },
        limits: { level: 20, maxBitrate: 64000, bufferBits: 128000 },
      }),
      b = new Recorder(path('b0'), {
        width: 64,
        height: 48,
        codec: 'hevc',
        colorSpace: 'sycc',
        limits: { level: 40, maxBitrate: 128000, bufferBits: 256000 },
      })
    let next: RecoveredRecordingSession | undefined
    fill(camera)
    try {
      const old = [camera.startRecording(a), camera.startRecording(b)]
      await until(() => old.every((r) => r.stats().completed >= 3n))
      const changed = await camera.switchRecordingsModeAsync(
        {
          width: 128,
          height: 96,
          format: 'YUV420',
          colorSpace: 'sycc',
          writable: true,
        },
        [
          {
            recording: old[0],
            output: path('a1'),
            settings: {
              limits: { level: 10, maxBitrate: 64000, bufferBits: 128000 },
            },
          },
          { recording: old[1], output: path('b1') },
        ],
      )
      await until(() => changed.every((r) => r.stats().completed >= 3n))
      camera.simulateDisconnect()
      next = await camera.reconnectRecordingsAsync(
        [
          {
            recording: changed[0],
            output: path('a2'),
            settings: { limits: null, encoder: null },
          },
          { recording: changed[1], output: path('b2') },
        ],
        fast,
      )
      await camera.close()
      await until(() =>
        next!.recordings.every((r) => r.stats().completed >= 3n),
      )
      await Promise.all(next.recordings.map((r) => r.flushAsync()))
      expect(a.encoderLimits()).toEqual(defaults)
      expect(a.encoderOptions().profile).toBe('default')
      expect(b.encoderLimits()).toEqual({
        level: 40,
        maxBitrate: 128000,
        bufferBits: 256000,
      })
      for (const [name, ceiling] of [
        ['a0', 20],
        ['b0', 40],
        ['a1', 10],
        ['b1', 40],
        ['a2', 62],
        ['b2', 40],
      ] as const)
        checkVideo(path(name), ceiling)
      await a.reconfigureAsync({ codec: 'hevc' }, path('changed-codec'))
      expect(a.encoderLimits()).toEqual(defaults)
    } finally {
      await Promise.allSettled([
        next?.camera.close(),
        camera.close(),
        a.close(),
        b.close(),
      ])
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

media(
  'AVC auto level 1b is above a 1.0 ceiling and a bounded 1.0 stream still independently decodes',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-level-1b-')),
      path = join(dir, 'bounded.mp4'),
      camera = new Camera({
        simulate: true,
        writable: true,
        width: 64,
        height: 48,
        format: 'YUV420',
        colorSpace: 'sycc',
        fifo: true,
      })
    fill(camera)
    try {
      expect(
        () =>
          new Recorder(path, {
            width: 64,
            height: 48,
            codec: 'h264',
            bitrate: 64000,
            limits: { level: 10 },
          }),
      ).toThrow()
      expect(existsSync(path)).toBe(false)
      const recorder = new Recorder(path, {
          width: 64,
          height: 48,
          codec: 'h264',
          colorSpace: 'sycc',
          bitrate: 64000,
          limits: { level: 10, maxBitrate: 64000, bufferBits: 128000 },
        }),
        recording = camera.startRecording(recorder)
      try {
        await until(() => recording.stats().completed >= 3n)
        await recording.flushAsync()
        const video = checkVideo(path, 10, recording.frames)
        expect(video.config[3]).toBe(10)
      } finally {
        await recorder.close()
      }
    } finally {
      await camera.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
