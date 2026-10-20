import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  CircularOutput2,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
async function until(fn: () => boolean) {
  const deadline = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > deadline) throw Error('condition timeout')
    await pause()
  }
}
class Sink implements CustomOutput {
  frames: OutputPacket[] = []
  starts = 0
  stops = 0
  discarded = false
  start() {
    this.starts++
  }
  outputframe(p: OutputPacket) {
    this.frames.push(p)
  }
  stop(reason?: { discard: boolean }) {
    this.stops++
    this.discarded = !!reason?.discard
  }
}
const opts = {
  fps: 25,
  width: 32,
  height: 24,
  producerQueue: { maxBytes: 65536, maxOperations: 8 },
  outputQueue: { maxBytes: 65536, maxOperations: 8, waitMs: 1000 },
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

test('flushed recorder supports fresh sessions, reset timestamps and monotonic output identities', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    peer = new Sink(),
    r = await Recorder.open(a, opts)
  try {
    const oldId = await r.addOutput(peer)
    await submit(c, r, 0)
    await submit(c, r, 1)
    await r.flushAsync()
    const before = r.producerStats().completed
    expect(r.sessionState()).toEqual({ id: 0n, phase: 'flushed', errorCode: 0 })
    await r.restartAsync(b)
    expect(r.sessionState()).toEqual({ id: 1n, phase: 'open', errorCode: 0 })
    expect(r.stats().outputFrames).toBe(0n)
    expect(r.outputState().generation).toBe(1n)
    expect(() => r.outputState(oldId)).toThrow()
    const nextId = await r.addOutput(new Sink())
    expect(nextId).toBeGreaterThan(oldId)
    await submit(c, r, 0)
    await submit(c, r, 1)
    await r.flushAsync()
    expect(a.frames.length).toBe(2)
    expect(peer.frames.length).toBe(2)
    expect(b.frames.length).toBe(2)
    expect(a.stops).toBe(1)
    expect(peer.stops).toBe(1)
    expect(r.producerStats().completed).toBeGreaterThan(before)
    await r.restartAsync()
    const d = new Sink()
    await r.openOutput(d)
    expect(r.outputState().generation).toBe(2n)
    await submit(c, r, 0)
    await r.flushAsync()
    expect(d.frames.length).toBe(1)
    expect(b.stops).toBe(1)
  } finally {
    await r.close()
    await c.close()
  }
})

test('restart can follow a queued flush through the producer FIFO', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = await Recorder.open(a, opts)
  try {
    await submit(c, r, 0)
    const flush = r.flushAsync()
    const restart = r.restartAsync(b)
    await flush
    await restart
    await submit(c, r, 0)
    await r.flushAsync()
    expect(a.frames.length).toBe(1)
    expect(b.frames.length).toBe(1)
  } finally {
    await r.close()
    await c.close()
  }
})

test('cancellation during candidate commit joins native cleanup and preserves the previous session', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = await Recorder.open(a, opts),
    g = gate()
  let entered = false
  const candidate: CustomOutput = {
    start: () => b.start(),
    outputframe: (p) => b.outputframe(p),
    commit: async () => {
      entered = true
      await g.promise
    },
    stop: (reason) => b.stop(reason),
  }
  try {
    await submit(c, r, 0)
    await r.flushAsync()
    const job = r.restartAsync(candidate)
    await until(() => entered)
    expect(job.cancel()).toBe(true)
    expect(job.done).toBe(false)
    expect(() => r.restartAsync(new Sink())).toThrow()
    g.release()
    await expect(Promise.resolve(job)).rejects.toBeInstanceOf(JobCancelledError)
    expect(r.sessionState().id).toBe(0n)
    expect(r.sessionState().phase).toBe('flushed')
    expect(a.stops).toBe(0)
    expect(b.discarded).toBe(true)
    expect(b.stops).toBe(1)
    expect(r.producerStats().ownedJobs).toBe(0n)
    await r.restartAsync(new Sink())
    await submit(c, r, 0)
    await r.flushAsync()
  } finally {
    g.release()
    await r.close()
    await c.close()
  }
})

test('restart rejects live media, active aliases and existing paths without altering the flushed session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-restart-')),
    path = join(dir, 'existing.mkv'),
    c = camera(),
    a = new Sink(),
    r = await Recorder.open(a, opts)
  try {
    await expect(
      Promise.resolve(r.restartAsync(new Sink())),
    ).rejects.toMatchObject({ code: -2 })
    await submit(c, r, 0)
    await r.flushAsync()
    await expect(Promise.resolve(r.restartAsync(a))).rejects.toMatchObject({
      code: -4,
    })
    writeFileSync(path, 'preserve')
    await expect(Promise.resolve(r.restartAsync(path))).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('preserve')
    expect(a.stops).toBe(0)
    expect(r.sessionState().id).toBe(0n)
    const fresh = join(dir, 'fresh.mkv')
    await r.restartAsync(fresh)
    await submit(c, r, 0)
    await r.flushAsync()
    expect(readFileSync(fresh).length).toBeGreaterThan(100)
  } finally {
    await r.close()
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh session clears old isolated delivery errors and can record after a failed flush result', async () => {
  const c = camera(),
    bad: CustomOutput = {
      outputframe() {
        throw Error('old sink failed')
      },
    },
    r = await Recorder.open(bad, { ...opts, isolate: true }),
    good = new Sink()
  try {
    await submit(c, r, 0)
    await expect(Promise.resolve(r.flushAsync())).rejects.toThrow()
    await r.restartAsync(good)
    expect(r.outputErrors.size).toBe(0)
    await submit(c, r, 0)
    await r.flushAsync()
    expect(good.frames.length).toBe(1)
  } finally {
    await r.close()
    await c.close()
  }
})

test('post-publication stop errors reject restart but preserve the new usable session', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = await Recorder.open(a, opts)
  a.stop = () => {
    throw Error('old stop failed')
  }
  try {
    await submit(c, r, 0)
    await r.flushAsync()
    await expect(Promise.resolve(r.restartAsync(b))).rejects.toThrow(
      'old stop failed',
    )
    expect(r.sessionState().id).toBe(1n)
    await submit(c, r, 0)
    await r.flushAsync()
    expect(b.frames.length).toBe(1)
  } finally {
    await r.close()
    await c.close()
  }
})

test('delayed circular sessions start with empty video and PCM history', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = new CircularOutput2({
      ...opts,
      bufferDurationMs: 1000,
      audio: { sampleRate: 48000, channels: 1 },
    })
  try {
    await r.openOutput(a)
    for (let session = 0; session < 2; session++) {
      for (let i = 0; i < 2; i++) {
        using f = c.acquire()
        await r.writeAVAsync(
          f,
          [
            {
              data: new Uint8Array(3840),
              timestampNs: BigInt(i) * 40_000_000n,
            },
          ],
          BigInt(i) * 40_000_000n,
        )
      }
      await r.flushAsync()
      if (session === 0) {
        await r.restartAsync(b)
        expect(r.bufferStats().frames).toBe(0n)
        expect(r.stats().audioFrames).toBe(0n)
      }
    }
    expect(a.frames.filter((p) => !p.audio).length).toBe(2)
    expect(b.frames.filter((p) => !p.audio).length).toBe(2)
    expect(
      b.frames.filter((p) => p.audio).reduce((n, p) => n + p.data.length, 0),
    ).toBe(7680)
  } finally {
    await r.close()
    await c.close()
  }
})

const mediaTest =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  mediaTest(
    `${codec} reusable AAC/MP4 sessions have fresh headers, IDRs, clocks and exact presented samples`,
    async () => {
      const { MuxedOutput } = await import('../../ts'),
        { mp4, decodeVideo, decodeAudio } = await import('./media')
      class Bytes {
        data = Buffer.alloc(0)
        async write(bytes: Uint8Array) {
          await pause()
          const n = Math.min(bytes.length, 127)
          this.data = Buffer.concat([
            this.data,
            Buffer.from(bytes.subarray(0, n)),
          ])
          return n
        }
        async patch(offset: bigint, bytes: Uint8Array) {
          await pause()
          const n = Math.min(bytes.length, 7)
          Buffer.from(bytes.subarray(0, n)).copy(this.data, Number(offset))
          return n
        }
      }
      const dir = mkdtempSync(join(tmpdir(), 'zc-restart-mp4-')),
        c = new Camera({ simulate: true, width: 128, height: 96, fifo: true }),
        sinks = [new Bytes(), new Bytes(), new Bytes()]
      const r = await Recorder.open(new MuxedOutput(sinks[0]), {
        width: 128,
        height: 96,
        fps: 25,
        codec,
        gop: 4,
        audio: { sampleRate: 48000, channels: 2 },
        outputQueue: { maxBytes: 1024 * 1024, maxOperations: 8, waitMs: 1000 },
      })
      try {
        c.start()
        for (let session = 0; session < 3; session++) {
          if (session) await r.restartAsync(new MuxedOutput(sinks[session]))
          const sequences: bigint[] = []
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
          await r.flushAsync()
          expect(r.sessionState().id).toBe(BigInt(session))
          expect(r.outputState().generation).toBe(BigInt(session))
          const path = join(dir, `${session}.mp4`)
          writeFileSync(path, sinks[session].data)
          const tracks = mp4(path),
            video = tracks.get(1)!,
            audio = tracks.get(2)!
          expect(video.samples.length).toBe(12)
          expect(video.keys[0]).toBe(true)
          decodeVideo(path, video, sequences)
          decodeAudio(path, audio, 0, 12 * 1920)
          expect(r.stats().audioFrames).toBe(BigInt(12 * 1920))
        }
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
}

test('parent close cancels candidate restart and waits for the outstanding commit hook', async () => {
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    g = gate(),
    r = await Recorder.open(a, opts)
  let entered = false,
    closed = false
  const candidate: CustomOutput = {
    outputframe: (p) => b.outputframe(p),
    commit: async () => {
      entered = true
      await g.promise
    },
    stop: (reason) => b.stop(reason),
  }
  try {
    await submit(c, r, 0)
    await r.flushAsync()
    const job = r.restartAsync(candidate)
    await until(() => entered)
    const close = r.close().then(() => {
      closed = true
    })
    await pause()
    expect(closed).toBe(false)
    g.release()
    await expect(Promise.resolve(job)).rejects.toMatchObject({ code: -2 })
    await close
    expect(a.stops).toBe(1)
    expect(b.stops).toBe(1)
    expect(b.discarded).toBe(true)
  } finally {
    g.release()
    await r.close()
    await c.close()
  }
})

test('candidate header failure does not stop the flushed output or publish another session', async () => {
  const c = camera(),
    a = new Sink(),
    r = await Recorder.open(a, opts)
  let discarded = false
  const bad: CustomOutput = {
    format: 'mkv',
    write() {
      throw Error('header failed')
    },
    stop(reason) {
      discarded = !!reason?.discard
    },
  }
  try {
    await submit(c, r, 0)
    await r.flushAsync()
    const result = await Promise.resolve(r.restartAsync(bad)).then(
      () => undefined,
      (error) => error,
    )
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('header failed')
    expect(discarded).toBe(true)
    expect(a.stops).toBe(0)
    expect(r.sessionState().id).toBe(0n)
    await r.restartAsync(new Sink())
    await submit(c, r, 0)
    await r.flushAsync()
  } finally {
    await r.close()
    await c.close()
  }
})

test('camera recordings flush without consuming the recorder and restart capture with fresh frame/audio clocks', async () => {
  const { AudioCapture } = await import('../../ts')
  const c = camera(),
    a = new Sink(),
    b = new Sink(),
    r = await Recorder.open(a, {
      ...opts,
      audio: { sampleRate: 48000, channels: 1 },
    })
  let first: ReturnType<Camera['startRecording']> | undefined,
    second: ReturnType<Camera['startRecording']> | undefined
  try {
    first = c.startRecording(r, {
      audio: new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 1,
        blockFrames: 480,
      }),
    })
    await until(() => first!.frames >= 3)
    await first.flushAsync()
    const firstCount = a.frames.length
    expect(c.stats().leased).toBe(0)
    await r.restartAsync(b)
    second = c.startRecording(r, {
      audio: new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 1,
        blockFrames: 480,
      }),
    })
    await first.close() // The previous pump no longer owns the reusable recorder.
    await until(() => second!.frames >= 3)
    await second.flushAsync()
    expect(a.frames.length).toBe(firstCount)
    expect(b.frames.filter((p) => !p.audio)[0].timestampNs).toBe(0n)
    expect(b.frames.some((p) => p.audio)).toBe(true)
    expect(r.sessionState().id).toBe(1n)
  } finally {
    await first?.close()
    await second?.close()
    await r.close()
    await c.close()
  }
})
