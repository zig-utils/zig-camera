import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  RtpOutput,
  rtpTimestamp,
  type OutputPacket,
  type CustomOutput,
} from '../../ts'
import { reassemble, report, length4 } from './rtp-reference'
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  cpSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end)
      throw Error('RTP receiver did not receive every accepted packet')
    await Bun.sleep(1)
  }
}
for (const codec of ['h264', 'hevc'] as const)
  test(`${codec} Home recorder sends exact video and signed AAC over UDP and independently decodes`, async () => {
    if (!process.env.ZC_TEST_CODECS || !process.env.ZC_TEST_AAC) return
    const payloads: Uint8Array[][] = [[], [], [], []],
      receivers: Bun.udp.Socket<'buffer'>[] = []
    const camera = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      fifo: true,
    })
    const originals: OutputPacket[] = []
    let recorder: Recorder | undefined
    let output: RtpOutput | undefined
    const directory = mkdtempSync(join(tmpdir(), 'zc-rtp-'))
    try {
      for (const list of payloads)
        receivers.push(
          await Bun.udpSocket({
            hostname: '127.0.0.1',
            port: 0,
            socket: {
              data: (_, bytes) => {
                list.push(bytes.slice())
              },
            },
          }),
        )
      output = new RtpOutput({
        address: '127.0.0.1',
        port: receivers[0].port,
        rtcpPort: receivers[1].port,
        ssrc: 10,
        sequence: 65535,
        timestampOrigin: 0,
        audio: {
          port: receivers[2].port,
          rtcpPort: receivers[3].port,
          ssrc: 11,
          sequence: 1,
          timestampOrigin: 0,
        },
        cname: 'codec-loopback',
        mtu: 128,
      })
      recorder = await Recorder.open(output, {
        width: 64,
        height: 48,
        codec,
        fps: 25,
        gop: 2,
        audio: { sampleRate: 48000, channels: 2 },
        asyncWrites: true,
        outputQueue: { maxBytes: 1024 * 1024, maxOperations: 4, waitMs: 2000 },
      })
      const observer: CustomOutput = {
        format: 'packets-aac',
        streams(info) {
          expect(info.audio?.encoding).toBe('aac')
        },
        outputframe(p) {
          originals.push({ ...p, data: p.data.slice() })
        },
      }
      await recorder.addOutput(observer)
      const pcm = Buffer.alloc(9600 * 4)
      for (let i = 0; i < 9600; i++) {
        const sample = Math.round(
          Math.sin((i * 2 * Math.PI * 440) / 48000) * 8000,
        )
        pcm.writeInt16LE(sample, i * 4)
        pcm.writeInt16LE(-sample, i * 4 + 2)
      }
      await recorder.writeAudioAsync(pcm, 0n)
      camera.start()
      for (let i = 0; i < 5; i++) {
        using frame = camera.acquire()
        await recorder.writeAsync(frame, BigInt(i) * 40_000_000n)
      }
      await recorder.flushAsync()
      await recorder.drain()
      await recorder.close()
      const stats = output.stats()
      await until(
        () =>
          payloads[0].length === Number(stats.tracks[0].packets) &&
          payloads[2].length === Number(stats.tracks[1].packets) &&
          payloads[1].length >= 2 &&
          payloads[3].length >= 2,
      )
      const video = reassemble(payloads[0], codec, 96, 10),
        audio = reassemble(payloads[2], 'aac', 97, 11),
        expectedVideo = originals.filter((p) => !p.audio),
        expectedAudio = originals.filter((p) => p.audio)
      expect(video.length).toBe(5)
      expect(video.map((p) => p.timestamp)).toEqual([
        0, 3600, 7200, 10800, 14400,
      ])
      expect(video.map((p) => p.data)).toEqual(
        expectedVideo.map((p) => Buffer.from(p.data)),
      )
      expect(audio.length).toBeGreaterThanOrEqual(10)
      expect(audio.map((p) => p.data)).toEqual(
        expectedAudio.map((p) => Buffer.from(p.data)),
      )
      expect(expectedAudio[0].timestampNs).toBeLessThan(0n)
      expect(expectedAudio[0].sourceTimestampNs).toBe(
        expectedAudio[0].timestampNs,
      )
      expect(audio.map((p) => p.timestamp)).toEqual(
        expectedAudio.map((p) => rtpTimestamp(p.timestampNs, 48000)),
      )
      for (let i = 1; i < audio.length; i++)
        expect(
          (audio[i].timestamp - audio[i - 1].timestamp) >>> 0,
        ).toBeGreaterThanOrEqual(1023)
      for (const index of [1, 3]) {
        const final = report(payloads[index].at(-1)!)
        expect(final.bye).toBe(true)
        expect(final.cname).toBe('codec-loopback')
        expect(final.packets).toBe(payloads[index - 1].length)
        expect(final.octets).toBe(
          payloads[index - 1].reduce((sum, p) => sum + p.length - 12, 0),
        )
      }
      if (process.env.ZC_INDEPENDENT_DECODER) {
        const path = join(directory, 'video.aus')
        writeFileSync(path, length4(video.map((p) => p.data)))
        const result = Bun.spawnSync([
          process.env.ZC_INDEPENDENT_DECODER,
          codec,
          path,
          '5',
          '--decode-only',
          '64',
          '48',
        ])
        expect(result.exitCode).toBe(0)
        if (result.exitCode) throw Error(result.stderr.toString())
      }
      if (process.env.ZC_AAC_DECODER) {
        const path = join(directory, 'audio.raw'),
          pcmPath = join(directory, 'decoded.pcm')
        writeFileSync(
          path,
          length4([Buffer.from([0x11, 0x90]), ...audio.map((p) => p.data)]),
        )
        const result = Bun.spawnSync([
          process.env.ZC_AAC_DECODER,
          path,
          pcmPath,
        ])
        expect(result.exitCode).toBe(0)
        if (result.exitCode) throw Error(result.stderr.toString())
        const decoded = readFileSync(pcmPath)
        const priming = Number(
          (-expectedAudio[0].timestampNs * 48000n) / 1_000_000_000n,
        )
        expect(decoded.length).toBe(audio.length * 1024 * 4)
        expect(decoded.length).toBeGreaterThanOrEqual((priming + 9600) * 4)
        let squared = 0
        for (let i = 0; i < 9600; i++)
          for (let channel = 0; channel < 2; channel++) {
            const actual = decoded.readInt16LE((priming + i) * 4 + channel * 2)
            const expected = pcm.readInt16LE(i * 4 + channel * 2)
            squared += (actual - expected) ** 2
          }
        expect(Math.sqrt(squared / (9600 * 2))).toBeLessThan(1000)
      }
    } catch (error) {
      try {
        const destination = join(
          process.env.ZC_MEDIA_FAILURE_DIR ?? 'zig-out/media-failures',
          'rtp-' + codec + '-' + Date.now(),
        )
        mkdirSync(destination, { recursive: true })
        cpSync(directory, destination, { recursive: true })
        writeFileSync(
          join(destination, 'packets.json'),
          JSON.stringify(
            payloads.map((list) =>
              list.map((bytes) => Buffer.from(bytes).toString('base64')),
            ),
          ),
        )
        writeFileSync(join(destination, 'error.txt'), String(error))
      } catch {}
      throw error
    } finally {
      await recorder?.close()
      await output?.close()
      await camera.close()
      for (const socket of receivers) socket.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

test('RTP failure isolation and async recovery preserve healthy recorder delivery', async () => {
  if (!process.env.ZC_TEST_CODECS) return
  const camera = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      fifo: true,
    }),
    healthy: OutputPacket[] = []
  const codec = 'h264' as const
  const marker = Error('RTP network failed')
  const collected: Uint8Array[] = []
  let badClosed = 0
  const bad = new RtpOutput({
    address: '127.0.0.1',
    port: 5004,
    socketFactory: async () => ({
      send() {
        throw marker
      },
      close() {
        badClosed++
      },
    }),
  })
  const good = new RtpOutput({
    address: '127.0.0.1',
    port: 5004,
    socketFactory: async ({ port }) => ({
      send(bytes) {
        if (port === 5004) collected.push(bytes.slice())
        return true
      },
      close() {},
    }),
  })
  const recorder = await Recorder.open(
    {
      outputframe(p) {
        healthy.push(p)
      },
    },
    {
      width: 64,
      height: 48,
      fps: 25,
      codec,
      gop: 2,
      isolate: true,
      asyncWrites: true,
    },
  )
  try {
    const id = await recorder.addOutput(bad)
    camera.start()
    for (let i = 0; i < 8; i++) {
      using frame = camera.acquire()
      await recorder.writeAsync(frame, BigInt(i) * 40_000_000n)
    }
    await until(() => recorder.outputState(id).errorCode !== 0)
    expect(recorder.outputErrors.get(id)).toBe(marker)
    const recovery = recorder.recover(good, id)
    for (let i = 8; i < 16; i++) {
      using frame = camera.acquire()
      await recorder.writeAsync(frame, BigInt(i) * 40_000_000n)
    }
    await recovery
    recovery.close()
    await recorder.close()
    expect(healthy.length).toBe(16)
    expect(collected.length).toBeGreaterThan(0)
    expect(badClosed).toBe(2)
  } finally {
    await recorder.close()
    await bad.close()
    await good.close()
    await camera.close()
  }
})

test('circular audio/video snapshots encode fresh signed AAC and finish the RTP output asynchronously', async () => {
  if (!process.env.ZC_TEST_CODECS || !process.env.ZC_TEST_AAC) return
  const camera = new Camera({
      simulate: true,
      width: 64,
      height: 48,
      fifo: true,
    }),
    packets: Uint8Array[][] = [[], [], [], []]
  const recorder = new Recorder(null, {
    width: 64,
    height: 48,
    fps: 25,
    codec: 'h264',
    gop: 2,
    circular: { maxFrames: 4, maxBytes: 1024 * 1024, durationMs: 1000 },
    audio: { sampleRate: 48000, channels: 2 },
    asyncWrites: true,
  })
  const output = new RtpOutput({
    address: '127.0.0.1',
    port: 5004,
    ssrc: 10,
    timestampOrigin: 0,
    audio: { port: 5006, ssrc: 11, timestampOrigin: 0 },
    mtu: 128,
    socketFactory: async ({ port }) => ({
      send(bytes) {
        packets[port - 5004].push(bytes.slice())
        return true
      },
      close() {},
    }),
  })
  try {
    camera.start()
    for (let i = 0; i < 8; i++) {
      await recorder.writeAudioAsync(
        Buffer.alloc(1920 * 4),
        BigInt(i) * 40_000_000n,
      )
      using frame = camera.acquire()
      await recorder.writeAsync(frame, BigInt(i) * 40_000_000n)
    }
    const retained = recorder.bufferStats()
    expect(retained.frames).toBeGreaterThanOrEqual(2n)
    expect(retained.frames).toBeLessThanOrEqual(4n)
    const job = recorder.snapshot(output)
    await job
    await job.cleanupDone
    const video = reassemble(packets[0], 'h264', 96, 10),
      audio = reassemble(packets[2], 'aac', 97, 11)
    expect(video.length).toBe(Number(retained.frames))
    expect(video.map((p) => p.timestamp)).toEqual(
      Array.from({ length: Number(retained.frames) }, (_, i) => i * 3600),
    )
    expect(video[0].timestamp).toBe(0)
    expect(audio.length).toBeGreaterThanOrEqual(
      Math.ceil((Number(retained.frames) * 1920) / 1024),
    )
    expect(audio[0].timestamp).toBeGreaterThan(0x80000000)
    expect(report(packets[1].at(-1)!).bye).toBe(true)
    expect(report(packets[3].at(-1)!).bye).toBe(true)
    expect(output.stats().phase).toBe('stopped')
  } finally {
    await recorder.close()
    await output.close()
    await camera.close()
  }
})
