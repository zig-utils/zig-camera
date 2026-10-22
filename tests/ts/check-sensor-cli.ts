import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { referenceWord } from './sensor-reference'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera'),
  dir = mkdtempSync(join(tmpdir(), 'zc-sensor-cli-'))
function run(args: string[]) {
  const result = Bun.spawnSync([binary, ...args])
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
}
try {
  for (const format of [
    'R8',
    'R8_CSI2P',
    'R10_CSI2P',
    'R12',
    'R14_CSI2P',
    'MONO_PISP_COMP1',
    'SRGGB8',
    'SBGGR12_CSI2P',
    'RGGB_PISP_COMP1',
  ]) {
    const opts = [
        '--simulate',
        '--fifo',
        '--width',
        '17',
        '--height',
        '5',
        '--raw',
        '--raw-format',
        format,
        '--warmup',
        '0',
      ],
      png = join(dir, format + '.png'),
      dng = join(dir, format + '.dng')
    run(['capture', ...opts, '--output', png])
    run(['capture', ...opts, '--output', dng])
    const meta = JSON.parse(readFileSync(dng + '.json', 'utf8')),
      raw = readFileSync(png + '.raw.0'),
      b = readFileSync(dng),
      at = b.readUInt32LE(4),
      count = b.readUInt16LE(at),
      tags = new Map<number, number>()
    assert.equal(meta.raw_format, format)
    assert.equal(meta.raw_width, 17)
    assert.equal(meta.raw_height, 5)
    assert.equal(raw.length, meta.raw_stride * 5)
    for (let i = 0; i < count; i++) {
      const p = at + 2 + i * 12
      tags.set(b.readUInt16LE(p), b.readUInt32LE(p + 8))
    }
    assert.equal(tags.get(258), 16)
    assert.equal(
      tags.get(262),
      format.startsWith('S') || format.startsWith('RGGB') ? 32803 : 34892,
    )
    const start = tags.get(273)!,
      comp = format.endsWith('_PISP_COMP1'),
      bits = comp ? 16 : Number(format.match(/\d+/)![0]),
      packed = format.endsWith('_CSI2P')
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 17; x++) {
        const row = y * meta.raw_stride
        let value: number
        if (comp)
          value = referenceWord(
            raw.readUInt32LE(row + Math.floor(x / 8) * 8 + (x % 2) * 4),
          )[Math.floor((x % 8) / 2)]
        else if (bits === 8) value = raw[row + x]
        else if (!packed) value = raw.readUInt16LE(row + x * 2)
        else {
          const group = bits === 12 ? 2 : 4,
            size = bits === 10 ? 5 : bits === 12 ? 3 : 7,
            base = row + Math.floor(x / group) * size,
            shift = (x % group) * (bits - 8)
          let low = raw[base + group + Math.floor(shift / 8)]
          if ((shift % 8) + bits - 8 > 8)
            low += raw[base + group + Math.floor(shift / 8) + 1] * 256
          value =
            raw[base + (x % group)] * 2 ** (bits - 8) +
            ((low >>> (shift % 8)) & (2 ** (bits - 8) - 1))
        }
        assert.equal(b.readUInt16LE(start + (y * 17 + x) * 2), value)
      }
    if (process.env.ZC_RAW16_DECODER) {
      const decoded = Bun.spawnSync([process.env.ZC_RAW16_DECODER, dng])
      assert.equal(decoded.exitCode, 0)
      assert.deepEqual(
        Buffer.from(decoded.stdout).subarray(8),
        b.subarray(start),
      )
    }
    if (process.env.ZC_RAW_IDENTIFY) {
      const result = Bun.spawnSync([process.env.ZC_RAW_IDENTIFY, dng])
      assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
    }
  }
  for (const format of ['R08', 'RGGB_PISP_COMP2', 'R16_CSI2P']) {
    const path = join(dir, 'bad.dng'),
      result = Bun.spawnSync([
        binary,
        'capture',
        '--simulate',
        '--raw-format',
        format,
        '--warmup',
        '0',
        '--output',
        path,
      ])
    assert.notEqual(result.exitCode, 0)
    assert.equal(existsSync(path), false)
  }
  console.log(
    'Bayer/mono unpacked, CSI-2 and COMP1 CLI DNG preserves raw samples and metadata',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
