import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Camera,
  Recorder,
  AudioCapture,
  CameraError,
  type CustomOutput,
  type OutputPacket,
  type RecoveredRecordingSession,
  type Recording,
} from '../../ts'
const fast = { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 }
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, promise }
}
async function until(check: () => boolean) {
  const end = performance.now() + 5000
  while (!check()) {
    if (performance.now() > end) throw Error('session recovery deadline')
    await Bun.sleep(1)
  }
}
class Sink implements CustomOutput {
  packets: OutputPacket[] = []
  stopped = 0
  outputframe(packet: OutputPacket) {
    this.packets.push(packet)
  }
  stop() {
    this.stopped++
  }
}
async function setup(audio?: AudioCapture, preview = false) {
  const c = new Camera({
      simulate: true,
      width: 32,
      height: 24,
      lores: { width: 16, height: 12 },
      fifo: true,
    }),
    a = new Sink(),
    b = new Sink(),
    common = {
      fps: 25,
      asyncWrites: true,
      producerQueue: { maxBytes: 512 * 1024, maxOperations: 4 },
      outputQueue: { maxBytes: 512 * 1024, maxOperations: 16, waitMs: 1000 },
      audio: audio && {
        sampleRate: audio.sampleRate,
        channels: audio.channels,
      },
    },
    ra = await Recorder.open(a, { ...common, width: 32, height: 24 }),
    rb = await Recorder.open(b, {
      ...common,
      width: 16,
      height: 12,
      stream: 'lores',
    }),
    first = c.startRecording(ra, { audio }),
    second = c.startRecording(rb, { audio })
  if (preview)
    c.startPreview({ backend: 'headless', stream: 'lores', keepAspect: false })
  await until(() => first.frames > 1 && second.frames > 1)
  c.simulateDisconnect()
  await until(() => !!c.deviceError)
  return {
    c,
    ra,
    rb,
    first,
    second,
    a,
    b,
    async close(next?: RecoveredRecordingSession) {
      await Promise.allSettled([
        next?.camera.close(),
        c.close(),
        ra.close(),
        rb.close(),
      ])
      audio?.close()
    },
  }
}

test('all encoders recover into one new camera and old recording owners cannot detach replacements', async () => {
  const s = await setup(undefined, true),
    a = new Sink(),
    b = new Sink()
  let next: RecoveredRecordingSession | undefined
  try {
    next = await s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: a },
        { recording: s.second, output: b },
      ],
      fast,
    )
    expect(next.camera).not.toBe(s.c)
    expect(next.camera.cameraId).toBe(s.c.cameraId)
    expect(Object.isFrozen(next)).toBe(true)
    expect(next.recordings.length).toBe(2)
    expect(s.c.activeRecordings.length).toBe(0)
    expect(next.camera.activeRecordings).toEqual(next.recordings)
    expect(next.camera.previewInfo()).toMatchObject({
      suspended: false,
      stream: 'lores',
      keepAspect: false,
    })
    await Promise.allSettled([s.first.close(), s.second.close(), s.c.close()])
    await until(() => next!.recordings.every((r) => r.stats().completed >= 3n))
    expect(next.recordings.map((r) => r.error)).toEqual([undefined, undefined])
    expect(a.packets.length).toBeGreaterThan(0)
    expect(b.packets.length).toBeGreaterThan(0)
    expect(s.a.stopped).toBe(1)
    expect(s.b.stopped).toBe(1)
  } finally {
    await s.close(next)
  }
})

test('every output becomes ready before shared session publication', async () => {
  const s = await setup(),
    hold = gate(),
    entered = gate(),
    a = new Sink(),
    b = new Sink()
  let next: RecoveredRecordingSession | undefined
  try {
    const job = s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: a },
        {
          recording: s.second,
          output: {
            async start() {
              entered.release()
              await hold.promise
            },
            outputframe: (packet) => b.outputframe(packet),
          },
        },
      ],
      fast,
    )
    await entered.promise
    expect(() => s.ra.sessionState()).toThrow(CameraError)
    expect(() => s.rb.sessionState()).toThrow(CameraError)
    expect(a.packets.length).toBe(0)
    expect(b.packets.length).toBe(0)
    expect(job.done).toBe(false)
    hold.release()
    next = await job
    expect(s.ra.sessionState().phase).toBe('open')
    expect(s.rb.sessionState().phase).toBe('open')
    await until(() => next!.recordings.every((r) => r.stats().completed > 0n))
  } finally {
    hold.release()
    await s.close(next)
  }
})

test('cancelled preparation discards candidates and permits an explicit retry using stopped source descriptors', async () => {
  const s = await setup(),
    entered = gate(),
    hold = gate(),
    discarded: boolean[] = []
  let next: RecoveredRecordingSession | undefined
  try {
    const job = s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: new Sink() },
        {
          recording: s.second,
          output: {
            async start() {
              entered.release()
              await hold.promise
            },
            outputframe() {},
            stop(reason) {
              discarded.push(!!reason?.discard)
            },
          },
        },
      ],
      fast,
    )
    await entered.promise
    expect(job.cancel()).toBe(true)
    hold.release()
    await expect(job.wait()).rejects.toThrow('job cancelled')
    expect(discarded).toEqual([true])
    expect(s.ra.sessionState().phase).toBe('flushed')
    expect(s.rb.sessionState().phase).toBe('flushed')
    next = await s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: new Sink() },
        { recording: s.second, output: new Sink() },
      ],
      fast,
    )
    await until(() => next!.recordings.every((r) => r.frames > 0))
  } finally {
    hold.release()
    await s.close(next)
  }
})

test('one microphone cursor and fractional PCM history survive failed preparation and cross-camera recovery', async () => {
  const audio = new AudioCapture({
      simulate: true,
      sampleRate: 44100,
      channels: 2,
      blockFrames: 441,
    }),
    s = await setup(audio),
    a = new Sink(),
    b = new Sink()
  let next: RecoveredRecordingSession | undefined
  try {
    const captured = audio.sharedStats()!.capturedFrames
    const failed = s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: a },
        {
          recording: s.second,
          output: {
            start() {
              throw Error('prepare failed')
            },
            outputframe() {},
          },
        },
      ],
      fast,
    )
    await expect(failed.wait()).rejects.toThrow('prepare failed')
    expect(audio.sharedStats()).toMatchObject({
      closed: false,
      holds: 0,
      capturedFrames: captured,
    })
    expect(Number(audio.handle)).not.toBe(0)
    next = await s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: a },
        { recording: s.second, output: b },
      ],
      fast,
    )
    await s.c.close()
    expect(audio.sharedStats()!.holds).toBe(0)
    await until(() => next!.recordings.every((r) => r.stats().completed >= 3n))
    expect(next.recordings[0].audioStats()!.active).toBe(true)
    expect(next.recordings[1].audioStats()!.active).toBe(true)
    expect(next.recordings[0].audioStats()!.id).not.toBe(
      s.first.audioStats()!.id,
    )
    expect(audio.sharedStats()!.capturedFrames).toBeGreaterThan(captured)
  } finally {
    await s.close(next)
  }
})

test('subsets, duplicates, wrong geometry and shared cadence mismatch reject before terminal flush', async () => {
  const audio = new AudioCapture({ simulate: true, channels: 2 }),
    s = await setup(audio)
  try {
    expect(() =>
      s.c.reconnectRecordingsAsync([{ recording: s.first }], fast),
    ).toThrow(CameraError)
    expect(() =>
      s.c.reconnectRecordingsAsync(
        [{ recording: s.first }, { recording: s.first }],
        fast,
      ),
    ).toThrow(CameraError)
    expect(() =>
      s.c.reconnectRecordingsAsync(
        [
          { recording: s.first, settings: { width: 40 } },
          { recording: s.second },
        ],
        fast,
      ),
    ).toThrow()
    expect(() =>
      s.c.reconnectRecordingsAsync(
        [
          { recording: s.first, settings: { fps: 20 } },
          { recording: s.second, settings: { fps: 25 } },
        ],
        fast,
      ),
    ).toThrow(RangeError)
    expect(s.ra.sessionState().phase).toBe('open')
    expect(s.rb.sessionState().phase).toBe('open')
    expect(audio.sharedStats()!.holds).toBe(0)
  } finally {
    await s.close()
  }
})

test('retirement failure reports the published session without rolling back healthy replacements', async () => {
  const s = await setup(),
    original = s.a.stop.bind(s.a)
  let next: RecoveredRecordingSession | undefined
  s.a.stop = () => {
    original()
    throw Error('old retirement failed')
  }
  try {
    const result = await Promise.resolve(
      s.c.reconnectRecordingsAsync(
        [
          { recording: s.first, output: new Sink() },
          { recording: s.second, output: new Sink() },
        ],
        fast,
      ),
    ).then(
      () => undefined,
      (error) => error,
    )
    expect(result).toMatchObject({
      message: 'old retirement failed',
      published: true,
    })
    next = result.session
    expect(next!.recordings.length).toBe(2)
    expect(next!.camera.activeRecordings).toEqual(next!.recordings)
    await until(() => next!.recordings.every((r) => r.stats().completed > 0n))
    expect(next!.recordings.every((r) => r.error === undefined)).toBe(true)
  } finally {
    await s.close(next)
  }
})

test('source close after publication joins retirement and leaves the replacement camera and microphone independent', async () => {
  const audio = new AudioCapture({ simulate: true, channels: 2 }),
    s = await setup(audio),
    entered = gate(),
    hold = gate()
  let next: RecoveredRecordingSession | undefined
  s.a.stop = async () => {
    entered.release()
    await hold.promise
  }
  try {
    const job = s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: new Sink() },
        { recording: s.second, output: new Sink() },
      ],
      fast,
    )
    await entered.promise
    expect(job.cancel()).toBe(false)
    const closing = s.c.close()
    await Bun.sleep(5)
    expect(job.done).toBe(false)
    hold.release()
    next = await job
    await closing
    expect(audio.sharedStats()!.closed).toBe(false)
    await until(() => next!.recordings.every((r) => r.stats().completed > 0n))
    expect(next.camera.deviceState().connected).toBe(true)
  } finally {
    hold.release()
    await s.close(next)
  }
})

test('eight encoders commit one replacement generation while a live old frame stays independently owned', async () => {
  const c = new Camera({ simulate: true, width: 32, height: 24, buffers: 3 }),
    recorders: Recorder[] = []
  let next: RecoveredRecordingSession | undefined
  c.start()
  const frame = c.acquire(),
    bytes = frame.copyRGB()
  try {
    const recordings: Recording[] = []
    for (let i = 0; i < 8; i++) {
      const r = await Recorder.open(new Sink(), {
        width: 32,
        height: 24,
        asyncWrites: true,
      })
      recorders.push(r)
      recordings.push(c.startRecording(r))
    }
    await until(() => recordings.every((r) => r.stats().completed > 0n))
    c.simulateDisconnect()
    next = await c.reconnectRecordingsAsync(
      recordings.map((recording) => ({ recording, output: new Sink() })),
      fast,
    )
    expect(frame.copyRGB()).toEqual(bytes)
    expect(c.stats().leased).toBe(1)
    expect(next.camera.activeRecordings.length).toBe(8)
    await until(() => next!.recordings.every((r) => r.stats().completed > 0n))
  } finally {
    frame.release()
    await Promise.allSettled([
      next?.camera.close(),
      c.close(),
      ...recorders.map((r) => r.close()),
    ])
  }
})

test('source close before publication cancels and joins held host preparation, retaining flushed caller recorders', async () => {
  const s = await setup(),
    entered = gate(),
    hold = gate()
  try {
    const job = s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: new Sink() },
        {
          recording: s.second,
          output: {
            async start() {
              entered.release()
              await hold.promise
            },
            outputframe() {},
          },
        },
      ],
      fast,
    )
    await entered.promise
    const closing = s.c.close()
    await Bun.sleep(5)
    expect(job.done).toBe(false)
    hold.release()
    await expect(job.wait()).rejects.toMatchObject({ code: -2 })
    await closing
    expect(s.ra.sessionState().phase).toBe('flushed')
    expect(s.rb.sessionState().phase).toBe('flushed')
  } finally {
    hold.release()
    await s.close()
  }
})

test('cancelled group recovery removes exclusively prepared files before rejecting', async () => {
  const s = await setup(),
    dir = mkdtempSync(join(tmpdir(), 'zc-recovery-file-')),
    path = join(dir, 'candidate.mkv'),
    entered = gate(),
    hold = gate()
  try {
    const job = s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: path },
        {
          recording: s.second,
          output: {
            async start() {
              entered.release()
              await hold.promise
            },
            outputframe() {},
          },
        },
      ],
      fast,
    )
    await entered.promise
    await until(() => existsSync(path))
    expect(job.cancel()).toBe(true)
    hold.release()
    await expect(job.wait()).rejects.toThrow('job cancelled')
    expect(existsSync(path)).toBe(false)
    expect(s.ra.sessionState().phase).toBe('flushed')
  } finally {
    hold.release()
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!process.env.ZC_TEST_CODECS || !process.env.ZC_TEST_AAC)(
  'AVC/HEVC/AAC MP4 recovery reuses the microphone sample phase across new camera and encoder epochs',
  async () => {
    const { mp4, decodeAudio, decodeVideoI420 } = await import('./media')
    const dir = mkdtempSync(join(tmpdir(), 'zc-recovery-av-')),
      paths = [
        'old-main.mp4',
        'old-lores.mp4',
        'new-main.mp4',
        'new-lores.mp4',
      ].map((name) => join(dir, name)),
      c = new Camera({
        simulate: true,
        writable: true,
        width: 64,
        height: 48,
        lores: { width: 32, height: 24 },
        fifo: true,
      }),
      audio = new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 2,
        blockFrames: 480,
      }),
      common = {
        fps: 25,
        quality: 100,
        gop: 2,
        asyncWrites: true,
        audio: { sampleRate: 48000, channels: 2 },
        producerQueue: { maxBytes: 512 * 1024, maxOperations: 4 },
      },
      a = new Recorder(paths[0], {
        ...common,
        width: 64,
        height: 48,
        codec: 'h264',
        encoder: { profile: 'baseline', preset: 'slow', qp: 12 },
        limits: { level: 20 },
      }),
      b = new Recorder(paths[1], {
        ...common,
        width: 32,
        height: 24,
        stream: 'lores',
        codec: 'hevc',
        encoder: { profile: 'main' },
        limits: { level: 20, maxBitrate: 128000, bufferBits: 256000 },
      })
    c.preCallback = (frame) => {
      frame.withMappedStream((map) => {
        for (let y = 0; y < map.height; y++) map.row(y).fill(80)
      })
      frame.withMappedStream((map) => {
        for (let plane = 0; plane < 3; plane++)
          for (let y = 0; y < (plane ? map.height / 2 : map.height); y++)
            map.row(y, plane).fill(plane ? 128 : 100)
      }, 'lores')
    }
    const old = [c.startRecording(a, { audio }), c.startRecording(b, { audio })]
    let next: RecoveredRecordingSession | undefined
    try {
      await until(() => old.every((r) => r.stats().completed >= 3n))
      c.simulateDisconnect()
      next = await c.reconnectRecordingsAsync(
        [
          {
            recording: old[0],
            output: paths[2],
            settings: {
              codec: 'hevc',
              fps: 20,
              limits: { level: 20, maxBitrate: 128000, bufferBits: 256000 },
            },
          },
          {
            recording: old[1],
            output: paths[3],
            settings: {
              codec: 'h264',
              fps: 20,
              encoder: { profile: 'main', qp: 12 },
              limits: { level: 20 },
            },
          },
        ],
        fast,
      )
      const origin = Number(old[0].audioStats()!.admittedFrames)
      expect(old[1].audioStats()!.admittedFrames).toBe(BigInt(origin))
      await c.close()
      await until(() =>
        next!.recordings.every((r) => r.stats().completed >= 3n),
      )
      await Promise.all(next.recordings.map((r) => r.flushAsync()))
      const runs = [...old, ...next.recordings],
        dimensions = [
          [64, 48],
          [32, 24],
          [64, 48],
          [32, 24],
        ],
        codecs = ['avc1', 'hvc1', 'hvc1', 'avc1']
      for (let i = 0; i < 4; i++) {
        const tracks = mp4(paths[i]),
          video = tracks.get(1)!,
          sound = tracks.get(2)!,
          [w, h] = dimensions[i],
          samples = Number(runs[i].audioStats()!.admittedFrames)
        expect([video.width, video.height, video.codec]).toEqual([
          w,
          h,
          codecs[i],
        ])
        expect(samples).toBe(runs[i].frames * (i < 2 ? 1920 : 2400))
        expect(sound.presentedUs).toBe(
          BigInt(runs[i].frames) * (i < 2 ? 40000n : 50000n),
        )
        decodeAudio(paths[i], sound, i < 2 ? 0 : origin, samples)
        const pixels = new Uint8Array((w * h * 3) / 2)
        pixels.fill(16 + Math.round(((i % 2 ? 100 : 80) * 219) / 255), 0, w * h)
        pixels.fill(128, w * h)
        decodeVideoI420(
          paths[i],
          video,
          video.samples.map(() => pixels),
        )
      }
      expect(Number(audio.handle)).toBe(0)
    } finally {
      await Promise.allSettled([
        next?.camera.close(),
        c.close(),
        a.close(),
        b.close(),
      ])
      audio.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('recorder close after publication joins retirement and reports the committed camera to its caller', async () => {
  const s = await setup(),
    entered = gate(),
    hold = gate()
  let next: RecoveredRecordingSession | undefined
  s.a.stop = async () => {
    entered.release()
    await hold.promise
  }
  try {
    const job = s.c.reconnectRecordingsAsync(
      [
        { recording: s.first, output: new Sink() },
        { recording: s.second, output: new Sink() },
      ],
      fast,
    )
    await entered.promise
    const closing = s.ra.close()
    expect(job.cancel()).toBe(false)
    hold.release()
    const error = await job.wait().then(
      () => undefined,
      (error) => error,
    )
    expect(error).toMatchObject({ code: -2, published: true })
    next = error.session
    await closing
    expect(next!.camera.deviceState().connected).toBe(true)
    await until(() => next!.recordings[1].stats().completed > 0n)
    expect(next!.recordings[1].error).toBeUndefined()
  } finally {
    hold.release()
    await s.close(next)
  }
})
