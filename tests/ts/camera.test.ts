import { test, expect, afterEach } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  linkSync,
  renameSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Camera,
  Recorder,
  AudioCapture,
  CameraError,
  Control,
  type PreparationJob,
} from '../../ts'
import { mkvFrames, mp4, decodeVideo, decodeAudio } from './media'
const directories: string[] = []
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'zig-camera-bun-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true })
})
const delay = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean, timeout = 5000) {
  const end = performance.now() + timeout
  while (!predicate()) {
    if (performance.now() > end) throw new Error('condition timeout')
    await delay()
  }
}
const camera = (width = 32, height = 24, raw = false) =>
  new Camera({ simulate: true, width, height, fifo: true, raw })
async function feed(cam: Camera, rec: Recorder, index: number, fps = 25) {
  using frame = cam.acquire()
  rec.write(frame, (BigInt(index) * 1_000_000_000n) / BigInt(fps))
  return frame.sequence
}
function throwsCode(operation: () => unknown, code: number) {
  try {
    operation()
    throw new Error('operation unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(CameraError)
    expect((error as CameraError).code).toBe(code)
  }
}
test('explicit simulation and geometry checks', async () => {
  expect(() => new Camera({ width: 32, height: 24 })).toThrow()
  throwsCode(() => new Camera({ simulate: true, width: 32 }), -1)
  const cam = camera()
  expect(cam.info().cameraId).toBe('synthetic')
  expect(cam.info().width).toBe(32)
  await cam.close()
})
test('frame copies are owned, release is idempotent, leases block close', async () => {
  const cam = camera()
  cam.start()
  const frame = cam.acquire()
  const bytes = frame.copyRGB()
  expect(bytes.length).toBe(32 * 24 * 3)
  await expect(cam.close()).rejects.toBeInstanceOf(CameraError)
  expect(frame.copyRGB()).toEqual(bytes)
  frame.release()
  frame.release()
  expect(() => frame.copyRGB()).toThrow()
  await cam.close()
  expect(bytes.length).toBe(2304)
})
test('sensor selection and paired lores share the lease', async () => {
  const cam = new Camera({
    simulate: true,
    width: 66,
    height: 34,
    fifo: true,
    sensor: { width: 640, height: 480, bitDepth: 12 },
    lores: { width: 18, height: 10 },
  })
  try {
    expect(cam.sensorModes().length).toBeGreaterThan(0)
    cam.start()
    using frame = cam.acquire()
    const stream = frame.copyStream('lores')
    expect(stream.format).toBe('YUV420')
    expect(stream.data.length).toBe(270)
    expect(frame.metadata().sequence).toBe(frame.sequence)
  } finally {
    await cam.close()
  }
})
test('typed controls are atomic and metadata retains revisions', async () => {
  const cam = camera()
  try {
    cam.start()
    const revision = cam.setControls([
      { id: Control.aeEnable, type: 'bool', values: [0] },
      { id: Control.exposureTime, type: 'int', values: [1000] },
      { id: Control.analogueGain, type: 'float', values: [2] },
    ])
    for (let i = 0; i < 8; i++) {
      using frame = cam.acquire()
      if (frame.metadata().controlRevision >= revision) {
        expect(frame.metadata().exposureUs).toBe(1000)
        expect(frame.metadata().analogueGain).toBe(2)
        break
      }
    }
    throwsCode(
      () => cam.setControls([{ id: 999, type: 'int', values: [1] }]),
      -8,
    )
  } finally {
    await cam.close()
  }
})
test('autofocus observes asynchronous metadata without leasing frames', async () => {
  const cam = camera()
  try {
    expect(await cam.autofocus()).toBe(3)
    expect(cam.stats().leased).toBe(0)
  } finally {
    await cam.close()
  }
})
test('bounded queued capture jobs return owned data and handle abort', async () => {
  const cam = camera()
  try {
    const jobs = Array.from({ length: 32 }, () => cam.captureRGB())
    throwsCode(() => cam.captureRGB(), -4)
    const results = await Promise.all(jobs)
    expect(results.every((data) => data.length === 2304)).toBe(true)
    expect(cam.stats().leased).toBe(0)
    const abort = new AbortController()
    abort.abort(new Error('cancel'))
    await expect(cam.captureRGB({ signal: abort.signal })).rejects.toThrow(
      'cancel',
    )
  } finally {
    await cam.close()
  }
})
test('stop rejects queued captures and allows restart', async () => {
  const cam = camera()
  const job = cam.captureRGB()
  const outcome = job.then(
    () => null,
    (error) => error,
  )
  await cam.stop()
  expect(await outcome).toBeInstanceOf(CameraError)
  expect((await cam.captureRGB()).length).toBe(2304)
  await cam.close()
})
test('JPEG and calibrated DNG save without a Python image runtime', async () => {
  const dir = root(),
    cam = camera(128, 96, true)
  try {
    cam.start()
    using frame = cam.acquire()
    frame.saveJPEG(join(dir, 'photo.jpg'))
    frame.saveDNG(join(dir, 'photo.dng'))
    const jpeg = readFileSync(join(dir, 'photo.jpg'))
    expect(jpeg.readUInt16BE()).toBe(0xffd8)
    expect(jpeg.readUInt16BE(jpeg.length - 2)).toBe(0xffd9)
    const dng = readFileSync(join(dir, 'photo.dng'))
    expect(dng.toString('ascii', 0, 2)).toBe('II')
    expect(dng.readUInt16LE(2)).toBe(42)
    const off = dng.readUInt32LE(4),
      count = dng.readUInt16LE(off)
    const tags = new Map<
      number,
      { type: number; count: number; value: number }
    >()
    for (let i = 0; i < count; i++) {
      const pos = off + 2 + i * 12
      tags.set(dng.readUInt16LE(pos), {
        type: dng.readUInt16LE(pos + 2),
        count: dng.readUInt32LE(pos + 4),
        value: dng.readUInt32LE(pos + 8),
      })
    }
    expect(tags.get(256)!.value).toBe(128)
    expect(tags.get(257)!.value).toBe(96)
    expect(tags.get(50717)!.value).toBe(4095)
    const strip = tags.get(273)!.value
    expect(dng.readUInt16LE(strip + (7 * 128 + 5) * 2)).toBe(366)
  } finally {
    await cam.close()
  }
})
test('timestamp validation never leaks the camera frame', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, 'clip.mkv'), {
      width: 32,
      height: 24,
      fps: 25,
    })
  try {
    cam.start()
    using frame = cam.acquire()
    rec.write(frame, 0n)
    throwsCode(() => rec.write(frame, 0n), -1)
    frame.release()
    await feed(cam, rec, 1)
    await rec.close()
    expect(mkvFrames(join(dir, 'clip.mkv')).length).toBe(2)
    expect(cam.stats().leased).toBe(0)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('async split preserves exactly one segment per accepted frame', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24, fps: 25 })
  try {
    cam.start()
    for (let i = 0; i < 4; i++) await feed(cam, rec, i)
    const job = rec.split(join(dir, 'b.mkv'))
    let i = 4
    while (!job.status.done) {
      await feed(cam, rec, i++)
      await delay()
    }
    await job
    expect(job.cancel()).toBe(false)
    job.close()
    await rec.close()
    expect(
      mkvFrames(join(dir, 'a.mkv')).length +
        mkvFrames(join(dir, 'b.mkv')).length,
    ).toBe(i)
    expect(rec.outputErrors.size).toBe(0)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('split file collisions never truncate existing data', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  try {
    cam.start()
    await feed(cam, rec, 0)
    const path = join(dir, 'exists.mkv')
    writeFileSync(path, 'keep me')
    const job = rec.split(path)
    await until(() => job.status.done)
    await expect(job.wait()).rejects.toBeInstanceOf(CameraError)
    job.close()
    expect(readFileSync(path, 'utf8')).toBe('keep me')
    await feed(cam, rec, 1)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('active file aliases and duplicate preparation are rejected safely', async () => {
  const dir = root(),
    cam = camera(),
    path = join(dir, 'a.mkv'),
    rec = new Recorder(path, { width: 32, height: 24 })
  try {
    cam.start()
    await feed(cam, rec, 0)
    const alias = join(dir, 'alias.mkv')
    linkSync(path, alias)
    const job = rec.split(alias)
    await until(() => job.status.done)
    expect(job.status.errorCode).not.toBe(0)
    job.close()
    const next = rec.split(join(dir, 'b.mkv'))
    throwsCode(() => rec.split(join(dir, 'c.mkv')), -4)
    next.cancel()
    await until(() => next.status.done)
    next.close()
    expect(rec.outputState().generation).toBe(0n)
    await feed(cam, rec, 1)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('cancelled preparation removes only its created inode', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  try {
    cam.start()
    const path = join(dir, 'cancel.mkv'),
      job = rec.split(path)
    await until(() => existsSync(path))
    renameSync(path, join(dir, 'moved.mkv'))
    writeFileSync(path, 'replacement')
    expect(job.cancel()).toBe(true)
    await until(() => job.status.done)
    expect(job.status.errorCode).toBe(-5)
    expect(readFileSync(path, 'utf8')).toBe('replacement')
    job.close()
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('recorder close cancels unstaged jobs and leaves queryable results', async () => {
  const dir = root(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  const job = rec.split(join(dir, 'b.mkv'))
  await rec.close()
  expect(job.status.done).toBe(true)
  expect(job.status.errorCode).toBe(-5)
  job.close()
  expect(existsSync(join(dir, 'b.mkv'))).toBe(false)
  await rec.close()
})
test('bounded native job handles and stale output IDs', async () => {
  const dir = root(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  const jobs: PreparationJob[] = []
  try {
    const ids = [
      0n,
      ...Array.from({ length: 7 }, (_, i) =>
        rec.addOutput(join(dir, `out-${i}.mkv`)),
      ),
    ]
    for (const [i, id] of ids.entries())
      jobs.push(rec.split(join(dir, `next-${i}.mkv`), id))
    throwsCode(() => rec.split(join(dir, 'overflow.mkv')), -4)
    for (const job of jobs) job.cancel()
    await until(() => jobs.every((job) => job.status.done))
    for (const job of jobs) job.close()
    rec.removeOutput(ids[2])
    throwsCode(() => rec.outputState(ids[2]), -2)
  } finally {
    await rec.close()
    for (const job of jobs) {
      try {
        job.close()
      } catch {}
    }
  }
})
test('automatic rotation runs natively with bounded asynchronous sink I/O', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, '000.mkv'), {
      width: 32,
      height: 24,
      fps: 25,
      exclusive: true,
      io: { maxBytes: 16 * 1024 * 1024, maxOperations: 65536 },
    })
  try {
    cam.start()
    rec.setRotation(join(dir, '{index:03}.mkv'), { durationMs: 100 })
    for (let i = 0; i < 30; i++) {
      await feed(cam, rec, i)
      await delay()
    }
    await rec.close()
    const files = readdirSync(dir)
      .filter((x) => x.endsWith('.mkv'))
      .sort()
    expect(files.length).toBeGreaterThan(2)
    expect(
      files.reduce(
        (count, file) => count + mkvFrames(join(dir, file)).length,
        0,
      ),
    ).toBe(30)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('automatic rotation failure is observable and healthy recording continues', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, '000.mkv'), {
      width: 32,
      height: 24,
      fps: 25,
      exclusive: true,
    })
  writeFileSync(join(dir, '001.mkv'), 'reserved')
  try {
    cam.start()
    rec.setRotation(join(dir, '{index:03}.mkv'), { maxBytes: 1 })
    for (let i = 0; i < 12; i++) {
      await feed(cam, rec, i)
      await delay()
    }
    await until(() => {
      rec.poll()
      return !rec.automaticState().pending
    })
    expect(rec.automaticState().errorCode).not.toBe(0)
    expect(rec.outputState().errorCode).toBe(0)
    await rec.close()
    expect(mkvFrames(join(dir, '000.mkv')).length).toBe(12)
    expect(readFileSync(join(dir, '001.mkv'), 'utf8')).toBe('reserved')
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('malformed patterns and unsupported formats fail before file creation', async () => {
  const dir = root(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  try {
    for (const pattern of [
      'x.mkv',
      '{index}{index}.mkv',
      '{index:0129}.mkv',
      '{index}.mp4',
    ])
      expect(() =>
        rec.setRotation(join(dir, pattern), { durationMs: 100 }),
      ).toThrow()
    expect(() => rec.split('bad\0name')).toThrow()
  } finally {
    await rec.close()
  }
})
test('output draining snapshots a fixed accepted prefix and survives close', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, 'a.mkv'), {
      width: 32,
      height: 24,
      io: { maxBytes: 1024 * 1024, maxOperations: 65536 },
    })
  try {
    cam.start()
    for (let i = 0; i < 5; i++) await feed(cam, rec, i)
    const drain = rec.drain()
    await rec.close()
    await drain
    expect(mkvFrames(join(dir, 'a.mkv')).length).toBe(5)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('circular snapshots retain owned pre-roll while recording continues', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(null, {
      width: 32,
      height: 24,
      fps: 25,
      circular: { maxFrames: 8, maxBytes: 1024 * 1024 },
    })
  try {
    cam.start()
    for (let i = 0; i < 5; i++) await feed(cam, rec, i)
    const snapshot = rec.snapshot(join(dir, 'snapshot.mkv'))
    for (let i = 5; i < 9; i++) await feed(cam, rec, i)
    await rec.close()
    await snapshot
    expect(mkvFrames(join(dir, 'snapshot.mkv')).length).toBe(5)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('background recording shares capture jobs and releases every lease', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  try {
    const recording = cam.startRecording(rec)
    const data = await cam.captureRGB()
    expect(data.length).toBe(2304)
    await until(() => recording.frames >= 6)
    await recording.close()
    expect(mkvFrames(join(dir, 'a.mkv')).length).toBe(recording.frames)
    expect(cam.stats().leased).toBe(0)
  } finally {
    await rec.close()
    await cam.close()
  }
})
test('synthetic audio clocks and deterministic PCM remain native', () => {
  using audio = new AudioCapture({
    simulate: true,
    sampleRate: 48000,
    channels: 2,
    blockFrames: 48,
  })
  const a = audio.read(),
    b = audio.read()
  expect(a.timestampNs).toBe(0n)
  expect(b.timestampNs).toBe(1_000_000n)
  expect(a.data.length).toBe(192)
  expect(new DataView(a.data.buffer).getInt16(0, true)).toBe(-10000)
  expect(new DataView(a.data.buffer).getInt16(2, true)).toBe(10000)
})
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview('asynchronous SDL preview shares the Bun capture pump', async () => {
  const cam = camera()
  try {
    cam.startPreview()
    await cam.captureRGB()
    expect(cam.stats().leased).toBe(0)
    cam.stopPreview()
  } finally {
    await cam.close()
  }
})
const codecs = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  codecs(
    `${codec} MP4 async splits decode with exact video order`,
    async () => {
      const dir = root(),
        cam = camera(128, 96),
        a = join(dir, 'a.mp4'),
        b = join(dir, 'b.mp4'),
        rec = new Recorder(a, {
          width: 128,
          height: 96,
          fps: 25,
          codec,
          gop: 4,
        })
      const sequences: bigint[] = []
      try {
        cam.start()
        for (let i = 0; i < 5; i++) sequences.push(await feed(cam, rec, i))
        const job = rec.split(b)
        for (let i = 5; i < 20; i++) {
          sequences.push(await feed(cam, rec, i))
          await delay()
        }
        await job
        job.close()
        await rec.close()
        const first = mp4(a).get(1)!,
          second = mp4(b).get(1)!
        expect(first.samples.length + second.samples.length).toBe(
          sequences.length,
        )
        decodeVideo(a, first, sequences.slice(0, first.samples.length))
        decodeVideo(b, second, sequences.slice(first.samples.length))
      } finally {
        await rec.close()
        await cam.close()
      }
    },
    30000,
  )
}
const aac = process.env.ZC_TEST_AAC === '1' ? test : test.skip
for (const codec of ['h264', 'hevc'] as const) {
  aac(
    `${codec} AAC/MP4 native async rotation preserves exact A/V segment boundaries`,
    async () => {
      const dir = root(),
        cam = camera(128, 96),
        rec = new Recorder(join(dir, '000.mp4'), {
          width: 128,
          height: 96,
          fps: 25,
          codec,
          gop: 4,
          exclusive: true,
          audio: { sampleRate: 48000, channels: 2 },
        })
      const sequences: bigint[] = []
      try {
        cam.start()
        rec.setRotation(join(dir, '{index:03}.mp4'), { durationMs: 100 })
        for (let i = 0; i < 24; i++) {
          const pcm = new Uint8Array(1920 * 2 * 2)
          const d = new DataView(pcm.buffer)
          for (let s = 0; s < 1920; s++) {
            const value = (((i * 1920 + s) % 200) - 100) * 100
            d.setInt16(s * 4, value, true)
            d.setInt16(s * 4 + 2, -value, true)
          }
          rec.writeAudio(pcm, BigInt(i) * 40_000_000n)
          sequences.push(await feed(cam, rec, i))
          await delay()
        }
        await rec.close()
        let first = 0,
          samples = 0
        const files = readdirSync(dir)
          .filter((x) => x.endsWith('.mp4'))
          .sort()
        expect(files.length).toBeGreaterThan(1)
        for (const name of files) {
          const path = join(dir, name),
            tracks = mp4(path),
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
        expect(first).toBe(24)
        expect(samples).toBe(46080)
      } finally {
        await rec.close()
        await cam.close()
      }
    },
    30000,
  )
}

test('completed job handles retain bounded admission until explicitly released', async () => {
  const dir = root(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  const jobs: PreparationJob[] = []
  try {
    const ids = [
      0n,
      ...Array.from({ length: 7 }, (_, i) =>
        rec.addOutput(join(dir, `o-${i}.mkv`)),
      ),
    ]
    for (const [i, id] of ids.entries()) {
      const job = rec.split(join(dir, `n-${i}.mkv`), id)
      job.cancel()
      jobs.push(job)
    }
    await until(() => jobs.every((job) => job.status.done))
    throwsCode(() => rec.split(join(dir, 'full.mkv')), -4)
    jobs[0].close()
    const next = rec.split(join(dir, 'available.mkv'))
    next.cancel()
    await until(() => next.status.done)
    next.close()
    for (const job of jobs) job.close()
  } finally {
    await rec.close()
    for (const job of jobs) job.close()
  }
})

test('simultaneous stop/close coalesce teardown and preserve native preparation results', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(join(dir, 'a.mkv'), { width: 32, height: 24 })
  const recording = cam.startRecording(rec)
  await until(() => recording.frames >= 4)
  const job = recording.split(join(dir, 'b.mkv'))
  const closing = cam.close()
  throwsCode(() => cam.captureRGB(), -2)
  await Promise.all([closing, cam.close()])
  expect(Number(rec.handle)).toBe(0)
  expect(job.status.done).toBe(true)
  job.close()
})

test('Bun worker dispatch failure releases snapshot/drain handles and allows close retry', async () => {
  const dir = root(),
    cam = camera(),
    rec = new Recorder(null, {
      width: 32,
      height: 24,
      circular: { maxFrames: 8, maxBytes: 1024 * 1024 },
    })
  const OriginalWorker = globalThis.Worker
  try {
    cam.start()
    for (let i = 0; i < 4; i++) await feed(cam, rec, i)
    globalThis.Worker = class {
      constructor() {
        throw new Error('worker spawn failed')
      }
    } as unknown as typeof Worker
    for (let i = 0; i < 3; i++)
      await expect(rec.snapshot(join(dir, `failed-${i}.mkv`))).rejects.toThrow(
        'worker spawn failed',
      )
    await expect(rec.close()).rejects.toThrow('worker spawn failed')
    expect(rec.closing).toBe(false)
    expect(rec.handle).not.toBe(0)
    globalThis.Worker = OriginalWorker
    await rec.snapshot(join(dir, 'successful.mkv'))
    await rec.close()
    expect(mkvFrames(join(dir, 'successful.mkv')).length).toBe(4)
  } finally {
    globalThis.Worker = OriginalWorker
    await rec.close()
    await cam.close()
  }
})
