import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  AudioCapture,
  MuxedOutput,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
  type OutputStreams,
} from '../../ts'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, decodeAudio, decodeVideo } from './media'
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
const opts = {
  width: 32,
  height: 24,
  fps: 25,
  producerQueue: { maxBytes: 1024 * 1024, maxOperations: 8 },
  outputQueue: { maxBytes: 1024 * 1024, maxOperations: 16, waitMs: 1000 },
}
class Sink implements CustomOutput {
  metadata?: OutputStreams
  frames: OutputPacket[] = []
  discarded = false
  starts = 0
  start() {
    this.starts++
  }
  streams(streams: OutputStreams) {
    this.metadata = streams
  }
  outputframe(packet: OutputPacket) {
    this.frames.push(packet)
  }
  stop(reason?: { discard: boolean }) {
    this.discarded = !!reason?.discard
  }
}
function camera(width = 32, height = 24) {
  const c = new Camera({ simulate: true, width, height, fifo: true })
  c.start()
  return c
}
async function frame(c: Camera, r: Recorder) {
  using f = c.acquire()
  await r.writeAsync(f, 0n)
}
async function failure(job: PromiseLike<unknown>) {
  return Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
}
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('timeout')
    await pause()
  }
}

test('reconfiguration changes geometry, fps, quality and PCM format with immutable session settings', async () => {
  const old = new Sink(),
    next = new Sink(),
    c = camera(),
    larger = camera(64, 48)
  const input = { ...opts, audio: { sampleRate: 48000, channels: 2 } }
  const r = await Recorder.open(old, input)
  try {
    input.audio.channels = 1
    expect(r.options.audio?.channels).toBe(2)
    await frame(c, r)
    const flush = r.flushAsync()
    const audio = {
      sampleRate: 44100,
      channels: 1,
      bufferFrames: 44100,
      bitrate: 64000,
    }
    const job = r.reconfigureAsync(
      { width: 64, height: 48, fps: 20, quality: 45, audio },
      next,
    )
    audio.channels = 2
    await flush
    await job
    expect(r.width).toBe(64)
    expect(r.height).toBe(48)
    expect(r.fps).toBe(20)
    expect(r.options.quality).toBe(45)
    expect(r.options.audio?.channels).toBe(1)
    expect(next.metadata).toMatchObject({
      width: 64,
      height: 48,
      fps: 20,
      codec: 3,
      audio: { sampleRate: 44100, channels: 1 },
    })
    expect(next.metadata?.headers.length).toBe(0)
    using wrong = c.acquire()
    expect(() => r.writeAsync(wrong, 0n)).toThrow()
    using correct = larger.acquire()
    await r.writeAVAsync(
      correct,
      [{ data: new Uint8Array(4410), timestampNs: 0n }],
      0n,
    )
    await r.flushAsync()
    expect(next.frames.filter((p) => !p.audio).length).toBe(1)
    expect(r.stats().audioFrames).toBe(2205n)
    await r.reconfigureAsync({ audio: null }, new Sink())
    expect(r.options.audio).toBeUndefined()
    await frame(larger, r)
    await r.flushAsync()
    await r.restartAsync(new Sink())
    expect(r.width).toBe(64)
    expect(r.fps).toBe(20)
    expect(r.options.quality).toBe(45)
    expect(r.sessionState().id).toBe(3n)
  } finally {
    await r.close()
    await c.close()
    await larger.close()
  }
})

test('cancelled setup and throwing hooks preserve old session settings and allow a retry', async () => {
  const c = camera(),
    r = await Recorder.open(new Sink(), opts)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = new Sink()
  let entered = false
  const pending: CustomOutput = {
    streams: async (streams) => {
      next.streams(streams)
      entered = true
      await gate
    },
    outputframe: (p) => next.outputframe(p),
    stop: (reason) => next.stop(reason),
  }
  try {
    await frame(c, r)
    await r.flushAsync()
    const before = r.options
    const job = r.reconfigureAsync(
      { width: 64, height: 48, quality: 20 },
      pending,
    )
    const result = failure(job)
    await until(() => entered)
    expect(next.metadata?.width).toBe(64)
    expect(r.options).toBe(before)
    expect(r.width).toBe(32)
    expect(job.cancel()).toBe(true)
    release()
    expect(await result).toBeInstanceOf(JobCancelledError)
    await job.operationDone
    expect(next.discarded).toBe(true)
    expect(r.options).toBe(before)
    expect(r.sessionState().id).toBe(0n)
    const bad: CustomOutput = {
      start() {
        throw Error('candidate setup failed')
      },
      outputframe() {},
    }
    expect(await failure(r.reconfigureAsync({ fps: 50 }, bad))).toMatchObject({
      message: 'candidate setup failed',
    })
    expect(r.options).toBe(before)
    await r.reconfigureAsync({ fps: 50, quality: 70 }, new Sink())
    expect(r.fps).toBe(50)
    expect(r.options.quality).toBe(70)
    await frame(c, r)
  } finally {
    release()
    await r.close()
    await c.close()
  }
})

test('invalid recipes and incompatible containers preserve files and terminal configuration', async () => {
  const c = camera(),
    r = await Recorder.open(new Sink(), opts)
  const dir = mkdtempSync(join(tmpdir(), 'zc-config-'))
  try {
    expect(
      await failure(r.reconfigureAsync({ quality: 70 }, new Sink())),
    ).toMatchObject({ code: -2 })
    await frame(c, r)
    await r.flushAsync()
    const before = r.options
    for (const settings of [
      { quality: 0 },
      { width: 0 },
      { fps: 0 },
      { gop: 2 },
      { bitrate: 1000 },
      { audio: { sampleRate: 0, channels: 1 } },
    ])
      expect(() => r.reconfigureAsync(settings)).toThrow()
    const existing = join(dir, 'existing.mkv')
    writeFileSync(existing, 'keep')
    expect(
      await failure(r.reconfigureAsync({ quality: 60 }, existing)),
    ).toBeInstanceOf(Error)
    expect(readFileSync(existing, 'utf8')).toBe('keep')
    const incompatible = join(dir, 'candidate.mp4')
    expect(
      await failure(r.reconfigureAsync({ quality: 60 }, incompatible)),
    ).toBeInstanceOf(Error)
    expect(existsSync(incompatible)).toBe(false)
    expect(r.options).toBe(before)
    expect(r.sessionState().id).toBe(0n)
    const fresh = join(dir, 'fresh.mkv')
    await r.reconfigureAsync({ quality: 60 }, fresh)
    await frame(c, r)
    await r.flushAsync()
    expect(readFileSync(fresh).readUInt32BE()).toBe(0x1a45dfa3)
    expect(r.options.quality).toBe(60)
  } finally {
    await r.close()
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

const mediaTest =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
mediaTest(
  'one recorder switches MJPEG/AVC/HEVC, rate control, GOP, PCM/AAC formats and video-only MP4',
  async () => {
    const c = camera(128, 96),
      old = new Sink(),
      r = await Recorder.open(old, { ...opts, width: 128, height: 96 })
    const dir = mkdtempSync(join(tmpdir(), 'zc-codec-config-'))
    try {
      await frame(c, r)
      await r.flushAsync()
      const unpatchable: CustomOutput = {
        format: 'mp4',
        write: () => undefined,
      }
      expect(
        await failure(
          r.reconfigureAsync(
            { codec: 'h264', audio: { sampleRate: 48000, channels: 2 } },
            unpatchable,
          ),
        ),
      ).toBeInstanceOf(Error)
      expect(r.sessionState().id).toBe(0n)
      expect(r.options.codec).toBeUndefined()
      for (const [index, codec] of (
        ['h264', 'hevc', 'h264'] as const
      ).entries()) {
        const rate = index === 0 ? 44100 : 48000,
          channels = index === 0 ? 1 : 2,
          fps = index === 0 ? 25 : 30
        const sink = {
          data: Buffer.alloc(0),
          async write(bytes: Uint8Array) {
            await pause()
            const n = Math.min(127, bytes.length)
            this.data = Buffer.concat([
              this.data,
              Buffer.from(bytes.subarray(0, n)),
            ])
            return n
          },
          async patch(offset: bigint, bytes: Uint8Array) {
            await pause()
            const n = Math.min(7, bytes.length)
            this.data.set(bytes.subarray(0, n), Number(offset))
            return n
          },
        }
        // Audio is deliberately disabled for the third session; its MP4 needs no patch hook.
        const output =
          index === 2
            ? { format: 'mp4' as const, write: sink.write.bind(sink) }
            : new MuxedOutput(sink)
        await r.reconfigureAsync(
          {
            codec,
            fps,
            quality: 75 - index * 10,
            bitrate: index === 0 ? 200000 : 0,
            gop: 3,
            audio:
              index === 2
                ? null
                : {
                    sampleRate: rate,
                    channels,
                    bufferFrames: rate,
                    bitrate: channels * 64000,
                  },
          },
          output,
        )
        const sequences: bigint[] = [],
          samples = rate / fps
        for (let i = 0; i < 9; i++) {
          using f = c.acquire()
          sequences.push(f.sequence)
          const ts = BigInt(Math.floor((i * 1e9) / fps))
          if (index === 2) await r.writeAsync(f, ts)
          else {
            const pcm = new Uint8Array(samples * channels * 2),
              view = new DataView(pcm.buffer)
            for (let k = 0; k < samples; k++)
              for (let ch = 0; ch < channels; ch++)
                view.setInt16(
                  (k * channels + ch) * 2,
                  (((i * samples + k) % 200) - 100) * 100 * (ch ? -1 : 1),
                  true,
                )
            await r.writeAVAsync(f, [{ data: pcm, timestampNs: ts }], ts)
          }
        }
        await r.flushAsync()
        const path = join(dir, `${index}.mp4`)
        writeFileSync(path, sink.data)
        const tracks = mp4(path),
          video = tracks.get(1)!
        expect(video.codec).toBe(codec === 'h264' ? 'avc1' : 'hvc1')
        expect(video.keys[0]).toBe(true)
        expect(video.keys.filter(Boolean).length).toBeGreaterThanOrEqual(3)
        decodeVideo(path, video, sequences)
        if (index !== 2) {
          const audio = tracks.get(2)!
          expect(audio.rate).toBe(rate)
          expect(audio.channels).toBe(channels)
          decodeAudio(path, audio, 0, samples * 9)
        } else expect(tracks.size).toBe(1)
        expect(r.sessionState().id).toBe(BigInt(index + 1))
      }
      const jpeg = new Sink()
      await r.reconfigureAsync({ codec: 'mjpeg', fps: 25 }, jpeg)
      expect(r.options.bitrate).toBeUndefined()
      expect(r.options.gop).toBeUndefined()
      expect(jpeg.metadata).toMatchObject({
        codec: 3,
        width: 128,
        height: 96,
        fps: 25,
      })
      expect(jpeg.metadata?.headers.length).toBe(0)
      await frame(c, r)
      await r.flushAsync()
      expect(jpeg.frames.length).toBe(1)
    } finally {
      await r.close()
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30000,
)

test('camera pump checks the reconfigured video/audio format before capture starts', async () => {
  const c = camera(),
    larger = camera(64, 48),
    sink = new Sink(),
    r = await Recorder.open(new Sink(), opts)
  using wrongAudio = new AudioCapture({
    simulate: true,
    sampleRate: 48000,
    channels: 2,
  })
  let recording: ReturnType<Camera['startRecording']> | undefined
  let audio: AudioCapture | undefined
  try {
    await frame(c, r)
    await r.flushAsync()
    await r.reconfigureAsync(
      {
        width: 64,
        height: 48,
        fps: 20,
        audio: { sampleRate: 44100, channels: 1, bufferFrames: 44100 },
      },
      sink,
    )
    expect(() => c.startRecording(r)).toThrow('geometry mismatch')
    expect(() => larger.startRecording(r, { audio: wrongAudio })).toThrow(
      'audio capture format',
    )
    audio = new AudioCapture({
      simulate: true,
      sampleRate: 44100,
      channels: 1,
      blockFrames: 441,
    })
    recording = larger.startRecording(r, { audio })
    await until(() => recording!.frames >= 3)
    await recording.flushAsync()
    expect(recording.error).toBeUndefined()
    expect(sink.frames.filter((p) => !p.audio).length).toBeGreaterThanOrEqual(3)
    expect(sink.frames.some((p) => p.audio)).toBe(true)
    expect(sink.frames.filter((p) => !p.audio)[0].timestampNs).toBe(0n)
    expect(larger.stats().leased).toBe(0)
  } finally {
    await recording?.close()
    audio?.close()
    await r.close()
    await c.close()
    await larger.close()
  }
})

test('post-publication retirement failure reports the installed configuration', async () => {
  const c = camera(),
    next = new Sink()
  const old: CustomOutput = {
    outputframe() {},
    stop() {
      throw Error('old session stop')
    },
  }
  const r = await Recorder.open(old, opts)
  try {
    await frame(c, r)
    await r.flushAsync()
    expect(
      await failure(r.reconfigureAsync({ fps: 50, quality: 33 }, next)),
    ).toMatchObject({ message: 'old session stop' })
    expect(r.sessionState()).toMatchObject({ id: 1n, phase: 'open' })
    expect(r.fps).toBe(50)
    expect(r.options.quality).toBe(33)
    expect(next.metadata?.fps).toBe(50)
    await frame(c, r)
    await r.flushAsync()
    expect(next.frames.length).toBe(1)
  } finally {
    await r.close()
    await c.close()
  }
})
