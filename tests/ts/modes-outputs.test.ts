import { test, expect, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  linkSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Camera,
  Recorder,
  FileOutput,
  MuxedOutput,
  CameraError,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
import { mkvFrames, mp4, decodeVideo, decodeAudio } from './media'
function expectJob(value: PromiseLike<unknown>) {
  return expect(Promise.resolve(value))
}
const dirs: string[] = []
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'zig-camera-objects-'))
  dirs.push(path)
  return path
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const pause = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition timeout')
    await pause()
  }
}
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function cam(width = 32, height = 24) {
  return new Camera({ simulate: true, width, height, fifo: true })
}
function code(operation: () => unknown, status: number) {
  try {
    operation()
    throw new Error('unexpected success')
  } catch (error) {
    expect(error).toBeInstanceOf(CameraError)
    expect((error as CameraError).code).toBe(status)
  }
}
async function feed(camera: Camera, recorder: Recorder, index: number) {
  using frame = camera.acquire()
  recorder.write(frame, BigInt(index) * 40_000_000n)
  await pause()
  return frame.sequence
}
class Collector implements CustomOutput {
  packets: OutputPacket[] = []
  events: string[] = []
  start() {
    this.events.push('start')
  }
  streams() {
    this.events.push('streams')
  }
  outputframe(packet: OutputPacket) {
    this.packets.push(packet)
  }
  stop() {
    this.events.push('stop')
  }
}
class Bytes {
  data = Buffer.alloc(0)
  writes = 0
  write(bytes: Uint8Array) {
    const part = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 17)))
    this.data = Buffer.concat([this.data, part])
    this.writes++
    return part.length
  }
  patch(offset: bigint, bytes: Uint8Array) {
    const start = Number(offset)
    Buffer.from(bytes).copy(this.data, start)
    return bytes.length
  }
}
test('permanent mode jobs switch geometry and return negotiated configuration', async () => {
  const camera = cam()
  try {
    camera.start()
    const job = camera.switchMode(
      { width: 64, height: 48, role: 'video', fifo: true },
      { dropFrames: 2 },
    )
    const info = await job
    expect(info.width).toBe(64)
    expect(camera.options.role).toBe('video')
    expect(job.done).toBe(true)
    expect(job.cancel()).toBe(false)
    using frame = camera.acquire()
    expect(frame.width).toBe(64)
    expect(frame.sequence >= 2n).toBe(true)
  } finally {
    await camera.close()
  }
})
test('temporary RGB, metadata, lores and file jobs restore original running mode', async () => {
  const dir = root(),
    camera = cam()
  try {
    camera.start()
    const rgb = await camera.switchModeAndCaptureRGB(
      { width: 64, height: 48 },
      { dropFrames: 2 },
    )
    expect(rgb.length).toBe(64 * 48 * 3)
    expect(camera.info().width).toBe(32)
    const meta = await camera.switchModeAndCaptureMetadata({
      width: 48,
      height: 32,
    })
    expect(meta.exposureUs).toBeGreaterThan(0)
    const stream = await camera.switchModeAndCaptureBuffer(
      { width: 64, height: 48, lores: { width: 18, height: 10 } },
      'lores',
    )
    expect(stream.data.length).toBe(270)
    const file = join(dir, 'photo.dng')
    await camera.switchModeAndCaptureFile({ width: 64, height: 48 }, file)
    expect(readFileSync(file).readUInt16LE(2)).toBe(42)
    const jpeg = join(dir, 'photo.jpg')
    await camera.switchModeAndCaptureFile({ width: 64, height: 48 }, jpeg)
    expect(readFileSync(jpeg).readUInt16BE(0)).toBe(0xffd8)
    expect(camera.info().width).toBe(32)
    expect(camera.stats().leased).toBe(0)
    using frame = camera.acquire()
    expect(frame.width).toBe(32)
  } finally {
    await camera.close()
  }
})
test('failed configuration and capture restore prior camera without leaked leases', async () => {
  const camera = cam()
  try {
    camera.start()
    await expectJob(camera.switchMode({ width: 64 })).rejects.toBeInstanceOf(
      CameraError,
    )
    expect(camera.info().width).toBe(32)
    await expectJob(
      camera.switchModeAndCaptureFile(
        { width: 64, height: 48 },
        '/missing/parent/photo.jpg',
      ),
    ).rejects.toBeInstanceOf(CameraError)
    expect(camera.info().width).toBe(32)
    expect(camera.stats().leased).toBe(0)
    using frame = camera.acquire()
    expect(frame.width).toBe(32)
  } finally {
    await camera.close()
  }
})
test('mode jobs reject outstanding frame leases and active recording', async () => {
  const dir = root(),
    camera = cam(),
    recorder = new Recorder(join(dir, 'clip.mkv'), { width: 32, height: 24 })
  try {
    camera.start()
    using frame = camera.acquire()
    await expectJob(
      camera.switchMode({ width: 64, height: 48 }),
    ).rejects.toMatchObject({ code: -4 })
    expect(frame.copyRGB().length).toBe(2304)
    frame.release()
    const recording = camera.startRecording(recorder)
    code(() => camera.switchMode({ width: 64, height: 48 }), -4)
    await recording.close()
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('queued cancellation, deadlines, FIFO jobs and bounded admission', async () => {
  const camera = cam()
  try {
    const first = camera.switchMode({ width: 64, height: 48 })
    const cancelled = camera.switchMode({ width: 80, height: 48 })
    expect(cancelled.cancel()).toBe(true)
    await expectJob(cancelled).rejects.toBeInstanceOf(JobCancelledError)
    await first
    const jobs = Array.from({ length: 32 }, (_, i) =>
      camera.switchMode({ width: 32 + (i % 2) * 16, height: 24 }),
    )
    code(() => camera.switchMode({ width: 32, height: 24 }), -4)
    for (const job of jobs) job.cancel()
    await Promise.all(jobs.map((job) => job.wait().catch(() => {})))
    await expectJob(
      camera.switchMode({ width: 64, height: 48 }, { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: -3 })
    expect(camera.info().width).toBe(64)
  } finally {
    await camera.close()
  }
})
test('claimed mode cancellation rolls back and close waits for cleanup', async () => {
  const camera = cam()
  camera.start()
  const job = camera.switchModeAndCaptureRGB(
    { width: 64, height: 48 },
    { dropFrames: 1_000_000 },
  )
  await until(() => job.state === 'running')
  expect(job.cancel()).toBe(true)
  await expectJob(job).rejects.toBeInstanceOf(JobCancelledError)
  expect(camera.info().width).toBe(32)
  const pending = camera.switchModeAndCaptureRGB(
    { width: 80, height: 48 },
    { dropFrames: 1_000_000 },
  )
  await until(() => pending.state === 'running')
  await camera.close()
  expect(pending.done).toBe(true)
  expect(Number(camera.handle)).toBe(0)
})
test('mode configuration snapshots and callback errors preserve terminal results', async () => {
  const camera = cam()
  try {
    const options = { width: 64, height: 48 }
    const job = camera.switchMode(options, {
      signalFunction: () => {
        throw new Error('signal failed')
      },
    })
    options.width = 96
    expect((await job).width).toBe(64)
    await job.cleanupDone
    expect(String(job.callbackError)).toContain('signal failed')
    expect(job.cancel()).toBe(false)
  } finally {
    await camera.close()
  }
})
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview(
  'SDL preview is recreated across mode changes and temporary capture',
  async () => {
    const camera = cam()
    try {
      camera.startPreview()
      await camera.captureRGB()
      await camera.switchMode({ width: 64, height: 48 })
      expect((await camera.captureRGB()).length).toBe(64 * 48 * 3)
      await camera.switchModeAndCaptureRGB({ width: 80, height: 48 })
      expect((await camera.captureRGB()).length).toBe(64 * 48 * 3)
    } finally {
      await camera.close()
    }
  },
)
test('custom packet outputs receive owned bytes, streams and ordered lifecycle on Bun', async () => {
  const camera = cam(),
    output = new Collector()
  const recorder = await Recorder.open(output, {
    width: 32,
    height: 24,
    fps: 25,
  })
  try {
    camera.start()
    for (let i = 0; i < 5; i++) await feed(camera, recorder, i)
    await recorder.drain()
    expect(output.packets.length).toBe(5)
    const owned = output.packets[0].data.slice()
    await recorder.close()
    expect(output.events).toEqual(['start', 'streams', 'stop'])
    expect(output.packets[0].data).toEqual(owned)
    expect(output.packets.map((x) => x.timestampNs)).toEqual([
      0n,
      40_000_000n,
      80_000_000n,
      120_000_000n,
      160_000_000n,
    ])
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('muxed byte objects handle partial writes and native Home Matroska output', async () => {
  const dir = root(),
    camera = cam(),
    bytes = new Bytes()
  const recorder = await Recorder.open(new MuxedOutput(bytes, 'mkv'), {
    width: 32,
    height: 24,
    fps: 25,
  })
  try {
    camera.start()
    for (let i = 0; i < 5; i++) await feed(camera, recorder, i)
    await recorder.close()
    const path = join(dir, 'clip.mkv')
    writeFileSync(path, bytes.data)
    expect(mkvFrames(path).length).toBe(5)
    expect(bytes.writes).toBeGreaterThan(10)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('FileOutput writes elementary frames and exact Home PTS', async () => {
  const dir = root(),
    camera = cam(),
    path = join(dir, 'video.mjpg'),
    pts = join(dir, 'video.pts')
  const recorder = await Recorder.open(new FileOutput(path, { pts }), {
    width: 32,
    height: 24,
    fps: 25,
  })
  try {
    camera.start()
    for (let i = 0; i < 3; i++) await feed(camera, recorder, i)
    await recorder.close()
    expect(readFileSync(path).readUInt16BE()).toBe(0xffd8)
    expect(readFileSync(pts, 'utf8')).toBe('0.000\n40.000\n80.000\n')
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('custom object splits await old stop and preserve a live healthy sibling', async () => {
  const dir = root(),
    camera = cam(),
    old = new Collector(),
    next = new Collector(),
    gate = deferred()
  let stopping = false
  old.stop = async () => {
    stopping = true
    await gate.promise
    old.events.push('stop')
  }
  const recorder = await Recorder.open(old, { width: 32, height: 24, fps: 25 })
  let job: ReturnType<Recorder['split']> | undefined
  try {
    camera.start()
    recorder.addOutput(join(dir, 'sibling.mkv'))
    for (let i = 0; i < 3; i++) await feed(camera, recorder, i)
    job = recorder.split(next)
    for (let i = 3; i < 12; i++) {
      await feed(camera, recorder, i)
      if (stopping) break
    }
    await until(() => stopping)
    expect(job.status.done).toBe(false)
    expect(recorder.outputState().generation).toBe(1n)
    code(() => recorder.split(new Collector()), -4)
    gate.release()
    await job
    job.close()
    await recorder.close()
    expect(old.events.at(-1)).toBe('stop')
    expect(next.events.at(-1)).toBe('stop')
    expect(mkvFrames(join(dir, 'sibling.mkv')).length).toBe(
      old.packets.length + next.packets.length,
    )
  } finally {
    gate.release()
    if (job) {
      try {
        await job
        job.close()
      } catch {}
    }
    await recorder.close()
    await camera.close()
  }
})
test('blocked async startup leaves existing capture and outputs progressing', async () => {
  const dir = root(),
    camera = cam(),
    gate = deferred()
  const recorder = new Recorder(join(dir, 'primary.mkv'), {
    width: 32,
    height: 24,
    fps: 25,
  })
  const added = new Collector()
  let entered = false
  added.start = async () => {
    entered = true
    await gate.promise
  }
  try {
    const recording = camera.startRecording(recorder),
      job = recorder.addOutput(added)
    await until(() => entered)
    const before = recording.frames
    await until(() => recording.frames >= before + 5)
    expect(job.done).toBe(false)
    gate.release()
    const id = await job
    await until(() => added.packets.length >= 3)
    await recorder.removeOutput(id)
    await recording.close()
    expect(added.events.at(-1)).toBe('stop')
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('header delivery failure never publishes the replacement or poisons old output', async () => {
  const dir = root(),
    camera = cam(),
    old = new Collector(),
    failure = new Error('header failure')
  const recorder = await Recorder.open(old, { width: 32, height: 24, fps: 25 })
  try {
    camera.start()
    await feed(camera, recorder, 0)
    const job = recorder.split(
      new MuxedOutput(
        {
          write() {
            throw failure
          },
        },
        'mkv',
      ),
    )
    let observed: unknown
    try {
      await job.wait()
    } catch (error) {
      observed = error
    }
    expect(observed).toBe(failure)
    job.close()
    expect(recorder.outputState().generation).toBe(0n)
    await feed(camera, recorder, 1)
    await recorder.close()
    expect(old.packets.length).toBe(2)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('isolated async packet failure quarantines only the failing output', async () => {
  const dir = root(),
    camera = cam(),
    failure = new Error('sink failed'),
    bad = new Collector()
  bad.outputframe = async () => {
    await pause()
    throw failure
  }
  const recorder = new Recorder(join(dir, 'healthy.mkv'), {
    width: 32,
    height: 24,
    fps: 25,
    isolate: true,
  })
  try {
    camera.start()
    const id = await recorder.addOutput(bad)
    for (let i = 0; i < 8; i++) await feed(camera, recorder, i)
    await until(() => recorder.outputState(id).errorCode !== 0)
    expect(recorder.outputErrors.get(id)).toBe(failure)
    const replacement = new Collector(),
      job = recorder.recover(replacement, id)
    for (let i = 8; i < 16; i++) await feed(camera, recorder, i)
    await job
    job.close()
    expect(recorder.outputState(id).generation).toBe(1n)
    await recorder.close()
    expect(mkvFrames(join(dir, 'healthy.mkv')).length).toBe(16)
    expect(replacement.packets.length).toBeGreaterThan(0)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('custom queue pressure charges in-flight work without blocking healthy delivery', async () => {
  const dir = root(),
    camera = cam(),
    gate = deferred(),
    slow = new Collector()
  let entered = false
  slow.outputframe = async () => {
    entered = true
    await gate.promise
  }
  const recorder = new Recorder(join(dir, 'healthy.mkv'), {
    width: 32,
    height: 24,
    fps: 25,
    isolate: true,
    outputQueue: { maxBytes: 1024 * 1024, maxOperations: 2 },
  })
  try {
    camera.start()
    const id = await recorder.addOutput(slow)
    await feed(camera, recorder, 0)
    await until(() => entered)
    for (let i = 1; i < 8; i++) await feed(camera, recorder, i)
    expect(recorder.outputState(id).errorCode).toBe(-6)
    gate.release()
    await recorder.close()
    expect(mkvFrames(join(dir, 'healthy.mkv')).length).toBe(8)
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('output claims reject shared objects and descriptors before truncation', async () => {
  const dir = root(),
    path = join(dir, 'active.mkv'),
    alias = join(dir, 'alias.mkv'),
    output = new Collector(),
    recorder = new Recorder(path, { width: 32, height: 24 })
  try {
    await recorder.addOutput(output)
    await expectJob(recorder.addOutput(output)).rejects.toMatchObject({
      code: -4,
    })
    linkSync(path, alias)
    const before = readFileSync(path)
    await expectJob(
      recorder.addOutput(new MuxedOutput(alias, 'mkv', { exclusive: false })),
    ).rejects.toBeInstanceOf(CameraError)
    expect(readFileSync(path)).toEqual(before)
  } finally {
    await recorder.close()
  }
})
test('output hooks cannot re-enter recorder, including asynchronous stop', async () => {
  const output = new Collector()
  let recorder: Recorder
  let observed: unknown
  output.stop = async () => {
    await pause()
    try {
      await recorder.close()
    } catch (error) {
      observed = error
    }
  }
  recorder = await Recorder.open(output, { width: 32, height: 24 })
  await recorder.close()
  expect(observed).toMatchObject({ code: -2 })
})
test('close aborts staged output jobs with no further frame and waits for owned stop', async () => {
  const camera = cam(),
    old = new Collector(),
    next = new Collector()
  const recorder = await Recorder.open(old, { width: 32, height: 24, fps: 25 })
  try {
    camera.start()
    await feed(camera, recorder, 0)
    const job = recorder.split(next)
    await until(() => job.status.staged)
    await recorder.close()
    expect(job.status.done).toBe(true)
    expect(recorder.outputErrors.size).toBe(0)
    job.close()
    expect(old.events.at(-1)).toBe('stop')
    expect(next.events.at(-1)).toBe('stop')
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('custom output publication rejects cancellation before the next lifecycle poll', async () => {
  const { native } = await import('../../ts/ffi')
  const recorder = await Recorder.open(new Collector(), {
    width: 32,
    height: 24,
  })
  const original = native.zc_preparation_job_publish
  let cancelled: boolean | undefined
  try {
    Object.assign(native, {
      zc_preparation_job_publish: (...args: Parameters<typeof original>) => {
        const code = original(...args)
        if (code === 0)
          queueMicrotask(() => {
            cancelled = job.cancel()
          })
        return code
      },
    })
    const job = recorder.split(new Collector())
    await until(() => cancelled !== undefined)
    expect(cancelled).toBe(false)
    await recorder.close()
    await expectJob(job).rejects.toMatchObject({ code: -5 })
    job.close()
  } finally {
    Object.assign(native, { zc_preparation_job_publish: original })
    await recorder.close()
  }
})
const codecs = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  codecs(
    `${codec} custom Home MP4 output and object split independently decode`,
    async () => {
      const dir = root(),
        camera = cam(128, 96),
        a = new Bytes(),
        b = new Bytes(),
        recorder = await Recorder.open(new MuxedOutput(a), {
          width: 128,
          height: 96,
          fps: 25,
          codec,
          gop: 4,
        })
      const sequences: bigint[] = []
      try {
        camera.start()
        for (let i = 0; i < 5; i++)
          sequences.push(await feed(camera, recorder, i))
        const job = recorder.split(new MuxedOutput(b))
        for (let i = 5; i < 20; i++)
          sequences.push(await feed(camera, recorder, i))
        await job
        job.close()
        await recorder.close()
        const first = join(dir, 'a.mp4'),
          second = join(dir, 'b.mp4')
        writeFileSync(first, a.data)
        writeFileSync(second, b.data)
        const av = mp4(first).get(1)!,
          bv = mp4(second).get(1)!
        expect(av.samples.length + bv.samples.length).toBe(20)
        decodeVideo(first, av, sequences.slice(0, av.samples.length))
        decodeVideo(second, bv, sequences.slice(av.samples.length))
      } finally {
        await recorder.close()
        await camera.close()
      }
    },
    30000,
  )
}

test('completed mode callback can submit normal capture while retaining its admission slot', async () => {
  const camera = cam()
  try {
    let captured = 0
    const job = camera.switchMode(
      { width: 64, height: 48 },
      {
        signalFunction: async () => {
          captured = (await camera.captureRGB()).length
        },
      },
    )
    await job
    await job.cleanupDone
    expect(captured).toBe(64 * 48 * 3)
    expect(job.callbackError).toBeUndefined()
  } finally {
    await camera.close()
  }
})
test('cancelled async output startup retains claims until its owned stop completes', async () => {
  const dir = root(),
    output = new Collector(),
    gate = deferred(),
    recorder = new Recorder(join(dir, 'primary.mkv'), { width: 32, height: 24 })
  let entered = false
  output.start = async () => {
    entered = true
    await gate.promise
  }
  try {
    const job = recorder.addOutput(output)
    await until(() => entered)
    expect(job.cancel()).toBe(true)
    expect(job.done).toBe(false)
    const close = recorder.close()
    await pause()
    expect(Number(recorder.handle)).not.toBe(0)
    gate.release()
    await close
    expect(job.done).toBe(true)
    expect(output.events.at(-1)).toBe('stop')
  } finally {
    gate.release()
    await recorder.close()
  }
})
test('stop hook failures are reported after all other output objects close', async () => {
  const a = new Collector(),
    b = new Collector(),
    failure = new Error('stop failed')
  a.stop = () => {
    throw failure
  }
  const recorder = await Recorder.open(a, { width: 32, height: 24 })
  await recorder.addOutput(b)
  let observed: unknown
  try {
    await recorder.close()
  } catch (error) {
    observed = error
  }
  expect(observed).toBe(failure)
  expect(b.events.at(-1)).toBe('stop')
  expect(Number(recorder.handle)).toBe(0)
})
const aac = process.env.ZC_TEST_AAC === '1' ? test : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  aac(
    `${codec} custom AAC/MP4 patchable outputs preserve exact A/V split samples`,
    async () => {
      const dir = root(),
        camera = cam(128, 96),
        a = new Bytes(),
        b = new Bytes(),
        recorder = await Recorder.open(new MuxedOutput(a), {
          width: 128,
          height: 96,
          fps: 25,
          codec,
          gop: 4,
          audio: { sampleRate: 48000, channels: 2 },
        }),
        sequences: bigint[] = []
      try {
        camera.start()
        let job: ReturnType<Recorder['split']> | undefined
        for (let i = 0; i < 20; i++) {
          if (i === 5) job = recorder.split(new MuxedOutput(b))
          const data = new Uint8Array(1920 * 4),
            view = new DataView(data.buffer)
          for (let sample = 0; sample < 1920; sample++) {
            const value = (((i * 1920 + sample) % 200) - 100) * 100
            view.setInt16(sample * 4, value, true)
            view.setInt16(sample * 4 + 2, -value, true)
          }
          recorder.writeAudio(data, BigInt(i) * 40_000_000n)
          sequences.push(await feed(camera, recorder, i))
        }
        await job
        job!.close()
        await recorder.close()
        const paths = [join(dir, 'a.mp4'), join(dir, 'b.mp4')]
        writeFileSync(paths[0], a.data)
        writeFileSync(paths[1], b.data)
        let first = 0,
          samples = 0
        for (const path of paths) {
          const tracks = mp4(path),
            video = tracks.get(1)!,
            audio = tracks.get(2)!
          decodeVideo(
            path,
            video,
            sequences.slice(first, first + video.samples.length),
          )
          decodeAudio(path, audio, samples, video.samples.length * 1920)
          first += video.samples.length
          samples += video.samples.length * 1920
        }
        expect(first).toBe(20)
        expect(samples).toBe(38400)
      } finally {
        await recorder.close()
        await camera.close()
      }
    },
    30000,
  )
}

test('pre-aborted mode and output jobs never claim resources or leak admission', async () => {
  const dir = root(),
    camera = cam(),
    abort = new AbortController(),
    output = new Collector(),
    recorder = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  abort.abort(new Error('already aborted'))
  try {
    for (let i = 0; i < 40; i++) {
      const mode = camera.switchMode(
        { width: 64, height: 48 },
        { signal: abort.signal },
      )
      await mode.wait().catch(() => {})
      expect(mode.phase).toBe(4)
      const add = recorder.addOutput(output, { signal: abort.signal })
      await add.wait().catch(() => {})
      await add.cleanupDone
    }
    expect(output.events.length).toBe(0)
    expect(camera.info().width).toBe(32)
    const id = await recorder.addOutput(output)
    await recorder.removeOutput(id)
  } finally {
    await recorder.close()
    await camera.close()
  }
})

test('cancelled FileOutput startup removes its fresh file after callback ownership retires', async () => {
  const dir = root(),
    path = join(dir, 'cancel.mjpg'),
    gate = deferred(),
    output = new FileOutput(path),
    start = output.start.bind(output),
    recorder = new Recorder(join(dir, 'primary.mkv'), { width: 32, height: 24 })
  let started = false
  output.start = async () => {
    await start()
    started = true
    await gate.promise
  }
  try {
    const job = recorder.split(output)
    await until(() => started)
    expect(existsSync(path)).toBe(true)
    expect(job.cancel()).toBe(true)
    gate.release()
    await job.wait().catch(() => {})
    job.close()
    expect(existsSync(path)).toBe(false)
  } finally {
    gate.release()
    await recorder.close()
  }
})

test('failed new attachment header never poisons an existing fail-fast recording', async () => {
  const dir = root(),
    camera = cam(),
    recorder = new Recorder(join(dir, 'healthy.mkv'), {
      width: 32,
      height: 24,
    }),
    failure = new Error('startup header rejected')
  try {
    const recording = camera.startRecording(recorder)
    await until(() => recording.frames >= 3)
    const added = recorder.addOutput(
      new MuxedOutput(
        {
          write() {
            throw failure
          },
        },
        'mkv',
      ),
    )
    let observed: unknown
    try {
      await added
    } catch (error) {
      observed = error
    }
    expect(observed).toBe(failure)
    const before = recording.frames
    await until(() => recording.frames >= before + 3)
    await recording.close()
    expect(mkvFrames(join(dir, 'healthy.mkv')).length).toBe(recording.frames)
  } finally {
    await recorder.close()
    await camera.close()
  }
})

test('mode worker dispatch failure leaves the previous camera live', async () => {
  const camera = cam(),
    OriginalWorker = globalThis.Worker
  try {
    camera.start()
    globalThis.Worker = class {
      constructor() {
        throw new Error('mode worker unavailable')
      }
    } as unknown as typeof Worker
    let observed: unknown
    try {
      await camera.switchMode({ width: 64, height: 48 })
    } catch (error) {
      observed = error
    }
    expect(String(observed)).toContain('mode worker unavailable')
    expect(camera.info().width).toBe(32)
    using frame = camera.acquire()
    expect(frame.width).toBe(32)
  } finally {
    globalThis.Worker = OriginalWorker
    await camera.close()
  }
})

test('mode completion callback may close its own camera without a teardown cycle', async () => {
  const camera = cam()
  const job = camera.switchMode(
    { width: 64, height: 48 },
    {
      signalFunction: async () => {
        await camera.close()
      },
    },
  )
  await job
  await job.cleanupDone
  expect(Number(camera.handle)).toBe(0)
  expect(job.callbackError).toBeUndefined()
})
test('output completion callback may close its recorder without a teardown cycle', async () => {
  const dir = root(),
    recorder = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 }),
    output = new Collector()
  const job = recorder.addOutput(output, {
    signalFunction: async () => {
      await recorder.close()
    },
  })
  await job
  await job.cleanupDone
  expect(Number(recorder.handle)).toBe(0)
  expect(output.events.at(-1)).toBe('stop')
  expect(job.callbackError).toBeUndefined()
})
test('custom output fixed-prefix drain remains valid after recorder and mailbox close', async () => {
  const camera = cam(),
    output = new Collector(),
    recorder = await Recorder.open(output, { width: 32, height: 24, fps: 25 })
  try {
    camera.start()
    for (let i = 0; i < 5; i++) {
      using frame = camera.acquire()
      recorder.write(frame, BigInt(i) * 40_000_000n)
    }
    const drain = recorder.drain()
    await recorder.close()
    await drain
    expect(output.packets.length).toBe(5)
  } finally {
    await recorder.close()
    await camera.close()
  }
})

test('stop cancels a mode after the target camera is configured and restores the original', async () => {
  const camera = cam()
  try {
    camera.start()
    const job = camera.switchModeAndCaptureRGB(
      { width: 64, height: 48 },
      { dropFrames: 1_000_000 },
    )
    await until(() => job.progress === 3)
    await camera.stop()
    expect(job.done).toBe(true)
    expect(camera.info().width).toBe(32)
    camera.start()
    using frame = camera.acquire()
    expect(frame.width).toBe(32)
  } finally {
    await camera.close()
  }
})

preview(
  'preview recreation failure rolls the camera back before the job rejects',
  async () => {
    const { native } = await import('../../ts/ffi')
    const camera = cam(),
      original = native.zc_preview_open
    try {
      camera.startPreview()
      await camera.captureRGB()
      Object.assign(native, {
        zc_preview_open: (...args: Parameters<typeof original>) =>
          args[1] === 64 ? -6 : original(...args),
      })
      let observed: unknown
      try {
        await camera.switchMode({ width: 64, height: 48 })
      } catch (error) {
        observed = error
      }
      expect(observed).toMatchObject({ code: -6 })
      expect(camera.info().width).toBe(32)
      expect((await camera.captureRGB()).length).toBe(2304)
    } finally {
      Object.assign(native, { zc_preview_open: original })
      await camera.close()
    }
  },
)
