import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkvFrames } from './media'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera'),
  dir = mkdtempSync(join(tmpdir(), 'zc-yuv-cli-'))
const formats = ['YUV420', 'YVU420', 'NV12', 'NV21'] as const
const common = [
  '--simulate',
  '--fifo',
  '--width',
  '32',
  '--height',
  '24',
  '--lores-width',
  '16',
  '--lores-height',
  '16',
  '--warmup',
  '0',
]
function run(args: string[]) {
  const result = Bun.spawnSync([binary, ...args])
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
}
try {
  for (const stream of ['main', 'lores']) {
    let canonical: Buffer | undefined,
      image: Buffer | undefined,
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
      const suffix = {
        YUV420: 'i420',
        YVU420: 'yv12',
        NV12: 'nv12',
        NV21: 'nv21',
      }[format]
      const raw = readFileSync(`${path}.lores.${suffix}`),
        pixels = 16 * 16
      assert.equal(raw.length, (pixels * 3) / 2)
      if (!canonical) canonical = raw
      const expected = Buffer.from(canonical)
      if (format === 'YVU420') {
        canonical.copy(expected, pixels, (pixels * 5) / 4)
        canonical.copy(expected, (pixels * 5) / 4, pixels, (pixels * 5) / 4)
      }
      if (format === 'NV12' || format === 'NV21')
        for (let i = 0; i < pixels / 4; i++) {
          expected[pixels + i * 2] =
            canonical[pixels + (format === 'NV12' ? 0 : pixels / 4) + i]
          expected[pixels + i * 2 + 1] =
            canonical[pixels + (format === 'NV12' ? pixels / 4 : 0) + i]
        }
      assert.deepEqual(raw, expected)
      const video = join(dir, `${stream}-${format}.mkv`)
      run([
        'record',
        ...opts,
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
  for (const format of formats.slice(1))
    for (const args of [
      ['--width', '31'],
      ['--height', '23'],
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
    'YUV CLI images, raw chroma ordering and recordings validated with Bun',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
