import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  CircularOutput2,
  CameraError,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
const pause = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms))
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('condition timeout')
    await pause()
  }
}
function camera() {
  const c = new Camera({ simulate: true, width: 32, height: 24, fifo: true })
  c.start()
  return c
}
function submit(c: Camera, r: Recorder, i: number) {
  using frame = c.acquire()
  return r.writeAsync(frame, BigInt(i) * 40_000_000n)
}
class Sink implements CustomOutput {
  frames: OutputPacket[] = []
  entered = 0
  stops = 0
  gates = [gate(), gate(), gate(), gate()]
  async outputframe(p: OutputPacket) {
    const index = this.entered++
    await this.gates[index]?.promise
    this.frames.push(p)
  }
  stop() {
    this.stops++
  }
  release() {
    for (const g of this.gates) g.release()
  }
}
const options = {
  width: 32,
  height: 24,
  outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
}

test('recording drain joins queued producers and every sink acknowledgement before later FIFO writes', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = await Recorder.open(a, options)
  try {
    await r.addOutput(b)
    await submit(c, r, 0)
    await until(() => a.entered === 1 && b.entered === 1)
    const one = submit(c, r, 1),
      two = submit(c, r, 2)
    const drain = r.drainRecordingAsync(),
      later = submit(c, r, 3)
    a.gates[0].release()
    b.gates[0].release()
    await one
    await until(() => a.entered === 2 && b.entered === 2)
    a.gates[1].release()
    b.gates[1].release()
    await two
    await until(() => a.entered === 3 && b.entered === 3)
    await until(() => r.producerStats().completed === 4n)
    expect(drain.done).toBe(false)
    expect(later.done).toBe(false)
    expect(() => r.stats()).toThrow(CameraError)
    a.gates[2].release()
    await pause(5)
    expect(drain.done).toBe(false)
    b.gates[2].release()
    await drain
    expect(a.frames.length).toBe(3)
    expect(b.frames.length).toBe(3)
    a.release()
    b.release()
    await later
    await r.drainRecordingAsync()
    expect(a.frames.length).toBe(4)
    expect(b.frames.length).toBe(4)
  } finally {
    a.release()
    b.release()
    await r.close()
    await c.close()
  }
})

test('active recording drain cancellation releases its fences without cancelling delivery or later writes', async () => {
  const c = camera(),
    a = new Sink(),
    r = await Recorder.open(a, options)
  try {
    await submit(c, r, 0)
    const drain = r.drainRecordingAsync()
    await until(() => r.producerStats().completed === 2n)
    expect(drain.cancel()).toBe(true)
    await expect(Promise.resolve(drain)).rejects.toBeInstanceOf(
      JobCancelledError,
    )
    expect(r.producerStats().ownedJobs).toBe(0n)
    const later = submit(c, r, 1)
    a.release()
    await later
    await r.drainRecordingAsync()
    expect(a.frames.length).toBe(2)
    const empty = r.drainRecordingAsync({ timeoutMs: 0 })
    await expect(Promise.resolve(empty)).rejects.toMatchObject({ code: -3 })
    await r.drainRecordingAsync()
  } finally {
    a.release()
    await r.close()
    await c.close()
  }
})

test('terminal flush emits delayed tails, cannot be cancelled after start, and close joins acknowledgements', async () => {
  const c = camera(),
    a = new Sink(),
    r = new CircularOutput2({ ...options, bufferDurationMs: 1000 })
  try {
    await r.openOutput(a)
    for (let i = 0; i < 3; i++) await submit(c, r, i)
    await r.drainRecordingAsync()
    expect(a.frames.length).toBe(0)
    const flush = r.flushAsync()
    await until(() => a.entered === 1)
    expect(flush.cancel()).toBe(false)
    expect(flush.done).toBe(false)
    const closed = r.close()
    await pause(5)
    expect(a.stops).toBe(0)
    a.release()
    await flush
    await closed
    expect(a.frames.map((p) => p.timestampNs)).toEqual([
      0n,
      40_000_000n,
      80_000_000n,
    ])
    expect(a.stops).toBe(1)
  } finally {
    a.release()
    await r.close()
    await c.close()
  }
})

test('a queued cancelled flush leaves encoders accepting, while repeated completed flushes are idempotent', async () => {
  const c = camera(),
    a = new Sink(),
    r = await Recorder.open(a, options)
  try {
    await submit(c, r, 0)
    const active = submit(c, r, 1),
      flush = r.flushAsync()
    expect(flush.cancel()).toBe(true)
    await expect(Promise.resolve(flush)).rejects.toBeInstanceOf(
      JobCancelledError,
    )
    a.release()
    await active
    await submit(c, r, 2)
    await r.flushAsync()
    await r.flushAsync()
    expect(a.frames.length).toBe(3)
    expect(a.stops).toBe(0)
    expect(() => submit(c, r, 3)).toThrow(CameraError)
    using frame = c.acquire()
    expect(() => r.write(frame, 120_000_000n)).toThrow(CameraError)
    await r.close()
    expect(a.frames.length).toBe(3)
  } finally {
    a.release()
    await r.close()
    await c.close()
  }
})

test('recording drain waits for healthy peers before surfacing an isolated sink failure', async () => {
  const c = camera(),
    good = new Sink(),
    bad: CustomOutput = {
      outputframe() {
        throw Error('sink failure')
      },
    },
    r = await Recorder.open(bad, { ...options, isolate: true })
  try {
    const id = await r.addOutput(good)
    await submit(c, r, 0)
    const drain = r.drainRecordingAsync()
    await until(() => good.entered === 1)
    await pause(5)
    expect(drain.done).toBe(false)
    good.release()
    await expect(Promise.resolve(drain)).rejects.toThrow()
    expect(good.frames.length).toBe(1)
    await submit(c, r, 1)
    await r.drain(id)
    expect(good.frames.length).toBe(2)
  } finally {
    good.release()
    await r.close()
    await c.close()
  }
})

test('recording drain includes retiring host epochs across a producer split', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = await Recorder.open(a, options)
  let split: ReturnType<Recorder['split']> | undefined
  try {
    await submit(c, r, 0)
    split = r.split(b)
    await until(() => split!.status.staged)
    await submit(c, r, 1)
    const drain = r.drainRecordingAsync()
    await until(() => b.entered === 1)
    a.release()
    await pause(5)
    expect(drain.done).toBe(false)
    b.release()
    await drain
    await split
    split.close()
    split = undefined
    expect(a.frames.length).toBe(1)
    expect(b.frames.length).toBe(1)
  } finally {
    a.release()
    b.release()
    await r.close()
    split?.close()
    await c.close()
  }
})

const mediaTest =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  mediaTest(
    `${codec} terminal flush makes complete AAC/MP4 decodable before close and never repeats tails or patches`,
    async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
      const { tmpdir } = await import('node:os'),
        { join } = await import('node:path')
      const { MuxedOutput } = await import('../../ts')
      const { mp4, decodeVideo, decodeAudio } = await import('./media')
      const dir = mkdtempSync(join(tmpdir(), 'zc-flush-mp4-'))
      const c = new Camera({
        simulate: true,
        width: 128,
        height: 96,
        fifo: true,
      })
      let data = Buffer.alloc(0),
        patches = 0,
        stops = 0
      const bytes = {
        async write(value: Uint8Array) {
          await pause()
          const count = Math.min(value.length, 127)
          data = Buffer.concat([data, Buffer.from(value.subarray(0, count))])
          return count
        },
        async patch(offset: bigint, value: Uint8Array) {
          await pause()
          const count = Math.min(value.length, 7)
          Buffer.from(value.subarray(0, count)).copy(data, Number(offset))
          patches++
          return count
        },
      }
      const output = new MuxedOutput(bytes)
      output.stop = async () => {
        stops++
      }
      const r = await Recorder.open(output, {
        width: 128,
        height: 96,
        fps: 25,
        codec,
        gop: 4,
        audio: { sampleRate: 48000, channels: 2 },
        outputQueue: { maxBytes: 1024 * 1024, maxOperations: 8, waitMs: 1000 },
      })
      const sequences: bigint[] = []
      try {
        c.start()
        for (let i = 0; i < 12; i++) {
          const pcm = new Uint8Array(1920 * 4),
            view = new DataView(pcm.buffer)
          for (let sample = 0; sample < 1920; sample++) {
            const value = (((i * 1920 + sample) % 200) - 100) * 100
            view.setInt16(sample * 4, value, true)
            view.setInt16(sample * 4 + 2, -value, true)
          }
          using frame = c.acquire()
          sequences.push(frame.sequence)
          await r.writeAVAsync(
            frame,
            [{ data: pcm, timestampNs: BigInt(i) * 40_000_000n }],
            BigInt(i) * 40_000_000n,
          )
        }
        await r.drainRecordingAsync()
        const beforeFlush = data.length
        await r.flushAsync()
        expect(data.length).toBeGreaterThan(beforeFlush)
        expect(stops).toBe(0)
        expect(patches).toBeGreaterThan(0)
        const path = join(dir, 'flushed.mp4')
        writeFileSync(path, data)
        const tracks = mp4(path),
          video = tracks.get(1)!,
          audio = tracks.get(2)!
        expect(video.samples.length).toBe(12)
        decodeVideo(path, video, sequences)
        decodeAudio(path, audio, 0, 12 * 1920)
        const final = Buffer.from(data),
          count = patches
        await r.flushAsync()
        await r.drainRecordingAsync()
        expect(data).toEqual(final)
        expect(patches).toBe(count)
        expect(() => {
          using frame = c.acquire()
          r.write(frame, 480_000_000n)
        }).toThrow(CameraError)
        await r.close()
        expect(data).toEqual(final)
        expect(patches).toBe(count)
        expect(stops).toBe(1)
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
}

test('flush rejects a staged split before ending codecs, allowing recording to commit and retry', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = await Recorder.open(a, options)
  a.release()
  b.release()
  let split: ReturnType<Recorder['split']> | undefined
  try {
    await submit(c, r, 0)
    split = r.split(b)
    await until(() => split!.status.staged)
    await expect(Promise.resolve(r.flushAsync())).rejects.toMatchObject({
      code: -4,
    })
    await submit(c, r, 1)
    await split
    split.close()
    split = undefined
    await r.flushAsync()
    expect(a.frames.length + b.frames.length).toBe(2)
  } finally {
    a.release()
    b.release()
    await r.close()
    split?.close()
    await c.close()
  }
})
