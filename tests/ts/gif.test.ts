import { expect, test } from 'bun:test'
import { Camera } from '../../ts'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeGif } from './gif-media'
const decoded = process.env.ZC_GIF_DECODER ? test : test.skip
const formats = [
  'BGR888',
  'RGB888',
  'XBGR8888',
  'XRGB8888',
  'YUV420',
  'YVU420',
  'NV12',
  'NV21',
  'YUYV',
  'YVYU',
  'UYVY',
  'VYUY',
  'BGR161616',
  'RGB161616',
] as const
for (const format of formats)
  for (const stream of ['main', 'lores'] as const)
    decoded(
      `independent GIF ${format} ${stream} pixels survive request and camera retirement`,
      async () => {
        const c = new Camera({
            simulate: true,
            fifo: true,
            width: 18,
            height: 10,
            format,
            lores: { width: 10, height: 6, format },
          }),
          dir = mkdtempSync(join(tmpdir(), 'zc-gif-')),
          path = join(dir, 'capture.GIF')
        try {
          c.start()
          using f = c.acquire()
          const rgb = f.copyRGB(stream),
            width = stream === 'main' ? 18 : 10,
            height = stream === 'main' ? 10 : 6
          const bytes = f.encodeImage({ format: 'GIF', stream })
          f.saveFile(path, { stream })
          expect(readFileSync(path)).toEqual(Buffer.from(bytes))
          f.release()
          await c.close()
          const image = decodeGif(path)
          expect([image.width, image.height]).toEqual([width, height])
          const expected = Buffer.alloc(width * height * 4)
          for (let i = 0; i < width * height; i++) {
            expected.set(rgb.subarray(i * 3, i * 3 + 3), i * 4)
            expected[i * 4 + 3] = 255
          }
          expect(image.pixels).toEqual(expected)
        } finally {
          await c.close()
          rmSync(dir, { recursive: true, force: true })
        }
      },
    )
decoded(
  'GIF capture jobs preserve staged files on callback failure and permit reuse after cleanup',
  async () => {
    const c = new Camera({
        simulate: true,
        fifo: true,
        width: 18,
        height: 10,
      }),
      dir = mkdtempSync(join(tmpdir(), 'zc-gif-stage-')),
      path = join(dir, 'photo.gif'),
      marker = Error('post capture')
    try {
      writeFileSync(path, 'original')
      c.postCallback = () => {
        throw marker
      }
      await expect(
        Promise.resolve(c.captureFileAsync(path)),
      ).rejects.toThrow('post')
      expect(readFileSync(path, 'utf8')).toBe('original')
      expect(readdirSync(dir)).toEqual(['photo.gif'])
      expect(c.stats().leased).toBe(0)
      c.setRequestCallbacks({})
      await c.captureFile(path)
      expect([decodeGif(path).width, decodeGif(path).height]).toEqual([
        18, 10,
      ])
    } finally {
      c.setRequestCallbacks({})
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
test('GIF rejects raw sources and unsupported metadata before capture or file replacement', async () => {
  const c = new Camera({ simulate: true, width: 18, height: 10 }),
    dir = mkdtempSync(join(tmpdir(), 'zc-gif-invalid-')),
    path = join(dir, 'capture.gif')
  try {
    writeFileSync(path, 'original')
    for (const options of [
      { stream: 'raw' as const },
      { iccProfile: 'srgb' as const },
      { exif: true },
    ])
      expect(() => c.captureFileAsync(path, options)).toThrow()
    expect(c.stats().delivered).toBe(0n)
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['capture.gif'])
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
