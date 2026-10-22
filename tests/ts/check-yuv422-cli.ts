import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkvFrames } from './media'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera'),
  dir = mkdtempSync(join(tmpdir(), 'zc-422-cli-'))
const formats = ['YUYV', 'YVYU', 'UYVY', 'VYUY'] as const,
  offsets = {
    YUYV: [0, 1, 2, 3],
    YVYU: [0, 3, 2, 1],
    UYVY: [1, 0, 3, 2],
    VYUY: [1, 2, 3, 0],
  }
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
    let image: Buffer | undefined,
      canonical: Buffer | undefined,
      packets: ReturnType<typeof mkvFrames> | undefined
    for (const format of formats) {
      const path = join(dir, `${stream}-${format}.png`),
        opts = [...common, '--main-format', format, '--lores-format', format]
      run(['capture', ...opts, '--image-stream', stream, '--output', path])
      const bytes = readFileSync(path)
      if (image) assert.deepEqual(bytes, image)
      else image = bytes
      const metadata = JSON.parse(readFileSync(`${path}.json`, 'utf8'))
      assert.equal(metadata.main_format, format)
      assert.equal(metadata.lores_format, format)
      const raw = readFileSync(`${path}.lores.${format.toLowerCase()}`)
      assert.equal(raw.length, 16 * 13 * 2)
      if (!canonical) canonical = raw
      for (let i = 0; i < raw.length; i += 4)
        for (let k = 0; k < 4; k++)
          assert.equal(raw[i + offsets[format][k]], canonical[i + k])
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
  for (const format of formats)
    for (const args of [
      ['--width', '31'],
      ['--color-space', 'srgb'],
    ]) {
      const path = join(dir, 'invalid.png'),
        result = Bun.spawnSync([
          binary,
          'capture',
          ...common,
          '--main-format',
          format,
          ...args,
          '--output',
          path,
        ])
      assert.notEqual(result.exitCode, 0)
      assert.equal(existsSync(path), false)
    }
  console.log(
    'packed 422 CLI odd-height images, raw byte order and recordings validated with Bun',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
