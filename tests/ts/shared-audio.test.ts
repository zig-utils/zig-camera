import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  AudioCapture,
  MuxedOutput,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
import { native as symbols } from '../../ts/ffi'
const n: {
  zc_start: (...args: Parameters<typeof symbols.zc_start>) => number
} = symbols
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mp4, decodeAudio, decodeVideoI420 } from './media'
const pause = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('shared audio timeout')
    await pause()
  }
}
const failed = (p: PromiseLike<unknown>) =>
  Promise.resolve(p).then(
    () => undefined,
    (e) => e,
  )
class Sink implements CustomOutput {
  packets: OutputPacket[] = []
  release!: () => void
  gate: Promise<void>
  constructor(blocked = false) {
    this.gate = new Promise<void>((r) => {
      this.release = r
    })
    if (!blocked) this.release()
  }
  async outputframe(packet: OutputPacket) {
    await this.gate
    this.packets.push(packet)
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
const opts = (lores = false, rate = 48000, asyncWrites = true) => ({
  width: lores ? 32 : 64,
  height: lores ? 24 : 48,
  stream: lores ? ('lores' as const) : ('main' as const),
  fps: 25,
  asyncWrites,
  audio: { sampleRate: rate, channels: 2 },
  producerQueue: { maxBytes: 512 * 1024, maxOperations: 2 },
  outputQueue: {
    maxBytes: 1024 * 1024,
    maxOperations: asyncWrites ? 1 : 128,
    waitMs: 2000,
  },
})
function samples(frames: number, channels = 2, start = 0) {
  const result = Buffer.alloc(frames * channels * 2)
  for (let i = 0; i < frames; i++)
    for (let ch = 0; ch < channels; ch++)
      result.writeInt16LE(
        (((start + i) % 200) - 100) * 100 * (ch ? -1 : 1),
        (i * channels + ch) * 2,
      )
  return result
}
function pcm(s: Sink) {
  return Buffer.concat(
    s.packets.filter((p) => p.audio).map((p) => Buffer.from(p.data)),
  )
}
for (const rate of [44100, 48000])
  for (const asyncWrites of [false, true])
    test(`one ${rate} Hz cursor feeds exact stereo samples to two ${asyncWrites ? 'async' : 'sync'} encoders`, async () => {
      const c = cam(),
        audio = new AudioCapture({
          simulate: true,
          sampleRate: rate,
          channels: 2,
          blockFrames: rate === 44100 ? 147 : 480,
        }),
        sa = new Sink(),
        sb = new Sink(),
        r = await Recorder.open(sa, opts(false, rate, asyncWrites)),
        p = await Recorder.open(sb, opts(true, rate, asyncWrites))
      const a = c.startRecording(r, { audio }),
        b = c.startRecording(p, { audio })
      try {
        await until(
          () => a.stats().completed >= 6n && b.stats().completed >= 6n,
        )
        const fa = a.flushAsync(),
          fb = b.flushAsync()
        await Promise.all([fa, fb])
        for (const [run, sink] of [
          [a, sa],
          [b, sb],
        ] as const) {
          const frames = Number(run.audioStats()!.admittedFrames)
          expect(frames).toBe((run.frames * rate) / 25)
          expect(pcm(sink)).toEqual(samples(frames))
          expect(run.audioStats()!.pending).toBe(false)
        }
        const shared = audio.sharedStats()!
        expect(shared.capturedFrames).toBe(BigInt((a.frames * rate) / 25))
        expect(shared.frames).toBeLessThanOrEqual(shared.maxFrames)
        expect(shared.blocks).toBeLessThanOrEqual(shared.maxBlocks)
        expect(shared.reads).toBeLessThan(
          BigInt(((a.frames + b.frames) * rate) / 25 / audio.blockFrames),
        )
        expect(c.stats().leased).toBe(0)
        expect(Number(audio.handle)).toBe(0)
        const cached = a.audioStats()
        await c.close()
        expect(a.audioStats()).toEqual(cached)
      } finally {
        await Promise.allSettled([a.close(), b.close(), r.close(), p.close()])
        await c.close()
        audio.close()
      }
    })
test('drop video catches up continuous PCM without another capture cursor or unbounded jobs', async () => {
  const c = cam(),
    audio = new AudioCapture({
      simulate: true,
      sampleRate: 48000,
      channels: 2,
      blockFrames: 480,
    }),
    slow = new Sink(true),
    good = new Sink(),
    r = await Recorder.open(slow, opts()),
    p = await Recorder.open(good, opts(true)),
    a = c.startRecording(r, { audio, backpressure: 'drop' }),
    b = c.startRecording(p, { audio })
  try {
    await until(() => r.hostIOStats().blockedWaits === 1n)
    await until(() => a.stats().skipped >= 8n && b.stats().completed >= 8n)
    expect(r.producerStats().ownedJobs).toBe(1n)
    expect(c.stats().leased).toBe(0)
    slow.release()
    await until(() => a.stats().completed >= 3n)
    const fa = a.flushAsync(),
      fb = b.flushAsync()
    await Promise.all([fa, fb])
    const video = slow.packets.filter((p) => !p.audio)
    expect(
      video.some(
        (p, i) =>
          i > 0 &&
          p.sourceTimestampNs - video[i - 1].sourceTimestampNs > 40_000_000n,
      ),
    ).toBe(true)
    const frames = Number(a.audioStats()!.admittedFrames)
    expect(frames).toBeGreaterThan(a.frames * 1920)
    expect(pcm(slow)).toEqual(samples(frames))
    expect(pcm(good).subarray(0, frames * 4)).toEqual(pcm(slow))
    expect(a.audioStats()!.overruns).toBe(0n)
    expect(r.producerStats().highJobs).toBeLessThanOrEqual(2n)
  } finally {
    slow.release()
    await Promise.allSettled([a.close(), b.close(), r.close(), p.close()])
    await c.close()
    audio.close()
  }
})
test('history overrun quarantines only the slow encoder while its entered producer stays bounded', async () => {
  const c = cam(),
    audio = new AudioCapture({
      simulate: true,
      sampleRate: 48000,
      channels: 2,
      blockFrames: 480,
      sharedHistory: { maxFrames: 3840, maxBlocks: 16 },
    }),
    slow = new Sink(true),
    r = await Recorder.open(slow, opts()),
    p = await Recorder.open(new Sink(), opts(true)),
    a = c.startRecording(r, { audio, backpressure: 'drop' }),
    b = c.startRecording(p, { audio })
  try {
    await until(() => a.error !== undefined)
    expect(a.audioStats()!.overruns).toBe(1n)
    expect(a.audioStats()!.active).toBe(false)
    expect(a.stats().failed).toBe(true)
    expect(r.producerStats().ownedJobs).toBe(1n)
    const before = b.frames
    await until(() => b.frames >= before + 4)
    expect(b.error).toBeUndefined()
    expect(b.audioStats()!.overruns).toBe(0n)
    expect(audio.sharedStats()!.highFrames).toBeLessThanOrEqual(3840n)
    const closing = failed(a.close())
    slow.release()
    expect(await closing).toBeDefined()
    await b.flushAsync()
    expect(Number(audio.handle)).toBe(0)
  } finally {
    slow.release()
    await Promise.allSettled([a.close(), b.close(), r.close(), p.close()])
    await failed(c.close())
    audio.close()
  }
})
test('late joining audio consumers begin at the shared media clock and retiring one leaves the source live', async () => {
  const c = cam(),
    audio = new AudioCapture({
      simulate: true,
      sampleRate: 48000,
      channels: 2,
      blockFrames: 480,
    }),
    sa = new Sink(),
    sb = new Sink(),
    r = await Recorder.open(sa, opts()),
    p = await Recorder.open(sb, opts(true)),
    a = c.startRecording(r, { audio })
  let b: ReturnType<Camera['startRecording']> | undefined
  try {
    await until(() => a.stats().completed >= 4n)
    b = c.startRecording(p, { audio })
    await until(() => b!.stats().completed >= 3n)
    await a.flushAsync()
    expect(Number(audio.handle)).not.toBe(0)
    const before = b.frames
    await until(() => b!.frames >= before + 2)
    await b.flushAsync()
    const frames = Number(b.audioStats()!.admittedFrames)
    const origin =
      b.audioStats()!.nextTimestampNs! - BigInt(b.frames) * 40_000_000n
    expect(origin).toBeGreaterThanOrEqual(160_000_000n)
    const start = Number((origin * 48000n) / 1_000_000_000n)
    expect(pcm(sb)).toEqual(samples(frames, 2, start))
    expect(Number(audio.handle)).toBe(0)
  } finally {
    await Promise.allSettled([a.close(), b?.close(), r.close(), p.close()])
    await c.close()
    audio.close()
  }
})
test('cross-camera cursor and mismatched cadence reject without stealing source or recorder ownership', async () => {
  const c = cam(),
    other = cam(),
    audio = new AudioCapture({ simulate: true, channels: 2, blockFrames: 480 }),
    r = await Recorder.open(new Sink(), opts()),
    p = await Recorder.open(new Sink(), opts(true)),
    different = await Recorder.open(new Sink(), { ...opts(), fps: 24 }),
    a = c.startRecording(r, { audio })
  try {
    expect(() => other.startRecording(p, { audio })).toThrow(
      'shared microphone cursor',
    )
    expect(() => c.startRecording(different, { audio })).toThrow(
      'same recording FPS',
    )
    expect(() => audio.read()).toThrow()
    expect(() => audio.close()).toThrow()
    expect(p.sessionState().phase).toBe('open')
    const b = c.startRecording(p, { audio })
    await until(() => a.stats().completed >= 3n && b.stats().completed >= 3n)
    await c.stop()
    expect(Number(audio.handle)).toBe(0)
  } finally {
    await Promise.allSettled([
      c.close(),
      other.close(),
      r.close(),
      p.close(),
      different.close(),
    ])
    audio.close()
  }
})
test('failed camera start releases the native cursor while preserving the caller-owned audio source', async () => {
  const c = cam(),
    audio = new AudioCapture({ simulate: true, channels: 2, blockFrames: 480 }),
    r = await Recorder.open(new Sink(), opts()),
    start = n.zc_start
  try {
    n.zc_start = () => -9
    expect(() => c.startRecording(r, { audio })).toThrow()
    expect(c.activeRecordings).toEqual([])
    expect(audio.read().data.length).toBe(480 * 4)
  } finally {
    n.zc_start = start
    audio.close()
    await r.close()
    await c.close()
  }
})
test('bounded source read exhaustion fails its audio group while unrelated video keeps recording', async () => {
  const c = cam(),
    audio = new AudioCapture({ simulate: true, channels: 2, blockFrames: 1 }),
    r = await Recorder.open(new Sink(), opts()),
    p = await Recorder.open(new Sink(), opts(true)),
    v = await Recorder.open(new Sink(), {
      width: 64,
      height: 48,
      asyncWrites: true,
    }),
    a = c.startRecording(r, { audio }),
    b = c.startRecording(p, { audio }),
    plain = c.startRecording(v)
  try {
    await until(
      () =>
        a.error !== undefined &&
        b.error !== undefined &&
        plain.stats().completed >= 3n,
    )
    expect(audio.sharedStats()!.reads).toBe(256n)
    expect(audio.sharedStats()!.errorCode).toBe(-4)
    expect(a.frames).toBe(0)
    expect(b.frames).toBe(0)
    expect(plain.error).toBeUndefined()
    expect(await failed(c.stop())).toBeDefined()
    expect(Number(audio.handle)).toBe(0)
  } finally {
    await Promise.allSettled([
      a.close(),
      b.close(),
      plain.close(),
      r.close(),
      p.close(),
      v.close(),
    ])
    await failed(c.close())
    audio.close()
  }
})
class Bytes {
  data = Buffer.alloc(0)
  blocked = false
  release!: () => void
  gate = new Promise<void>((r) => {
    this.release = r
  })
  async write(bytes: Uint8Array) {
    if (this.blocked) await this.gate
    this.data = Buffer.concat([this.data, bytes])
  }
  patch(offset: bigint, bytes: Uint8Array) {
    Buffer.from(bytes).copy(this.data, Number(offset))
  }
}
test.skipIf(!process.env.ZC_TEST_CODECS || !process.env.ZC_TEST_AAC)(
  'shared AAC keeps exact MP4 sample edits and waveform across dropped HEVC video',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-shared-aac-')),
      c = new Camera({
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
      fast = new Bytes(),
      slow = new Bytes(),
      paths = [join(dir, 'fast.mp4'), join(dir, 'slow.mp4')]
    const r = await Recorder.open(new MuxedOutput(fast), {
        ...opts(),
        codec: 'h264',
        quality: 100,
        gop: 2,
      }),
      p = await Recorder.open(new MuxedOutput(slow), {
        ...opts(true),
        codec: 'hevc',
        quality: 100,
        gop: 2,
      })
    c.preCallback = (f) => {
      f.withMappedStream((map) => {
        for (let y = 0; y < 48; y++) map.row(y).fill(80)
      })
      f.withMappedStream((map) => {
        for (let plane = 0; plane < 3; plane++)
          for (let y = 0; y < (plane ? 12 : 24); y++)
            map.row(y, plane).fill(plane ? 128 : 100)
      }, 'lores')
    }
    slow.blocked = true
    const a = c.startRecording(r, { audio }),
      b = c.startRecording(p, { audio, backpressure: 'drop' })
    try {
      await until(
        () =>
          p.hostIOStats().blockedWaits > 0n &&
          b.stats().skipped >= 6n &&
          a.stats().completed >= 6n,
      )
      slow.release()
      await until(() => b.stats().completed >= 3n)
      const fa = a.flushAsync(),
        fb = b.flushAsync()
      await Promise.all([fa, fb])
      for (const [i, run, bytes] of [
        [0, a, fast],
        [1, b, slow],
      ] as const) {
        writeFileSync(paths[i], bytes.data)
        const tracks = mp4(paths[i]),
          video = tracks.get(1)!,
          sound = tracks.get(2)!,
          frames = Number(run.audioStats()!.admittedFrames)
        decodeAudio(paths[i], sound, 0, frames)
        expect(sound.presentedUs).toBe(video.times.at(-1)! + 40_000n)
        function ref(w: number, h: number, y: number) {
          const out = new Uint8Array((w * h * 3) / 2)
          out.fill(y, 0, w * h)
          out.fill(128, w * h)
          return out
        }
        const expected = i
          ? ref(32, 24, 16 + Math.round((100 * 219) / 255))
          : ref(64, 48, 16 + Math.round((80 * 219) / 255))
        decodeVideoI420(
          paths[i],
          video,
          video.samples.map(() => expected),
        )
        if (i)
          expect(sound.presentedUs!).toBeGreaterThan(
            BigInt(video.samples.length) * 40_000n,
          )
        expect(run.audioStats()!.overruns).toBe(0n)
      }
    } finally {
      slow.release()
      await Promise.allSettled([a.close(), b.close(), r.close(), p.close()])
      await c.close()
      audio.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('a foreign microphone claim during mode publication leaves recorder ownership recoverable', async () => {
  const c = cam(),
    other = cam(),
    audio = new AudioCapture({ simulate: true, channels: 2, blockFrames: 480 })
  let entered!: () => void, release!: () => void
  const enteredGate = new Promise<void>((r) => {
      entered = r
    }),
    hold = new Promise<void>((r) => {
      release = r
    })
  const r = await Recorder.open(
    {
      outputframe() {},
      async stop() {
        entered()
        await hold
      },
    },
    { width: 64, height: 48, asyncWrites: true },
  )
  const peer = await Recorder.open(new Sink(), opts())
  try {
    const job = c.switchRecordingModeAsync(
      r,
      { width: 64, height: 48 },
      { fps: 25, audio: { sampleRate: 48000, channels: 2 } },
      new Sink(),
      { audio },
    )
    const result = failed(job)
    await enteredGate
    const foreign = other.startRecording(peer, { audio })
    release()
    expect(await result).toBeDefined()
    expect(c.activeRecordings).toEqual([])
    const recovered = c.startRecording(r)
    await until(
      () =>
        recovered.stats().completed >= 2n && foreign.stats().completed >= 2n,
    )
    expect(Number(audio.handle)).not.toBe(0)
    await Promise.all([recovered.close(), foreign.close()])
  } finally {
    release()
    await Promise.allSettled([
      c.close(),
      other.close(),
      r.close(),
      peer.close(),
    ])
    audio.close()
  }
})

test('future microphone blocks stay native and empty windows never advance the sample cursor', async () => {
  const c = cam(),
    audio = new AudioCapture({
      simulate: true,
      channels: 2,
      blockFrames: 480,
      startNs: 100_000_000_000n,
    }),
    r = await Recorder.open(new Sink(), opts()),
    peer = await Recorder.open(new Sink(), opts(true)),
    a = c.startRecording(r, { audio }),
    b = c.startRecording(peer, { audio })
  try {
    await until(() => a.stats().completed >= 3n && b.stats().completed >= 3n)
    expect(a.audioStats()!.admittedFrames).toBe(0n)
    expect(b.audioStats()!.nextTimestampNs).toBe(0n)
    const stats = audio.sharedStats()!
    expect(stats.reads).toBe(1n)
    expect(stats.pendingFuture).toBe(true)
    expect(stats.capturedFrames).toBe(0n)
    expect(stats.closed).toBe(false)
    await c.stop()
    expect(audio.sharedStats()!.closed).toBe(true)
    expect(audio.sharedStats()!.frames).toBe(0n)
    expect(audio.sharedStats()!.pendingFuture).toBe(false)
    expect(Number(audio.handle)).toBe(0)
  } finally {
    await Promise.allSettled([a.close(), b.close(), r.close(), peer.close()])
    await c.close()
    audio.close()
  }
})

test('flushed recorder sessions rejoin the live microphone group without old recordings releasing new owners', async () => {
  const c = cam(),
    audio = new AudioCapture({
      simulate: true,
      sampleRate: 48000,
      channels: 2,
      blockFrames: 480,
    }),
    first = new Sink(),
    next = new Sink(),
    r = await Recorder.open(first, opts()),
    p = await Recorder.open(new Sink(), opts(true)),
    a = c.startRecording(r, { audio }),
    b = c.startRecording(p, { audio })
  let resumed: ReturnType<Camera['startRecording']> | undefined
  try {
    await until(() => a.stats().completed >= 3n && b.stats().completed >= 3n)
    const oldId = a.audioStats()!.id
    await a.flushAsync()
    expect(Number(audio.handle)).not.toBe(0)
    await r.restartAsync(next)
    resumed = c.startRecording(r, { audio })
    expect(resumed.audioStats()!.id).toBeGreaterThan(oldId)
    await a.close()
    await until(() => resumed!.stats().completed >= 3n)
    const end = resumed.flushAsync(),
      peerEnd = b.flushAsync()
    await Promise.all([end, peerEnd])
    const state = resumed.audioStats()!,
      frames = Number(state.admittedFrames),
      origin = state.nextTimestampNs! - BigInt(resumed.frames) * 40_000_000n
    expect(origin).toBeGreaterThanOrEqual(120_000_000n)
    expect(pcm(next)).toEqual(
      samples(frames, 2, Number((origin * 48000n) / 1_000_000_000n)),
    )
    expect(Number(audio.handle)).toBe(0)
  } finally {
    await Promise.allSettled([
      a.close(),
      b.close(),
      resumed?.close(),
      r.close(),
      p.close(),
    ])
    await c.close()
    audio.close()
  }
})

test('rejected producer byte admission cancels its PCM borrow without advancing or blocking peers', async () => {
  const c = cam(),
    audio = new AudioCapture({
      simulate: true,
      sampleRate: 48000,
      channels: 2,
      blockFrames: 480,
    }),
    r = await Recorder.open(new Sink(), {
      ...opts(),
      producerQueue: { maxBytes: 64 * 48 * 3, maxOperations: 1 },
    }),
    p = await Recorder.open(new Sink(), opts(true)),
    a = c.startRecording(r, { audio }),
    b = c.startRecording(p, { audio })
  try {
    await until(() => a.error !== undefined && b.stats().completed >= 3n)
    expect(a.audioStats()!.pending).toBe(false)
    expect(a.audioStats()!.cancelledBatches).toBe(1n)
    expect(a.audioStats()!.nextTimestampNs).toBeUndefined()
    expect(a.audioStats()!.admittedFrames).toBe(0n)
    expect(b.error).toBeUndefined()
    expect(b.audioStats()!.admittedFrames).toBeGreaterThan(0n)
    expect(await failed(a.close())).toBeDefined()
    await b.flushAsync()
  } finally {
    await Promise.allSettled([a.close(), b.close(), r.close(), p.close()])
    await failed(c.close())
    audio.close()
  }
})
