import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkvFrames } from './media'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera'),
  dir = mkdtempSync(join(tmpdir(), 'zc-rgb16-cli-'))
const formats = ['BGR161616', 'RGB161616'] as const
const common = [
  '--simulate',
  '--fifo',
  '--width',
  '32',
  '--height',
  '25',
  '--lores-width',
  '16',
  '--lores-height',
  '13',
  '--warmup',
  '0',
]
function run(args: string[]) {
  const result = Bun.spawnSync([binary, ...args])
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
}
try {
  for (const stream of ['main', 'lores']) {
    const images = new Map<string, Buffer>()
    let canonical: Buffer | undefined,
      packets: ReturnType<typeof mkvFrames> | undefined
    for (const format of formats) {
      const opts = [
        ...common,
        '--main-format',
        format,
        '--lores-format',
        format,
      ]
      for (const ext of ['png', 'tiff', 'ppm', 'bmp', 'jpeg']) {
        const path = join(dir, `${stream}-${format}.${ext}`)
        run([
          'capture',
          ...opts,
          '--image-stream',
          stream,
          '--exif',
          'none',
          '--output',
          path,
        ])
        const bytes = readFileSync(path)
        if (images.has(ext)) assert.deepEqual(bytes, images.get(ext))
        else images.set(ext, bytes)
        if (ext === 'png') assert.equal(bytes[24], 16)
        if (ext === 'ppm')
          assert.ok(bytes.subarray(0, 30).includes(Buffer.from('65535\n')))
        if (ext === 'tiff') {
          const at = bytes.readUInt32LE(4),
            count = bytes.readUInt16LE(at)
          let bits: number | undefined
          for (let i = 0; i < count; i++) {
            const p = at + 2 + i * 12
            if (bytes.readUInt16LE(p) === 258) bits = bytes.readUInt32LE(p + 8)
          }
          assert.ok(bits)
          assert.deepEqual(
            [0, 2, 4].map((i) => bytes.readUInt16LE(bits! + i)),
            [16, 16, 16],
          )
        }
        const metadata = JSON.parse(readFileSync(`${path}.json`, 'utf8'))
        assert.equal(metadata.main_format, format)
        assert.equal(metadata.lores_format, format)
        const suffix = format === 'BGR161616' ? 'rgb48le' : 'bgr48le',
          raw = readFileSync(`${path}.lores.${suffix}`)
        assert.equal(raw.length, 16 * 13 * 6)
        if (format === 'BGR161616') canonical = raw
        assert.ok(canonical)
        for (let i = 0; i < raw.length; i += 6)
          for (let c = 0; c < 3; c++)
            assert.equal(
              raw.readUInt16LE(i + c * 2),
              canonical.readUInt16LE(
                i + (format === 'RGB161616' ? 2 - c : c) * 2,
              ),
            )
      }
      const video = join(dir, `${stream}-${format}.mkv`)
      run([
        'record',
        ...opts,
        '--height',
        '24',
        '--lores-height',
        '16',
        '--record-stream',
        stream,
        '--frames',
        '3',
        '--output',
        video,
      ])
      const actual = mkvFrames(video)
      if (packets) assert.deepEqual(actual, packets)
      else packets = actual
    }
  }
  const path = join(dir, 'invalid.png'),
    result = Bun.spawnSync([
      binary,
      'capture',
      ...common,
      '--main-format',
      'RGB161616_INVALID',
      '--output',
      path,
    ])
  assert.notEqual(result.exitCode, 0)
  assert.equal(existsSync(path), false)
  console.log(
    'RGB16 CLI word order, full-precision still headers, raw sidecars and recordings validated with Bun',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
