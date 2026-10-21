import { expect, test } from 'bun:test'
import { Camera, Recorder, type RecorderSessionOptions } from '../../ts'
import { native as n, ptr, storage, check } from '../../ts/ffi'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mp4 } from './media'
const av =
  process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1'
    ? test
    : test.skip
av(
  'reconfiguration retains resolved AAC defaults for unchanged formats, while explicit rates and zero reset remain authoritative',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-session-bitrate-'))
    const c = new Camera({ simulate: true, width: 64, height: 48, fifo: true })
    const r = new Recorder(join(dir, 'initial.mp4'), {
      width: 64,
      height: 48,
      codec: 'h264',
      fps: 25,
      audio: { sampleRate: 48000, channels: 1 },
    })
    const recipe = () => {
      const video = storage(32),
        audio = storage(24),
        bits = new Uint32Array(1)
      check(
        n.zc_video_session_config(r.handle, ptr(video), ptr(audio), ptr(bits)),
      )
      return bits[0]
    }
    const feed = async () => {
      for (let i = 0; i < 2; i++) {
        using frame = c.acquire()
        r.writeAudio(
          new Uint8Array((r.options.audio!.sampleRate / 25) * 2),
          BigInt(i) * 40_000_000n,
        )
        r.write(frame, BigInt(i) * 40_000_000n)
      }
      await r.flushAsync()
    }
    try {
      c.start()
      expect(recipe()).toBe(128000)
      await feed()
      expect(mp4(join(dir, 'initial.mp4')).get(2)?.bitrate).toBe(128000)
      const cases: [RecorderSessionOptions, number, number][] = [
        [{ colorSpace: 'rec709' }, 128000, 128000],
        [{ quality: 70 }, 128000, 128000],
        [
          { audio: { sampleRate: 48000, channels: 1, bitrate: 96000 } },
          96000,
          96000,
        ],
        [{ audio: { sampleRate: 48000, channels: 1, bitrate: 0 } }, 0, 64000],
        [{ audio: { sampleRate: 32000, channels: 1 } }, 0, 64000],
      ]
      for (const [
        index,
        [settings, expectedRecipe, expectedBitrate],
      ] of cases.entries()) {
        const path = join(dir, `session-${index}.mp4`)
        await r.reconfigureAsync(settings, path)
        expect(recipe()).toBe(expectedRecipe)
        if (index === 0)
          await c.switchMode({
            width: 64,
            height: 48,
            colorSpace: 'rec709',
            fifo: true,
          })
        await feed()
        const audio = mp4(path).get(2)!
        expect(audio.bitrate).toBe(expectedBitrate)
        expect(audio.rate).toBe(r.options.audio!.sampleRate)
        expect(audio.samples.length).toBeGreaterThan(0)
      }
    } finally {
      await r.close()
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
av(
  'bitrate inheritance rechecks ownership after a settings getter closes the recorder',
  async () => {
    const r = new Recorder(null, {
      width: 64,
      height: 48,
      codec: 'h264',
      audio: { sampleRate: 48000, channels: 1 },
    })
    await r.flushAsync()
    const original = n.zc_video_session_config
    let closing: Promise<void> | undefined,
      calls = 0
    Object.assign(n, {
      zc_video_session_config: () => {
        calls++
        throw Error('stale native owner query')
      },
    })
    try {
      expect(() =>
        r.reconfigureAsync({
          get audio() {
            closing = r.close()
            return { sampleRate: 48000, channels: 1 }
          },
        }),
      ).toThrow('closed recorder')
      expect(calls).toBe(0)
    } finally {
      Object.assign(n, { zc_video_session_config: original })
      await closing
      await r.close()
    }
  },
)
