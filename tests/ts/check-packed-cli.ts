import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkvFrames } from './media'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera'),
  dir = mkdtempSync(join(tmpdir(), 'zc-packed-cli-'))
const formats = ['BGR888', 'RGB888', 'XBGR8888', 'XRGB8888'] as const
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
    let image: Buffer | undefined,
      packets: ReturnType<typeof mkvFrames> | undefined
    for (const format of formats) {
      const path = join(dir, `${stream}-${format}.png`)
      const opts = [
        ...common,
        '--main-format',
        format,
        '--lores-format',
        format,
      ]
      run(['capture', ...opts, '--image-stream', stream, '--output', path])
      const bytes = readFileSync(path)
      if (image) assert.deepEqual(bytes, image)
      else image = bytes
      const metadata = JSON.parse(readFileSync(`${path}.json`, 'utf8'))
      assert.equal(metadata.main_format, format)
      assert.equal(metadata.lores_format, format)
      const layout = {
        BGR888: 'rgb',
        RGB888: 'bgr',
        XBGR8888: 'rgbx',
        XRGB8888: 'bgrx',
      }[format]
      assert.equal(
        readFileSync(`${path}.lores.${layout}`).length,
        16 * 16 * (format.length === 8 ? 4 : 3),
      )
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
  for (const format of ['RGBA8888', 'RGBX', 'invalid']) {
    const path = join(dir, 'rejected.png'),
      result = Bun.spawnSync([
        binary,
        'capture',
        ...common,
        '--main-format',
        format,
        '--output',
        path,
      ])
    assert.notEqual(result.exitCode, 0)
    assert.equal(existsSync(path), false)
  }
  console.log('packed CLI capture, sidecars and recordings validated with Bun')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
