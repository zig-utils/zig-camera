import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeGif } from './gif-media'
const cli = process.argv[2]
assert(cli)
const dir = mkdtempSync(join(tmpdir(), 'zc-cli-gif-'))
try {
  for (const stream of ['main', 'lores'])
    for (const format of ['BGR888', 'RGB161616', 'NV21', 'UYVY']) {
      const path = join(dir, `${format}-${stream}.GIF`)
      const result = Bun.spawnSync([
        cli,
        'capture',
        '--simulate',
        '--fifo',
        '--width',
        '18',
        '--height',
        '10',
        '--lores-width',
        '10',
        '--lores-height',
        '6',
        '--main-format',
        format,
        '--lores-format',
        format,
        '--image-stream',
        stream,
        '--warmup',
        '0',
        '--output',
        path,
      ])
      assert.equal(
        result.exitCode,
        0,
        new TextDecoder().decode(result.stderr),
      )
      const image = decodeGif(path)
      assert.deepEqual(
        [image.width, image.height],
        stream === 'main' ? [18, 10] : [10, 6],
      )
      for (let i = 3; i < image.pixels.length; i += 4)
        assert.equal(image.pixels[i], 255)
    }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
