import { test, expect } from 'bun:test'
import {
  Camera,
  Recorder,
  CircularOutput2,
  FileOutput,
  MuxedOutput,
  CameraError,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
import { native as n } from '../../ts/ffi'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, decodeVideoI420 } from './media'
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
class Tape implements CustomOutput {
  packets: OutputPacket[] = []
  outputframe(packet: OutputPacket) {
    if (!packet.audio)
      this.packets.push({ ...packet, data: packet.data.slice() })
  }
}
function camera() {
  const c = new Camera({
    simulate: true,
    writable: true,
    width: 32,
    height: 24,
    format: 'YUV420',
    colorSpace: 'sycc',
    fifo: true,
  })
  c.start()
  return c
}
function input(c: Camera, r: Recorder, index: number) {
  using f = c.acquire()
  f.withMappedStream((m) => {
    for (let p = 0; p < 3; p++)
      for (let y = 0; y < (p ? 12 : 24); y++)
        m.row(y, p).fill(p === 0 ? 100 : p === 1 ? 70 : 170)
  })
  r.write(f, BigInt(index) * 40000000n)
}
function nalUnits(data: Uint8Array, annex: boolean) {
  const bytes = Buffer.from(data),
    units: Buffer[] = []
  if (annex) {
    const start = Buffer.from([0, 0, 0, 1])
    let at = 0
    while (at < bytes.length) {
      expect(bytes.subarray(at, at + 4)).toEqual(start)
      const next = bytes.indexOf(start, at + 4)
      const end = next < 0 ? bytes.length : next
      expect(end).toBeGreaterThan(at + 4)
      units.push(bytes.subarray(at + 4, end))
      at = end
    }
  } else {
    let at = 0
    while (at < bytes.length) {
      const size = bytes.readUInt32BE(at)
      at += 4
      expect(size).toBeGreaterThan(0)
      expect(at + size).toBeLessThanOrEqual(bytes.length)
      units.push(bytes.subarray(at, at + size))
      at += size
    }
  }
  return units
}
function kind(nal: Uint8Array, codec: 'h264' | 'hevc') {
  return codec === 'h264' ? nal[0] & 31 : (nal[0] >> 1) & 63
}
function parameters(packet: OutputPacket, codec: 'h264' | 'hevc') {
  expect(packet.annexB).toBe(true)
  return nalUnits(packet.data, true).filter((n) =>
    codec === 'h264'
      ? [7, 8, 13].includes(kind(n, codec))
      : [32, 33, 34].includes(kind(n, codec)),
  )
}
function checkPackets(tape: Tape, codec: 'h264' | 'hevc', repeat: boolean) {
  expect(tape.packets.length).toBeGreaterThan(2)
  const first = parameters(tape.packets[0], codec)
  expect(first.map((n) => kind(n, codec))).toEqual(
    codec === 'h264' ? [7, 8] : [32, 33, 34],
  )
  for (const [p, packet] of tape.packets.entries()) {
    const sets = parameters(packet, codec)
    expect(sets).toEqual(p === 0 || (packet.keyframe && repeat) ? first : [])
    if (p > 0 && packet.keyframe && repeat) {
      const types = nalUnits(packet.data, true).map((n) => kind(n, codec))
      expect(types).not.toContain(codec === 'h264' ? 6 : 39)
    }
  }
}
function decode(
  dir: string,
  name: string,
  codec: 'h264' | 'hevc',
  packets: OutputPacket[],
) {
  const tool = process.env.ZC_INDEPENDENT_DECODER
  if (!tool) return
  const path = join(dir, `${name}.aus`),
    refs = join(dir, `${name}.i420`)
  writeFileSync(
    path,
    Buffer.concat(
      packets.flatMap((p) => {
        const size = Buffer.alloc(4)
        size.writeUInt32BE(p.data.length)
        return [size, Buffer.from(p.data)]
      }),
    ),
  )
  const frame = Buffer.alloc((32 * 24 * 3) / 2)
  frame.fill(100, 0, 32 * 24)
  frame.fill(70, 32 * 24, (32 * 24 * 5) / 4)
  frame.fill(170, (32 * 24 * 5) / 4)
  writeFileSync(refs, Buffer.concat(packets.map(() => frame)))
  const result = Bun.spawnSync([
    tool,
    codec,
    path,
    String(packets.length),
    '--i420',
    '32',
    '24',
    refs,
  ])
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
}
for (const codec of ['h264', 'hevc'] as const)
  for (const policy of [undefined, false, true])
    media(
      `${codec} packet policy ${String(policy)} preserves raw files, PTS, muxed samples and fresh decoder joins`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zc-repeat-')),
          c = camera(),
          tape = new Tape(),
          path = join(dir, 'raw.bin'),
          pts = join(dir, 'raw.pts'),
          muxed = join(dir, 'peer.mp4')
        const options = {
          width: 32,
          height: 24,
          codec,
          gop: 1000,
          quality: 100,
          colorSpace: 'sycc' as const,
          repeatHeaders: policy,
        }
        const r = await Recorder.open(tape, options)
        try {
          options.repeatHeaders = !(policy ?? true)
          expect(r.repeatedHeaders()).toBe(policy ?? true)
          await r.addOutput(new FileOutput(path, { pts }))
          await r.addOutput(new MuxedOutput(muxed))
          for (let i = 0; i < 6; i++) {
            if (i === 2 || i === 4) await r.requestKeyframeAsync()
            input(c, r, i)
          }
          await r.close()
          expect(tape.packets.map((p) => p.keyframe)).toEqual([
            true,
            false,
            true,
            false,
            true,
            false,
          ])
          checkPackets(tape, codec, policy ?? true)
          expect(r.hostIOStats().completedBytes).toBe(
            BigInt(
              tape.packets.reduce((sum, packet) => sum + packet.data.length, 0),
            ),
          )
          expect(readFileSync(path)).toEqual(
            Buffer.concat(tape.packets.map((p) => Buffer.from(p.data))),
          )
          expect(readFileSync(pts, 'utf8')).toBe(
            '0.000\n40.000\n80.000\n120.000\n160.000\n200.000\n',
          )
          decode(dir, 'all', codec, tape.packets)
          if (policy ?? true)
            decode(dir, 'joined', codec, tape.packets.slice(2))
          const video = mp4(muxed).get(1)!
          expect(video.samples.length).toBe(6)
          for (const sample of video.samples)
            for (const nal of nalUnits(sample, false))
              expect(
                codec === 'h264' ? [7, 8, 13] : [32, 33, 34],
              ).not.toContain(kind(nal, codec))
          const ref = new Uint8Array((32 * 24 * 3) / 2)
          ref.fill(100, 0, 32 * 24)
          ref.fill(70, 32 * 24, (32 * 24 * 5) / 4)
          ref.fill(170, (32 * 24 * 5) / 4)
          decodeVideoI420(
            muxed,
            video,
            video.samples.map(() => ref),
          )
        } finally {
          await r.close()
          await c.close()
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )

test('repeatHeaders validates and snapshots before file creation or output hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zc-repeat-invalid-')),
    path = join(dir, 'not-created.mp4')
  let starts = 0
  try {
    for (const repeatHeaders of [null, 0, 1, 'true', {}, [], NaN]) {
      const options = {
        width: 32,
        height: 24,
        repeatHeaders: repeatHeaders as never,
      }
      expect(() => new Recorder(path, options)).toThrow()
      await expect(
        Recorder.open(
          {
            start() {
              starts++
            },
            outputframe() {},
          },
          options,
        ),
      ).rejects.toThrow()
      expect(existsSync(path)).toBe(false)
    }
    expect(starts).toBe(0)
    const r = new Recorder(null, { width: 32, height: 24 })
    try {
      expect(r.repeatedHeaders()).toBe(true)
      expect(n.zc_video_set_repeat_headers(r.handle, 2)).toBe(-1)
      expect(r.repeatedHeaders()).toBe(true)
      expect(n.zc_video_set_repeat_headers(r.handle, 0)).toBe(0)
      expect(r.repeatedHeaders()).toBe(false)
      await r.openOutput(new Tape())
      expect(n.zc_video_set_repeat_headers(r.handle, 1)).toBe(-4)
      expect(r.repeatedHeaders()).toBe(false)
    } finally {
      await r.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const codec of ['h264', 'hevc'] as const)
  media(
    `${codec} snapshots, delayed replay and split preparation retain copied policy`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-repeat-life-'))
      try {
        for (const repeatHeaders of [false, true]) {
          const c = camera(),
            r = new CircularOutput2({
              width: 32,
              height: 24,
              codec,
              gop: 2,
              quality: 100,
              colorSpace: 'sycc',
              repeatHeaders,
              bufferDurationMs: 40,
              circular: { maxBytes: 1048576, maxFrames: 32, durationMs: 2000 },
            })
          try {
            const history = new Recorder(null, {
              width: 32,
              height: 24,
              codec,
              gop: 2,
              quality: 100,
              colorSpace: 'sycc',
              repeatHeaders,
              circular: { maxBytes: 1048576, maxFrames: 32, durationMs: 2000 },
            })
            try {
              for (let i = 0; i < 6; i++) input(c, history, i)
              const snapshot = new Tape()
              await history.snapshot(snapshot)
              checkPackets(snapshot, codec, repeatHeaders)
              decode(
                dir,
                String(repeatHeaders) + '-snapshot',
                codec,
                snapshot.packets,
              )
            } finally {
              await history.close()
            }
            const a = new Tape()
            await r.openOutput(a)
            for (let i = 0; i < 6; i++) input(c, r, i)
            for (let i = 6; i < 10; i++) input(c, r, i)
            await r.drain()
            const b = new Tape(),
              split = r.split(b)
            let index = 10
            const deadline = performance.now() + 5000
            while (!split.status.done) {
              if (performance.now() > deadline) throw Error('split timeout')
              input(c, r, index++)
              await Bun.sleep(2)
            }
            await split.wait({ timeoutMs: 5000 })
            split.close()
            for (let i = 0; i < 5; i++) input(c, r, index++)
            await r.flushAsync()
            checkPackets(a, codec, repeatHeaders)
            checkPackets(b, codec, repeatHeaders)
            decode(dir, `${repeatHeaders}-split`, codec, b.packets)
            expect(r.repeatedHeaders()).toBe(repeatHeaders)
          } finally {
            await r.close()
            await c.close()
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

media(
  'session header policy preserves rollback and inheritance, and null explicitly restores the default',
  async () => {
    const c = camera(),
      first = new Tape(),
      r = await Recorder.open(first, {
        width: 32,
        height: 24,
        codec: 'h264',
        gop: 2,
        colorSpace: 'sycc',
        repeatHeaders: false,
      })
    try {
      for (let i = 0; i < 4; i++) input(c, r, i)
      await r.flushAsync()
      const cancelled = r.reconfigureAsync({ repeatHeaders: true }, new Tape()),
        rejected = Promise.resolve(cancelled).catch((e) => e)
      expect(cancelled.cancel()).toBe(true)
      expect(await rejected).toBeInstanceOf(JobCancelledError)
      await cancelled.operationDone
      expect(r.repeatedHeaders()).toBe(false)
      const second = new Tape()
      await r.reconfigureAsync({ codec: 'hevc' }, second)
      expect(r.repeatedHeaders()).toBe(false)
      for (let i = 0; i < 4; i++) input(c, r, i)
      await r.flushAsync()
      checkPackets(second, 'hevc', false)
      const third = new Tape()
      await r.reconfigureAsync({ repeatHeaders: null, gop: 2 }, third)
      expect(r.repeatedHeaders()).toBe(true)
      for (let i = 0; i < 4; i++) input(c, r, i)
      await r.flushAsync()
      checkPackets(third, 'hevc', true)
      expect(r.options.repeatHeaders).toBeUndefined()
    } finally {
      await r.close()
      await c.close()
    }
  },
)

for (const codec of ['h264', 'hevc'] as const)
  media(
    `${codec} recovered outputs inherit the session's repeated-header policy`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-repeat-recover-')),
        c = camera(),
        healthy = new Tape(),
        failure = new Error('intentional packet sink failure')
      const r = await Recorder.open(healthy, {
        width: 32,
        height: 24,
        codec,
        gop: 2,
        quality: 100,
        colorSpace: 'sycc',
        repeatHeaders: true,
        isolate: true,
      })
      try {
        const id = await r.addOutput({
          outputframe() {
            throw failure
          },
        })
        let index = 0
        const deadline = performance.now() + 5000
        while (r.outputState(id).errorCode === 0) {
          if (performance.now() > deadline) throw Error('sink failure timeout')
          input(c, r, index++)
          await Bun.sleep(2)
        }
        const fresh = new Tape(),
          job = r.recover(fresh, id)
        while (!job.status.done) {
          if (performance.now() > deadline) throw Error('recovery timeout')
          input(c, r, index++)
          await Bun.sleep(2)
        }
        await job.wait({ timeoutMs: 5000 })
        job.close()
        for (let i = 0; i < 6; i++) input(c, r, index++)
        await r.close()
        checkPackets(fresh, codec, true)
        decode(dir, 'recovered', codec, fresh.packets)
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

for (const codec of ['h264', 'hevc'] as const)
  media(
    `${codec} coordinated camera/recorder modes preserve an explicit first-only policy`,
    async () => {
      const c = camera(),
        before = new Tape(),
        r = await Recorder.open(before, {
          width: 32,
          height: 24,
          codec,
          gop: 2,
          colorSpace: 'sycc',
          repeatHeaders: false,
        })
      c.preCallback = (f) =>
        f.withMappedStream((m) => {
          for (let p = 0; p < 3; p++)
            for (let y = 0; y < (p ? 12 : 24); y++)
              m.row(y, p).fill(p === 0 ? 100 : p === 1 ? 70 : 170)
        })
      let recording = c.startRecording(r)
      const wait = async (fn: () => boolean) => {
        const end = performance.now() + 5000
        while (!fn()) {
          if (performance.now() > end) throw Error('mode frame timeout')
          await Bun.sleep(1)
        }
      }
      try {
        await wait(() => recording.frames >= 4)
        const after = new Tape()
        recording = await c.switchRecordingModeAsync(
          r,
          {
            simulate: true,
            writable: true,
            width: 32,
            height: 24,
            format: 'YUV420',
            colorSpace: 'sycc',
            fifo: true,
          },
          {},
          after,
        )
        expect(r.repeatedHeaders()).toBe(false)
        await wait(() => recording.frames >= 5)
        await recording.flushAsync()
        checkPackets(after, codec, false)
        expect(r.options.repeatHeaders).toBe(false)
      } finally {
        await recording.close()
        await r.close()
        await c.close()
      }
    },
  )

test('session repeatHeaders accessors are read once before native job admission', async () => {
  const r = new Recorder(null, { width: 32, height: 24, repeatHeaders: false })
  let reads = 0
  try {
    await r.flushAsync()
    await r.reconfigureAsync({
      get repeatHeaders() {
        reads++
        return true
      },
    })
    expect(reads).toBe(1)
    expect(r.repeatedHeaders()).toBe(true)
  } finally {
    await r.close()
  }
})
