import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  CameraError,
  EncoderPreset,
  type EncoderOptions,
  type RecoveredRecordingSession,
} from '../../ts'
import { native as n, ptr } from '../../ts/ffi'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, decodeVideoI420, type Track } from './media'
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
const fast = { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 }
async function until(check: () => boolean) {
  const deadline = performance.now() + 5000
  while (!check()) {
    if (performance.now() > deadline) throw Error('encoder policy timeout')
    await Bun.sleep(1)
  }
}
function checkProfile(video: Track, profile: EncoderOptions['profile']) {
  if (video.codec === 'avc1') {
    const idc = video.config[1]
    if (profile === 'baseline' || profile === 'constrained-baseline') {
      expect(idc).toBe(66)
      expect(video.config[2] & 64).toBe(64)
    } else if (profile === 'main') expect([66, 77]).toContain(idc)
    else expect([66, 77, 100]).toContain(idc)
  } else {
    expect(video.codec).toBe('hvc1')
    expect(video.config[1] & 31).toBe(1)
  }
}
function expected(w: number, h: number) {
  const bytes = new Uint8Array((w * h * 3) / 2)
  bytes.fill(16 + Math.round((100 * 219) / 255), 0, w * h)
  bytes.fill(128, w * h)
  return bytes
}
function fill(camera: Camera) {
  camera.preCallback = (frame) =>
    frame.withMappedStream((map) => {
      for (let p = 0; p < 3; p++)
        for (let y = 0; y < (p ? map.height / 2 : map.height); y++)
          map.row(y, p).fill(p ? 128 : 100)
    })
}
function inspect(path: string, profile: EncoderOptions['profile']) {
  const video = mp4(path).get(1)!
  checkProfile(video, profile)
  const bytes = expected(video.width!, video.height!)
  decodeVideoI420(
    path,
    video,
    video.samples.map(() => bytes),
  )
  return video
}
test('invalid codec options fail before creating files or invoking custom output hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-policy-invalid-')),
    path = join(dir, 'rejected.mp4')
  let starts = 0
  try {
    const invalid = [
      { codec: 'h264', encoder: { qp: 52 } },
      { codec: 'h264', encoder: { qp: -1 } },
      { codec: 'h264', encoder: { qp: 1.5 } },
      { codec: 'h264', encoder: null },
      { codec: 'h264', encoder: 'slow' },
      { codec: 'h264', encoder: [] },
      { codec: 'h264', encoder: { preset: 'constructor' } },
      { codec: 'h264', encoder: { profile: 'unknown' } },
      { codec: 'hevc', encoder: { profile: 'high' } },
      { codec: 'h264', bitrate: 1000000, encoder: { qp: 26 } },
      { codec: 'mjpeg', encoder: { preset: 'slow' } },
    ] as const
    for (const options of invalid) {
      expect(
        () => new Recorder(path, { width: 32, height: 24, ...options } as any),
      ).toThrow()
      await expect(
        Recorder.open(
          {
            start() {
              starts++
            },
            outputframe() {},
          },
          { width: 32, height: 24, ...options } as any,
        ),
      ).rejects.toThrow()
      expect(existsSync(path)).toBe(false)
    }
    expect(starts).toBe(0)
    const recorder = new Recorder(null, { width: 32, height: 24 })
    expect(recorder.encoderOptions()).toEqual({
      profile: 'default',
      preset: 'veryfast',
      qp: 0,
    })
    await recorder.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
for (const codec of ['h264', 'hevc'] as const) {
  const profiles: NonNullable<EncoderOptions['profile']>[] =
    codec === 'h264'
      ? ['default', 'baseline', 'main', 'high', 'constrained-baseline']
      : ['default', 'main']
  for (const profile of profiles)
    media(
      `${codec} ${profile} policy owns copied options, headers and decoded MP4 through all presets`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zc-policy-mp4-')),
          camera = new Camera({
            simulate: true,
            writable: true,
            width: 32,
            height: 24,
            format: 'YUV420',
            colorSpace: 'sycc',
            fifo: true,
          })
        fill(camera)
        try {
          for (const preset of Object.keys(
            EncoderPreset,
          ) as (keyof typeof EncoderPreset)[]) {
            const path = join(dir, `${preset}.mp4`),
              options: EncoderOptions = { profile, preset, qp: 12 },
              recorder = new Recorder(path, {
                width: 32,
                height: 24,
                codec,
                encoder: options,
                gop: 2,
              })
            options.profile = 'high'
            options.qp = 50
            expect(recorder.encoderOptions()).toEqual({
              profile,
              preset,
              qp: 12,
            })
            expect(Object.isFrozen(recorder.options.encoder)).toBe(true)
            const recording = camera.startRecording(recorder)
            await until(() => recording.stats().completed >= 3n)
            await recording.flushAsync()
            const video = inspect(path, profile)
            expect(video.samples.length).toBe(recording.frames)
            await recorder.close()
          }
        } finally {
          await camera.close()
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )
}
media(
  'native option replacement preserves headers on error, survives color changes and freezes after output attachment',
  async () => {
    const recorder = new Recorder(null, {
      width: 32,
      height: 24,
      codec: 'h264',
      encoder: { profile: 'baseline', qp: 26 },
    })
    try {
      const getHeaders = () => {
          const out = new BigUint64Array(1)
          expect(
            n.zc_video_get_headers(recorder.handle, null, 0n, ptr(out)),
          ).toBe(0)
          const bytes = new Uint8Array(Number(out[0]))
          expect(
            n.zc_video_get_headers(
              recorder.handle,
              ptr(bytes),
              BigInt(bytes.length),
              ptr(out),
            ),
          ).toBe(0)
          return bytes
        },
        before = getHeaders(),
        bad = new Uint32Array([16, 3, 0, 52])
      expect(n.zc_video_set_codec_options(recorder.handle, ptr(bad))).toBe(-1)
      expect(getHeaders()).toEqual(before)
      const color = new Uint32Array(6)
      n.zc_default_video_color(ptr(color))
      color[3] = 1
      expect(n.zc_video_set_color(recorder.handle, ptr(color))).toBe(0)
      expect(recorder.encoderOptions()).toEqual({
        profile: 'baseline',
        preset: 'veryfast',
        qp: 26,
      })
      await recorder.addOutput({ outputframe() {} })
      expect(n.zc_video_set_codec_options(recorder.handle, null)).toBe(-4)
    } finally {
      await recorder.close()
    }
  },
)

media(
  'session reconfiguration copies policies, rejects conflicts before preparation and resets omitted policy on codec changes',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-policy-session-')),
      path = (name: string) => join(dir, `${name}.mp4`),
      camera = new Camera({
        simulate: true,
        writable: true,
        width: 32,
        height: 24,
        format: 'YUV420',
        colorSpace: 'sycc',
        fifo: true,
      }),
      recorder = await Recorder.open(path('first'), {
        width: 32,
        height: 24,
        codec: 'h264',
        encoder: { profile: 'baseline', preset: 'slow', qp: 12 },
      })
    fill(camera)
    try {
      let r = camera.startRecording(recorder)
      await until(() => r.stats().completed >= 3n)
      await r.flushAsync()
      expect(() =>
        recorder.reconfigureAsync({ bitrate: 1000000 }, path('invalid')),
      ).toThrow(CameraError)
      expect(existsSync(path('invalid'))).toBe(false)
      expect(recorder.encoderOptions().qp).toBe(12)
      const policy: EncoderOptions = {
        profile: 'main',
        preset: 'medium',
        qp: 18,
      }
      const change = recorder.reconfigureAsync(
        { encoder: policy },
        path('second'),
      )
      policy.qp = 50
      await change
      expect(recorder.encoderOptions()).toEqual({
        profile: 'main',
        preset: 'medium',
        qp: 18,
      })
      r = camera.startRecording(recorder)
      await until(() => r.stats().completed >= 3n)
      await r.flushAsync()
      await recorder.restartAsync(path('retained'))
      expect(recorder.encoderOptions()).toEqual({
        profile: 'main',
        preset: 'medium',
        qp: 18,
      })
      r = camera.startRecording(recorder)
      await until(() => r.stats().completed >= 3n)
      await r.flushAsync()
      await recorder.reconfigureAsync(
        { encoder: null, bitrate: 1000000 },
        path('abr'),
      )
      expect(recorder.encoderOptions()).toEqual({
        profile: 'default',
        preset: 'veryfast',
        qp: 0,
      })
      r = camera.startRecording(recorder)
      await until(() => r.stats().completed >= 3n)
      await r.flushAsync()
      await recorder.reconfigureAsync({ codec: 'hevc' }, path('hevc'))
      expect(recorder.encoderOptions()).toEqual({
        profile: 'default',
        preset: 'veryfast',
        qp: 0,
      })
      r = camera.startRecording(recorder)
      await until(() => r.stats().completed >= 3n)
      await r.flushAsync()
      inspect(path('first'), 'baseline')
      inspect(path('second'), 'main')
      inspect(path('retained'), 'main')
      inspect(path('abr'), 'default')
      inspect(path('hevc'), 'default')
    } finally {
      await camera.close()
      await recorder.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

media(
  'cancelled custom policy preparation retains old encoder state for a fresh file restart',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-policy-cancel-')),
      output = join(dir, 'candidate.mp4'),
      recorder = new Recorder(null, {
        width: 32,
        height: 24,
        codec: 'h264',
        encoder: { profile: 'baseline', qp: 12 },
      })
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (entered = resolve))
    try {
      await recorder.flushAsync()
      const job = recorder.reconfigureAsync(
        { encoder: { profile: 'high', qp: 40 } },
        {
          async start() {
            entered()
            await held
          },
          outputframe() {},
        },
      )
      await started
      expect(job.cancel()).toBe(true)
      release()
      await expect(job.wait()).rejects.toThrow()
      expect(recorder.encoderOptions()).toEqual({
        profile: 'baseline',
        preset: 'veryfast',
        qp: 12,
      })
      expect(recorder.options.encoder).toEqual({ profile: 'baseline', qp: 12 })
      await recorder.restartAsync(output)
      expect(recorder.encoderOptions().qp).toBe(12)
    } finally {
      release()
      await recorder.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

media(
  'coordinated modes and fresh-camera recovery carry independent encoder policies into newly published sessions',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-policy-group-')),
      path = (name: string) => join(dir, `${name}.mp4`),
      camera = new Camera({
        simulate: true,
        writable: true,
        width: 32,
        height: 24,
        format: 'YUV420',
        colorSpace: 'sycc',
        fifo: true,
      }),
      a = new Recorder(path('a0'), {
        width: 32,
        height: 24,
        codec: 'h264',
        encoder: { profile: 'baseline', qp: 12 },
      }),
      b = new Recorder(path('b0'), {
        width: 32,
        height: 24,
        codec: 'hevc',
        encoder: { profile: 'main', preset: 'slow', qp: 12 },
      })
    fill(camera)
    let next: RecoveredRecordingSession | undefined
    try {
      const old = [camera.startRecording(a), camera.startRecording(b)]
      await until(() => old.every((r) => r.stats().completed >= 3n))
      const switched = await camera.switchRecordingsModeAsync(
        {
          width: 48,
          height: 32,
          format: 'YUV420',
          colorSpace: 'sycc',
          writable: true,
        },
        [
          {
            recording: old[0],
            output: path('a1'),
            settings: {
              encoder: { profile: 'main', preset: 'medium', qp: 12 },
            },
          },
          { recording: old[1], output: path('b1') },
        ],
      )
      await until(() => switched.every((r) => r.stats().completed >= 3n))
      camera.simulateDisconnect()
      next = await camera.reconnectRecordingsAsync(
        [
          { recording: switched[0], output: path('a2') },
          {
            recording: switched[1],
            output: path('b2'),
            settings: {
              codec: 'h264',
              encoder: { profile: 'constrained-baseline', qp: 12 },
            },
          },
        ],
        fast,
      )
      expect(a.options.encoder).toEqual({
        profile: 'main',
        preset: 'medium',
        qp: 12,
      })
      expect(b.options.encoder).toEqual({
        profile: 'constrained-baseline',
        qp: 12,
      })
      await camera.close()
      await until(() =>
        next!.recordings.every((r) => r.stats().completed >= 3n),
      )
      await Promise.all(next.recordings.map((r) => r.flushAsync()))
      for (const [name, profile] of [
        ['a0', 'baseline'],
        ['b0', 'main'],
        ['a1', 'main'],
        ['b1', 'main'],
        ['a2', 'main'],
        ['b2', 'constrained-baseline'],
      ] as const)
        inspect(path(name), profile)
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

function avcPpsQP(config: Buffer) {
  let at = 6
  for (let i = 0; i < (config[5] & 31); i++) at += 2 + config.readUInt16BE(at)
  expect(config[at++]).toBeGreaterThan(0)
  const size = config.readUInt16BE(at)
  at += 2
  const pps = config.subarray(at, at + size)
  expect(pps[0] & 31).toBe(8)
  const data: number[] = []
  let zeros = 0
  for (const byte of pps.subarray(1)) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    data.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  let bit = 0
  const read = (width: number) => {
      let v = 0
      for (let i = 0; i < width; i++) {
        if (bit >= data.length * 8) throw Error('truncated PPS')
        v = v * 2 + ((data[bit >> 3] >> (7 - (bit++ & 7))) & 1)
      }
      return v
    },
    ue = () => {
      let count = 0
      while (!read(1)) if (++count > 30) throw Error('oversized Exp-Golomb')
      return 2 ** count - 1 + read(count)
    }
  ue()
  ue()
  read(2)
  expect(ue()).toBe(0)
  ue()
  ue()
  read(3)
  const v = ue()
  return 26 + (v & 1 ? (v + 1) / 2 : -v / 2)
}
media(
  'AVC fixed QP is represented in the emitted PPS across quantizer endpoints',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-policy-qp-')),
      camera = new Camera({ simulate: true, width: 32, height: 24 })
    try {
      for (const qp of [1, 12, 26, 51]) {
        const path = join(dir, `${qp}.mp4`),
          recorder = new Recorder(path, {
            width: 32,
            height: 24,
            codec: 'h264',
            encoder: { profile: 'baseline', qp },
          })
        const recording = camera.startRecording(recorder)
        await until(() => recording.stats().completed > 0n)
        await recording.flushAsync()
        await recorder.close()
        expect(avcPpsQP(mp4(path).get(1)!.config)).toBe(qp)
      }
    } finally {
      await camera.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
