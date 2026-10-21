import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  MuxedOutput,
  CircularOutput2,
  type Frame,
  type ColorSpaceDescription,
  type ColorSpaceRequest,
  type OutputStreams,
} from '../../ts'

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mp4, decodeVideoI420 } from './media'
import { bitstreamColor } from './color-signaling'
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip
const av =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('timeout')
    await pause()
  }
}
const profile = (
  matrix: ColorSpaceDescription['ycbcrEncoding'],
  full = false,
): ColorSpaceDescription => ({
  primaries: matrix === 'rec2020' ? 'rec2020' : 'rec709',
  transfer: 'rec709',
  ycbcrEncoding: matrix,
  range: full ? 'full' : 'limited',
})
const codes = (color: ColorSpaceDescription) => ({
  primaries: { rec709: 1, smpte170m: 6, rec2020: 9 }[color.primaries],
  transfer: { rec709: 1, linear: 8, srgb: 13 }[color.transfer],
  matrix: { rec709: 1, rec601: 6, rec2020: 9, none: 0 }[color.ycbcrEncoding],
  fullRange: color.range === 'full',
})
const legacy: ColorSpaceDescription = {
  primaries: 'rec709',
  transfer: 'srgb',
  ycbcrEncoding: 'rec601',
  range: 'limited',
}
const info = (color: ColorSpaceDescription) => ({ present: true, ...color })
function checkFile(
  path: string,
  color: ColorSpaceDescription,
  expected?: readonly Uint8Array[],
) {
  const video = mp4(path).get(1)!
  expect(video.color).toEqual(codes(color))
  expect(bitstreamColor(video)).toEqual(codes(color))
  if (expected) decodeVideoI420(path, video, expected)
  return video
}
function edit(frame: Frame, stream: 'main' | 'lores', index: number) {
  frame.withMappedStream((map) => {
    for (const plane of map.planes) plane.bytes.fill(0xee)
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++) {
        if (map.format === 'BGR888')
          map
            .row(y)
            .set(
              [
                20 + ((x * 4 + index * 11) % 200),
                30 + ((y * 5 + index * 7) % 180),
                40 + (((x + y) * 3 + index * 9) % 170),
              ],
              x * 3,
            )
        else {
          map.row(y)[x] = 20 + ((x * 3 + y * 2 + index * 13) % 210)
          map.row(y >> 1, 1)[x >> 1] = 90 + (((x >> 1) + index * 3) % 60)
          map.row(y >> 1, 2)[x >> 1] = 100 + (((y >> 1) + index * 2) % 55)
        }
      }
  }, stream)
}
// Independent floating-point source inverse + target matrix/range. YCbCr
// conversion keeps out-of-gamut intermediates, then clamps encoded output.
function reference(
  frame: Frame,
  stream: 'main' | 'lores',
  target: ColorSpaceDescription,
) {
  const source = frame.copyStream(stream),
    c = frame.colorSpace(stream),
    w = source.width,
    h = source.height,
    p = w * h,
    out = new Uint8Array((p * 3) / 2)
  const weights = (matrix: string) =>
    matrix === 'rec709'
      ? [0.2126, 0.0722]
      : matrix === 'rec2020'
        ? [0.2627, 0.0593]
        : [0.299, 0.114]
  const [kr, kb] = weights(target.ycbcrEncoding),
    kg = 1 - kr - kb,
    yr = target.range === 'full' ? 255 : 219,
    uv = target.range === 'full' ? 255 : 224,
    off = target.range === 'full' ? 0 : 16
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      let cb = 0,
        cr = 0
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const pos = (y + dy) * w + x + dx
          let r: number, g: number, b: number
          if (source.format === 'BGR888')
            [r, g, b] = source.data.subarray(pos * 3, pos * 3 + 3)
          else {
            const [sk, sb] = weights(c.ycbcrEncoding),
              sg = 1 - sk - sb,
              sy = c.range === 'full' ? 255 : 219,
              su = c.range === 'full' ? 255 : 224,
              l =
                ((source.data[pos] - (c.range === 'full' ? 0 : 16)) * 255) / sy,
              i = (y >> 1) * (w >> 1) + (x >> 1),
              u = ((source.data[p + i] - 128) * 255) / su,
              v = ((source.data[p + p / 4 + i] - 128) * 255) / su
            r = l + 2 * (1 - sk) * v
            b = l + 2 * (1 - sb) * u
            g =
              l -
              ((2 * sb * (1 - sb)) / sg) * u -
              ((2 * sk * (1 - sk)) / sg) * v
          }
          const luma = kr * r + kg * g + kb * b
          out[pos] = byte(off + (luma * yr) / 255)
          cb += ((b - luma) * uv) / (255 * 2 * (1 - kb))
          cr += ((r - luma) * uv) / (255 * 2 * (1 - kr))
        }
      const i = (y >> 1) * (w >> 1) + (x >> 1)
      out[p + i] = byte(128 + cb / 4)
      out[p + p / 4 + i] = byte(128 + cr / 4)
    }
  return out
}
for (const codec of ['h264', 'hevc'] as const)
  for (const rgb of [false, true])
    for (const full of [false, true])
      media(
        `${codec} ${rgb ? 'RGB' : 'I420'} main and lores convert to ${full ? 'full' : 'limited'} color with copied async inputs`,
        async () => {
          const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
            target = profile(full ? 'rec2020' : 'rec709', full)
          const c = new Camera({
            simulate: true,
            width: 64,
            height: 48,
            format: rgb ? 'BGR888' : 'YUV420',
            colorSpace: {
              ...target,
              ycbcrEncoding: full ? 'rec709' : 'rec601',
              range: full ? 'limited' : 'full',
            },
            fifo: true,
            writable: true,
            lores: { width: 32, height: 24, rgb },
          })
          const r = new Recorder(join(dir, 'video.mp4'), {
            width: full ? 32 : 64,
            height: full ? 24 : 48,
            stream: full ? 'lores' : 'main',
            codec,
            colorSpace: target,
            quality: 100,
            fps: 25,
            producerQueue: { maxBytes: 65536, maxOperations: 2 },
          })
          const expected: Uint8Array[] = [],
            stream = full ? 'lores' : 'main'
          try {
            expect(r.colorSpace()).toMatchObject(target)
            c.start()
            for (let i = 0; i < 3; i++) {
              const frame = c.acquire()
              edit(frame, stream, i)
              expected.push(reference(frame, stream, target))
              const job = r.writeAsync(frame, BigInt(i) * 40_000_000n)
              frame.withMappedStream((map) => {
                for (const p of map.planes) p.bytes.fill(0)
              }, stream)
              frame.release()
              await job
            }
            await r.close()
            checkFile(join(dir, 'video.mp4'), target, expected)
            expect(c.stats().leased).toBe(0)
          } finally {
            await r.close()
            await c.close()
            rmSync(dir, { recursive: true, force: true })
          }
        },
      )

media(
  'wrong transfer or gamut rejects synchronous and async A/V before PCM admission; invalid profiles preserve files',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
      path = join(dir, 'protected.mp4')
    writeFileSync(path, 'unchanged')
    for (const colorSpace of [
      'srgb',
      'raw',
      { ...profile('rec709'), range: 'unknown' },
    ] as unknown as ColorSpaceRequest[])
      expect(
        () =>
          new Recorder(path, {
            width: 32,
            height: 24,
            codec: 'h264',
            colorSpace,
          }),
      ).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('unchanged')
    expect(
      () => new Recorder(path, { width: 32, height: 24, colorSpace: 'rec709' }),
    ).toThrow()
    const c = new Camera({ simulate: true, width: 32, height: 24, fifo: true }),
      r = new Recorder(null, {
        width: 32,
        height: 24,
        codec: 'h264',
        colorSpace: 'rec2020',
        audio: { sampleRate: 48000, channels: 2 },
      })
    try {
      c.start()
      using frame = c.acquire()
      expect(() => r.write(frame, 0n)).toThrow()
      expect(() => r.writeAsync(frame, 0n)).toThrow()
      expect(() =>
        r.writeAVAsync(
          frame,
          [{ data: new Uint8Array(1920 * 4), timestampNs: 0n }],
          0n,
        ),
      ).toThrow()
      expect(r.stats()).toMatchObject({
        outputFrames: 0n,
        audioFrames: 0n,
        audioQueuedFrames: 0n,
      })
      expect(() => c.startRecording(r)).toThrow()
      expect(r.colorSpace()).toMatchObject(profile('rec2020'))
    } finally {
      await r.close()
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
class Bytes {
  data = new Uint8Array()
  metadata?: OutputStreams
  streams(value: OutputStreams) {
    this.metadata = value
  }
  write(bytes: Uint8Array) {
    const next = new Uint8Array(this.data.length + bytes.length)
    next.set(this.data)
    next.set(bytes, this.data.length)
    this.data = next
    return bytes.length
  }
  patch(offset: bigint, bytes: Uint8Array) {
    this.data.set(bytes, Number(offset))
    return bytes.length
  }
}
function writeBytes(dir: string, name: string, bytes: Bytes) {
  const path = join(dir, name)
  writeFileSync(path, bytes.data)
  return path
}
async function feed(
  c: Camera,
  r: Recorder,
  index: number,
  target: ColorSpaceDescription,
  audio = false,
) {
  const frame = c.acquire()
  try {
    const pixels = reference(frame, 'main', target)
    if (audio)
      r.writeAudio(new Uint8Array(1920 * 4), BigInt(index) * 40_000_000n)
    r.write(frame, BigInt(index) * 40_000_000n)
    await pause()
    return pixels
  } finally {
    frame.release()
  }
}
for (const codec of ['h264', 'hevc'] as const)
  av(
    `${codec} prepared custom splits and both async A/V snapshots preserve the frozen profile after recorder close`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
        target = profile('rec2020'),
        first = join(dir, 'first.mp4')
      const c = new Camera({
        simulate: true,
        width: 64,
        height: 48,
        fifo: true,
        format: 'YUV420',
        colorSpace: target,
      })
      const r = new Recorder(first, {
        width: 64,
        height: 48,
        codec,
        colorSpace: target,
        fps: 25,
        gop: 2,
        quality: 100,
        audio: { sampleRate: 48000, channels: 2 },
        circular: { maxFrames: 12, maxBytes: 1024 ** 2, durationMs: 1000 },
      })
      const split = new Bytes(),
        snapshot = new Bytes(),
        refs: Uint8Array[] = []
      let index = 0
      const next = async () => {
        refs.push(await feed(c, r, index++, target, true))
      }
      try {
        c.start()
        for (let i = 0; i < 4; i++) await next()
        const job = r.split(new MuxedOutput(split))
        await until(() => r.outputState().splitState === 1)
        while (!job.status.done) {
          await next()
          if (index > 12) throw Error('split did not publish')
        }
        await job
        for (let i = 0; i < 3; i++) await next()
        const stats = r.bufferStats(),
          firstIndex = Number(stats.firstNs / 40_000_000n),
          lastIndex = Number(stats.lastNs / 40_000_000n)
        const fileSnapshot = join(dir, 'frozen-file.mp4'),
          a = r.snapshot(fileSnapshot),
          b = r.snapshot(new MuxedOutput(snapshot))
        await next()
        await next()
        await r.close()
        await Promise.all([a, b])
        checkFile(first, target)
        checkFile(writeBytes(dir, 'split.mp4', split), target)
        for (const path of [
          fileSnapshot,
          writeBytes(dir, 'frozen-object.mp4', snapshot),
        ]) {
          checkFile(path, target, refs.slice(firstIndex, lastIndex + 1))
          expect(mp4(path).get(2)?.codec).toBe('mp4a')
        }
        expect(split.metadata?.colorSpace).toMatchObject(info(target))
        expect(snapshot.metadata?.colorSpace).toMatchObject(info(target))
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

for (const codec of ['h264', 'hevc'] as const)
  media(
    `${codec} restart inherits color, reconfiguration copies it, cancellation rolls back, and null restores legacy MJPEG`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
        old = profile('rec709'),
        target = profile('rec2020'),
        initial = new Bytes()
      const c = new Camera({
        simulate: true,
        width: 64,
        height: 48,
        colorSpace: old,
        fifo: true,
      })
      const r = await Recorder.open(new MuxedOutput(initial), {
        width: 64,
        height: 48,
        codec,
        colorSpace: old,
        fps: 25,
        quality: 100,
      })
      try {
        c.start()
        await feed(c, r, 0, old)
        await feed(c, r, 1, old)
        await r.flushAsync()
        const reason = Error('cancel color change'),
          cancelled = r.reconfigureAsync(
            { colorSpace: target },
            join(dir, 'cancelled.mp4'),
          )
        const outcome = Promise.resolve(cancelled).catch((error) => error)
        expect(cancelled.cancel(reason)).toBe(true)
        expect(await outcome).toBe(reason)
        expect(existsSync(join(dir, 'cancelled.mp4'))).toBe(false)
        expect(r.colorSpace()).toMatchObject(old)
        const rejected = new MuxedOutput(new Bytes())
        rejected.start = () => {
          throw Error('reject new sink')
        }
        await expect(
          Promise.resolve(r.reconfigureAsync({ colorSpace: target }, rejected)),
        ).rejects.toThrow('reject new sink')
        expect(r.colorSpace()).toMatchObject(old)
        const bytes = new Bytes(),
          recipe = { ...target },
          job = r.reconfigureAsync(
            { colorSpace: recipe },
            new MuxedOutput(bytes),
          )
        recipe.primaries = 'smpte170m'
        recipe.transfer = 'linear'
        recipe.range = 'full'
        await job
        expect(r.options.colorSpace).toEqual(target)
        expect(Object.isFrozen(r.options.colorSpace)).toBe(true)
        expect(r.colorSpace()).toMatchObject(target)
        await c.switchMode({
          width: 64,
          height: 48,
          colorSpace: target,
          fifo: true,
        })
        const refs = [await feed(c, r, 0, target), await feed(c, r, 1, target)]
        await r.flushAsync()
        checkFile(writeBytes(dir, 'changed.mp4', bytes), target, refs)
        const path = join(dir, 'inherited.mp4')
        await r.restartAsync(path)
        expect(r.colorSpace()).toMatchObject(target)
        const last = await feed(c, r, 0, target)
        await r.flushAsync()
        checkFile(path, target, [last])
        await r.reconfigureAsync(
          { colorSpace: null, codec: 'mjpeg' },
          join(dir, 'reset.mkv'),
        )
        expect(r.options.colorSpace).toBeUndefined()
        expect(() => r.colorSpace()).toThrow()
        await c.switchMode({
          width: 64,
          height: 48,
          colorSpace: 'srgb',
          fifo: true,
        })
        using frame = c.acquire()
        r.write(frame, 0n)
        checkFile(writeBytes(dir, 'original.mp4', initial), old)
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

media(
  'camera/recorder mode jobs publish color together and roll back a mismatched target',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
      old = profile('rec709'),
      target = profile('rec2020'),
      a = new Bytes(),
      b = new Bytes()
    const c = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      colorSpace: old,
      fifo: true,
    })
    const r = await Recorder.open(new MuxedOutput(a), {
      width: 64,
      height: 48,
      codec: 'h264',
      colorSpace: old,
      asyncWrites: true,
    })
    let first: ReturnType<Camera['startRecording']> | undefined,
      second: typeof first,
      reset: typeof first
    try {
      first = c.startRecording(r)
      await until(() => first!.frames >= 3)
      await expect(
        Promise.resolve(
          first.switchModeAsync(
            { width: 80, height: 48, colorSpace: target },
            {},
            new MuxedOutput(new Bytes()),
          ),
        ),
      ).rejects.toThrow()
      expect(c.colorSpace()).toMatchObject({
        primaries: old.primaries,
        transfer: old.transfer,
      })
      expect(r.options.colorSpace).toEqual(old)
      await r.restartAsync(new MuxedOutput(new Bytes()))
      first = c.startRecording(r)
      second = await first.switchModeAsync(
        { width: 80, height: 48, colorSpace: target },
        { colorSpace: target },
        new MuxedOutput(b),
      )
      await until(() => second!.frames >= 3)
      expect(c.colorSpace()).toMatchObject({
        primaries: target.primaries,
        transfer: target.transfer,
      })
      const defaults = new Bytes()
      reset = await second.switchModeAsync(
        { width: 64, height: 48, colorSpace: 'srgb' },
        { colorSpace: null },
        new MuxedOutput(defaults),
      )
      await until(() => reset!.frames >= 3)
      await reset.flushAsync()
      expect(r.colorSpace()).toMatchObject(legacy)
      checkFile(writeBytes(dir, 'old.mp4', a), old)
      checkFile(writeBytes(dir, 'new.mp4', b), target)
      checkFile(writeBytes(dir, 'defaults.mp4', defaults), legacy)
    } finally {
      await first?.close()
      await second?.close()
      await reset?.close()
      await r.close()
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
for (const target of [
  {
    primaries: 'smpte170m',
    transfer: 'rec709',
    ycbcrEncoding: 'rec601',
    range: 'limited',
  },
  {
    primaries: 'rec2020',
    transfer: 'linear',
    ycbcrEncoding: 'rec2020',
    range: 'full',
  },
  { ...legacy, range: 'full' },
] as const)
  media(
    `custom ${target.primaries}/${target.transfer}/${target.range} tags survive hostile metadata hooks without relabeling`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
        bytes = new Bytes(),
        source = { ...target }
      bytes.streams = (value) => {
        bytes.metadata = value
        if (value.colorSpace) {
          value.colorSpace.primaries = 'raw'
          value.colorSpace.transfer = 'linear'
          value.colorSpace.range = 'limited'
        }
      }
      const c = new Camera({
        simulate: true,
        width: 64,
        height: 48,
        colorSpace: source,
        fifo: true,
      })
      const r = await Recorder.open(new MuxedOutput(bytes), {
        width: 64,
        height: 48,
        codec: 'h264',
        colorSpace: source,
        quality: 100,
      })
      try {
        expect(r.colorSpace()).toMatchObject(target)
        c.start()
        const refs = [await feed(c, r, 0, target), await feed(c, r, 1, target)]
        await r.close()
        checkFile(writeBytes(dir, 'custom.mp4', bytes), target, refs)
      } finally {
        await r.close()
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

media(
  'automatic rotation and recovery factories preserve VUI, nclx and output stream color',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
      target = profile('rec709'),
      initial = new Bytes(),
      rotated = new Bytes(),
      recovered = new Bytes()
    const c = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      colorSpace: target,
      fifo: true,
    })
    const r = await Recorder.open(new MuxedOutput(initial), {
      width: 64,
      height: 48,
      codec: 'hevc',
      colorSpace: target,
      fps: 25,
      gop: 2,
      isolate: true,
    })
    let index = 0
    try {
      c.start()
      r.setRotation(() => new MuxedOutput(rotated), { durationMs: 80 })
      while (!r.automaticState().pending) await feed(c, r, index++, target)
      await until(() => {
        r.poll()
        return r.outputState().splitState === 1
      })
      while (r.outputState().generation < 1n) await feed(c, r, index++, target)
      await r.stopAutomatic()
      await feed(c, r, index++, target)
      // A user I/O exception poisons only this output. Its replacement is built
      // from the retained recorder profile, not the hook's mutable metadata.
      rotated.write = () => {
        throw Error('broken colored output')
      }
      await feed(c, r, index++, target)
      await until(() => {
        r.poll()
        return r.outputState().errorCode !== 0
      })
      r.setRecovery(0, () => new MuxedOutput(recovered), {
        retryDelayMs: 0,
        maxDelayMs: 0,
      })
      for (let i = 0; i < 10 && r.outputState().generation < 2n; i++) {
        await feed(c, r, index++, target)
        r.poll()
      }
      await until(() => {
        r.poll()
        return r.outputState().generation === 2n
      })
      await r.stopAutomatic()
      await feed(c, r, index++, target)
      await r.close()
      checkFile(writeBytes(dir, 'initial.mp4', initial), target)
      checkFile(writeBytes(dir, 'recovered.mp4', recovered), target)
      expect(recovered.metadata?.colorSpace).toMatchObject(target)
    } finally {
      await r.close()
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

media(
  'multiple encoders negotiate independent matrix/range profiles in one camera mode transaction',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
      source = profile('rec709'),
      oldA = new Bytes(),
      oldB = new Bytes(),
      newA = new Bytes(),
      newB = new Bytes()
    const other = { ...source, ycbcrEncoding: 'rec601', range: 'full' } as const
    const next = profile('rec2020'),
      nextOther = { ...next, ycbcrEncoding: 'rec601', range: 'full' } as const
    const c = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      colorSpace: source,
      fifo: true,
      format: 'YUV420',
      lores: { width: 32, height: 24 },
    })
    const a = await Recorder.open(new MuxedOutput(oldA), {
      width: 64,
      height: 48,
      codec: 'h264',
      colorSpace: source,
      asyncWrites: true,
    })
    const b = await Recorder.open(new MuxedOutput(oldB), {
      width: 32,
      height: 24,
      stream: 'lores',
      codec: 'hevc',
      colorSpace: other,
      asyncWrites: true,
    })
    let first: ReturnType<Camera['startRecording']> | undefined,
      second: typeof first,
      changed: readonly NonNullable<typeof first>[] = []
    try {
      first = c.startRecording(a)
      second = c.startRecording(b)
      await until(() => first!.frames >= 3 && second!.frames >= 3)
      changed = await c.switchRecordingsModeAsync(
        {
          width: 80,
          height: 48,
          format: 'YUV420',
          colorSpace: next,
          lores: { width: 40, height: 24 },
        },
        [
          {
            recording: first,
            settings: { colorSpace: next },
            output: new MuxedOutput(newA),
          },
          {
            recording: second,
            settings: { colorSpace: nextOther },
            output: new MuxedOutput(newB),
          },
        ],
      )
      await until(() => changed.every((r) => r.frames >= 3))
      await Promise.all(changed.map((r) => r.flushAsync()))
      for (const [name, bytes, target] of [
        ['a.mp4', oldA, source],
        ['b.mp4', oldB, other],
        ['new-a.mp4', newA, next],
        ['new-b.mp4', newB, nextOther],
      ] as const)
        checkFile(writeBytes(dir, name, bytes), target)
      expect(a.colorSpace()).toMatchObject(next)
      expect(b.colorSpace()).toMatchObject(nextOther)
    } finally {
      await first?.close()
      await second?.close()
      for (const r of changed) await r.close()
      await a.close()
      await b.close()
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
av(
  'CircularOutput2 delayed A/V containers retain the recording profile across async splits',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-record-color-')),
      target = profile('rec709', true),
      a = new Bytes(),
      b = new Bytes()
    const c = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      format: 'YUV420',
      colorSpace: target,
      fifo: true,
    })
    const r = new CircularOutput2({
      width: 64,
      height: 48,
      codec: 'hevc',
      colorSpace: target,
      bufferDurationMs: 80,
      fps: 25,
      gop: 2,
      audio: { sampleRate: 48000, channels: 2 },
    })
    let index = 0
    try {
      c.start()
      for (let i = 0; i < 4; i++) await feed(c, r, index++, target, true)
      await r.openOutput(new MuxedOutput(a))
      for (let i = 0; i < 5; i++) await feed(c, r, index++, target, true)
      const job = r.split(new MuxedOutput(b))
      await until(() => r.outputState().splitState === 1)
      while (!job.status.done) {
        await feed(c, r, index++, target, true)
        if (index > 20) throw Error('delayed split did not commit')
      }
      await job
      for (let i = 0; i < 5; i++) await feed(c, r, index++, target, true)
      await r.close()
      for (const [name, bytes] of [
        ['old.mp4', a],
        ['new.mp4', b],
      ] as const) {
        const path = writeBytes(dir, name, bytes)
        expect(checkFile(path, target).samples.length).toBeGreaterThan(0)
        expect(mp4(path).get(2)?.codec).toBe('mp4a')
      }
    } finally {
      await r.close()
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
