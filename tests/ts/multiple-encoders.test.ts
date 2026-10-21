import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  AudioCapture,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
const pause = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms))
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > end) throw Error('condition timeout')
    await pause()
  }
}
const failure = (p: PromiseLike<unknown>) =>
  Promise.resolve(p).then(
    () => undefined,
    (e) => e,
  )
class Sink implements CustomOutput {
  packets: OutputPacket[] = []
  stopped = 0
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
  stop() {
    this.stopped++
  }
}
const cam = () =>
  new Camera({
    simulate: true,
    width: 64,
    height: 48,
    fifo: true,
    lores: { width: 32, height: 24 },
  })
const options = (lores = false, asyncWrites = true) => ({
  width: lores ? 32 : 64,
  height: lores ? 24 : 48,
  stream: lores ? ('lores' as const) : ('main' as const),
  asyncWrites,
  producerQueue: { maxBytes: 64 * 48 * 3, maxOperations: 1 },
  outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 2000 },
})
for (const asyncWrites of [false, true])
  test(`main and lores encode independently with ${asyncWrites ? 'asynchronous' : 'synchronous'} inputs`, async () => {
    const c = cam(),
      mainSink = new Sink(),
      lowSink = new Sink()
    const main = await Recorder.open(mainSink, options(false, asyncWrites)),
      low = await Recorder.open(lowSink, {
        ...options(true, asyncWrites),
        producerQueue: { maxBytes: 9216, maxOperations: 2 },
      })
    const a = c.startRecording(main),
      b = c.startRecording(low)
    try {
      await until(() => a.stats().completed >= 3n && b.stats().completed >= 3n)
      const active = c.activeRecordings
      expect(active).toEqual([a, b])
      expect(Object.isFrozen(active)).toBe(true)
      await b.flushAsync()
      const before = a.frames
      await until(() => a.frames >= before + 3)
      await a.close()
      await low.close()
      expect(a.stats().id).not.toBe(b.stats().id)
      expect(a.stats().skipped).toBe(0n)
      expect(b.stats().skipped).toBe(0n)
      expect(a.stats().pending).toBe(false)
      expect(b.stats().active).toBe(false)
      for (let i = 0; i < 3; i++)
        expect(mainSink.packets[i].sourceTimestampNs).toBe(
          lowSink.packets[i].sourceTimestampNs,
        )
      // JPEG SOF dimensions prove that each encoder got its selected stream.
      function dimensions(data: Uint8Array) {
        for (let i = 2; i < data.length - 8; i++)
          if (data[i] === 255 && data[i + 1] === 192)
            return [
              (data[i + 7] << 8) | data[i + 8],
              (data[i + 5] << 8) | data[i + 6],
            ]
        throw Error('missing SOF')
      }
      expect(dimensions(mainSink.packets[0].data)).toEqual([64, 48])
      expect(dimensions(lowSink.packets[0].data)).toEqual([32, 24])
      expect(c.stats().leased).toBe(0)
    } finally {
      await Promise.allSettled([a.close(), b.close(), low.close()])
      await c.close()
    }
  })
test('dropping busy encoder preserves healthy capture, bounded copies and source timestamp gaps', async () => {
  const c = cam(),
    slow = new Sink(true),
    good = new Sink()
  const r = await Recorder.open(slow, options()),
    peer = await Recorder.open(good, options(true))
  const a = c.startRecording(r, { backpressure: 'drop' }),
    b = c.startRecording(peer)
  try {
    await until(() => r.hostIOStats().blockedWaits === 1n)
    const first = a.frames
    const captured = await c.capture((f) => f.sequence, { timeoutMs: 1000 })
    await until(() => a.stats().skipped >= 8n && b.stats().completed >= 8n)
    expect(captured).toBeGreaterThan(0n)
    expect(a.frames).toBe(first)
    expect(c.stats().leased).toBe(0)
    expect(r.producerStats().ownedJobs).toBe(1n)
    expect(r.producerStats().ownedBytes).toBe(64n * 48n * 3n)
    slow.release()
    await until(() => a.stats().completed >= 3n)
    await a.close()
    await b.close()
    expect(
      slow.packets[2].sourceTimestampNs - slow.packets[1].sourceTimestampNs,
    ).toBeGreaterThan(40_000_000n)
    expect(a.stats().pending).toBe(false)
    expect(a.stats().failures).toBe(0n)
    expect(r.producerStats().highJobs).toBe(1n)
    const frozen = a.stats()
    await c.close()
    expect(a.stats()).toEqual(frozen)
  } finally {
    slow.release()
    await Promise.allSettled([a.close(), b.close()])
    await c.close()
  }
})
test('default wait policy gates camera and peers without overlapping producers', async () => {
  const c = cam(),
    slow = new Sink(true),
    good = new Sink()
  const r = await Recorder.open(slow, options()),
    peer = await Recorder.open(good, options(true))
  const a = c.startRecording(r),
    b = c.startRecording(peer)
  try {
    await until(() => r.hostIOStats().blockedWaits === 1n)
    const before = b.frames,
      delivered = c.stats().delivered
    const capture = c.capture((f) => f.sequence)
    await pause(15)
    expect(b.frames).toBe(before)
    expect(c.stats().delivered).toBe(delivered)
    expect(c.stats().leased).toBe(0)
    expect(a.stats().skipped).toBe(0n)
    expect(a.stats().pending).toBe(true)
    slow.release()
    await capture
    await until(() => b.frames > before)
  } finally {
    slow.release()
    await Promise.allSettled([a.close(), b.close()])
    await c.close()
  }
})
test('encoder output failure quarantines only its attachment and keeps healthy peers live', async () => {
  const c = cam(),
    good = new Sink(),
    expected = Error('intentional sink failure')
  const bad = await Recorder.open(
      {
        outputframe() {
          throw expected
        },
      },
      options(),
    ),
    peer = await Recorder.open(good, options(true))
  const a = c.startRecording(bad, { backpressure: 'drop' }),
    b = c.startRecording(peer)
  try {
    await until(() => a.error !== undefined)
    expect(a.stats().failed).toBe(true)
    expect(a.stats().active).toBe(false)
    expect(a.stats().failures).toBe(1n)
    const before = b.frames
    await until(() => b.frames >= before + 3)
    expect(c.activeRecordings).toEqual([b])
    expect(b.error).toBeUndefined()
    expect(await failure(a.close())).toBeDefined()
    await b.close()
    expect(c.stats().leased).toBe(0)
  } finally {
    await Promise.allSettled([a.close(), b.close()])
    await c.close()
  }
})
test('eight attachments bound admission, duplicate ownership cannot steal and IDs never recycle', async () => {
  const c = cam(),
    recorders: Recorder[] = [],
    runs: ReturnType<Camera['startRecording']>[] = []
  try {
    for (let i = 0; i < 9; i++)
      recorders.push(await Recorder.open(new Sink(), options()))
    for (let i = 0; i < 8; i++) runs.push(c.startRecording(recorders[i]))
    expect(() => c.startRecording(recorders[8])).toThrow()
    expect(() => c.startRecording(recorders[0])).toThrow()
    const old = runs[3].stats().id
    await runs[3].close()
    const replacement = c.startRecording(recorders[8])
    runs.push(replacement)
    expect(replacement.stats().id).toBeGreaterThan(runs[7].stats().id)
    expect(replacement.stats().id).not.toBe(old)
    expect(() => c.startRecording(recorders[0])).toThrow()
    await until(
      () =>
        runs[0].stats().completed >= 2n && replacement.stats().completed >= 2n,
    )
    await c.stop()
    expect(c.activeRecordings).toEqual([])
    for (const r of runs) {
      expect(r.stats().pending).toBe(false)
      expect(r.stats().active).toBe(false)
    }
  } finally {
    await Promise.allSettled(recorders.map((r) => r.close()))
    await c.close()
  }
})
test('camera close joins every encoder and cancels all producer turns before native state destruction', async () => {
  const c = cam(),
    sinks = [new Sink(true), new Sink(true)]
  const recorders = await Promise.all(
    sinks.map((s) => Recorder.open(s, options())),
  )
  const runs = recorders.map((r) =>
    c.startRecording(r, { backpressure: 'drop' }),
  )
  try {
    await until(() =>
      recorders.every((r) => r.hostIOStats().blockedWaits === 1n),
    )
    const closing = c.close()
    let done = false
    void closing.then(() => {
      done = true
    })
    await until(() => recorders.every((r) => r.closing))
    expect(done).toBe(false)
    sinks.forEach((s) => s.release())
    await closing
    for (const r of runs) {
      expect(r.stats().active).toBe(false)
      expect(r.stats().pending).toBe(false)
      expect(r.stats().failures).toBe(0n)
    }
    expect(sinks.map((s) => s.stopped)).toEqual([1, 1])
  } finally {
    sinks.forEach((s) => s.release())
    await Promise.allSettled(recorders.map((r) => r.close()))
    await c.close()
  }
})
test('mode switching rejects multiple encoders before flushing and works after peer retirement', async () => {
  const c = cam(),
    r = await Recorder.open(new Sink(), {
      ...options(),
      producerQueue: { maxBytes: 65536, maxOperations: 1 },
    }),
    peer = await Recorder.open(new Sink(), options(true))
  const a = c.startRecording(r),
    b = c.startRecording(peer)
  try {
    expect(() => a.switchModeAsync({ width: 96, height: 64 })).toThrow()
    expect(r.sessionState().phase).toBe('open')
    expect(peer.sessionState().phase).toBe('open')
    await b.close()
    const resumed = await a.switchModeAsync({ width: 96, height: 64 })
    expect(resumed.stats().id).toBeGreaterThan(b.stats().id)
    await until(() => resumed.stats().completed >= 2n)
    expect(r.width).toBe(96)
    expect(c.activeRecordings).toEqual([resumed])
    await a.close()
    expect(r.closing).toBe(false)
    await resumed.close()
  } finally {
    await Promise.allSettled([a.close(), b.close(), r.close()])
    await c.close()
  }
})
test.skipIf(!process.env.ZC_TEST_AAC)(
  'shared audio accepts dropping consumers and holds the microphone until its last recording closes',
  async () => {
    const c = cam(),
      audio = new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 1,
      }),
      r = await Recorder.open(new Sink(), {
        ...options(),
        audio: { sampleRate: 48000, channels: 1 },
        producerQueue: { maxBytes: 65536, maxOperations: 1 },
      }),
      peer = await Recorder.open(new Sink(), {
        ...options(true),
        audio: { sampleRate: 48000, channels: 1 },
        producerQueue: { maxBytes: 65536, maxOperations: 1 },
      })
    try {
      const a = c.startRecording(r, { audio, backpressure: 'drop' })
      const b = c.startRecording(peer, { audio })
      expect(() => audio.read()).toThrow()
      expect(() => audio.close()).toThrow()
      await until(() => a.stats().completed >= 2n && b.stats().completed >= 2n)
      expect(c.activeRecordings.length).toBe(2)
      await b.close()
      expect(audio.handle).not.toBe(0)
      await a.close()
      expect(Number(audio.handle)).toBe(0)
      await c.stop()
    } finally {
      await c.close()
      audio.close()
      await Promise.allSettled([r.close(), peer.close()])
    }
  },
)

test('retiring a blocked wait encoder immediately releases peer capture before its output hook settles', async () => {
  const c = cam(),
    slow = new Sink(true),
    r = await Recorder.open(slow, options()),
    peer = await Recorder.open(new Sink(), options(true))
  const a = c.startRecording(r),
    b = c.startRecording(peer)
  try {
    await until(() => r.hostIOStats().blockedWaits === 1n)
    const before = b.frames,
      closing = a.close()
    let done = false
    void closing.then(() => {
      done = true
    })
    await until(() => b.frames >= before + 3)
    expect(done).toBe(false)
    expect(a.stats().active).toBe(false)
    expect(c.stats().leased).toBe(0)
    slow.release()
    await closing
    expect(a.stats().pending).toBe(false)
    expect(a.stats().failures).toBe(0n)
  } finally {
    slow.release()
    await Promise.allSettled([a.close(), b.close()])
    await c.close()
  }
})

test('mode cancellation while its last producer is blocked preserves the original recording', async () => {
  const c = cam(),
    sink = new Sink(true),
    r = await Recorder.open(sink, options())
  const a = c.startRecording(r)
  try {
    await until(() => r.hostIOStats().blockedWaits === 1n)
    const job = a.switchModeAsync({ width: 64, height: 48 }, {}, null, {
      timeoutMs: 20,
    })
    expect(await failure(job)).toBeDefined()
    expect(c.info().width).toBe(64)
    expect(c.activeRecordings).toEqual([a])
    expect(a.stats().active).toBe(true)
    sink.release()
    await until(() => a.stats().completed >= 3n)
    await a.close()
  } finally {
    sink.release()
    await Promise.allSettled([a.close()])
    await c.close()
  }
})

test.skipIf(!process.env.ZC_TEST_CODECS)(
  'simultaneous AVC main and HEVC lores MP4 decode independently after shared request release',
  async () => {
    const { mkdtempSync, rmSync } = await import('node:fs'),
      { tmpdir } = await import('node:os'),
      { join } = await import('node:path'),
      { mp4, decodeVideoI420 } = await import('./media')
    const dir = mkdtempSync(join(tmpdir(), 'zc-multi-codecs-')),
      paths = [join(dir, 'main.mp4'), join(dir, 'lores.mp4')]
    const c = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      lores: { width: 32, height: 24 },
      writable: true,
      fifo: true,
    })
    const r = new Recorder(paths[0], {
        ...options(),
        codec: 'h264',
        quality: 100,
        gop: 2,
      }),
      p = new Recorder(paths[1], {
        ...options(true),
        codec: 'hevc',
        quality: 100,
        gop: 2,
      })
    c.preCallback = (f) => {
      f.withMappedStream((map) => {
        for (let y = 0; y < 48; y++)
          for (let x = 0; x < 64; x++) map.row(y).set([30, 90, 150], x * 3)
      })
      f.withMappedStream((map) => {
        for (let plane = 0; plane < 3; plane++)
          for (let y = 0; y < (plane ? 12 : 24); y++)
            map.row(y, plane).fill([100, 80, 160][plane])
      }, 'lores')
    }
    const a = c.startRecording(r),
      b = c.startRecording(p)
    try {
      await until(() => a.stats().completed >= 4n && b.stats().completed >= 4n)
      await c.stop()
      const main = mp4(paths[0]).get(1)!,
        lores = mp4(paths[1]).get(1)!
      expect([main.codec, main.width, main.height]).toEqual(['avc1', 64, 48])
      expect([lores.codec, lores.width, lores.height]).toEqual(['hvc1', 32, 24])
      expect(main.samples.length).toBeGreaterThanOrEqual(4)
      expect(lores.samples.length).toBeGreaterThanOrEqual(4)
      const shared = Math.min(main.times.length, lores.times.length)
      expect(main.times.slice(0, shared)).toEqual(lores.times.slice(0, shared))
      function reference(width: number, height: number, values: number[]) {
        const pixels = width * height,
          data = new Uint8Array((pixels * 3) / 2)
        data.fill(values[0], 0, pixels)
        data.fill(values[1], pixels, (pixels * 5) / 4)
        data.fill(values[2], (pixels * 5) / 4)
        return data
      }
      const luma = 0.299 * 30 + 0.587 * 90 + 0.114 * 150
      const rgb = reference(64, 48, [
        16 + Math.round((219 * luma) / 255),
        128 + Math.round(((224 / 255) * (150 - luma)) / (2 * (1 - 0.114))),
        128 + Math.round(((224 / 255) * (30 - luma)) / (2 * (1 - 0.299))),
      ])
      const yuv = reference(32, 24, [
        16 + Math.round((100 * 219) / 255),
        128 + Math.round(((80 - 128) * 224) / 255),
        128 + Math.round(((160 - 128) * 224) / 255),
      ])
      decodeVideoI420(
        paths[0],
        main,
        main.samples.map(() => rgb),
      )
      decodeVideoI420(
        paths[1],
        lores,
        lores.samples.map(() => yuv),
      )
      expect(c.stats().leased).toBe(0)
    } finally {
      await Promise.allSettled([r.close(), p.close()])
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
