import { test, expect } from 'bun:test'
import { Camera, Recorder } from '../../ts'
import { mp4, decodeVideoI420 } from './media'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const media = process.env.ZC_TEST_CODECS === '1' ? test : test.skip

// Use unequal components, edges and spatial variation so incorrect visible crops,
// padded dimensions or a lost chroma plane cannot pass as a constant grey image.
function pattern(width: number, height: number, index: number) {
  const bytes = new Uint8Array((width * height * 3) / 2)
  let offset = 0
  for (let p = 0; p < 3; p++) {
    const w = p ? width / 2 : width,
      h = p ? height / 2 : height
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        bytes[offset++] =
          (p ? 70 + p * 30 : 40) + index * 8 + ((x * 2 + y * 3) % 60)
  }
  return bytes
}
media(
  'tiny crops and 4K HEVC encode concurrently and retain visible I420 pixels',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-hevc-geometry-'))
    const sizes = [
      [16, 16],
      [18, 22],
      [32, 24],
      [18, 50],
      [34, 18],
      [64, 48],
      [3840, 2160],
    ] as const
    const owners: {
      camera: Camera
      recorder: Recorder
      path: string
      refs: Uint8Array[]
      width: number
      height: number
    }[] = []
    try {
      // All handles coexist: a global CTU-size conflict must fail the test regardless
      // of whether the first encoder is a small stream or a subsequent large stream.
      for (const [width, height] of sizes) {
        const path = join(dir, `${width}x${height}.mp4`)
        const camera = new Camera({
          simulate: true,
          writable: true,
          width,
          height,
          format: 'YUV420',
          colorSpace: 'sycc',
          fifo: true,
        })
        try {
          const recorder = new Recorder(path, {
            width,
            height,
            codec: 'hevc',
            colorSpace: 'sycc',
            quality: 99,
            encoder: { preset: 'ultrafast' },
            limits: { level: width === 3840 ? 50 : 20 },
          })
          owners.push({ camera, recorder, path, refs: [], width, height })
          camera.start()
        } catch (e) {
          await camera.close()
          throw e
        }
      }
      for (let index = 0; index < 3; index++)
        for (const owner of owners) {
          const { camera, recorder, width, height, refs } = owner
          using frame = camera.acquire()
          const bytes = pattern(width, height, index)
          refs.push(bytes)
          frame.withMappedStream((map) => {
            let offset = 0
            for (let p = 0; p < 3; p++)
              for (let y = 0; y < (p ? height / 2 : height); y++) {
                const w = p ? width / 2 : width
                map.row(y, p).set(bytes.subarray(offset, offset + w))
                offset += w
              }
          })
              recorder.write(frame, BigInt(index) * 33333333n)
        }
      // Close in reverse order: a large stream retires while small streams still
      // own their native encoders and cached cropped parameter sets.
      for (const owner of owners.toReversed()) {
        await owner.recorder.close()
        const video = mp4(owner.path).get(1)!
        expect([video.width, video.height]).toEqual([owner.width, owner.height])
        expect(video.samples.length).toBe(3)
        expect(video.config[12] / 3).toBeLessThanOrEqual(
          owner.width === 3840 ? 50 : 20,
        )
        decodeVideoI420(owner.path, video, owner.refs)
      }
    } finally {
      for (const owner of owners.toReversed()) {
        await owner.recorder.close()
        await owner.camera.close()
      }
      rmSync(dir, { recursive: true, force: true })
    }
  },
  60000,
)
