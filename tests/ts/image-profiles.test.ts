import { expect, test } from 'bun:test'
import { Camera, type ImageOptions } from '../../ts'
import { inflateSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const formats = ['jpeg', 'png', 'tiff'] as const
type Format = (typeof formats)[number]
const cam = (extra: ConstructorParameters<typeof Camera>[0] = {}) =>
  new Camera({
    simulate: true,
    width: 18,
    height: 10,
    fifo: true,
    lores: { width: 8, height: 6 },
    ...extra,
  })
export function imageProfile(input: Uint8Array, format: Format): Buffer {
  const b = Buffer.from(input)
  if (format === 'jpeg') {
    const parts: Buffer[] = []
    let at = 2,
      total = 0
    while (at < b.length && b[at + 1] !== 0xda) {
      expect(b[at]).toBe(255)
      const size = b.readUInt16BE(at + 2)
      if (
        b[at + 1] === 0xe2 &&
        b.toString('ascii', at + 4, at + 16) === 'ICC_PROFILE\0'
      ) {
        expect(b[at + 16]).toBe(parts.length + 1)
        total = b[at + 17]
        parts.push(b.subarray(at + 18, at + size + 2))
      }
      at += size + 2
    }
    expect(parts.length).toBe(total)
    expect(total).toBeGreaterThan(0)
    return Buffer.concat(parts)
  }
  if (format === 'png') {
    const profiles: Buffer[] = []
    for (let at = 8; at < b.length;) {
      const size = b.readUInt32BE(at),
        kind = b.toString('ascii', at + 4, at + 8)
      if (kind === 'iCCP') {
        const body = b.subarray(at + 8, at + 8 + size),
          zero = body.indexOf(0)
        expect(zero).toBeGreaterThan(0)
        expect(body[zero + 1]).toBe(0)
        profiles.push(
          inflateSync(body.subarray(zero + 2), {
            maxOutputLength: 16 * 1024 * 1024,
          }),
        )
      }
      expect(['sRGB', 'gAMA', 'cHRM', 'cICP'].includes(kind)).toBe(false)
      at += 12 + size
    }
    expect(profiles.length).toBe(1)
    return profiles[0]
  }
  const little = b.toString('ascii', 0, 2) === 'II'
  const u16 = (at: number) => (little ? b.readUInt16LE(at) : b.readUInt16BE(at))
  const u32 = (at: number) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at))
  const at = u32(4),
    entries = u16(at),
    profiles: Buffer[] = []
  for (let i = 0; i < entries; i++) {
    const field = at + 2 + i * 12
    if (u16(field) === 34675) {
      expect(u16(field + 2)).toBe(7)
      const count = u32(field + 4),
        offset = u32(field + 8)
      profiles.push(b.subarray(offset, offset + count))
    }
  }
  expect(profiles.length).toBe(1)
  return profiles[0]
}
for (const format of formats)
  test(`owned ${format} ICC bytes and atomic files preserve profile and samples`, async () => {
    const c = cam(),
      dir = mkdtempSync(join(tmpdir(), 'zc-icc-'))
    try {
      c.start()
      using frame = c.acquire()
      const plain = frame.encodeImage({ format }),
        encoded = frame.encodeImage({ format, iccProfile: 'srgb' })
      const profile = imageProfile(encoded, format)
      expect(profile.toString('ascii', 36, 40)).toBe('acsp')
      expect(profile.readUInt32BE(0)).toBe(profile.length)
      const path = join(dir, `image.${format}`),
        basePath = join(dir, `plain.${format}`)
      frame.saveFile(path, { format, iccProfile: 'srgb' })
      writeFileSync(basePath, plain)
      expect(imageProfile(readFileSync(path), format)).toEqual(profile)
      if (format === 'jpeg') {
        const scan = (b: Buffer) => {
          let at = 2
          while (b[at + 1] !== 0xda) at += b.readUInt16BE(at + 2) + 2
          return b.subarray(at)
        }
        expect(scan(Buffer.from(encoded))).toEqual(scan(Buffer.from(plain)))
      }
      if (format === 'png') {
        const idat = (data: Uint8Array) => {
          const b = Buffer.from(data),
            parts: Buffer[] = []
          for (let at = 8; at < b.length;) {
            const size = b.readUInt32BE(at)
            if (b.toString('ascii', at + 4, at + 8) === 'IDAT')
              parts.push(b.subarray(at + 8, at + 8 + size))
            at += size + 12
          }
          return Buffer.concat(parts)
        }
        expect(idat(encoded)).toEqual(idat(plain))
      }
      const independent = process.env.ZC_IMAGE_DECODER
      if (independent) {
        const decoded = (p: string) => {
          const result = Bun.spawnSync([independent, format, p])
          expect(result.exitCode).toBe(0)
          return Buffer.from(result.stdout)
        }
        expect(decoded(path)).toEqual(decoded(basePath))
      }
      if (process.env.ZC_ICC_READER) {
        const result = Bun.spawnSync([process.env.ZC_ICC_READER, format, path])
        expect(result.exitCode).toBe(0)
        expect(Buffer.from(result.stdout)).toEqual(Buffer.from(profile))
      }
      frame.release()
      await c.close()
      expect(imageProfile(encoded, format)).toEqual(profile)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
test('ICC profiles are copied at capture admission, including mode-worker file and encoded jobs', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-icc-copy-'))
  try {
    const base = imageProfile(
      await c.captureEncodedImage({ format: 'png', iccProfile: 'srgb' }),
      'png',
    )
    for (const format of formats) {
      const bytes = new Uint8Array(base),
        options: ImageOptions & { dropFrames: number } = {
          format,
          iccProfile: bytes,
          dropFrames: 2,
        }
      const job = c.captureEncodedImageAsync(options)
      bytes.fill(0)
      options.iccProfile = 'srgb'
      options.format = 'bmp'
      expect(imageProfile(await job, format)).toEqual(base)
      const modeBytes = new Uint8Array(base)
      const switched = c.switchModeAndCaptureEncodedImage(
        { width: 32, height: 24 },
        { format, iccProfile: modeBytes },
      )
      modeBytes.fill(0)
      expect(imageProfile(await switched, format)).toEqual(base)
      const path = join(dir, `mode.${format}`),
        fileBytes = new Uint8Array(base)
      const file = c.switchModeAndCaptureFile({ width: 32, height: 24 }, path, {
        format,
        iccProfile: fileBytes,
      })
      fileBytes.fill(0)
      expect((await file).sequence).toBeGreaterThan(0n)
      expect(imageProfile(readFileSync(path), format)).toEqual(base)
      expect(c.info()).toMatchObject({ width: 18, height: 10 })
      expect(c.stats().leased).toBe(0)
    }
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('sRGB matches actual main/lores RGB and I420 metadata and rejects gamut or transfer mismatch without replacing a file', async () => {
  const c = cam({ format: 'YUV420', colorSpace: 'sycc' }),
    dir = mkdtempSync(join(tmpdir(), 'zc-icc-color-'))
  try {
    for (const stream of ['main', 'lores'] as const)
      expect(
        imageProfile(
          await c.captureEncodedImage({
            format: 'png',
            iccProfile: 'srgb',
            stream,
          }),
          'png',
        ).length,
      ).toBeGreaterThan(132)
    const path = join(dir, 'keep.png')
    writeFileSync(path, 'existing')
    const error = await c
      .switchModeAndCaptureFile({ colorSpace: 'rec2020' }, path, {
        format: 'png',
        iccProfile: 'srgb',
      })
      .then(
        () => null,
        (e) => e,
      )
    expect(error).toMatchObject({ code: -8 })
    expect(readFileSync(path, 'utf8')).toBe('existing')
    expect(c.colorSpace().transfer).toBe('srgb')
    expect(
      imageProfile(
        await c.captureEncodedImage({ format: 'png', iccProfile: 'srgb' }),
        'png',
      ).length,
    ).toBeGreaterThan(132)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
  for (const colorSpace of ['rec709', 'rec2020', 'smpte170m'] as const) {
    const other = cam({ colorSpace })
    try {
      await expect(
        other.captureEncodedImage({ format: 'png', iccProfile: 'srgb' }),
      ).rejects.toMatchObject({ code: -8 })
    } finally {
      await other.close()
    }
  }
})
test('malformed, oversized, non-RGB profiles and unsupported still formats reject before queuing', async () => {
  const c = cam()
  try {
    const profile = imageProfile(
      await c.captureEncodedImage({ format: 'png', iccProfile: 'srgb' }),
      'png',
    )
    for (const value of [
      null,
      12,
      {},
      new Uint8Array(),
      new Uint8Array(16 * 1024 * 1024 + 1),
      new Uint8Array([1, 2, 3]),
    ])
      expect(() =>
        c.captureEncodedImageAsync({
          format: 'png',
          iccProfile: value as never,
        }),
      ).toThrow()
    const cmyk = Buffer.from(profile)
    const tooManyJpegParts = Buffer.alloc(65519 * 255 + 1)
    profile.copy(tooManyJpegParts)
    tooManyJpegParts.writeUInt32BE(tooManyJpegParts.length, 0)
    expect(() =>
      c.captureEncodedImageAsync({
        format: 'jpeg',
        iccProfile: tooManyJpegParts,
      }),
    ).toThrow()
    cmyk.write('CMYK', 16, 'ascii')
    expect(() =>
      c.captureEncodedImageAsync({ format: 'png', iccProfile: cmyk }),
    ).toThrow()
    for (const format of ['bmp', 'ppm', 'dng'] as const)
      expect(() =>
        c.captureEncodedImageAsync({ format, iccProfile: 'srgb' }),
      ).toThrow()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})

test('large custom JPEG profiles survive APP2 fragmentation and independent extraction', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-icc-parts-'))
  try {
    const base = imageProfile(
      await c.captureEncodedImage({ format: 'png', iccProfile: 'srgb' }),
      'png',
    )
    const profile = Buffer.alloc(131100)
    base.copy(profile)
    profile.writeUInt32BE(profile.length, 0)
    const path = join(dir, 'large.jpg')
    await c.captureFile(path, { format: 'jpeg', iccProfile: profile })
    expect(imageProfile(readFileSync(path), 'jpeg')).toEqual(profile)
    if (process.env.ZC_ICC_READER) {
      const result = Bun.spawnSync([process.env.ZC_ICC_READER, 'jpeg', path])
      expect(result.exitCode).toBe(0)
      expect(Buffer.from(result.stdout)).toEqual(Buffer.from(profile))
    }
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('cancelled profile capture leaves files intact and focus-locked jobs retain prepared profiles', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-icc-cancel-'))
  try {
    const profile = imageProfile(
      await c.captureEncodedImage({ format: 'png', iccProfile: 'srgb' }),
      'png',
    )
    const path = join(dir, 'keep.png')
    writeFileSync(path, 'keep')
    const job = c.captureFileAsync(path, {
      iccProfile: new Uint8Array(profile),
      dropFrames: 100,
    })
    expect(job.cancel()).toBe(true)
    await expect(Promise.resolve(job)).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('keep')
    c.startContinuousAutofocus()
    const result = await c.captureFocusLockedEncodedImage({
      format: 'png',
      iccProfile: 'srgb',
    })
    expect(imageProfile(result, 'png')).toEqual(profile)
    expect(await c.autofocusPause()).toBe(3)
    expect(await c.autofocusResume()).toBe(3)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
