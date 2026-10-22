import { expect, test } from 'bun:test'
import { Camera, type ImageExif } from '../../ts'
import { prepareExif } from '../../ts/exif'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const reader = process.env.ZC_EXIF_READER
const camera = () =>
  new Camera({
    simulate: true,
    width: 18,
    height: 10,
    fifo: true,
    lores: { width: 8, height: 6 },
  })
function inspect(path: string, format: string) {
  const result = Bun.spawnSync([reader!, format, path])
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString())
}
function rawBigEndian() {
  // A complete caller TIFF containing an inline two-byte Artist string.
  return Uint8Array.from([
    77, 77, 0, 42, 0, 0, 0, 8, 0, 1, 1, 59, 0, 2, 0, 0, 0, 2, 65, 0, 0, 0, 0, 0,
    0, 0,
  ])
}
for (const format of ['jpeg', 'png', 'tiff'] as const)
  test.skipIf(!reader)(
    `${format} request Exif and ICC retain actual selected dimensions, time and exposure`,
    async () => {
      const c = camera(),
        dir = mkdtempSync(join(tmpdir(), 'zc-exif-'))
      try {
        c.start()
        using frame = c.acquire()
        const meta = frame.metadata()
        for (const stream of ['main', 'lores'] as const) {
          const path = join(dir, `${stream}.${format}`)
          frame.saveFile(path, {
            format,
            stream,
            exif: true,
            iccProfile: 'srgb',
          })
          const found = inspect(path, format)
          expect(found).toMatchObject({
            hasExif: true,
            software: 'zig-camera',
            orientation: 1,
            width: stream === 'main' ? 18 : 8,
            height: stream === 'main' ? 10 : 6,
          })
          expect(found.exposureTime[0] / found.exposureTime[1]).toBeCloseTo(
            meta.exposureUs! / 1e6,
            8,
          )
          expect(found.iso).toBe(Math.floor(meta.analogueGain * 100))
          expect(found.dateTimeOriginal).toMatch(
            /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/,
          )
          expect(found.offsetTimeOriginal).toBe('+00:00')
          expect(found.subSecTimeOriginal).toMatch(/^\d{9}$/)
          expect(found.make).toBeNull()
          const bytes = frame.encodeImage({ format, stream, exif: true })
          writeFileSync(path, bytes)
          expect(inspect(path, format).width).toBe(stream === 'main' ? 18 : 8)
        }
      } finally {
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
test.skipIf(!reader)(
  'JPEG defaults, explicit disable and non-JPEG defaults apply to direct and temporary-mode jobs',
  async () => {
    const c = camera(),
      dir = mkdtempSync(join(tmpdir(), 'zc-exif-default-'))
    try {
      const path = join(dir, 'photo.jpeg')
      await c.captureFile(path)
      expect(inspect(path, 'jpeg').software).toBe('zig-camera')
      await c.captureFile(path, { exif: false })
      expect(inspect(path, 'jpeg').hasExif).toBe(false)
      for (const exif of [undefined, false] as const) {
        const bytes = await c.switchModeAndCaptureEncodedImage(
          { width: 32, height: 24 },
          { format: 'jpeg', exif },
        )
        writeFileSync(path, bytes)
        expect(inspect(path, 'jpeg').hasExif).toBe(exif !== false)
        expect(c.info()).toMatchObject({ width: 18, height: 10 })
      }
      await c.captureFile(join(dir, 'plain.png'))
      expect(inspect(join(dir, 'plain.png'), 'png').hasExif).toBe(false)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
for (const format of ['jpeg', 'png', 'tiff'] as const)
  test.skipIf(!reader)(
    `${format} typed overrides preserve extended ISO, signed GPS, fractions and thumbnail bytes`,
    async () => {
      const c = camera(),
        dir = mkdtempSync(join(tmpdir(), 'zc-exif-fields-'))
      try {
        const path = join(dir, `photo.${format}`)
        await c.captureFile(path, {
          exif: {
            model: 'My model',
            artist: 'Chris',
            copyright: '(c) Chris',
            iso: 102400,
            exposureTime: [1, 125],
            fNumber: [28, 10],
            exposureBias: [-2, 3],
            dateTimeOriginal: '2001:02:03 04:05:06',
            gps: {
              latitude: -45.123456,
              longitude: -122.987654,
              altitude: -123.4,
            },
            thumbnail: Uint8Array.from([255, 216, 255, 217]),
          },
        })
        const found = inspect(path, format)
        expect(found).toMatchObject({
          model: 'My model',
          artist: 'Chris',
          copyright: '(c) Chris',
          iso: 102400,
          exposureTime: [1, 125],
          fNumber: [28, 10],
          exposureBias: [-2, 3],
          dateTimeOriginal: '2001:02:03 04:05:06',
          offsetTimeOriginal: null,
          subSecTimeOriginal: null,
          thumbnailHex: 'ffd8ffd9',
        })
        expect(found.gpsLatitude).toBeCloseTo(-45.123456, 7)
        expect(found.gpsLongitude).toBeCloseTo(-122.987654, 7)
        expect(found.gpsAltitude).toBeCloseTo(-123.4, 6)
      } finally {
        await c.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
test.skipIf(!reader)(
  'raw big-endian inputs are copied before queued, focus and mode captures; optional defaults preserve caller fields',
  async () => {
    const c = camera(),
      dir = mkdtempSync(join(tmpdir(), 'zc-exif-raw-'))
    try {
      const path = join(dir, 'photo.jpg'),
        raw = rawBigEndian()
      const job = c.captureFileAsync(path, { exif: raw, dropFrames: 2 })
      raw.fill(0)
      await job
      expect(inspect(path, 'jpeg')).toMatchObject({
        byteOrder: 'big',
        artist: 'A',
        software: null,
      })
      c.startContinuousAutofocus()
      const bytes = await c.captureFocusLockedEncodedImage({
        exif: { raw: rawBigEndian(), captureMetadata: true },
      })
      writeFileSync(path, bytes)
      expect(inspect(path, 'jpeg')).toMatchObject({
        byteOrder: 'big',
        artist: 'A',
        software: 'zig-camera',
        width: 18,
      })
      const source = rawBigEndian()
      const mode = c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        exif: { raw: source, captureMetadata: true },
      })
      source.fill(0)
      await mode
      expect(inspect(path, 'jpeg')).toMatchObject({
        artist: 'A',
        width: 32,
        height: 24,
      })
      expect(c.info()).toMatchObject({ width: 18, height: 10 })
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
test('invalid Exif rejects before capture admission and retains destination bytes', async () => {
  const c = camera(),
    dir = mkdtempSync(join(tmpdir(), 'zc-exif-invalid-'))
  try {
    const path = join(dir, 'keep.jpg')
    writeFileSync(path, 'keep')
    const invalid: unknown[] = [
      null,
      1,
      { artist: 'nonASCII \u00e9' },
      { iso: 0 },
      { gps: { latitude: 91 } },
      { gps: { longitude: NaN } },
      {
        gps: {
          timestamp: [
            [24, 1],
            [0, 1],
            [0, 1],
          ],
        },
      },
      { exposureTime: [1, 0] },
      { orientation: 9 },
      { raw: rawBigEndian(), artist: 'conflict' },
      { tags: [{ group: 'image', tag: 0x8769, type: 'long', value: 8 }] },
      {
        artist: 'A',
        tags: [
          { group: 'image', tag: 0x013b, type: 'ascii', value: 'duplicate' },
        ],
      },
      new Uint8Array([1, 2, 3]),
    ]
    const before = c.stats().delivered
    for (const exif of invalid)
      expect(() =>
        c.captureFileAsync(path, { exif: exif as ImageExif }),
      ).toThrow()
    for (const format of ['bmp', 'ppm', 'dng'] as const)
      expect(() => c.captureEncodedImageAsync({ format, exif: true })).toThrow()
    expect(c.stats().delivered).toBe(before)
    expect(c.stats().leased).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['keep.jpg'])
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('Exif preparation reads documented getters once and copies nested custom field values', () => {
  let artistReads = 0,
    valueReads = 0
  const bytes = Uint8Array.of(65, 0)
  const result = prepareExif(
    {
      captureMetadata: false,
      get artist() {
        artistReads++
        return 'Chris'
      },
      tags: [
        {
          group: 'image',
          tag: 0x010e,
          type: 'ascii',
          get value() {
            valueReads++
            return bytes
          },
        },
      ],
    },
    1,
  )!
  const copy = result.data!.slice()
  bytes.fill(0)
  expect(result.data).toEqual(copy)
  expect(artistReads).toBe(1)
  expect(valueReads).toBe(1)
})

test('capture-default growth past JPEG APP1 capacity leaves existing files intact and releases the lease', async () => {
  const c = camera(),
    dir = mkdtempSync(join(tmpdir(), 'zc-exif-growth-'))
  try {
    const path = join(dir, 'keep.jpg'),
      raw = new Uint8Array(65500)
    raw.set([73, 73, 42, 0, 8, 0, 0, 0])
    writeFileSync(path, 'keep')
    await expect(
      c.captureFile(path, { exif: { raw, captureMetadata: true } }),
    ).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('keep')
    expect(readdirSync(dir)).toEqual(['keep.jpg'])
    expect(c.stats().leased).toBe(0)
    expect(
      (await c.captureEncodedImage({ exif: false })).length,
    ).toBeGreaterThan(4)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
