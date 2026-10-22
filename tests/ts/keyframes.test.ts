import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  CameraError,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, decodeVideoI420, type Track } from './media'
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
const empty = { requested: 0n, applied: 0n, pending: 0 }
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('keyframe timeout')
    await Bun.sleep(1)
  }
}
function camera(yuv = false) {
  const c = new Camera({
    simulate: true,
    writable: true,
    width: 32,
    height: 24,
    fifo: true,
    ...(yuv ? { format: 'YUV420' as const, colorSpace: 'sycc' as const } : {}),
  })
  c.start()
  return c
}
function input(c: Camera, r: Recorder, index: number, async = false) {
  using f = c.acquire()
  if (f.format === 'YUV420')
    f.withMappedStream((map) => {
      for (let p = 0; p < 3; p++)
        for (let y = 0; y < (p ? 12 : 24); y++)
          map.row(y, p).fill(p === 0 ? 100 : p === 1 ? 70 : 170)
    })
  return async
    ? r.writeAsync(f, BigInt(index) * 40000000n)
    : r.write(f, BigInt(index) * 40000000n)
}
function idrs(video: Track) {
  return video.samples.map((sample) => {
    let at = 0,
      idr = false
    while (at < sample.length) {
      const size = sample.readUInt32BE(at)
      at += 4
      expect(size).toBeGreaterThan(0)
      expect(at + size).toBeLessThanOrEqual(sample.length)
      const kind =
        video.codec === 'avc1' ? sample[at] & 31 : (sample[at] >> 1) & 63
      idr ||= video.codec === 'avc1' ? kind === 5 : kind === 19 || kind === 20
      at += size
    }
    return idr
  })
}
function check(path: string, keys: boolean[]) {
  const video = mp4(path).get(1)!
  expect(video.keys).toEqual(keys)
  expect(idrs(video)).toEqual(keys)
  const ref = new Uint8Array((32 * 24 * 3) / 2)
  ref.fill(100, 0, 32 * 24)
  ref.fill(70, 32 * 24, (32 * 24 * 5) / 4)
  ref.fill(170, (32 * 24 * 5) / 4)
  decodeVideoI420(
    path,
    video,
    keys.map(() => ref),
  )
}
for (const codec of ['h264', 'hevc'] as const) {
  media(
    `${codec} counted synchronous requests generate distinct IDRs without consuming invalid inputs`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-key-sync-')),
        path = join(dir, 'video.mp4'),
        c = camera(true)
      const r = new Recorder(path, {
        width: 32,
        height: 24,
        codec,
        gop: 1000,
        quality: 100,
        colorSpace: 'sycc',
      })
      try {
        expect(r.keyframeState()).toEqual(empty)
        input(c, r, 0)
        input(c, r, 1)
        r.requestKeyframe()
        r.requestKeyframe()
        expect(() => input(c, r, 1)).toThrow(CameraError)
        expect(r.keyframeState()).toEqual({
          requested: 2n,
          applied: 0n,
          pending: 2,
        })
        input(c, r, 2)
        expect(r.keyframeState()).toEqual({
          requested: 2n,
          applied: 1n,
          pending: 1,
        })
        input(c, r, 3)
        input(c, r, 4)
        await r.requestKeyframeAsync()
        expect(r.keyframeState()).toEqual({
          requested: 3n,
          applied: 2n,
          pending: 1,
        })
        input(c, r, 5)
        input(c, r, 6)
        await r.flushAsync()
        expect(r.keyframeState()).toEqual({
          requested: 3n,
          applied: 3n,
          pending: 0,
        })
        expect(() => r.requestKeyframe()).toThrow(CameraError)
        await expect(
          Promise.resolve(r.requestKeyframeAsync()),
        ).rejects.toBeInstanceOf(CameraError)
        await r.close()
        check(path, [true, false, true, true, false, true, false])
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
  media(
    `${codec} async requests follow copied writes and cancelled intent never forces a frame`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-key-async-')),
        path = join(dir, 'video.mp4'),
        c = camera(true)
      const r = new Recorder(path, {
        width: 32,
        height: 24,
        codec,
        gop: 1000,
        quality: 100,
        colorSpace: 'sycc',
      })
      try {
        await input(c, r, 0, true)
        const first = input(c, r, 1, true),
          request = r.requestKeyframeAsync(),
          second = input(c, r, 2, true),
          cancelled = r.requestKeyframeAsync()
        const rejected = Promise.resolve(cancelled).catch((e) => e)
        const third = input(c, r, 3, true),
          a = r.requestKeyframeAsync(),
          b = r.requestKeyframeAsync(),
          fourth = input(c, r, 4, true)
        expect(() => r.requestKeyframe()).toThrow(CameraError)
        expect(cancelled.cancel()).toBe(true)
        expect(await rejected).toBeInstanceOf(JobCancelledError)
        await Promise.all([first, request, second, third, a, b, fourth])
        expect(r.keyframeState()).toEqual({
          requested: 3n,
          applied: 2n,
          pending: 1,
        })
        input(c, r, 5)
        input(c, r, 6)
        await r.close()
        check(path, [true, false, true, false, true, true, false])
        expect(r.producerStats().ownedJobs).toBe(0n)
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
}

test('zero-payload keyframe jobs obey producer bounds and wait behind an active blocked write', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let entered = false
  const packets: OutputPacket[] = []
  const sink: CustomOutput = {
    async outputframe(p) {
      entered = true
      await gate
      packets.push(p)
    },
  }
  const c = camera(),
    r = await Recorder.open(sink, {
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 5000 },
      producerQueue: { maxBytes: 65536, maxOperations: 3 },
    })
  try {
    await input(c, r, 0, true)
    await until(() => entered)
    const active = input(c, r, 1, true)
    await until(() => r.producerStats().running)
    await until(() => r.hostIOStats().blockedWaits === 1n)
    const key = r.requestKeyframeAsync(),
      cancelled = r.requestKeyframeAsync()
    const rejected = Promise.resolve(cancelled).catch((e) => e)
    expect(() => r.requestKeyframeAsync()).toThrow(CameraError)
    expect(() => r.requestKeyframe()).toThrow(CameraError)
    expect(cancelled.cancel()).toBe(true)
    expect(await rejected).toBeInstanceOf(JobCancelledError)
    await cancelled.operationDone
    expect(key.done).toBe(false)
    release()
    await active
    await key
    expect(r.keyframeState()).toEqual({
      requested: 1n,
      applied: 0n,
      pending: 1,
    })
    await input(c, r, 2, true)
    expect(r.keyframeState()).toEqual({
      requested: 1n,
      applied: 1n,
      pending: 0,
    })
    await r.close()
    expect(packets.length).toBe(3)
    expect(r.producerStats().ownedJobs).toBe(0n)
    expect(r.producerStats().rejected).toBe(1n)
  } finally {
    release()
    await r.close()
    await c.close()
  }
})

test('pending keyframe intent survives cancelled restart and resets only with a published session', async () => {
  const c = camera(),
    r = new Recorder(null, { width: 32, height: 24 })
  try {
    r.requestKeyframe()
    r.requestKeyframe()
    input(c, r, 0)
    await r.flushAsync()
    const previous = { requested: 2n, applied: 1n, pending: 1 }
    expect(r.keyframeState()).toEqual(previous)
    const restart = r.restartAsync(),
      rejected = Promise.resolve(restart).catch((e) => e)
    expect(restart.cancel()).toBe(true)
    expect(await rejected).toBeInstanceOf(JobCancelledError)
    await restart.operationDone
    expect(r.keyframeState()).toEqual(previous)
    await r.restartAsync()
    expect(r.keyframeState()).toEqual(empty)
    await r.requestKeyframeAsync()
    input(c, r, 0)
    expect(r.keyframeState()).toEqual({
      requested: 1n,
      applied: 1n,
      pending: 0,
    })
  } finally {
    await r.close()
    await c.close()
  }
})

test('active camera recording exposes ordered keyframe requests and rejects them after stop', async () => {
  const c = camera(),
    r = new Recorder(null, { width: 32, height: 24, asyncWrites: true })
  const recording = c.startRecording(r)
  try {
    await until(() => recording.frames >= 2)
    await recording.requestKeyframeAsync()
    await recording.flushAsync()
    expect(r.keyframeState().requested).toBe(1n)
    expect(() => recording.requestKeyframe()).toThrow(CameraError)
    expect(() => recording.requestKeyframeAsync()).toThrow(CameraError)
  } finally {
    await recording.close()
    await r.close()
    await c.close()
  }
})

test('keyframe job options cannot close the owner between snapshot and native admission', async () => {
  const r = new Recorder(null, { width: 32, height: 24 })
  let closing: Promise<void> | undefined,
    reads = 0
  expect(() =>
    r.requestKeyframeAsync({
      get signal() {
        reads++
        closing = r.close()
        return undefined
      },
    }),
  ).toThrow(CameraError)
  await closing
  expect(reads).toBe(1)
  expect(r.producerStats().ownedJobs).toBe(0n)
})

test('encoder-applied intent remains observable when its output fails, and a failed recorder rejects more requests', async () => {
  const c = camera()
  const r = await Recorder.open(
    { outputframe() {} },
    {
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 1, maxOperations: 1 },
    },
  )
  try {
    r.requestKeyframe()
    expect(() => input(c, r, 0)).toThrow(CameraError)
    expect(r.keyframeState()).toEqual({
      requested: 1n,
      applied: 1n,
      pending: 0,
    })
    expect(() => r.requestKeyframe()).toThrow(CameraError)
    await expect(
      Promise.resolve(r.requestKeyframeAsync()),
    ).rejects.toBeInstanceOf(CameraError)
  } finally {
    await r.close().catch(() => {})
    await c.close()
  }
})
