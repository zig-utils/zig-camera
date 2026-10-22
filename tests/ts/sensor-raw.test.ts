import { expect, test } from 'bun:test'
import { Camera } from '../../ts'
import { referenceWord } from './sensor-reference'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const patterns = ['RGGB', 'BGGR', 'GRBG', 'GBRG']
const formats = patterns
  .flatMap((p) => [
    ...[8, 10, 12, 14, 16].map((b) => `S${p}${b}`),
    ...[10, 12, 14].map((b) => `S${p}${b}_CSI2P`),
    `${p}_PISP_COMP1`,
  ])
  .concat([
    'R8',
    'R10',
    'R12',
    'R14',
    'R16',
    'R8_CSI2P',
    'R10_CSI2P',
    'R12_CSI2P',
    'R14_CSI2P',
    'MONO_PISP_COMP1',
  ])
function descriptor(format: string) {
  const comp = format.endsWith('_PISP_COMP1'),
    bits = comp ? 16 : Number(format.match(/\d+/)![0]),
    mono = format.startsWith('MONO') || /^R\d/.test(format),
    packed = format.endsWith('_CSI2P')
  return {
    comp,
    bits,
    mono,
    packed,
    row: (w: number) =>
      comp
        ? Math.ceil(w / 8) * 8
        : packed && bits > 8
          ? Math.ceil(w / (bits === 12 ? 2 : 4)) *
            (bits === 10 ? 5 : bits === 12 ? 3 : 7)
          : w * (bits === 8 ? 1 : 2),
  }
}
function decodePhysical(
  data: Uint8Array,
  w: number,
  h: number,
  format: string,
) {
  const d = descriptor(format),
    b = Buffer.from(data),
    stride = d.row(w)
  return Uint16Array.from({ length: w * h }, (_, i) => {
    const x = i % w,
      y = Math.floor(i / w),
      row = y * stride
    if (d.comp)
      return referenceWord(
        b.readUInt32LE(row + Math.floor(x / 8) * 8 + (x % 2) * 4),
      )[Math.floor((x % 8) / 2)]
    if (d.bits === 8) return b[row + x]
    if (!d.packed) return b.readUInt16LE(row + x * 2)
    const group = d.bits === 12 ? 2 : 4,
      size = d.bits === 10 ? 5 : d.bits === 12 ? 3 : 7,
      base = row + Math.floor(x / group) * size,
      shift = (x % group) * (d.bits - 8)
    let low = b[base + group + Math.floor(shift / 8)]
    if ((shift % 8) + d.bits - 8 > 8)
      low += b[base + group + Math.floor(shift / 8) + 1] * 256
    return (
      b[base + (x % group)] * 2 ** (d.bits - 8) +
      ((low >>> (shift % 8)) & (2 ** (d.bits - 8) - 1))
    )
  })
}
function tags(bytes: Uint8Array) {
  const b = Buffer.from(bytes),
    at = b.readUInt32LE(4),
    n = b.readUInt16LE(at),
    result = new Map<
      number,
      { type: number; count: number; at: number; value: number }
    >()
  expect(b.toString('ascii', 0, 2)).toBe('II')
  for (let i = 0; i < n; i++) {
    const p = at + 2 + i * 12
    result.set(b.readUInt16LE(p), {
      type: b.readUInt16LE(p + 2),
      count: b.readUInt32LE(p + 4),
      at: p + 8,
      value: b.readUInt32LE(p + 8),
    })
  }
  return { b, values: result }
}
function dngWords(bytes: Uint8Array) {
  const { b, values } = tags(bytes),
    w = values.get(256)!.value,
    h = values.get(257)!.value,
    p = values.get(273)!.value
  expect(values.get(258)!.value).toBe(16)
  expect(values.get(279)!.value).toBe(w * h * 2)
  return Uint16Array.from({ length: w * h }, (_, i) =>
    b.readUInt16LE(p + i * 2),
  )
}
for (const format of formats)
  test(`${format} raw ownership precision physical packing and DNG`, async () => {
    const c = new Camera({
        simulate: true,
        width: 17,
        height: 5,
        raw: true,
        rawFormat: format,
        writable: true,
        fifo: true,
      }),
      dir = mkdtempSync(join(tmpdir(), 'zc-sensor-'))
    try {
      c.start()
      using f = c.acquire()
      const physical = f.copyStream('raw'),
        d = descriptor(format)
      expect(physical.rowBytes).toBe(d.row(17))
      expect(physical.data.length).toBe(d.row(17) * 5)
      const want = decodePhysical(physical.data, 17, 5, format),
        words = f.copyRaw16()
      expect(words).toEqual(want)
      if (!d.comp)
        for (let y = 0; y < 5; y++)
          for (let x = 0; x < 17; x++)
            expect(words[y * 17 + x]).toBe(
              2 ** (d.bits - 6) +
                ((x * 17 + y * 31) % (2 ** d.bits - 1 - 2 ** (d.bits - 6))),
            )
      const bytes = f.encodeImage({ format: 'dng' }),
        { values } = tags(bytes)
      expect(dngWords(bytes)).toEqual(want)
      expect(values.get(262)!.value).toBe(d.mono ? 34892 : 32803)
      expect(values.get(50717)!.value).toBe(2 ** d.bits - 1)
      if (d.mono) {
        for (const tag of [33421, 33422, 50710, 50711, 50721, 50728, 50778])
          expect(values.has(tag)).toBe(false)
        expect(values.get(50714)!.count).toBe(1)
        expect(values.get(50713)!.value).toBe(0x00010001)
      } else {
        expect(values.get(33422)!.count).toBe(4)
        expect(values.get(50714)!.count).toBe(4)
      }
      const path = join(dir, 'frame.dng')
      f.saveFile(path, { format: 'dng' })
      expect(dngWords(readFileSync(path))).toEqual(want)
      if (process.env.ZC_RAW16_DECODER) {
        const result = Bun.spawnSync([process.env.ZC_RAW16_DECODER, path])
        expect(result.exitCode).toBe(0)
        expect(Buffer.from(result.stdout).subarray(8)).toEqual(
          Buffer.from(want.buffer),
        )
      }
      let alias: Uint8Array | undefined
      f.withMappedStream((map) => {
        alias = map.row(0)
        expect(alias.length).toBe(d.row(17))
        expect(() => f.copyRaw16()).toThrow()
      }, 'raw')
      expect(alias!.byteLength).toBe(0)
      f.release()
      expect(words).toEqual(want)
      expect(() => f.copyRaw16()).toThrow()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
for (const format of ['RGGB_PISP_COMP1', 'MONO_PISP_COMP1'])
  test(`${format} every COMP1 mode and clipping survives writable raw maps`, async () => {
    const c = new Camera({
      simulate: true,
      width: 17,
      height: 3,
      raw: true,
      rawFormat: format,
      writable: true,
      fifo: true,
    })
    const vectors = [
      0, 1, 2, 3, 0xffffffff, 0x80000000, 0xaaaaaaaa, 0x55555555, 0x7fffffff,
      0x01020304, 0x8f00ffff,
    ]
    try {
      c.start()
      using f = c.acquire()
      f.withMappedStream((map) => {
        for (let y = 0; y < 3; y++) {
          const row = map.row(y),
            dv = new DataView(row.buffer, row.byteOffset, row.length)
          for (let i = 0; i < row.length / 4; i++)
            dv.setUint32(i * 4, vectors[(y * 6 + i) % vectors.length], true)
        }
      }, 'raw')
      const physical = f.copyStream('raw'),
        want = decodePhysical(physical.data, 17, 3, format)
      expect(f.copyRaw16()).toEqual(want)
      expect(dngWords(f.encodeImage({ format: 'dng' }))).toEqual(want)
    } finally {
      await c.close()
    }
  })
for (const format of [
  'R8',
  'R10_CSI2P',
  'MONO_PISP_COMP1',
  'SRGGB8',
  'SRGGB12_CSI2P',
  'RGGB_PISP_COMP1',
])
  test(`${format} orthogonal modes transform sensor samples and retain correct CFA`, async () => {
    const base = new Camera({
        simulate: true,
        width: 20,
        height: 8,
        raw: true,
        rawFormat: format,
        fifo: true,
      }),
      target = new Camera({
        simulate: true,
        width: 8,
        height: 20,
        raw: true,
        rawFormat: format,
        fifo: true,
        transform: { rotation: 90 },
      })
    try {
      base.start()
      target.start()
      using a = base.acquire()
      using b = target.acquire()
      const first = a.copyRaw16(),
        actual = b.copyRaw16()
      expect(actual.length).toBe(first.length)
      const raw = b.copyStream('raw')
      expect(raw.width).toBe(8)
      expect(raw.height).toBe(20)
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 8; x++)
          expect(actual[y * 8 + x]).toBe(first[(7 - x) * 20 + y])
      if (descriptor(format).mono) expect(raw.format).toBe(format)
      else expect(raw.format).not.toBe(format)
      expect(actual).toEqual(dngWords(b.encodeImage({ format: 'dng' })))
    } finally {
      await base.close()
      await target.close()
    }
  })
test('raw16 jobs own samples after source close and temporary modes restore the original raw recipe', async () => {
  const c = new Camera({
    simulate: true,
    width: 17,
    height: 5,
    raw: true,
    rawFormat: 'R10_CSI2P',
    fifo: true,
  })
  try {
    const copy = await c.captureRaw16Async()
    expect(copy.length).toBe(85)
    const bundle = await c.switchModeAndCaptureStreams(
      { width: 25, height: 9, raw: true, rawFormat: 'RGGB_PISP_COMP1' },
      ['main', 'raw'],
    )
    expect(bundle.streams.raw!.data.length).toBe(32 * 9)
    using restored = await c.captureRequest()
    expect(restored.copyStream('raw').format).toBe('R10_CSI2P')
    restored.release()
    await c.close()
    expect(copy[0]).toBe(16)
  } finally {
    await c.close()
  }
  const plain = new Camera({ simulate: true, width: 17, height: 5 })
  try {
    await expect(plain.captureRaw16()).rejects.toThrow()
    expect(plain.stats().leased).toBe(0)
  } finally {
    await plain.close()
  }
})
test('invalid packed aliases and contradictory unpacked requests reject before opening', () => {
  for (const rawFormat of [
    'RGGB_PISP_COMP2',
    'R16_CSI2P',
    'SRGGB16_PISP_COMP1',
    'R08',
  ])
    expect(
      () =>
        new Camera({
          simulate: true,
          width: 17,
          height: 5,
          raw: true,
          rawFormat,
        }),
    ).toThrow()
  for (const rawFormat of ['RGGB_PISP_COMP1', 'MONO_PISP_COMP1', 'R10_CSI2P'])
    expect(
      () =>
        new Camera({
          simulate: true,
          width: 17,
          height: 5,
          raw: true,
          rawFormat,
          unpackedRaw: true,
        }),
    ).toThrow()
})
for (const rawFormat of ['MONO_PISP_COMP1', 'RGGB_PISP_COMP1', 'R10_CSI2P'])
  test(`${rawFormat} temporary encoded and staged DNG jobs honor explicit packing and restore`, async () => {
    const c = new Camera({ simulate: true, width: 17, height: 5, fifo: true }),
      dir = mkdtempSync(join(tmpdir(), 'zc-sensor-mode-'))
    try {
      const bytes = await c.switchModeAndCaptureEncodedImage(
        { width: 25, height: 9, rawFormat },
        { format: 'dng' },
      )
      expect(dngWords(bytes).length).toBe(25 * 9)
      expect(c.options.raw).toBeUndefined()
      const path = join(dir, 'mode.dng')
      await c.switchModeAndCaptureFile(
        { width: 25, height: 9, rawFormat },
        path,
      )
      expect(dngWords(readFileSync(path))).toEqual(dngWords(bytes))
      expect(c.options.raw).toBeUndefined()
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
