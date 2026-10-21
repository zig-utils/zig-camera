import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  AudioCapture,
  JobCancelledError,
  type Frame,
  type OutputPacket,
} from '../../ts'
import { native as n, ptr } from '../../ts/ffi'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mp4, decodeVideoI420, decodeAudio, mkvFrames } from './media'
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > end) throw Error('timeout')
    await pause()
  }
}
const fail = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const camera = (rgb = false) =>
  new Camera({
    simulate: true,
    width: 64,
    height: 48,
    fifo: true,
    writable: true,
    lores: { width: 32, height: 24, rgb },
  })
function edit(frame: Frame, rgb: boolean, index: number) {
  frame.withMappedStream((map) => {
    for (const plane of map.planes) plane.bytes.fill(0xee)
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 32; x++) {
        if (rgb)
          map
            .row(y)
            .set(
              [
                (x * 7 + index * 20) & 255,
                (y * 9 + index * 10) & 255,
                ((x + y) * 5 + index * 13) & 255,
              ],
              x * 3,
            )
        else {
          map.row(y)[x] = 20 + ((x * 5 + y * 3 + index * 20) % 220)
          map.row(Math.floor(y / 2), 1)[Math.floor(x / 2)] =
            64 + Math.floor(x / 2) * 8 + index * 8
          map.row(Math.floor(y / 2), 2)[Math.floor(x / 2)] =
            80 + Math.floor(y / 2) * 10 + index * 5
        }
      }
  }, 'lores')
}
function canonical(frame: Frame, rgb: boolean) {
  const source = frame.copyStream('lores').data,
    out = new Uint8Array((32 * 24 * 3) / 2),
    pixels = 32 * 24
  if (!rgb) {
    for (let i = 0; i < pixels; i++)
      out[i] = 16 + Math.round((source[i] * 219) / 255)
    for (let i = pixels; i < out.length; i++)
      out[i] = 128 + Math.round(((source[i] - 128) * 224) / 255)
    return out
  }
  for (let y = 0; y < 24; y += 2)
    for (let x = 0; x < 32; x += 2) {
      let r = 0,
        g = 0,
        b = 0
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const off = ((y + dy) * 32 + x + dx) * 3,
            red = source[off],
            green = source[off + 1],
            blue = source[off + 2]
          out[(y + dy) * 32 + x + dx] = Math.round(
            16 + (219 * (0.299 * red + 0.587 * green + 0.114 * blue)) / 255,
          )
          r += red
          g += green
          b += blue
        }
      const luma = 0.299 * r + 0.587 * g + 0.114 * b,
        i = (y / 2) * 16 + x / 2
      out[pixels + i] = Math.round(
        128 + ((224 / 255) * (b - luma)) / (2 * (1 - 0.114) * 4),
      )
      out[pixels + pixels / 4 + i] = Math.round(
        128 + ((224 / 255) * (r - luma)) / (2 * (1 - 0.299) * 4),
      )
    }
  return out
}
for (const rgb of [false, true])
  for (const asyncWrites of [false, true])
    test(`manual ${rgb ? 'RGB' : 'I420'} lores MJPEG ${asyncWrites ? 'producer' : 'sync'} owns pixels and preserves main`, async () => {
      const c = camera(rgb),
        packets: OutputPacket[] = [],
        expected: Uint8Array[] = [],
        dir = mkdtempSync(join(tmpdir(), 'zc-record-stream-'))
      const r = await Recorder.open(
        {
          outputframe(packet) {
            packets.push(packet)
          },
        },
        {
          width: 32,
          height: 24,
          stream: 'lores',
          quality: 98,
          asyncWrites,
          producerQueue: { maxBytes: rgb ? 2304 : 1152, maxOperations: 1 },
        },
      )
      try {
        c.start()
        for (let i = 0; i < 3; i++) {
          using frame = c.acquire()
          const main = frame.copyRGB()
          edit(frame, rgb, i)
          expected.push(frame.copyRGB('lores'))
          expect(frame.copyRGB()).toEqual(main)
          if (asyncWrites) {
            const job = r.writeAsync(frame, BigInt(i) * 40_000_000n)
            expect(r.producerStats().ownedBytes).toBe(BigInt(rgb ? 2304 : 1152))
            frame.withMappedStream((map) => {
              for (const plane of map.planes) plane.bytes.fill(0)
            }, 'lores')
            frame.release()
            await job
          } else r.write(frame, BigInt(i) * 40_000_000n)
        }
        await r.close()
        expect(packets.length).toBe(3)
        const decoder = process.env.ZC_IMAGE_DECODER
        if (decoder)
          for (let i = 0; i < 3; i++) {
            const path = join(dir, `${i}.jpg`)
            writeFileSync(path, packets[i].data)
            const result = Bun.spawnSync([decoder, 'jpeg', path])
            expect(result.exitCode).toBe(0)
            const data = Buffer.from(result.stdout)
            expect([data.readUInt32LE(0), data.readUInt32LE(4)]).toEqual([
              32, 24,
            ])
            let total = 0
            for (let j = 0; j < expected[i].length; j++)
              total += Math.abs(data[j + 8] - expected[i][j])
            expect(total / expected[i].length).toBeLessThan(4)
          }
        expect(c.stats().leased).toBe(0)
      } finally {
        await c.close()
        await r.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })

for (const codec of ['h264', 'hevc'] as const)
  for (const rgb of [false, true])
    (process.env.ZC_TEST_CODECS ? test : test.skip)(
      `${codec} ${rgb ? 'RGB' : 'I420'} lores sync/async MP4 retains all YUV components without an RGB round trip`,
      async () => {
        const c = camera(rgb),
          dir = mkdtempSync(join(tmpdir(), 'zc-codec-stream-')),
          path = join(dir, 'lores.mp4'),
          expected: Uint8Array[] = []
        const r = new Recorder(path, {
          width: 32,
          height: 24,
          stream: 'lores',
          codec,
          quality: 100,
          gop: 2,
          fps: 25,
        })
        try {
          c.start()
          for (let i = 0; i < 4; i++) {
            using frame = c.acquire()
            edit(frame, rgb, i)
            expected.push(canonical(frame, rgb))
            if (i % 2) {
              const job = r.writeAsync(frame, BigInt(i) * 40_000_000n)
              frame.release()
              await job
            } else r.write(frame, BigInt(i) * 40_000_000n)
          }
          await r.close()
          const video = mp4(path).get(1)!
          expect([video.width, video.height]).toEqual([32, 24])
          expect(video.samples.length).toBe(4)
          const file = readFileSync(path),
            color = file.indexOf('nclx')
          expect(color).toBeGreaterThan(0)
          expect([...file.subarray(color + 4, color + 11)]).toEqual([
            0, 1, 0, 13, 0, 6, 0,
          ])
          decodeVideoI420(path, video, expected)
          expect(c.stats().leased).toBe(0)
        } finally {
          await r.close()
          await c.close()
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )

test('lores recording pump coexists with main capture and focus jobs, and session changes retain source', async () => {
  const c = camera(),
    packets: OutputPacket[] = []
  const r = await Recorder.open(
    {
      outputframe(packet) {
        packets.push(packet)
      },
    },
    { width: 32, height: 24, stream: 'lores', asyncWrites: true },
  )
  try {
    c.startContinuousAutofocus()
    const recording = c.startRecording(r)
    expect((await c.captureFocusLockedRGB()).length).toBe(64 * 48 * 3)
    await until(() => recording.frames >= 3)
    await recording.flushAsync()
    expect(recording.error).toBeUndefined()
    expect(c.stats().leased).toBe(0)
    expect(r.options.stream).toBe('lores')
    await r.restartAsync({
      outputframe(packet) {
        packets.push(packet)
      },
    })
    expect(r.options.stream).toBe('lores')
    const again = c.startRecording(r)
    await until(() => again.frames >= 2)
    const next = await again.switchModeAsync(
      { width: 80, height: 60, lores: { width: 40, height: 30, rgb: true } },
      {},
      {
        outputframe(packet) {
          packets.push(packet)
        },
      },
    )
    expect([r.width, r.height, r.options.stream]).toEqual([40, 30, 'lores'])
    expect(c.info().width).toBe(80)
    await until(() => next.frames >= 2)
    await next.flushAsync()
    await r.reconfigureAsync(
      { stream: 'main', width: 80, height: 60 },
      { outputframe() {} },
    )
    expect(r.options.stream).toBe('main')
    const main = c.startRecording(r)
    await until(() => main.frames >= 2)
    await main.flushAsync()
  } finally {
    await c.close()
    await r.close()
  }
})

test('unavailable sources and incompatible geometry reject before camera ownership or session flush', async () => {
  const absent = new Camera({ simulate: true, width: 64, height: 48 }),
    c = camera(),
    r = await Recorder.open(
      { outputframe() {} },
      { stream: 'lores', width: 32, height: 24 },
    )
  try {
    expect(() => absent.startRecording(r)).toThrow()
    expect(r.sessionState().phase).toBe('open')
    const recording = c.startRecording(r)
    await until(() => recording.frames >= 2)
    expect(() =>
      recording.switchModeAsync(
        { width: 80, height: 60 },
        {},
        { outputframe() {} },
      ),
    ).toThrow()
    expect(r.sessionState().phase).toBe('open')
    const before = recording.frames
    await until(() => recording.frames > before)
    await recording.flushAsync()
    const mismatched = new Recorder(null, {
      width: 64,
      height: 48,
      stream: 'lores',
      circular: { maxFrames: 4, maxBytes: 65536 },
    })
    try {
      expect(() => c.startRecording(mismatched)).toThrow()
    } finally {
      await mismatched.close()
    }
  } finally {
    await absent.close()
    await c.close()
    await r.close()
  }
})

test('source color preflight rejects incompatible transfer/gamut rather than tagging misleading video', async () => {
  const c = camera(),
    data = new Uint8Array(24),
    view = new DataView(data.buffer)
  try {
    expect(n.zc_get_stream_color_space(c.handle, 2, ptr(data))).toBe(0)
    expect(n.zc_video_check_input_color(ptr(data), 0)).toBe(0)
    view.setUint32(12, 3, true)
    expect(n.zc_video_check_input_color(ptr(data), 0)).toBe(-8)
    view.setUint32(12, 2, true)
    view.setUint32(8, 4, true)
    expect(n.zc_video_check_input_color(ptr(data), 0)).toBe(-8)
  } finally {
    await c.close()
  }
})

for (const codec of ['h264', 'hevc'] as const)
  (process.env.ZC_TEST_CODECS && process.env.ZC_TEST_AAC ? test : test.skip)(
    `${codec} lores I420 producer groups retain AAC synchronization and exact video/color order`,
    async () => {
      const c = camera(),
        dir = mkdtempSync(join(tmpdir(), 'zc-stream-av-')),
        path = join(dir, 'lores.mp4'),
        expected: Uint8Array[] = []
      const audio = new AudioCapture({
        simulate: true,
        sampleRate: 48000,
        channels: 2,
        blockFrames: 1920,
      })
      const r = new Recorder(path, {
        stream: 'lores',
        width: 32,
        height: 24,
        codec,
        fps: 25,
        quality: 100,
        gop: 2,
        audio: { sampleRate: 48000, channels: 2, bitrate: 128000 },
      })
      try {
        c.start()
        for (let i = 0; i < 6; i++) {
          using frame = c.acquire()
          edit(frame, false, i % 3)
          expected.push(canonical(frame, false))
          const block = audio.read(0)
          const job = r.writeAVAsync(frame, [block], BigInt(i) * 40_000_000n)
          expect(r.producerStats().ownedBytes).toBe(
            1152n + BigInt(block.data.length) + 24n,
          )
          frame.release()
          await job
        }
        await r.close()
        const tracks = mp4(path)
        decodeVideoI420(path, tracks.get(1)!, expected)
        decodeAudio(path, tracks.get(2)!, 0, 6 * 1920)
        expect(tracks.get(2)!.presentedUs).toBe(240000n)
        expect(c.stats().leased).toBe(0)
      } finally {
        audio.close()
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

test('lores queued cancellation preserves compact admission accounting and later frames', async () => {
  const c = camera(),
    packets: OutputPacket[] = []
  let release!: () => void,
    entered = false
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = await Recorder.open(
    {
      async outputframe(packet) {
        entered = true
        await hold
        packets.push(packet)
      },
    },
    {
      stream: 'lores',
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 65536, maxOperations: 1, waitMs: 1000 },
      producerQueue: { maxBytes: 1152 * 3, maxOperations: 3 },
    },
  )
  const submit = (i: number) => {
    using frame = c.acquire()
    return r.writeAsync(frame, BigInt(i) * 40_000_000n)
  }
  try {
    c.start()
    await submit(0)
    await until(() => entered)
    const active = submit(1)
    await until(() => r.producerStats().running)
    const skipped = submit(2),
      result = fail(skipped)
    expect(skipped.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    const next = submit(3)
    expect(r.producerStats().highBytes).toBeLessThanOrEqual(1152n * 3n)
    release()
    await active
    await next
    await r.close()
    expect(packets.map((packet) => packet.timestampNs)).toEqual([
      0n,
      40_000_000n,
      120_000_000n,
    ])
    expect(r.producerStats().ownedBytes).toBe(0n)
    expect(c.stats().leased).toBe(0)
  } finally {
    release()
    await r.close()
    await c.close()
  }
})

test('lores circular snapshots and async output splits preserve the chosen encoder source', async () => {
  const c = camera(),
    dir = mkdtempSync(join(tmpdir(), 'zc-stream-ring-')),
    path = join(dir, 'snapshot.mkv'),
    next = join(dir, 'next.mkv')
  const r = await Recorder.open(
    { outputframe() {} },
    {
      stream: 'lores',
      width: 32,
      height: 24,
      circular: { maxFrames: 16, maxBytes: 1024 * 1024 },
    },
  )
  try {
    c.start()
    for (let i = 0; i < 4; i++) {
      using frame = c.acquire()
      await r.writeAsync(frame, BigInt(i) * 40_000_000n)
    }
    await r.snapshot(path)
    expect(mkvFrames(path).length).toBe(4)
    const split = r.split(next)
    for (let i = 4; i < 8; i++) {
      using frame = c.acquire()
      await r.writeAsync(frame, BigInt(i) * 40_000_000n)
    }
    await split
    split.close()
    await r.close()
    const images = [...mkvFrames(path), ...mkvFrames(next)],
      decoder = process.env.ZC_IMAGE_DECODER
    expect(images.length).toBeGreaterThan(4)
    if (decoder)
      for (let i = 0; i < images.length; i++) {
        const jpeg = join(dir, `${i}.jpg`)
        writeFileSync(jpeg, images[i])
        const decoded = Bun.spawnSync([decoder, 'jpeg', jpeg])
        expect(decoded.exitCode).toBe(0)
        const bytes = Buffer.from(decoded.stdout)
        expect([bytes.readUInt32LE(0), bytes.readUInt32LE(4)]).toEqual([32, 24])
      }
  } finally {
    await r.close()
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('producer options and audio getters resolve before taking native pixel or PCM ownership', async () => {
  const c = camera(),
    r = await Recorder.open(
      { outputframe() {} },
      {
        stream: 'lores',
        width: 32,
        height: 24,
        audio: { sampleRate: 48000, channels: 1 },
      },
    )
  let teardown: Promise<void> | undefined
  try {
    c.start()
    using frame = c.acquire()
    expect(() => r.writeAsync(frame, 0n, { timeoutMs: NaN })).toThrow(
      RangeError,
    )
    expect(r.producerStats().ownedJobs).toBe(0n)
    const first = new Uint8Array(8)
    const blocks = [
      { data: first, timestampNs: 0n },
      {
        data: new Uint8Array(8),
        get timestampNs() {
          first.buffer.transfer()
          return 100000n
        },
      },
    ]
    expect(() => r.writeAVAsync(frame, blocks, 0n)).toThrow()
    expect(r.producerStats().ownedJobs).toBe(0n)
    expect(() =>
      r.writeAsync(frame, 0n, {
        get signalFunction() {
          teardown = r.close()
          return undefined
        },
      }),
    ).toThrow()
    await teardown
    expect(Number(r.handle)).toBe(0)
  } finally {
    await teardown
    await r.close()
    await c.close()
  }
})
