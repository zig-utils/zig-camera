import { test, expect } from 'bun:test'
import {
  Control,
  Camera,
  Recorder,
  AudioCapture,
  JobCancelledError,
  type Recording,
  type CustomOutput,
  type OutputPacket,
  type OutputStreams,
} from '../../ts'
import { native as ffi } from '../../ts/ffi'
import {
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const native: {
  zc_video_producer_barrier: (
    ...args: Parameters<typeof ffi.zc_video_producer_barrier>
  ) => number
  zc_producer_jobs_restart_publish: (
    ...args: Parameters<typeof ffi.zc_producer_jobs_restart_publish>
  ) => number
} = ffi
const pause = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('recording group timeout')
    await pause()
  }
}
const failed = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (e) => e,
  )
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
class Sink implements CustomOutput {
  packets: OutputPacket[] = []
  metadata?: OutputStreams
  stops = 0
  discarded = false
  streams(streams: OutputStreams) {
    this.metadata = streams
  }
  outputframe(packet: OutputPacket) {
    this.packets.push(packet)
  }
  stop(reason?: { discard: boolean }) {
    this.stops++
    this.discarded = !!reason?.discard
  }
}
const cam = () =>
  new Camera({
    simulate: true,
    width: 64,
    height: 48,
    lores: { width: 32, height: 24 },
    fifo: true,
  })
const opts = (lores = false) => ({
  width: lores ? 32 : 64,
  height: lores ? 24 : 48,
  stream: lores ? ('lores' as const) : ('main' as const),
  fps: 25,
  asyncWrites: true,
  producerQueue: { maxBytes: 512 * 1024, maxOperations: 2 },
  outputQueue: { maxBytes: 512 * 1024, maxOperations: 32, waitMs: 1000 },
})
const target = {
  width: 96,
  height: 64,
  lores: { width: 48, height: 32 },
  role: 'video' as const,
}
async function setup(
  oldA: CustomOutput = new Sink(),
  oldB: CustomOutput = new Sink(),
  audio?: AudioCapture,
) {
  const c = cam(),
    r = await Recorder.open(oldA, {
      ...opts(),
      audio: audio
        ? { sampleRate: audio.sampleRate, channels: audio.channels }
        : undefined,
    }),
    p = await Recorder.open(oldB, {
      ...opts(true),
      audio: audio
        ? { sampleRate: audio.sampleRate, channels: audio.channels }
        : undefined,
    }),
    a = c.startRecording(r, { audio }),
    b = c.startRecording(p, { audio })
  return {
    c,
    r,
    p,
    a,
    b,
    async close() {
      await Promise.allSettled([c.close(), r.close(), p.close()])
      audio?.close()
    },
  }
}
test('every encoder prepares before shared publication and metadata installs before old output retirement', async () => {
  const s = await setup(),
    hold = gate(),
    entered = gate(),
    nextA = new Sink(),
    nextB = new Sink()
  try {
    await until(
      () => s.a.stats().completed >= 2n && s.b.stats().completed >= 2n,
    )
    const candidate: CustomOutput = {
      async start() {
        entered.release()
        await hold.promise
      },
      streams: (i) => nextB.streams(i),
      outputframe: (p) => nextB.outputframe(p),
      stop: (r) => nextB.stop(r),
    }
    const mode = s.c.switchRecordingsModeAsync(target, [
      {
        recording: s.a,
        settings: { quality: 65 },
        output: nextA,
        backpressure: 'drop',
      },
      { recording: s.b, output: candidate },
    ])
    await entered.promise
    expect(s.r.width).toBe(64)
    expect(s.p.width).toBe(32)
    expect(s.c.options.width).toBe(64)
    expect(() => s.c.info()).toThrow()
    expect(() => s.r.writeAudio(new Uint8Array(4), 0n)).toThrow()
    expect(s.c.activeRecordings).toEqual([])
    hold.release()
    const next = await mode
    expect(Object.isFrozen(next)).toBe(true)
    expect([
      s.r.width,
      s.r.height,
      s.p.width,
      s.p.height,
      s.c.info().width,
    ]).toEqual([96, 64, 48, 32, 96])
    expect(nextA.metadata?.width).toBe(96)
    expect(nextB.metadata?.width).toBe(48)
    expect(next[0].backpressure).toBe('drop')
    expect(s.c.activeRecordings).toEqual(next)
    await Promise.all([s.a.close(), s.b.close()])
    await until(() => next.every((r) => r.stats().completed >= 3n))
    expect(next.every((r) => r.error === undefined)).toBe(true)
    expect(s.c.stats().leased).toBe(0)
  } finally {
    hold.release()
    await s.close()
  }
})
test('group switching preserves one microphone and fractional sample clock across a cadence change', async () => {
  const audio = new AudioCapture({
      simulate: true,
      sampleRate: 44100,
      channels: 2,
      blockFrames: 441,
    }),
    s = await setup(new Sink(), new Sink(), audio),
    hold = gate(),
    entered = gate(),
    a = new Sink(),
    b = new Sink()
  try {
    await until(
      () => s.a.stats().completed >= 3n && s.b.stats().completed >= 3n,
    )
    const mode = s.c.switchRecordingsModeAsync(target, [
      { recording: s.a, settings: { fps: 20 }, output: a },
      {
        recording: s.b,
        settings: { fps: 20 },
        output: {
          async start() {
            entered.release()
            await hold.promise
          },
          outputframe: (p) => b.outputframe(p),
        },
      },
    ])
    await entered.promise
    const origin = s.a.audioStats()!.nextTimestampNs!
    expect(origin).toBe(s.b.audioStats()!.nextTimestampNs!)
    expect(audio.sharedStats()!.holds).toBe(1)
    expect(Number(audio.handle)).not.toBe(0)
    expect(() => audio.close()).toThrow()
    expect(() => audio.read()).toThrow()
    hold.release()
    const next = await mode
    expect(audio.sharedStats()!.holds).toBe(0)
    await until(() => next.every((r) => r.stats().completed >= 3n))
    const flushes = next.map((r) => r.flushAsync())
    await Promise.all(flushes)
    function reference(frames: number, start: number) {
      const out = Buffer.alloc(frames * 4)
      for (let i = 0; i < frames; i++) {
        const v = (((start + i) % 200) - 100) * 100
        out.writeInt16LE(v, i * 4)
        out.writeInt16LE(-v, i * 4 + 2)
      }
      return out
    }
    for (const [recording, sink] of [
      [next[0], a],
      [next[1], b],
    ] as const) {
      const frames = Number(recording.audioStats()!.admittedFrames)
      expect(frames).toBe(recording.frames * 2205)
      expect(recording.audioStats()!.nextTimestampNs).toBe(
        origin + BigInt(recording.frames) * 50_000_000n,
      )
      const pcm = Buffer.concat(
        sink.packets.filter((p) => p.audio).map((p) => Buffer.from(p.data)),
      )
      expect(pcm).toEqual(
        reference(frames, Number((origin * 44100n) / 1_000_000_000n)),
      )
    }
    expect(Number(audio.handle)).toBe(0)
    expect(audio.sharedStats()!.closed).toBe(true)
  } finally {
    hold.release()
    await s.close()
  }
})
test('queued cancellation and lease rejection preserve every active old session and release holds', async () => {
  const audio = new AudioCapture({
      simulate: true,
      channels: 2,
      blockFrames: 480,
    }),
    s = await setup(new Sink(), new Sink(), audio)
  const members = [
    { recording: s.a, output: new Sink() },
    { recording: s.b, output: new Sink() },
  ]
  try {
    const cancelled = s.c.switchRecordingsModeAsync(target, members),
      result = failed(cancelled)
    expect(cancelled.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(audio.sharedStats()!.holds).toBe(0)
    expect(s.c.activeRecordings).toEqual([s.a, s.b])
    using lease = s.c.acquire()
    expect(
      await failed(s.c.switchRecordingsModeAsync(target, members)),
    ).toMatchObject({ code: -4 })
    expect(lease.copyRGB().length).toBe(64 * 48 * 3)
    lease.release()
    const before = s.a.frames
    await until(() => s.a.frames >= before + 2 && s.b.stats().completed >= 2n)
    expect(s.r.options.width).toBe(64)
    expect(s.p.options.width).toBe(32)
  } finally {
    await s.close()
  }
})
test('flush admission is reserved for all members before any old recording stops', async () => {
  const s = await setup(),
    original = native.zc_video_producer_barrier
  try {
    native.zc_video_producer_barrier = (...args) =>
      args[0] === s.p.handle ? -4 : original(...args)
    expect(
      await failed(
        s.c.switchRecordingsModeAsync(target, [
          { recording: s.a },
          { recording: s.b },
        ]),
      ),
    ).toMatchObject({ code: -4 })
    native.zc_video_producer_barrier = original
    expect(s.c.activeRecordings).toEqual([s.a, s.b])
    expect(s.r.sessionState().phase).toBe('open')
    expect(s.p.sessionState().phase).toBe('open')
    const before = s.a.frames
    await until(() => s.a.frames > before && s.b.stats().completed >= 2n)
    expect(s.c.info().width).toBe(64)
  } finally {
    native.zc_video_producer_barrier = original
    await s.close()
  }
})
test('one failed replacement discards prepared peer files and restores every old setting', async () => {
  const s = await setup(),
    dir = mkdtempSync(join(tmpdir(), 'zc-group-prepare-')),
    path = join(dir, 'candidate.mkv'),
    bad = Error('second candidate failed'),
    entered = gate(),
    hold = gate()
  try {
    const result = failed(
      s.c.switchRecordingsModeAsync(target, [
        { recording: s.a, output: path },
        {
          recording: s.b,
          output: {
            outputframe() {},
            async start() {
              entered.release()
              await hold.promise
              throw bad
            },
          },
        },
      ]),
    )
    await entered.promise
    await until(() => existsSync(path))
    hold.release()
    expect(await result).toBe(bad)
    expect(existsSync(path)).toBe(false)
    expect(s.c.info().width).toBe(64)
    expect(s.c.activeRecordings).toEqual([])
    expect([s.r.width, s.p.width]).toEqual([64, 32])
    expect(s.r.sessionState().phase).toBe('flushed')
    expect(s.p.sessionState().phase).toBe('flushed')
    await Promise.all([
      s.r.restartAsync(new Sink()),
      s.p.restartAsync(new Sink()),
    ])
    const a = s.c.startRecording(s.r),
      b = s.c.startRecording(s.p)
    await until(() => a.stats().completed >= 2n && b.stats().completed >= 2n)
    expect(s.c.stats().leased).toBe(0)
  } finally {
    hold.release()
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('cancellation joins a held output hook before releasing the camera and both recorder reservations', async () => {
  const s = await setup(),
    hold = gate(),
    entered = gate(),
    peer = new Sink()
  try {
    const mode = s.c.switchRecordingsModeAsync(target, [
      { recording: s.a, output: peer },
      {
        recording: s.b,
        output: {
          outputframe() {},
          async start() {
            entered.release()
            await hold.promise
          },
        },
      },
    ])
    const result = failed(mode)
    await entered.promise
    expect(mode.cancel()).toBe(true)
    await pause(10)
    expect(mode.done).toBe(false)
    expect(() => s.c.acquire()).toThrow()
    expect(() => s.r.restartAsync()).toThrow()
    hold.release()
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(s.c.info().width).toBe(64)
    expect([s.r.width, s.p.width]).toEqual([64, 32])
    expect(s.r.producerStats().ownedJobs).toBe(0n)
    expect(s.p.producerStats().ownedJobs).toBe(0n)
    expect(peer.discarded).toBe(true)
  } finally {
    hold.release()
    await s.close()
  }
})
test('native publication rejection releases all staged microphone owners without consuming caller PCM', async () => {
  const s = await setup(),
    audio = new AudioCapture({ simulate: true, channels: 2, blockFrames: 480 }),
    publish = native.zc_producer_jobs_restart_publish
  try {
    native.zc_producer_jobs_restart_publish = () => -4
    const settings = { audio: { sampleRate: 48000, channels: 2 } }
    expect(
      await failed(
        s.c.switchRecordingsModeAsync(target, [
          { recording: s.a, settings, output: new Sink(), audio },
          { recording: s.b, settings, output: new Sink(), audio },
        ]),
      ),
    ).toMatchObject({ code: -4 })
    native.zc_producer_jobs_restart_publish = publish
    expect(s.c.info().width).toBe(64)
    expect(s.c.activeRecordings).toEqual([])
    expect([s.r.width, s.p.width]).toEqual([64, 32])
    expect(audio.sharedStats()!.closed).toBe(true)
    const block = audio.read()
    expect(
      new DataView(block.data.buffer, block.data.byteOffset).getInt16(0, true),
    ).toBe(-10000)
    expect(s.r.producerStats().ownedJobs).toBe(0n)
    expect(s.p.producerStats().ownedJobs).toBe(0n)
  } finally {
    native.zc_producer_jobs_restart_publish = publish
    await s.close()
    audio.close()
  }
})
test('post-publication retirement failure exposes the whole new group and never rolls back one peer', async () => {
  const hold = gate(),
    entered = gate(),
    bad = Error('old output stop failed'),
    oldA = new Sink(),
    oldB = new Sink()
  const s = await setup(
    {
      outputframe: (p) => oldA.outputframe(p),
      async stop() {
        entered.release()
        await hold.promise
        throw bad
      },
    },
    oldB,
  )
  try {
    const mode = s.c.switchRecordingsModeAsync(target, [
        { recording: s.a, output: new Sink() },
        { recording: s.b, output: new Sink() },
      ]),
      result = failed(mode)
    await entered.promise
    expect(mode.cancel()).toBe(false)
    expect([s.r.width, s.p.width, s.c.options.width]).toEqual([96, 48, 96])
    hold.release()
    const error = await result
    expect(error).toMatchObject({
      message: 'old output stop failed',
      published: true,
    })
    const recordings = error.recordings as readonly Recording[]
    expect(recordings.length).toBe(2)
    expect(s.c.activeRecordings).toEqual(recordings)
    await until(() => recordings.every((r) => r.stats().completed >= 3n))
    expect(recordings.every((r) => r.error === undefined)).toBe(true)
  } finally {
    hold.release()
    await s.close()
  }
})
for (const owner of ['camera', 'recorder'] as const)
  test(`${owner} close joins a published group and leaves no partial capture owners`, async () => {
    const hold = gate(),
      entered = gate(),
      audio = new AudioCapture({
        simulate: true,
        channels: 2,
        blockFrames: 480,
      })
    const s = await setup(
      {
        outputframe() {},
        async stop() {
          entered.release()
          await hold.promise
        },
      },
      new Sink(),
      audio,
    )
    try {
      const mode = s.c.switchRecordingsModeAsync(target, [
          { recording: s.a, output: new Sink() },
          { recording: s.b, output: new Sink() },
        ]),
        result = failed(mode)
      await entered.promise
      const closing = owner === 'camera' ? s.c.close() : s.r.close()
      expect(mode.cancel()).toBe(false)
      await pause(10)
      expect(mode.done).toBe(false)
      hold.release()
      expect(await result).toMatchObject({ code: -2, published: true })
      await closing
      expect(s.c.activeRecordings).toEqual([])
      expect(Number(audio.handle)).toBe(0)
      if (owner === 'recorder') {
        expect([s.c.info().width, s.p.width]).toEqual([96, 48])
        const remaining = s.c.startRecording(s.p)
        await until(() => remaining.stats().completed >= 2n)
      }
    } finally {
      hold.release()
      await s.close()
    }
  })
test('eight encoders share one bounded publication and receive new stable capture identities', async () => {
  const c = cam(),
    recorders: Recorder[] = [],
    old: Recording[] = []
  try {
    for (let i = 0; i < 8; i++) {
      const r = await Recorder.open(new Sink(), opts())
      recorders.push(r)
      old.push(c.startRecording(r))
    }
    await until(() => old.every((r) => r.stats().completed >= 1n))
    const next = await c.switchRecordingsModeAsync(
      { width: 80, height: 60 },
      old.map((recording) => ({ recording, output: new Sink() })),
    )
    expect(next.length).toBe(8)
    for (const r of next)
      expect(r.stats().id).toBeGreaterThan(old[7].stats().id)
    await until(() => next.every((r) => r.stats().completed >= 2n))
    expect(recorders.every((r) => r.width === 80 && r.height === 60)).toBe(true)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    await Promise.allSettled(recorders.map((r) => r.close()))
  }
})
test('subsets, duplicates, explicit geometry errors and incompatible shared cadence reject before flush', async () => {
  const audio = new AudioCapture({
      simulate: true,
      channels: 2,
      blockFrames: 480,
    }),
    s = await setup(new Sink(), new Sink(), audio)
  try {
    expect(() =>
      s.c.switchRecordingsModeAsync(target, [{ recording: s.a }]),
    ).toThrow()
    expect(() =>
      s.c.switchRecordingsModeAsync(target, [
        { recording: s.a },
        { recording: s.a },
      ]),
    ).toThrow()
    expect(() =>
      s.c.switchRecordingsModeAsync(target, [
        { recording: s.a, settings: { width: 64 } },
        { recording: s.b },
      ]),
    ).toThrow()
    expect(() =>
      s.c.switchRecordingsModeAsync(target, [
        { recording: s.a, settings: { fps: 20 } },
        { recording: s.b },
      ]),
    ).toThrow()
    expect(() =>
      s.c.switchRecordingsModeAsync({ ...target, lores: undefined }, [
        { recording: s.a },
        { recording: s.b },
      ]),
    ).toThrow()
    expect(s.c.activeRecordings).toEqual([s.a, s.b])
    expect(audio.sharedStats()!.holds).toBe(0)
    await until(
      () => s.a.stats().completed >= 2n && s.b.stats().completed >= 2n,
    )
  } finally {
    await s.close()
  }
})
test('failed exclusive group path preparation preserves pre-existing destination bytes', async () => {
  const s = await setup(),
    dir = mkdtempSync(join(tmpdir(), 'zc-group-path-')),
    path = join(dir, 'existing.mkv')
  writeFileSync(path, 'preserve this file')
  try {
    expect(
      await failed(
        s.c.switchRecordingsModeAsync(target, [
          { recording: s.a, output: new Sink() },
          { recording: s.b, output: path },
        ]),
      ),
    ).toBeDefined()
    expect(readFileSync(path, 'utf8')).toBe('preserve this file')
    expect([s.r.width, s.p.width, s.c.info().width]).toEqual([64, 32, 64])
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('group mode reuses control restoration, AF coordination and completion callback ownership release', async () => {
  const s = await setup()
  try {
    const revision = s.c.setControls([
      { id: Control.aeEnable, type: 'bool', values: [0] },
      { id: Control.exposureTime, type: 'int', values: [3500] },
      { id: Control.analogueGain, type: 'float', values: [2] },
    ])
    const focus = s.c.autofocusAsync()
    let observed: number[] = []
    const job = s.c.switchRecordingsModeAsync(
      target,
      [
        { recording: s.a, output: new Sink() },
        { recording: s.b, output: new Sink() },
      ],
      {
        autofocusPolicy: 'wait',
        autofocus: true,
        dropFrames: 2,
        signalFunction() {
          observed = [s.c.info().width, s.r.width, s.p.width]
        },
      },
    )
    expect(await focus).toBe(3)
    const next = await job
    await job.cleanupDone
    expect(observed).toEqual([96, 96, 48])
    expect(s.c.controlSnapshot().revision).toBeGreaterThan(revision)
    expect(await s.c.captureMetadata()).toMatchObject({
      exposureUs: 3500,
      analogueGain: 2,
      afState: 2,
    })
    expect(next.length).toBe(2)
    expect(s.c.stats().leased).toBe(0)
  } finally {
    await s.close()
  }
})
test('replacing one microphone keeps its peer source alive and transfers each source exactly once', async () => {
  const old = new AudioCapture({
      simulate: true,
      channels: 2,
      blockFrames: 480,
    }),
    replacement = new AudioCapture({
      simulate: true,
      channels: 2,
      blockFrames: 480,
    }),
    s = await setup(new Sink(), new Sink(), old)
  try {
    await until(
      () => s.a.stats().completed >= 2n && s.b.stats().completed >= 2n,
    )
    const next = await s.c.switchRecordingsModeAsync(target, [
      { recording: s.a, output: new Sink(), audio: replacement },
      { recording: s.b, output: new Sink() },
    ])
    expect(Number(old.handle)).not.toBe(0)
    expect(Number(replacement.handle)).not.toBe(0)
    expect(old.sharedStats()!.holds).toBe(0)
    expect(replacement.sharedStats()!.holds).toBe(0)
    await next[0].close()
    expect(Number(replacement.handle)).toBe(0)
    expect(Number(old.handle)).not.toBe(0)
    await until(() => next[1].stats().completed >= 2n)
    await next[1].close()
    expect(Number(old.handle)).toBe(0)
  } finally {
    await s.close()
    replacement.close()
  }
})
test.skipIf(!process.env.ZC_TEST_CODECS || !process.env.ZC_TEST_AAC)(
  'AVC/HEVC/AAC group switching independently decodes old and new MP4 sessions at changed geometry and cadence',
  async () => {
    const { mp4, decodeAudio, decodeVideoI420 } = await import('./media')
    const dir = mkdtempSync(join(tmpdir(), 'zc-group-media-')),
      paths = [
        'old-main.mp4',
        'old-lores.mp4',
        'new-main.mp4',
        'new-lores.mp4',
      ].map((name) => join(dir, name))
    const c = new Camera({
        simulate: true,
        width: 64,
        height: 48,
        lores: { width: 32, height: 24 },
        fifo: true,
        writable: true,
      }),
      audio = new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 2,
        blockFrames: 480,
      }),
      format = { sampleRate: 48000, channels: 2 }
    const r = new Recorder(paths[0], {
        ...opts(),
        codec: 'h264',
        quality: 100,
        gop: 2,
        audio: format,
      }),
      p = new Recorder(paths[1], {
        ...opts(true),
        codec: 'hevc',
        quality: 100,
        gop: 2,
        audio: format,
      })
    c.preCallback = (f) => {
      f.withMappedStream((map) => {
        for (let y = 0; y < map.height; y++) map.row(y).fill(80)
      })
      f.withMappedStream((map) => {
        for (let plane = 0; plane < 3; plane++)
          for (let y = 0; y < (plane ? map.height / 2 : map.height); y++)
            map.row(y, plane).fill(plane ? 128 : 100)
      }, 'lores')
    }
    const old = [c.startRecording(r, { audio }), c.startRecording(p, { audio })]
    try {
      await until(() => old.every((r) => r.stats().completed >= 3n))
      const next = await c.switchRecordingsModeAsync(target, [
        {
          recording: old[0],
          settings: { codec: 'hevc', fps: 20, gop: 2 },
          output: paths[2],
        },
        {
          recording: old[1],
          settings: { codec: 'h264', fps: 20, gop: 2 },
          output: paths[3],
        },
      ])
      const origin = Number(old[0].audioStats()!.admittedFrames)
      expect(old[1].audioStats()!.admittedFrames).toBe(BigInt(origin))
      await until(() => next.every((r) => r.stats().completed >= 3n))
      await Promise.all(next.map((r) => r.flushAsync()))
      const dimensions = [
          [64, 48],
          [32, 24],
          [96, 64],
          [48, 32],
        ],
        codecs = ['avc1', 'hvc1', 'hvc1', 'avc1'],
        runs = [...old, ...next]
      for (let i = 0; i < 4; i++) {
        const tracks = mp4(paths[i]),
          video = tracks.get(1)!,
          sound = tracks.get(2)!,
          [w, h] = dimensions[i]
        expect([video.width, video.height, video.codec]).toEqual([
          w,
          h,
          codecs[i],
        ])
        const frames = Number(runs[i].audioStats()!.admittedFrames)
        decodeAudio(paths[i], sound, i < 2 ? 0 : origin, frames)
        expect(frames).toBe(runs[i].frames * (i < 2 ? 1920 : 2400))
        expect(sound.presentedUs).toBe(
          BigInt(runs[i].frames) * (i < 2 ? 40_000n : 50_000n),
        )
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
      expect(c.stats().leased).toBe(0)
    } finally {
      await Promise.allSettled([c.close(), r.close(), p.close()])
      audio.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('nonaligned 44.1 kHz capture blocks preserve sample phase through a 30 to 20 FPS switch', async () => {
  const c = cam(),
    audio = new AudioCapture({
      simulate: true,
      sampleRate: 44100,
      channels: 2,
      blockFrames: 1024,
    }),
    format = { sampleRate: 44100, channels: 2 },
    r = await Recorder.open(new Sink(), { ...opts(), fps: 30, audio: format }),
    p = await Recorder.open(new Sink(), {
      ...opts(true),
      fps: 30,
      audio: format,
    }),
    old = [c.startRecording(r, { audio }), c.startRecording(p, { audio })],
    sa = new Sink(),
    sb = new Sink()
  try {
    await until(
      () =>
        old[0].frames > 0 &&
        old[0].frames % 3 !== 0 &&
        old[1].frames === old[0].frames,
    )
    const next = await c.switchRecordingsModeAsync(target, [
      { recording: old[0], settings: { fps: 20 }, output: sa },
      { recording: old[1], settings: { fps: 20 }, output: sb },
    ])
    const start = Number(old[0].audioStats()!.admittedFrames),
      origin = old[0].audioStats()!.nextTimestampNs!
    expect(start % 4410).not.toBe(0)
    await until(() => next.every((r) => r.stats().completed >= 4n))
    await Promise.all(next.map((r) => r.flushAsync()))
    for (const [recording, sink] of [
      [next[0], sa],
      [next[1], sb],
    ] as const) {
      const count = Number(recording.audioStats()!.admittedFrames),
        expected = Buffer.alloc(count * 4)
      for (let i = 0; i < count; i++) {
        const v = (((start + i) % 200) - 100) * 100
        expected.writeInt16LE(v, i * 4)
        expected.writeInt16LE(-v, i * 4 + 2)
      }
      expect(count).toBe(recording.frames * 2205)
      expect(recording.audioStats()!.nextTimestampNs).toBe(
        origin + BigInt(recording.frames) * 50_000_000n,
      )
      expect(
        Buffer.concat(
          sink.packets.filter((p) => p.audio).map((p) => Buffer.from(p.data)),
        ),
      ).toEqual(expected)
    }
  } finally {
    await Promise.allSettled([c.close(), r.close(), p.close()])
    audio.close()
  }
})

test('a group can exchange main and lores encoder sources in one negotiated mode', async () => {
  const s = await setup(),
    a = new Sink(),
    b = new Sink()
  try {
    const next = await s.c.switchRecordingsModeAsync(target, [
      { recording: s.a, settings: { stream: 'lores' }, output: a },
      { recording: s.b, settings: { stream: 'main' }, output: b },
    ])
    expect([
      s.r.options.stream,
      s.r.width,
      s.p.options.stream,
      s.p.width,
    ]).toEqual(['lores', 48, 'main', 96])
    await until(() => next.every((r) => r.stats().completed >= 2n))
    await Promise.all(next.map((r) => r.flushAsync()))
    expect(a.metadata?.width).toBe(48)
    expect(b.metadata?.width).toBe(96)
    expect(a.packets.length).toBeGreaterThanOrEqual(2)
    expect(b.packets.length).toBeGreaterThanOrEqual(2)
    expect(next.every((r) => r.error === undefined)).toBe(true)
  } finally {
    await s.close()
  }
})
test('invalid output byte paths reject before any group capture owner is reserved', async () => {
  const s = await setup()
  try {
    for (const path of ['', '\0', 'x'.repeat(4097), '😀'.repeat(1025)])
      expect(() =>
        s.c.switchRecordingsModeAsync(target, [
          { recording: s.a, output: path },
          { recording: s.b, output: new Sink() },
        ]),
      ).toThrow()
    expect(s.c.activeRecordings).toEqual([s.a, s.b])
    expect(s.a.closing).toBe(false)
    expect(s.b.closing).toBe(false)
    await until(
      () => s.a.stats().completed >= 1n && s.b.stats().completed >= 1n,
    )
  } finally {
    await s.close()
  }
})
