import { test, expect, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  linkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Camera,
  Recorder,
  CircularOutput2,
  FileOutput,
  MuxedOutput,
  PtsStream,
  PtsOutput,
  CameraError,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
  type OutputFactoryContext,
} from '../../ts'
import { mkvFrames, mp4, decodeVideo, decodeAudio } from './media'
const roots: string[] = []
function root() {
  const value = mkdtempSync(join(tmpdir(), 'zc-factories-'))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true })
})
const pause = (ms = 1) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function until(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > end) throw Error('condition timeout')
    await pause()
  }
}
function cam(width = 32, height = 24) {
  return new Camera({ simulate: true, width, height, fifo: true })
}
async function feed(camera: Camera, recorder: Recorder, index: number) {
  using frame = camera.acquire()
  recorder.write(frame, BigInt(index) * 40_000_000n)
  await pause()
  return frame.sequence
}
function expectJob(job: PromiseLike<unknown>) {
  return expect(Promise.resolve(job))
}
class Packets implements CustomOutput {
  frames: OutputPacket[] = []
  starts = 0
  stops = 0
  discard = false
  start() {
    this.starts++
  }
  outputframe(packet: OutputPacket) {
    this.frames.push(packet)
  }
  stop(reason?: { discard: boolean }) {
    this.stops++
    this.discard = reason?.discard ?? false
  }
}
class Bytes {
  data = Buffer.alloc(0)
  write(bytes: Uint8Array) {
    const part = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 31)))
    this.data = Buffer.concat([this.data, part])
    return part.length
  }
  patch(offset: bigint, bytes: Uint8Array) {
    const part = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 7)))
    part.copy(this.data, Number(offset))
    return part.length
  }
}
function history(frames = 8) {
  return new Recorder(null, {
    width: 32,
    height: 24,
    fps: 25,
    circular: { maxFrames: frames, maxBytes: 1024 * 1024, durationMs: 1000 },
    outputQueue: { maxBytes: 65536, maxOperations: 2 },
  })
}
function busy(operation: () => unknown) {
  expect(operation).toThrow(CameraError)
}

test('custom snapshot freezes its submission window and survives source close with tiny delivery bounds', async () => {
  const camera = cam(),
    recorder = history(4),
    target = new Packets(),
    gate = deferred()
  target.start = async () => {
    target.starts++
    await gate.promise
  }
  try {
    camera.start()
    for (let i = 0; i < 6; i++) await feed(camera, recorder, i)
    const job = recorder.snapshot(target)
    await until(() => target.starts === 1)
    for (let i = 6; i < 10; i++) await feed(camera, recorder, i)
    await recorder.close()
    expect(job.done).toBe(false)
    gate.release()
    await job
    expect(target.frames.map((p) => p.sourceTimestampNs)).toEqual([
      80_000_000n,
      120_000_000n,
      160_000_000n,
      200_000_000n,
    ])
    expect(target.frames.map((p) => p.timestampNs)).toEqual([
      0n,
      40_000_000n,
      80_000_000n,
      120_000_000n,
    ])
    expect(target.stops).toBe(1)
    expect(target.discard).toBe(false)
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('custom snapshot slots bound pending jobs, and queued cancellation releases frozen ownership', async () => {
  const camera = cam(),
    recorder = history(),
    a = new Packets(),
    b = new Packets(),
    gate = deferred()
  a.start = async () => {
    a.starts++
    await gate.promise
  }
  b.start = async () => {
    b.starts++
    await gate.promise
  }
  try {
    camera.start()
    await feed(camera, recorder, 0)
    const first = recorder.snapshot(a),
      second = recorder.snapshot(b)
    expect(second.cancel()).toBe(true)
    await expectJob(second).rejects.toBeInstanceOf(JobCancelledError)
    expect(b.starts).toBe(0)
    const third = recorder.snapshot(new Packets())
    busy(() => recorder.snapshot(new Packets()))
    third.cancel()
    await expectJob(third).rejects.toBeInstanceOf(JobCancelledError)
    await until(() => a.starts === 1)
    gate.release()
    await first
    await recorder.snapshot(new Packets())
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('cancelled custom snapshots wait for in-flight hooks and never poison live outputs', async () => {
  const dir = root(),
    path = join(dir, 'healthy.mkv'),
    camera = cam(),
    recorder = history(),
    target = new Packets(),
    gate = deferred()
  let entered = false
  target.outputframe = async (packet) => {
    target.frames.push(packet)
    entered = true
    await gate.promise
  }
  try {
    camera.start()
    recorder.addOutput(path)
    for (let i = 0; i < 4; i++) await feed(camera, recorder, i)
    const job = recorder.snapshot(target)
    await until(() => entered)
    job.cancel()
    for (let i = 4; i < 8; i++) await feed(camera, recorder, i)
    expect(job.done).toBe(false)
    gate.release()
    await expectJob(job).rejects.toBeInstanceOf(JobCancelledError)
    expect(target.stops).toBe(1)
    expect(target.discard).toBe(true)
    await recorder.close()
    expect(mkvFrames(path).length).toBe(8)
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('custom snapshot errors and signal callbacks release their native windows', async () => {
  const camera = cam(),
    recorder = history(),
    failure = Error('snapshot write failure'),
    target = new Packets()
  target.outputframe = () => {
    throw failure
  }
  try {
    camera.start()
    await feed(camera, recorder, 0)
    const job = recorder.snapshot(target, {
      signalFunction: async () => {
        await recorder.close()
      },
    })
    let observed: unknown
    try {
      await job
    } catch (error) {
      observed = error
    }
    expect(observed).toBe(failure)
    await job.cleanupDone
    expect(job.callbackError).toBeUndefined()
    expect(target.stops).toBe(1)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('custom snapshots reject current and future live aliases before any truncate', async () => {
  const dir = root(),
    path = join(dir, 'live.mkv'),
    alias = join(dir, 'alias.mkv'),
    camera = cam(),
    recorder = history(),
    gate = deferred()
  const target = new MuxedOutput(alias, 'mkv', { exclusive: false })
  const start = target.start.bind(target)
  let entered = false
  target.start = async () => {
    await start()
    entered = true
    await gate.promise
  }
  try {
    camera.start()
    await feed(camera, recorder, 0)
    writeFileSync(alias, 'KEEP')
    const job = recorder.snapshot(target)
    await until(() => entered)
    linkSync(alias, path)
    recorder.addOutput(path)
    await feed(camera, recorder, 1)
    const before = readFileSync(path)
    gate.release()
    await expectJob(job).rejects.toBeInstanceOf(CameraError)
    expect(readFileSync(path)).toEqual(before)
    await feed(camera, recorder, 2)
    await recorder.close()
    expect(mkvFrames(path).length).toBe(2)
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('snapshot reservations prevent aliases introduced after binding', async () => {
  const dir = root(),
    path = join(dir, 'snapshot.mjpg'),
    camera = cam(),
    recorder = history(),
    gate = deferred()
  const target = new FileOutput(path)
  const output = target.outputframe.bind(target)
  let entered = false
  target.outputframe = async (packet) => {
    entered = true
    await gate.promise
    await output(packet)
  }
  try {
    camera.start()
    await feed(camera, recorder, 0)
    const job = recorder.snapshot(target)
    await until(() => entered)
    busy(() => recorder.addOutput(path))
    gate.release()
    await job
    expect(readFileSync(path).readUInt16BE(0)).toBe(0xffd8)
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('custom snapshots reject replay of a currently owned shared PTS stream', async () => {
  const dir = root(),
    camera = cam(),
    pts = await PtsStream.open(join(dir, 'live.pts'))
  const recorder = history()
  try {
    camera.start()
    await recorder.openOutput(new PtsOutput(new Packets(), pts))
    await feed(camera, recorder, 0)
    await expectJob(
      recorder.snapshot(
        new FileOutput(join(dir, 'snapshot.mjpg'), {
          pts: join(dir, 'live.pts'),
          exclusive: false,
        }),
      ),
    ).rejects.toBeInstanceOf(CameraError)
    await feed(camera, recorder, 1)
    await recorder.close()
    await pts.close()
    expect(readFileSync(join(dir, 'live.pts'), 'utf8')).toBe('0.000\n40.000\n')
  } finally {
    await recorder.close()
    await pts.close()
    await camera.close()
  }
})

test('rotation factories publish fresh key-aligned outputs with ordered context indices', async () => {
  const camera = cam(),
    initial = new Packets(),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 })
  const contexts: OutputFactoryContext[] = [],
    outputs = [initial]
  try {
    camera.start()
    recorder.setRotation(
      async (context) => {
        contexts.push(context)
        const output = new Packets()
        outputs.push(output)
        return output
      },
      { durationMs: 80, nextIndex: 4n },
    )
    let index = 0
    for (let generation = 1; generation <= 2; generation++) {
      while (!recorder.automaticState().pending) {
        await feed(camera, recorder, index++)
      }
      await until(() => {
        recorder.poll()
        return recorder.outputState().splitState === 1
      })
      await feed(camera, recorder, index++)
      await until(() => !recorder.automaticState().pending)
      expect(recorder.outputState().generation).toBe(BigInt(generation))
    }
    await recorder.stopAutomatic()
    await recorder.close()
    expect(contexts.map((c) => c.index)).toEqual([4n, 5n])
    expect(contexts.map((c) => c.generation)).toEqual([0n, 1n])
    expect(outputs.reduce((sum, out) => sum + out.frames.length, 0)).toBe(index)
    expect(
      outputs.every(
        (out) =>
          out.stops === 1 &&
          out.frames[0].keyframe &&
          out.frames[0].timestampNs === 0n,
      ),
    ).toBe(true)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('rotation factory failure latches observably and leaves the current sink healthy', async () => {
  const camera = cam(),
    initial = new Packets(),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 }),
    failure = Error('factory construction failed')
  let calls = 0
  try {
    camera.start()
    recorder.setRotation(
      () => {
        calls++
        throw failure
      },
      { maxBytes: 1 },
    )
    await feed(camera, recorder, 0)
    await until(() => !recorder.automaticState().pending)
    for (let i = 1; i < 5; i++) await feed(camera, recorder, i)
    expect(calls).toBe(1)
    expect(recorder.automaticState().error).toBe(failure)
    expect(recorder.outputState().generation).toBe(0n)
    await recorder.stopAutomatic()
    await recorder.close()
    expect(initial.frames.length).toBe(5)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('per-output factories rotate independently of healthy recording peers', async () => {
  const path = join(root(), 'primary.mkv'),
    camera = cam(),
    recorder = new Recorder(path, { width: 32, height: 24, fps: 25 }),
    old = new Packets(),
    next = new Packets()
  try {
    camera.start()
    const id = await recorder.addOutput(old)
    recorder.setRotation(
      (context) => {
        expect(context.id).toBe(id)
        return next
      },
      { maxBytes: 1 },
      id,
    )
    await feed(camera, recorder, 0)
    await until(() => {
      recorder.poll()
      return recorder.outputState(id).splitState === 1
    })
    await feed(camera, recorder, 1)
    await until(() => !recorder.automaticState(id).pending)
    await recorder.stopAutomatic(id)
    await feed(camera, recorder, 2)
    await recorder.close()
    expect(recorder.outputErrors.size).toBe(0)
    expect(mkvFrames(path).length).toBe(3)
    expect(old.frames.length).toBe(1)
    expect(next.frames.length).toBe(2)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('recovery factories use media-clock delays, fresh indices and lifetime attempt budgets', async () => {
  const path = join(root(), 'healthy.mkv'),
    camera = cam(),
    bad = new Packets(),
    fresh = new Packets(),
    original = Error('first recovery failed')
  let written = 0
  bad.outputframe = () => {
    if (++written === 2) throw Error('broken sink')
  }
  const recorder = await Recorder.open(bad, {
      width: 32,
      height: 24,
      fps: 25,
      isolate: true,
    }),
    indices: bigint[] = []
  try {
    camera.start()
    recorder.addOutput(path)
    recorder.setRecovery(
      0,
      (context) => {
        indices.push(context.index)
        if (indices.length === 1) throw original
        return fresh
      },
      { nextIndex: 7n, maxAttempts: 2, retryDelayMs: 80, maxDelayMs: 80 },
    )
    await feed(camera, recorder, 0)
    await feed(camera, recorder, 1)
    await until(() => recorder.outputState().errorCode !== 0)
    expect(recorder.recoveryState().deadlineNs).toBe(120_000_000n)
    await pause(100)
    recorder.poll()
    expect(indices.length).toBe(0)
    await feed(camera, recorder, 2)
    expect(indices.length).toBe(0)
    await feed(camera, recorder, 3)
    await until(() => !recorder.automaticState().pending)
    expect(recorder.automaticState().error).toBe(original)
    await feed(camera, recorder, 4)
    expect(indices).toEqual([7n])
    await feed(camera, recorder, 5)
    await until(
      () =>
        !recorder.automaticState().pending &&
        recorder.outputState().generation === 1n,
    )
    await feed(camera, recorder, 6)
    expect(indices).toEqual([7n, 8n])
    expect(recorder.recoveryState().attempts).toBe(2)
    await recorder.close()
    expect(mkvFrames(path).length).toBe(7)
    expect(fresh.frames.length).toBe(1)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('stopping a factory aborts its signal and cleans a late result without stopping the healthy source', async () => {
  const path = join(root(), 'late.mjpg'),
    camera = cam(),
    initial = new Packets(),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 }),
    gate = deferred()
  let context: OutputFactoryContext | undefined
  try {
    camera.start()
    recorder.setRotation(
      async (value) => {
        context = value
        const output = new FileOutput(path)
        await output.start()
        await gate.promise
        return output
      },
      { maxBytes: 1 },
    )
    await feed(camera, recorder, 0)
    await until(() => existsSync(path))
    const stopped = recorder.stopAutomatic()
    expect(context!.signal.aborted).toBe(true)
    await feed(camera, recorder, 1)
    expect(initial.stops).toBe(0)
    gate.release()
    await stopped
    expect(existsSync(path)).toBe(false)
    await feed(camera, recorder, 2)
    await recorder.close()
    expect(initial.frames.length).toBe(3)
  } finally {
    gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('factory results cannot reuse active sinks and invalid fresh results are discarded exactly once', async () => {
  const camera = cam(),
    initial = new Packets(),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 })
  let discarded = 0
  try {
    camera.start()
    recorder.setRotation(() => initial, { maxBytes: 1 })
    await feed(camera, recorder, 0)
    await until(() => !recorder.automaticState().pending)
    expect(initial.stops).toBe(0)
    expect(recorder.automaticState().errorCode).toBe(-4)
    await recorder.stopAutomatic()
    recorder.setRotation(
      () => ({
        format: 'mp4',
        stop(reason) {
          expect(reason?.discard).toBe(true)
          discarded++
        },
      }),
      { maxBytes: 1 },
    )
    await until(() => !recorder.automaticState().pending)
    expect(discarded).toBe(1)
    expect(initial.stops).toBe(0)
    await recorder.stopAutomatic()
    await recorder.close()
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('queued factory deadlines and immediate parent close release reserved native claims', async () => {
  for (const closeImmediately of [false, true]) {
    const camera = cam(),
      initial = new Packets(),
      recorder = await Recorder.open(initial, {
        width: 32,
        height: 24,
        fps: 25,
      })
    let calls = 0
    try {
      camera.start()
      await feed(camera, recorder, 0)
      recorder.setRotation(
        () => {
          calls++
          return new Packets()
        },
        { maxBytes: 1, ...(closeImmediately ? {} : { timeoutMs: 0 }) },
      )
      if (closeImmediately) await recorder.close()
      else {
        await until(() => !recorder.automaticState().pending)
        expect(recorder.automaticState().errorCode).toBe(-3)
        await recorder.stopAutomatic()
        await recorder.close()
      }
      expect(calls).toBe(0)
      expect(initial.stops).toBe(1)
    } finally {
      await recorder.close()
      await camera.close()
    }
  }
})
test('invalid exception codes cannot strand a factory claim', async () => {
  const camera = cam(),
    initial = new Packets(),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 })
  try {
    camera.start()
    await feed(camera, recorder, 0)
    for (const code of [12, -(2 ** 40)]) {
      const failure = new CameraError(code, 'factory')
      recorder.setRotation(
        () => {
          throw failure
        },
        { maxBytes: 1 },
      )
      await until(() => !recorder.automaticState().pending)
      expect(recorder.automaticState().errorCode).toBe(-6)
      expect(recorder.automaticState().error).toBe(failure)
      await recorder.stopAutomatic()
    }
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('parent close retires an uncommitted factory split without requiring another frame', async () => {
  const camera = cam(),
    initial = new Packets(),
    next = new Packets(),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 })
  try {
    camera.start()
    recorder.setRotation(() => next, { maxBytes: 1 })
    await feed(camera, recorder, 0)
    await until(() => {
      recorder.poll()
      return recorder.outputState().splitState === 1
    })
    await recorder.close()
    expect(initial.stops).toBe(1)
    expect(next.stops).toBe(1)
    expect(next.discard).toBe(true)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('factory header rejection preserves the healthy output and discards the unpublished writer', async () => {
  const camera = cam(),
    initial = new Packets(),
    failure = Error('header rejected'),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 })
  const target = new MuxedOutput(
    {
      write() {
        throw failure
      },
    },
    'mkv',
  )
  let discarded = 0
  target.stop = async (reason) => {
    expect(reason?.discard).toBe(true)
    discarded++
  }
  try {
    camera.start()
    recorder.setRotation(() => target, { maxBytes: 1 })
    await feed(camera, recorder, 0)
    await until(() => !recorder.automaticState().pending)
    expect(recorder.automaticState().error).toBe(failure)
    expect(recorder.outputState().generation).toBe(0n)
    expect(discarded).toBe(1)
    await recorder.stopAutomatic()
    await feed(camera, recorder, 1)
    await recorder.close()
    expect(initial.frames.length).toBe(2)
  } finally {
    await recorder.close()
    await camera.close()
  }
})
test('CircularOutput2 factory rotations retain a shared source PTS epoch across delayed segments', async () => {
  const camera = cam(),
    bytes = new Bytes(),
    pts = await PtsStream.open(bytes),
    recorder = new CircularOutput2({
      width: 32,
      height: 24,
      fps: 25,
      pts,
      bufferDurationMs: 80,
      circular: { maxFrames: 16, maxBytes: 1024 * 1024 },
    }),
    a = new Packets(),
    b = new Packets()
  try {
    camera.start()
    await recorder.openOutput(a)
    recorder.setRotation(() => b, { maxBytes: 1 })
    for (let i = 0; i < 3; i++) await feed(camera, recorder, i)
    await until(() => {
      recorder.poll()
      return recorder.outputState().splitState === 1
    })
    await feed(camera, recorder, 3)
    await until(() => !recorder.automaticState().pending)
    await recorder.stopAutomatic()
    await feed(camera, recorder, 4)
    await recorder.close()
    await pts.close()
    expect(a.frames.length + b.frames.length).toBe(5)
    expect(bytes.data.toString()).toBe(
      '0.000\n40.000\n80.000\n120.000\n160.000\n',
    )
    expect(b.frames[0].timestampNs).toBe(0n)
  } finally {
    await recorder.close()
    await pts.close()
    await camera.close()
  }
})
test('CircularOutput2 recovery factories can replace a poisoned shared observer', async () => {
  const camera = cam(),
    failure = Error('observer failed'),
    bytes = new Bytes(),
    fresh = await PtsStream.open(bytes),
    bad = await PtsStream.open({
      write() {
        throw failure
      },
    }),
    recorder = new CircularOutput2({
      width: 32,
      height: 24,
      fps: 25,
      isolate: true,
      bufferDurationMs: 0,
      pts: bad,
      circular: { maxFrames: 8, maxBytes: 1024 * 1024 },
    })
  try {
    camera.start()
    await recorder.openOutput(new Packets())
    recorder.setRecovery(0, () => new PtsOutput(new Packets(), fresh), {
      retryDelayMs: 0,
    })
    await feed(camera, recorder, 0)
    await until(() => {
      recorder.poll()
      return (
        !recorder.automaticState().pending &&
        recorder.outputState().generation === 1n
      )
    })
    await recorder.stopAutomatic()
    await feed(camera, recorder, 1)
    await feed(camera, recorder, 2)
    await recorder.close()
    await fresh.close()
    expect(bytes.data.toString()).toBe('0.000\n40.000\n')
    await expect(Promise.resolve().then(() => bad.close())).rejects.toBe(
      failure,
    )
  } finally {
    await recorder.close()
    await fresh.close()
    try {
      await bad.close()
    } catch {}
    await camera.close()
  }
})
test('factories reject reentry and manual routing mutations until disabled', async () => {
  const camera = cam(),
    initial = new Packets(),
    recorder = await Recorder.open(initial, { width: 32, height: 24, fps: 25 })
  try {
    camera.start()
    recorder.setRotation(
      () => {
        recorder.stats()
        return new Packets()
      },
      { maxBytes: 1 },
    )
    busy(() => recorder.split(new Packets()))
    await feed(camera, recorder, 0)
    await until(() => !recorder.automaticState().pending)
    expect(recorder.automaticState().errorCode).toBe(-2)
    await recorder.stopAutomatic()
    await recorder.close()
  } finally {
    await recorder.close()
    await camera.close()
  }
})
const av =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  av(
    `${codec} factory MP4 rotation preserves every video frame and presented AAC sample`,
    async () => {
      const camera = cam(128, 96),
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
      let index = 0
      const frame = async () => {
        if (index >= 100) throw Error('factory publication stalled')
        const pcm = new Uint8Array(1920 * 4),
          view = new DataView(pcm.buffer)
        for (let sample = 0; sample < 1920; sample++) {
          const value = (((index * 1920 + sample) % 200) - 100) * 100
          view.setInt16(sample * 4, value, true)
          view.setInt16(sample * 4 + 2, -value, true)
        }
        recorder.writeAudio(pcm, BigInt(index) * 40_000_000n)
        sequences.push(await feed(camera, recorder, index++))
      }
      try {
        camera.start()
        recorder.setRotation(() => new MuxedOutput(b), { durationMs: 160 })
        while (!recorder.automaticState().pending) await frame()
        await until(() => {
          recorder.poll()
          return recorder.outputState().splitState === 1
        })
        while (recorder.outputState().generation === 0n) await frame()
        await until(() => !recorder.automaticState().pending)
        await recorder.stopAutomatic()
        for (let i = 0; i < 4; i++) await frame()
        await recorder.close()
        let first = 0
        for (const [segment, bytes] of [a, b].entries()) {
          const path = join(root(), `${codec}-${segment}.mp4`)
          writeFileSync(path, bytes.data)
          const tracks = mp4(path),
            video = tracks.get(1)!,
            audio = tracks.get(2)!
          expect(video.samples.length).toBeGreaterThan(0)
          decodeVideo(
            path,
            video,
            sequences.slice(first, first + video.samples.length),
          )
          decodeAudio(path, audio, first * 1920, video.samples.length * 1920)
          first += video.samples.length
        }
        expect(first).toBe(index)
      } finally {
        await recorder.close()
        await camera.close()
      }
    },
    30000,
  )
  av(
    `${codec} custom MP4 snapshots independently decode owned GOP/PCM data after source close`,
    async () => {
      const camera = cam(128, 96),
        bytes = new Bytes(),
        gate = deferred(),
        sequences: bigint[] = []
      const recorder = new Recorder(null, {
        width: 128,
        height: 96,
        fps: 25,
        codec,
        gop: 4,
        circular: { maxFrames: 6, maxBytes: 1024 * 1024, durationMs: 1000 },
        audio: { sampleRate: 48000, channels: 2 },
      })
      const output = new MuxedOutput(bytes)
      let entered = false
      output.start = async () => {
        entered = true
        await gate.promise
      }
      const frame = async (i: number) => {
        const pcm = new Uint8Array(1920 * 4),
          d = new DataView(pcm.buffer)
        for (let s = 0; s < 1920; s++) {
          const value = (((i * 1920 + s) % 200) - 100) * 100
          d.setInt16(s * 4, value, true)
          d.setInt16(s * 4 + 2, -value, true)
        }
        recorder.writeAudio(pcm, BigInt(i) * 40_000_000n)
        sequences.push(await feed(camera, recorder, i))
      }
      try {
        camera.start()
        for (let i = 0; i < 8; i++) await frame(i)
        const stats = recorder.bufferStats(),
          first = Number(stats.firstNs / 40_000_000n),
          last = Number(stats.lastNs / 40_000_000n)
        const job = recorder.snapshot(output)
        await until(() => entered)
        for (let i = 8; i < 12; i++) await frame(i)
        await recorder.close()
        gate.release()
        await job
        const path = join(root(), `${codec}-snapshot.mp4`)
        writeFileSync(path, bytes.data)
        const tracks = mp4(path),
          video = tracks.get(1)!,
          audio = tracks.get(2)!
        expect(video.samples.length).toBe(last - first + 1)
        decodeVideo(path, video, sequences.slice(first, last + 1))
        const end = codec === 'h264' ? 7 : 8
        decodeAudio(path, audio, first * 1920, (end - first) * 1920)
      } finally {
        gate.release()
        await recorder.close()
        await camera.close()
      }
    },
    30000,
  )
}
