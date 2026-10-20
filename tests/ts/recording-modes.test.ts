import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  Recording,
  AudioCapture,
  MuxedOutput,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
  type OutputStreams,
} from '../../ts'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, decodeVideo, decodeAudio } from './media'
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function until(fn: () => boolean) {
  const deadline = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > deadline) throw Error('timeout')
    await pause()
  }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
function failed(job: PromiseLike<unknown>) {
  return Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
}
class Sink implements CustomOutput {
  metadata?: OutputStreams
  packets: OutputPacket[] = []
  stopped = 0
  discarded = false
  streams(info: OutputStreams) {
    this.metadata = info
  }
  outputframe(packet: OutputPacket) {
    this.packets.push(packet)
  }
  stop(reason?: { discard: boolean }) {
    this.stopped++
    this.discarded = !!reason?.discard
  }
}
const camera = () =>
  new Camera({ simulate: true, width: 32, height: 24, fifo: true })
const options = {
  width: 32,
  height: 24,
  fps: 25,
  producerQueue: { maxBytes: 1024 ** 2, maxOperations: 8 },
  outputQueue: { maxBytes: 1024 ** 2, maxOperations: 16, waitMs: 1000 },
}
const mode = { width: 64, height: 48, role: 'video' as const, fifo: true }
async function prepare() {
  const c = camera(),
    old = new Sink(),
    r = await Recorder.open(old, options)
  return { c, old, r }
}

test('active A/V pump changes camera, recorder, lores and audio together and safely retires the previous pump', async () => {
  const c = camera(),
    old = new Sink(),
    next = new Sink()
  const r = await Recorder.open(old, {
    ...options,
    audio: { sampleRate: 48000, channels: 2 },
  })
  const audio = new AudioCapture({
    simulate: true,
    sampleRate: 44100,
    channels: 1,
    blockFrames: 441,
  })
  let first: Recording | undefined, second: Recording | undefined
  try {
    first = c.startRecording(r, {
      audio: new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 2,
        blockFrames: 480,
      }),
    })
    await until(() => first!.frames >= 3)
    const target = { ...mode, lores: { width: 18, height: 10 } }
    const job = first.switchModeAsync(
      target,
      {
        fps: 20,
        quality: 65,
        audio: { sampleRate: 44100, channels: 1, bufferFrames: 44100 },
      },
      next,
      { audio, dropFrames: 2 },
    )
    target.lores.width = 20
    second = await job
    expect(second).toBeInstanceOf(Recording)
    expect(job.cancel()).toBe(false)
    expect(c.info()).toMatchObject({ width: 64, height: 48 })
    expect(c.options.lores?.width).toBe(18)
    expect(r.options).toMatchObject({
      width: 64,
      height: 48,
      fps: 20,
      quality: 65,
      audio: { sampleRate: 44100, channels: 1 },
    })
    expect(next.metadata).toMatchObject({
      width: 64,
      height: 48,
      fps: 20,
      audio: { sampleRate: 44100, channels: 1 },
    })
    const oldCount = old.packets.length
    await first.close()
    await until(() => second!.frames >= 3)
    await second.flushAsync()
    expect(old.packets.length).toBe(oldCount)
    expect(old.stopped).toBe(1)
    expect(next.packets.some((p) => p.audio)).toBe(true)
    expect(next.packets.filter((p) => !p.audio)[0].timestampNs).toBe(0n)
    expect(c.stats().leased).toBe(0)
    expect(r.sessionState()).toMatchObject({ id: 1n, phase: 'flushed' })
  } finally {
    await first?.close()
    await second?.close()
    audio.close()
    await c.close()
    await r.close()
  }
})

test('held candidate setup reserves both objects and cancellation restores the old mode and flushed recorder', async () => {
  const { c, old, r } = await prepare(),
    next = new Sink(),
    entered = gate(),
    hold = gate(),
    peer = camera()
  let recording: Recording | undefined
  const output: CustomOutput = {
    streams: async (info) => {
      next.streams(info)
      entered.release()
      await hold.promise
    },
    outputframe: (p) => next.outputframe(p),
    stop: (reason) => next.stop(reason),
  }
  try {
    c.start()
    using f = c.acquire()
    await r.writeAsync(f, 0n)
    f.release()
    const before = r.options
    const job = c.switchRecordingModeAsync(r, mode, { quality: 35 }, output)
    const result = failed(job)
    await entered.promise
    expect(next.metadata?.width).toBe(64)
    expect(r.options).toBe(before)
    expect(() => c.acquire()).toThrow()
    expect(() => c.switchMode(mode)).toThrow()
    expect(() => c.capture((f) => f.copyRGB())).toThrow()
    expect(() => r.reconfigureAsync({ quality: 70 })).toThrow()
    expect(() => r.flushAsync()).toThrow()
    expect(() => peer.startRecording(r)).toThrow()
    expect(job.cancel()).toBe(true)
    let settled = false
    void job.operationDone.then(() => {
      settled = true
    })
    await pause()
    expect(settled).toBe(false)
    hold.release()
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(next.discarded).toBe(true)
    expect(c.info().width).toBe(32)
    expect(r.options).toBe(before)
    expect(r.sessionState()).toMatchObject({ id: 0n, phase: 'flushed' })
    expect(old.stopped).toBe(0)
    expect(c.stats().leased).toBe(0)
    recording = await c.switchRecordingModeAsync(r, mode, {}, new Sink())
    await until(() => recording!.frames >= 2)
    await recording.flushAsync()
    expect(r.sessionState().id).toBe(1n)
  } finally {
    hold.release()
    await recording?.close()
    await peer.close()
    await c.close()
    await r.close()
  }
})

test('lease rejection and queued cancellation leave the current live recording intact', async () => {
  const { c, r } = await prepare()
  let recording: Recording | undefined
  try {
    recording = c.startRecording(r)
    await until(() => recording!.frames >= 2)
    using leased = c.acquire()
    expect(
      await failed(recording.switchModeAsync(mode, {}, new Sink())),
    ).toMatchObject({ code: -4 })
    expect(leased.copyRGB().length).toBe(32 * 24 * 3)
    expect(r.sessionState().phase).toBe('open')
    leased.release()
    const count = recording.frames
    const cancelled = recording.switchModeAsync(mode, {}, new Sink())
    const result = failed(cancelled)
    expect(cancelled.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    await cancelled.operationDone
    expect(c.info().width).toBe(32)
    expect(r.sessionState().phase).toBe('open')
    await until(() => recording!.frames > count)
    await recording.flushAsync()
  } finally {
    await recording?.close()
    await c.close()
    await r.close()
  }
})

test('invalid media rejects before flush; failed camera negotiation and hooks restore a stopped camera', async () => {
  const { c, r } = await prepare()
  try {
    expect(() => c.switchRecordingModeAsync(r, mode, { width: 32 })).toThrow()
    expect(() => c.switchRecordingModeAsync(r, mode, { quality: 0 })).toThrow()
    expect(r.sessionState().phase).toBe('open')
    const badCamera = {
      ...mode,
      sensor: { width: 123, height: 456, bitDepth: 7 },
    }
    expect(
      await failed(c.switchRecordingModeAsync(r, badCamera, {}, new Sink())),
    ).toBeInstanceOf(Error)
    expect(c.info().width).toBe(32)
    expect(() => c.acquire()).toThrow()
    expect(r.sessionState()).toMatchObject({ id: 0n, phase: 'flushed' })
    const bad: CustomOutput = {
      streams() {
        throw Error('candidate stream setup')
      },
      outputframe() {},
    }
    expect(
      await failed(c.switchRecordingModeAsync(r, mode, {}, bad)),
    ).toMatchObject({ message: 'candidate stream setup' })
    expect(c.info().width).toBe(32)
    expect(() => c.acquire()).toThrow()
    expect(r.width).toBe(32)
    c.start()
    using frame = c.acquire()
    expect(frame.width).toBe(32)
  } finally {
    await c.close()
    await r.close()
  }
})

for (const owner of ['camera', 'recorder'] as const) {
  test(`${owner} close cancels a coordinated switch, joins setup and releases both owners`, async () => {
    const { c, r } = await prepare(),
      entered = gate(),
      hold = gate(),
      next = new Sink()
    const audio = new AudioCapture({ simulate: true })
    let recording: Recording | undefined
    const output: CustomOutput = {
      commit: async () => {
        entered.release()
        await hold.promise
      },
      outputframe: (p) => next.outputframe(p),
      stop: (reason) => next.stop(reason),
    }
    try {
      recording = c.startRecording(r)
      await until(() => recording!.frames >= 2)
      const job = recording.switchModeAsync(
        mode,
        { audio: { sampleRate: 48000, channels: 1 } },
        output,
        { audio },
      )
      const result = failed(job)
      await entered.promise
      let done = false
      const close = (owner === 'camera' ? c.close() : r.close()).then(() => {
        done = true
      })
      await pause()
      expect(done).toBe(false)
      hold.release()
      expect(await result).toBeInstanceOf(Error)
      await close
      expect(next.discarded).toBe(true)
      expect(Number(r.handle)).toBe(0)
      if (owner === 'camera') expect(Number(c.handle)).toBe(0)
      else {
        expect(c.info().width).toBe(32)
        expect(c.stats().leased).toBe(0)
      }
      expect(audio.handle).not.toBe(0)
    } finally {
      hold.release()
      audio.close()
      await recording?.close()
      await c.close()
      await r.close()
    }
  })
}

test('post-publication stop failure exposes a usable matching recording instead of rolling the camera back', async () => {
  const c = camera(),
    next = new Sink()
  const r = await Recorder.open(
    {
      outputframe() {},
      stop() {
        throw Error('retired session stop')
      },
    },
    options,
  )
  let recording: Recording | undefined
  try {
    const error = await failed(c.switchRecordingModeAsync(r, mode, {}, next))
    expect(error.message).toBe('retired session stop')
    recording = error.recording
    expect(recording).toBeInstanceOf(Recording)
    expect(c.info().width).toBe(r.width)
    expect(r.sessionState().id).toBe(1n)
    await until(() => recording!.frames >= 2)
    await recording!.flushAsync()
    expect(next.packets.filter((p) => !p.audio).length).toBeGreaterThanOrEqual(
      2,
    )
  } finally {
    await recording?.close()
    await c.close()
    await r.close()
  }
})

test('coordinated job deadlines and signal callbacks release reservations before re-entry', async () => {
  const { c, r } = await prepare()
  let callbackWidth = 0
  try {
    const aborted = new AbortController()
    aborted.abort(new Error('abort before mode'))
    const job = c.switchRecordingModeAsync(r, mode, {}, new Sink(), {
      signal: aborted.signal,
      signalFunction() {
        callbackWidth = c.info().width
      },
    })
    expect(await failed(job)).toMatchObject({ message: 'abort before mode' })
    await job.cleanupDone
    expect(callbackWidth).toBe(32)
    expect(r.sessionState().phase).toBe('open')
    const timeout = c.switchRecordingModeAsync(r, mode, {}, new Sink(), {
      timeoutMs: 0,
    })
    expect(await failed(timeout)).toMatchObject({ code: -3 })
    await timeout.operationDone
    expect(c.info().width).toBe(32)
  } finally {
    await c.close()
    await r.close()
  }
})

const previewTest = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
previewTest(
  'preview is recreated for coordinated modes and restored after failed output setup',
  async () => {
    const { c, r } = await prepare()
    let recording: Recording | undefined
    try {
      c.startPreview('coordinated preview')
      const bad: CustomOutput = {
        start() {
          throw Error('preview rollback')
        },
        outputframe() {},
      }
      expect(
        await failed(c.switchRecordingModeAsync(r, mode, {}, bad)),
      ).toMatchObject({ message: 'preview rollback' })
      expect(c.info().width).toBe(32)
      await c.capture((frame) => expect(frame.width).toBe(32))
      recording = await c.switchRecordingModeAsync(r, mode, {}, new Sink())
      await until(() => recording!.frames >= 2)
      await recording.flushAsync()
      expect(c.info().width).toBe(64)
      expect(c.stats().leased).toBe(0)
    } finally {
      await recording?.close()
      await c.close()
      await r.close()
    }
  },
)

const mediaTest =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
for (const codec of ['h264', 'hevc'] as const)
  mediaTest(
    `${codec} coordinated A/V mode resumes fresh MP4 with exact decoded video and AAC samples`,
    async () => {
      const { c, r } = await prepare(),
        dir = mkdtempSync(join(tmpdir(), 'zc-joint-mode-'))
      const path = join(dir, 'next.mp4')
      let recording: Recording | undefined
      const audio = new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 2,
        blockFrames: 480,
      })
      try {
        const before = c.startRecording(r)
        await until(() => before.frames >= 3)
        recording = await before.switchModeAsync(
          { width: 128, height: 96, fifo: true, role: 'video' },
          {
            codec,
            fps: 25,
            gop: 3,
            quality: 90,
            audio: { sampleRate: 48000, channels: 2, bitrate: 128000 },
          },
          new MuxedOutput(path),
          { audio, dropFrames: 2 },
        )
        await until(() => recording!.frames >= 9)
        await recording.flushAsync()
        await before.close()
        const tracks = mp4(path),
          video = tracks.get(1)!,
          sound = tracks.get(2)!
        const count = recording.frames
        expect(video.samples.length).toBe(count)
        expect(video.keys[0]).toBe(true)
        decodeVideo(
          path,
          video,
          Array.from({ length: count }, (_, i) => BigInt(i + 2)),
        )
        expect(sound.rate).toBe(48000)
        decodeAudio(path, sound, 0, count * 1920)
        expect(r.width).toBe(128)
        expect(c.stats().leased).toBe(0)
      } finally {
        await recording?.close()
        audio.close()
        await c.close()
        await r.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )

test('cancellation during camera warmup restores mode before releasing ownership', async () => {
  const { c, r } = await prepare()
  try {
    c.start()
    const job = c.switchRecordingModeAsync(r, mode, {}, new Sink(), {
      dropFrames: 1_000_000,
    })
    const result = failed(job)
    await until(() => job.progress >= 3)
    expect(job.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(c.info().width).toBe(32)
    expect(r.width).toBe(32)
    expect(r.sessionState().id).toBe(0n)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    await r.close()
  }
})

test('candidate audio remains caller-owned and a closed source rejects before publication', async () => {
  const { c, r } = await prepare(),
    entered = gate(),
    hold = gate()
  const audio = new AudioCapture({
    simulate: true,
    sampleRate: 48000,
    channels: 1,
  })
  const next = new Sink()
  try {
    const output: CustomOutput = {
      commit: async () => {
        entered.release()
        await hold.promise
      },
      outputframe: (p) => next.outputframe(p),
      stop: (reason) => next.stop(reason),
    }
    const job = c.switchRecordingModeAsync(
      r,
      mode,
      { audio: { sampleRate: 48000, channels: 1 } },
      output,
      { audio },
    )
    const result = failed(job)
    await entered.promise
    audio.close()
    hold.release()
    expect(await result).toMatchObject({ code: -2 })
    expect(next.discarded).toBe(true)
    expect(c.info().width).toBe(32)
    expect(r.options.audio).toBeUndefined()
    expect(r.sessionState().id).toBe(0n)
  } finally {
    hold.release()
    audio.close()
    await c.close()
    await r.close()
  }
})

test('a recorder attached to another camera rejects coordinated and ordinary recording admission', async () => {
  const { c, r } = await prepare(),
    other = camera()
  let recording: Recording | undefined
  try {
    recording = c.startRecording(r)
    expect(() => other.startRecording(r)).toThrow('already attached')
    expect(() =>
      other.switchRecordingModeAsync(r, mode, {}, new Sink()),
    ).toThrow()
    await until(() => recording!.frames >= 2)
    expect(r.sessionState().phase).toBe('open')
    await recording.flushAsync()
  } finally {
    await recording?.close()
    await other.close()
    await c.close()
    await r.close()
  }
})

for (const owner of ['camera', 'recorder'] as const)
  test(`${owner} close joins a published switch without permitting cancellation or mismatched rollback`, async () => {
    const c = camera(),
      entered = gate(),
      hold = gate()
    const r = await Recorder.open(
      {
        outputframe() {},
        stop: async () => {
          entered.release()
          await hold.promise
        },
      },
      options,
    )
    let recording: Recording | undefined
    try {
      recording = c.startRecording(r)
      await until(() => recording!.frames >= 2)
      const job = recording.switchModeAsync(mode, {}, new Sink())
      const result = failed(job)
      await entered.promise
      expect(job.cancel()).toBe(false)
      let done = false
      const close = (owner === 'camera' ? c.close() : r.close()).then(() => {
        done = true
      })
      await pause()
      expect(done).toBe(false)
      hold.release()
      expect(await result).toMatchObject({ code: -2 })
      await close
      expect(Number(r.handle)).toBe(0)
      if (owner === 'camera') expect(Number(c.handle)).toBe(0)
      else expect(c.info().width).toBe(64)
    } finally {
      hold.release()
      await recording?.close()
      await c.close()
      await r.close()
    }
  })

test('exclusive path failure restores the camera and preserves existing bytes before a successful retry', async () => {
  const { c, r } = await prepare(),
    dir = mkdtempSync(join(tmpdir(), 'zc-mode-path-'))
  let recording: Recording | undefined
  try {
    const existing = join(dir, 'existing.mkv')
    writeFileSync(existing, 'keep')
    expect(
      await failed(c.switchRecordingModeAsync(r, mode, {}, existing)),
    ).toBeInstanceOf(Error)
    expect(c.info().width).toBe(32)
    expect(readFileSync(existing, 'utf8')).toBe('keep')
    expect(r.sessionState().id).toBe(0n)
    const path = join(dir, 'fresh.mkv')
    recording = await c.switchRecordingModeAsync(r, mode, {}, path)
    await until(() => recording!.frames >= 2)
    await recording.flushAsync()
    expect(readFileSync(path).readUInt32BE()).toBe(0x1a45dfa3)
    expect(c.info().width).toBe(64)
  } finally {
    await recording?.close()
    await c.close()
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('completed coordinated callbacks retain bounded camera admission but release native ownership', async () => {
  const { c, r } = await prepare(),
    hold = gate(),
    jobs: ReturnType<Camera['switchRecordingModeAsync']>[] = []
  try {
    for (let i = 0; i < 32; i++) {
      const job = c.switchRecordingModeAsync(r, mode, {}, new Sink(), {
        timeoutMs: 0,
        signalFunction: () => hold.promise,
      })
      jobs.push(job)
      await job.operationDone
    }
    expect(() => c.switchRecordingModeAsync(r, mode, {}, new Sink())).toThrow(
      'mode queue',
    )
    expect(c.info().width).toBe(32)
    expect(r.sessionState().phase).toBe('open')
    hold.release()
    await Promise.all(jobs.map((j) => j.cleanupDone))
    expect(c.info().width).toBe(32)
  } finally {
    hold.release()
    await c.close()
    await r.close()
  }
})

test('worker fault during coordinated close invalidates ownership and never closes a null handle', async () => {
  const { c, r } = await prepare(),
    original = c.handle
  const RealWorker = globalThis.Worker
  let fault: (() => void) | undefined
  // This fake never enters native code; only the test still owns original.
  const WorkerWithFault = function (
    url: string | URL,
    options?: WorkerOptions,
  ) {
    if (!String(url).endsWith('/mode-worker.ts'))
      return new RealWorker(url, options)
    return {
      onmessage: undefined,
      onerror: undefined as ((error: { message: string }) => void) | undefined,
      postMessage() {
        fault = () => this.onerror?.({ message: 'mode worker ownership fault' })
      },
      terminate() {},
    }
  } as unknown as typeof Worker
  globalThis.Worker = WorkerWithFault
  try {
    c.start()
    const job = c.switchRecordingModeAsync(r, mode, {}, new Sink())
    const result = failed(job)
    await until(() => !!fault)
    const close = c.close()
    fault!()
    expect(await result).toMatchObject({
      message: 'mode worker ownership fault',
    })
    await close
    expect(Number(c.handle)).toBe(0)
    expect(r.sessionState().phase).toBe('flushed')
  } finally {
    globalThis.Worker = RealWorker
    const { native } = await import('../../ts/ffi')
    expect(native.zc_stop(original)).toBe(0)
    expect(native.zc_close(original)).toBe(0)
    await r.close()
  }
})
