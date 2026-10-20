import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  CameraError,
  JobCancelledError,
  AudioCapture,
  PtsStream,
  CircularOutput2,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
const pause = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms))
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > end) throw Error('condition timeout')
    await pause()
  }
}
class Sink implements CustomOutput {
  frames: OutputPacket[] = []
  gate = deferred()
  entered = false
  stops = 0
  async outputframe(packet: OutputPacket) {
    this.entered = true
    await this.gate.promise
    this.frames.push(packet)
  }
  stop() {
    this.stops++
  }
}
function cam() {
  const c = new Camera({ simulate: true, width: 32, height: 24, fifo: true })
  c.start()
  return c
}
function submit(camera: Camera, recorder: Recorder, index: number) {
  using frame = camera.acquire()
  return recorder.writeAsync(frame, BigInt(index) * 40_000_000n)
}
test('async producer owns copied RGB after lease release and automatically waits without blocking Bun', async () => {
  const camera = cam(),
    sink = new Sink(),
    recorder = await Recorder.open(sink, {
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
    })
  const reference = new Sink()
  reference.gate.release()
  const expected = await Recorder.open(reference, { width: 32, height: 24 })
  try {
    using frame = camera.acquire()
    expected.write(frame, 0n)
    const first = recorder.writeAsync(frame, 0n)
    frame.release()
    for (let i = 0; i < 8; i++) {
      using overwrite = camera.acquire()
    }
    await first
    await expected.drain()
    await until(() => sink.entered)
    const second = submit(camera, recorder, 1)
    await until(() => recorder.producerStats().running)
    await until(() => recorder.hostIOStats().blockedWaits === 1n)
    expect(second.done).toBe(false)
    expect(() => recorder.stats()).toThrow(CameraError)
    expect(() => recorder.poll()).toThrow(CameraError)
    sink.gate.release()
    await second
    await recorder.drain()
    expect(sink.frames.length).toBe(2)
    expect(sink.frames[0].data).toEqual(reference.frames[0].data)
    const stats = recorder.producerStats()
    expect(stats.completed).toBe(2n)
    expect(stats.ownedBytes).toBe(0n)
    expect(stats.running).toBe(false)
    expect(recorder.hostIOStats().satisfiedWaits).toBe(1n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await expected.close()
    await camera.close()
  }
})
test('producer admission is byte/count bounded and cancelled queued jobs cannot bypass an active predecessor', async () => {
  const camera = cam(),
    sink = new Sink(),
    recorder = await Recorder.open(sink, {
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
      producerQueue: { maxBytes: 32 * 24 * 3 * 3, maxOperations: 3 },
    })
  try {
    await submit(camera, recorder, 0)
    await until(() => sink.entered)
    const active = submit(camera, recorder, 1)
    await until(() => recorder.producerStats().running)
    const skipped = submit(camera, recorder, 2)
    expect(skipped.cancel()).toBe(true)
    await expect(Promise.resolve(skipped)).rejects.toBeInstanceOf(
      JobCancelledError,
    )
    const last = submit(camera, recorder, 3)
    await pause(5)
    expect(last.done).toBe(false)
    const extra = submit(camera, recorder, 4)
    expect(() => submit(camera, recorder, 5)).toThrow(CameraError)
    extra.cancel()
    await expect(Promise.resolve(extra)).rejects.toBeInstanceOf(
      JobCancelledError,
    )
    sink.gate.release()
    await active
    await last
    await recorder.close()
    expect(sink.frames.map((f) => f.timestampNs)).toEqual([
      0n,
      40_000_000n,
      120_000_000n,
    ])
    const stats = recorder.producerStats()
    expect(stats.cancelled).toBe(2n)
    expect(stats.completed).toBe(3n)
    expect(stats.rejected).toBe(1n)
    expect(stats.ownedJobs).toBe(0n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('automatic wait timeout isolates its output and preserves healthy shared encoding peers', async () => {
  const camera = cam(),
    bad = new Sink(),
    healthy = new Sink()
  healthy.gate.release()
  const recorder = await Recorder.open(bad, {
    width: 32,
    height: 24,
    isolate: true,
    outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 10 },
  })
  try {
    const id = await recorder.addOutput(healthy)
    await submit(camera, recorder, 0)
    await until(() => bad.entered)
    await submit(camera, recorder, 1)
    await submit(camera, recorder, 2)
    const stats = recorder.hostIOStats()
    expect(stats.timedOutWaits).toBe(1n)
    expect(stats.rejectedOperations).toBe(1n)
    expect(recorder.outputState().errorCode).toBe(-6)
    bad.gate.release()
    await recorder.drain(id)
    await recorder.close()
    expect(healthy.frames.length).toBe(3)
  } finally {
    bad.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('parent close cancels pending and active inputs, joining the entered write before cleanup', async () => {
  const camera = cam(),
    sink = new Sink(),
    recorder = await Recorder.open(sink, {
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
    })
  try {
    await submit(camera, recorder, 0)
    await until(() => sink.entered)
    const active = submit(camera, recorder, 1)
    await until(() => recorder.hostIOStats().blockedWaits === 1n)
    const queued = submit(camera, recorder, 2)
    const drain = recorder.drainProducersAsync()
    const closed = recorder.close()
    await expect(Promise.resolve(queued)).rejects.toMatchObject({ code: -2 })
    await expect(Promise.resolve(drain)).rejects.toMatchObject({ code: -2 })
    expect(active.done).toBe(false)
    sink.gate.release()
    await expect(Promise.resolve(active)).rejects.toMatchObject({ code: -2 })
    await closed
    expect(sink.frames.length).toBe(2)
    expect(recorder.producerStats().ownedJobs).toBe(0n)
    expect(recorder.producerStats().cancelled).toBe(2n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})

test('active cancellation callback can close its recorder after ownership cleanup', async () => {
  const camera = cam(),
    sink = new Sink()
  const recorder = await Recorder.open(sink, {
    width: 32,
    height: 24,
    outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
  })
  try {
    await submit(camera, recorder, 0)
    await until(() => sink.entered)
    using frame = camera.acquire()
    let callbackOwned = -1n
    const active = recorder.writeAsync(frame, 40_000_000n, {
      signalFunction: async () => {
        callbackOwned = recorder.producerStats().ownedBytes
        await recorder.close()
      },
    })
    frame.release()
    await until(() => recorder.hostIOStats().blockedWaits === 1n)
    expect(active.cancel()).toBe(true)
    sink.gate.release()
    await expect(Promise.resolve(active)).rejects.toBeInstanceOf(
      JobCancelledError,
    )
    await active.cleanupDone
    expect(active.callbackError).toBeUndefined()
    expect(callbackOwned).toBe(0n)
    expect(sink.stops).toBe(1)
    expect(recorder.producerStats().ownedJobs).toBe(0n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('queued producer aborts/deadlines release copies, and synchronous sends retain fail-fast pressure', async () => {
  const camera = cam(),
    sink = new Sink(),
    recorder = await Recorder.open(sink, {
      width: 32,
      height: 24,
      isolate: true,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
    })
  try {
    using frame = camera.acquire()
    const job = recorder.writeAsync(frame, 0n, { timeoutMs: 0 })
    await expect(Promise.resolve(job)).rejects.toMatchObject({ code: -3 })
    expect(recorder.producerStats().ownedBytes).toBe(0n)
    recorder.write(frame, 0n)
    await until(() => sink.entered)
    using next = camera.acquire()
    recorder.write(next, 40_000_000n)
    expect(recorder.outputState().errorCode).toBe(-6)
    expect(recorder.hostIOStats().waitRequests).toBe(0n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('camera automatic producer capture applies backpressure and releases leases before waiting', async () => {
  const camera = cam(),
    sink = new Sink(),
    recorder = await Recorder.open(sink, {
      width: 32,
      height: 24,
      asyncWrites: true,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
    })
  const recording = camera.startRecording(recorder)
  try {
    await until(() => recorder.hostIOStats().blockedWaits === 1n)
    expect(camera.stats().leased).toBe(0)
    expect(recording.frames).toBe(2)
    // Another capture request cannot create a second overlapping pump.
    const capture = camera.capture((frame) => frame.sequence, {
      timeoutMs: 1000,
    })
    await pause(10)
    expect(recording.frames).toBe(2)
    sink.gate.release()
    await capture
    await recording.close()
    expect(recording.error).toBeUndefined()
    expect(recorder.producerStats().ownedJobs).toBe(0n)
    expect(sink.frames.length).toBeGreaterThanOrEqual(2)
  } finally {
    sink.gate.release()
    await recording.close()
    await camera.close()
  }
})
test('camera automatic A/V groups share one bounded admission and preserve PCM/video order', async () => {
  const camera = cam(),
    sink = new Sink()
  sink.gate.release()
  const recorder = await Recorder.open(sink, {
    width: 32,
    height: 24,
    fps: 25,
    asyncWrites: true,
    producerQueue: { maxBytes: 65536, maxOperations: 1 },
    audio: { sampleRate: 48000, channels: 1 },
    outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
  })
  const audio = new AudioCapture({
      simulate: true,
      sampleRate: 48000,
      channels: 1,
      blockFrames: 480,
    }),
    recording = camera.startRecording(recorder, { audio })
  try {
    await until(() => sink.frames.filter((f) => !f.audio).length >= 4)
    await recording.close()
    expect(recording.error).toBeUndefined()
    expect(sink.frames.filter((f) => f.audio).length).toBeGreaterThanOrEqual(16)
    expect(recorder.producerStats().highJobs).toBe(1n)
    expect(recorder.producerStats().ownedJobs).toBe(0n)
    expect(recorder.hostIOStats().rejectedOperations).toBe(0n)
    const video = sink.frames.filter((f) => !f.audio)
    expect(video.map((f) => f.timestampNs)).toEqual(
      video.map((_, i) => BigInt(i) * 40_000_000n),
    )
  } finally {
    await recording.close()
    await camera.close()
  }
})
test('delayed CircularOutput2 async split retires PTS predecessor hooks while the producer writes a multi-frame tail', async () => {
  const camera = cam(),
    bytes: Uint8Array[] = []
  const pts = await PtsStream.open({
    write(data) {
      bytes.push(data.slice())
      return data.length
    },
  })
  const recorder = new CircularOutput2({
    width: 32,
    height: 24,
    fps: 25,
    pts,
    bufferDurationMs: 200,
    circular: { maxBytes: 1024 * 1024, maxFrames: 16 },
    outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
  })
  const old = new Sink(),
    next = new Sink(),
    stopGate = deferred()
  let stopping = false
  old.stop = async () => {
    stopping = true
    await stopGate.promise
    old.stops++
  }
  old.gate.release()
  next.gate.release()
  try {
    await recorder.openOutput(old)
    for (let i = 0; i < 8; i++) await submit(camera, recorder, i)
    const split = recorder.split(next)
    await until(() => split.status.staged)
    // A large source-clock jump matures several frames inside one native job.
    const writing = submit(camera, recorder, 30)
    await until(() => stopping)
    expect(recorder.producerStats().running).toBe(true)
    expect(recorder.hostIOStats().generation).toBe(1n)
    const capacity = recorder.waitForOutput(0, { timeoutMs: 1000 })
    stopGate.release()
    await writing
    await split
    await capacity
    split.close()
    await recorder.close()
    await pts.close()
    expect(old.frames.length + next.frames.length).toBe(9)
    expect(old.stops).toBe(1)
    expect(next.stops).toBe(1)
    expect(recorder.hostIOStats().rejectedOperations).toBe(0n)
    expect(Buffer.concat(bytes).toString()).toBe(
      '0.000\n40.000\n80.000\n120.000\n160.000\n200.000\n240.000\n280.000\n1200.000\n',
    )
  } finally {
    stopGate.release()
    await recorder.close()
    await pts.close()
    await camera.close()
  }
})

const mediaTest =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  mediaTest(
    `${codec} async A/V writes, split and EOF preserve exact decoded samples under partial host writes`,
    async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'),
        { tmpdir } = await import('node:os'),
        { join } = await import('node:path'),
        { MuxedOutput } = await import('../../ts'),
        { mp4, decodeAudio, decodeVideo } = await import('./media')
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
      const dir = mkdtempSync(join(tmpdir(), 'zc-producer-media-')),
        camera = new Camera({
          simulate: true,
          width: 128,
          height: 96,
          fifo: true,
        }),
        a = new Bytes(),
        b = new Bytes(),
        sequences: bigint[] = [],
        recorder = await Recorder.open(new MuxedOutput(a), {
          width: 128,
          height: 96,
          fps: 25,
          codec,
          gop: 4,
          audio: { sampleRate: 48000, channels: 2 },
          outputQueue: {
            maxBytes: 1024 * 1024,
            maxOperations: 8,
            waitMs: 1000,
          },
        })
      try {
        camera.start()
        let split: ReturnType<Recorder['split']> | undefined
        for (let i = 0; i < 16; i++) {
          if (i === 6) {
            split = recorder.split(new MuxedOutput(b))
            await until(() => split!.status.staged)
          }
          const pcm = new Uint8Array(1920 * 4),
            view = new DataView(pcm.buffer)
          for (let sample = 0; sample < 1920; sample++) {
            const value = (((i * 1920 + sample) % 200) - 100) * 100
            view.setInt16(sample * 4, value, true)
            view.setInt16(sample * 4 + 2, -value, true)
          }
          using frame = camera.acquire()
          sequences.push(frame.sequence)
          const job = recorder.writeAVAsync(
            frame,
            [{ data: pcm, timestampNs: BigInt(i) * 40_000_000n }],
            BigInt(i) * 40_000_000n,
          )
          frame.release()
          pcm.fill(0) // Producer already owns its PCM, including during backpressure.
          await job
        }
        await split
        split!.close()
        await recorder.close()
        let first = 0
        for (const [index, bytes] of [a, b].entries()) {
          const path = join(dir, `${index}.mp4`)
          writeFileSync(path, bytes.data)
          const tracks = mp4(path),
            video = tracks.get(1)!,
            audio = tracks.get(2)!
          decodeVideo(
            path,
            video,
            sequences.slice(first, first + video.samples.length),
          )
          decodeAudio(path, audio, first * 1920, video.samples.length * 1920)
          first += video.samples.length
        }
        expect(first).toBe(16)
        expect(recorder.hostIOStats().rejectedOperations).toBe(0n)
        expect(recorder.producerStats().ownedBytes).toBe(0n)
      } finally {
        await recorder.close()
        await camera.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
}
test('camera close joins an active automatic producer after returning every camera lease', async () => {
  const camera = cam(),
    sink = new Sink(),
    recorder = await Recorder.open(sink, {
      width: 32,
      height: 24,
      asyncWrites: true,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
    })
  const recording = camera.startRecording(recorder)
  try {
    await until(() => recorder.hostIOStats().blockedWaits === 1n)
    expect(camera.stats().leased).toBe(0)
    const closed = camera.close()
    await pause(5)
    sink.gate.release()
    await closed
    expect(recording.error).toBeUndefined()
    expect(recorder.producerStats().ownedJobs).toBe(0n)
    expect(sink.stops).toBe(1)
  } finally {
    sink.gate.release()
    await recording.close()
    await camera.close()
  }
})
test('native path preparation waits cooperate with exclusive async producer turns', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { mkvFrames } = await import('./media'),
    dir = mkdtempSync(join(tmpdir(), 'zc-producer-native-split-')),
    camera = cam(),
    first = join(dir, 'a.mkv'),
    second = join(dir, 'b.mkv'),
    recorder = new Recorder(first, { width: 32, height: 24, fps: 25 })
  try {
    await submit(camera, recorder, 0)
    const split = recorder.split(second),
      waiting = split.wait()
    for (let i = 1; i < 8; i++) await submit(camera, recorder, i)
    await waiting
    split.close()
    await recorder.close()
    expect(mkvFrames(first).length + mkvFrames(second).length).toBe(8)
  } finally {
    await recorder.close()
    await camera.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('invalid producer limits fail before an existing recording path is touched', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } =
      await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    dir = mkdtempSync(join(tmpdir(), 'zc-producer-limits-')),
    path = join(dir, 'record.mkv')
  try {
    writeFileSync(path, 'preserved')
    for (const limits of [
      { maxBytes: 0, maxOperations: 1 },
      { maxBytes: 1024, maxOperations: 0 },
      { maxBytes: 1024, maxOperations: 9 },
    ]) {
      expect(
        () =>
          new Recorder(path, { width: 32, height: 24, producerQueue: limits }),
      ).toThrow(RangeError)
      expect(readFileSync(path, 'utf8')).toBe('preserved')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('retiring host descriptors reject aliases until their asynchronous stop fence completes', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { FileOutput } = await import('../../ts'),
    dir = mkdtempSync(join(tmpdir(), 'zc-producer-retire-')),
    path = join(dir, 'old.mjpg'),
    old = new FileOutput(path),
    next = new Sink(),
    gate = deferred(),
    camera = cam(),
    recorder = await Recorder.open(old, { width: 32, height: 24 })
  next.gate.release()
  const original = old.stop.bind(old)
  let stopping = false
  old.stop = async (reason) => {
    stopping = true
    await gate.promise
    await original(reason)
  }
  try {
    await submit(camera, recorder, 0)
    const split = recorder.split(next)
    await until(() => split.status.staged)
    await submit(camera, recorder, 1)
    await until(() => stopping)
    const before = readFileSync(path)
    await expect(
      Promise.resolve(
        recorder.addOutput(new FileOutput(path, { exclusive: false })),
      ),
    ).rejects.toBeInstanceOf(CameraError)
    expect(() => recorder.addOutput(path)).toThrow(CameraError)
    expect(readFileSync(path)).toEqual(before)
    gate.release()
    await split
    split.close()
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('active cancellation keeps input and owner until entered output completes, then recording continues', async () => {
  const camera = cam(),
    sink = new Sink()
  const recorder = await Recorder.open(sink, {
    width: 32,
    height: 24,
    outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
  })
  try {
    await submit(camera, recorder, 0)
    await until(() => sink.entered)
    const active = submit(camera, recorder, 1)
    await until(() => recorder.hostIOStats().blockedWaits === 1n)
    const reason = new Error('user stopped this frame')
    expect(active.cancel(reason)).toBe(true)
    expect(active.cancel()).toBe(false)
    const drain = recorder.drainProducersAsync()
    await pause(5)
    expect(active.done).toBe(false)
    expect(drain.done).toBe(false)
    expect(recorder.producerStats().ownedBytes).toBe(2304n)
    expect(() => recorder.stats()).toThrow(CameraError)
    sink.gate.release()
    await expect(Promise.resolve(active)).rejects.toBe(reason)
    await drain
    expect(recorder.producerStats().ownedJobs).toBe(0n)
    expect(active.cancel()).toBe(false)
    await submit(camera, recorder, 2)
    await recorder.drain()
    expect(sink.frames.map((f) => f.timestampNs)).toEqual([
      0n,
      40_000_000n,
      80_000_000n,
    ])
    expect(recorder.producerStats().cancelled).toBe(1n)
    expect(recorder.producerStats().failed).toBe(0n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})

test('producer drain captures a cleanup prefix and excludes later blocked writes', async () => {
  const camera = cam(),
    sink = new Sink()
  const recorder = await Recorder.open(sink, {
    width: 32,
    height: 24,
    outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
  })
  const firstGate = sink.gate,
    secondGate = deferred()
  try {
    await submit(camera, recorder, 0)
    await until(() => sink.entered)
    const second = submit(camera, recorder, 1)
    await until(() => recorder.hostIOStats().blockedWaits === 1n)
    const prefix = recorder.drainProducersAsync()
    const third = submit(camera, recorder, 2)
    sink.gate = secondGate
    firstGate.release()
    await second
    await prefix
    await until(() => recorder.hostIOStats().blockedWaits === 2n)
    expect(third.done).toBe(false)
    const cancelled = recorder.drainProducersAsync()
    expect(cancelled.cancel()).toBe(true)
    await expect(Promise.resolve(cancelled)).rejects.toBeInstanceOf(
      JobCancelledError,
    )
    const deadline = recorder.drainProducersAsync({ timeoutMs: 5 })
    await expect(Promise.resolve(deadline)).rejects.toMatchObject({ code: -3 })
    expect(third.cancelRequested).toBe(false)
    secondGate.release()
    await third
    await recorder.drainProducersAsync()
    await recorder.drain()
    expect(sink.frames.length).toBe(3)
  } finally {
    firstGate.release()
    secondGate.release()
    await recorder.close()
    await camera.close()
  }
})

for (const mode of ['signal', 'deadline'] as const) {
  test(`active producer ${mode} waits for native cleanup before rejection`, async () => {
    const camera = cam(),
      sink = new Sink(),
      controller = new AbortController()
    const recorder = await Recorder.open(sink, {
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
    })
    try {
      await submit(camera, recorder, 0)
      await until(() => sink.entered)
      using frame = camera.acquire()
      const active = recorder.writeAsync(
        frame,
        40_000_000n,
        mode === 'signal' ? { signal: controller.signal } : { timeoutMs: 30 },
      )
      frame.release()
      await until(() => recorder.hostIOStats().blockedWaits === 1n)
      if (mode === 'signal') controller.abort(new Error('abort frame'))
      await until(() => active.cancelRequested)
      expect(active.done).toBe(false)
      expect(camera.stats().leased).toBe(0)
      sink.gate.release()
      if (mode === 'signal')
        await expect(Promise.resolve(active)).rejects.toBe(
          controller.signal.reason,
        )
      else
        await expect(Promise.resolve(active)).rejects.toMatchObject({
          code: -3,
        })
      await recorder.drainProducersAsync()
      expect(recorder.producerStats().ownedJobs).toBe(0n)
    } finally {
      sink.gate.release()
      await recorder.close()
      await camera.close()
    }
  })
}

for (const codec of ['h264', 'hevc'] as const) {
  mediaTest(
    `${codec} active cancellation completes MP4/AAC operations and preserves later recording`,
    async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { MuxedOutput } = await import('../../ts')
      const { mp4, decodeAudio, decodeVideo } = await import('./media')
      const gate = deferred()
      let hold = false,
        entered = false,
        data = Buffer.alloc(0)
      const bytes = {
        async write(value: Uint8Array) {
          if (hold) {
            entered = true
            await gate.promise
          }
          data = Buffer.concat([data, Buffer.from(value)])
          return value.length
        },
        async patch(offset: bigint, value: Uint8Array) {
          if (hold) {
            entered = true
            await gate.promise
          }
          Buffer.from(value).copy(data, Number(offset))
          return value.length
        },
      }
      const dir = mkdtempSync(join(tmpdir(), 'zc-cancel-mp4-'))
      const camera = new Camera({
        simulate: true,
        width: 128,
        height: 96,
        fifo: true,
      })
      const recorder = await Recorder.open(new MuxedOutput(bytes), {
        width: 128,
        height: 96,
        fps: 25,
        codec,
        gop: 4,
        audio: { sampleRate: 48000, channels: 2 },
        outputQueue: { maxBytes: 1024 * 1024, maxOperations: 1, waitMs: 1000 },
      })
      const sequences: bigint[] = []
      try {
        camera.start()
        for (let i = 0; i < 12; i++) {
          const pcm = new Uint8Array(1920 * 4),
            view = new DataView(pcm.buffer)
          for (let sample = 0; sample < 1920; sample++) {
            const value = (((i * 1920 + sample) % 200) - 100) * 100
            view.setInt16(sample * 4, value, true)
            view.setInt16(sample * 4 + 2, -value, true)
          }
          if (i === 4) hold = true
          using frame = camera.acquire()
          sequences.push(frame.sequence)
          const job = recorder.writeAVAsync(
            frame,
            [{ data: pcm, timestampNs: BigInt(i) * 40_000_000n }],
            BigInt(i) * 40_000_000n,
          )
          frame.release()
          if (i === 4) {
            await until(
              () => entered && recorder.hostIOStats().pendingWaits > 0n,
            )
            expect(job.cancel()).toBe(true)
            expect(job.done).toBe(false)
            gate.release()
            await expect(Promise.resolve(job)).rejects.toBeInstanceOf(
              JobCancelledError,
            )
          } else await job
        }
        await recorder.drainProducersAsync()
        await recorder.close()
        const path = join(dir, 'cancel.mp4')
        writeFileSync(path, data)
        const tracks = mp4(path),
          video = tracks.get(1)!,
          audio = tracks.get(2)!
        expect(video.samples.length).toBe(12)
        decodeVideo(path, video, sequences)
        decodeAudio(path, audio, 0, 12 * 1920)
        expect(recorder.producerStats().cancelled).toBe(1n)
        expect(recorder.producerStats().failed).toBe(0n)
        expect(recorder.hostIOStats().rejectedOperations).toBe(0n)
      } finally {
        gate.release()
        await recorder.close()
        await camera.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
}
