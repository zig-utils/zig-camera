import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera'),
  directory = mkdtempSync(join(tmpdir(), 'zc-align-cli-'))
try {
  for (const [profile, format, width] of [
    ['pisp', 'YUV420', 128],
    ['vc4', 'BGR888', 160],
    ['minimum', 'YUV420', 190],
  ] as const) {
    const path = join(directory, `${profile}.png`),
      result = Bun.spawnSync([
        binary,
        'capture',
        '--simulate',
        '--fifo',
        '--width',
        '191',
        '--height',
        '101',
        '--main-format',
        format,
        '--align',
        profile,
        '--lores-width',
        '129',
        '--lores-height',
        '65',
        '--warmup',
        '0',
        '--output',
        path,
      ])
    assert.equal(result.exitCode, 0, Buffer.from(result.stderr).toString())
    const image = readFileSync(path)
    assert.equal(image.readUInt32BE(16), width)
    assert.equal(image.readUInt32BE(20), 100)
    if (process.env.ZC_IMAGE_DECODER) {
      const decoded = Bun.spawnSync([process.env.ZC_IMAGE_DECODER, 'png', path])
      assert.equal(decoded.exitCode, 0, Buffer.from(decoded.stderr).toString())
      const bytes = Buffer.from(decoded.stdout)
      assert.deepEqual(
        [bytes.readUInt32LE(0), bytes.readUInt32LE(4)],
        [width, 100],
      )
    }
  }
  const automatic = Bun.spawnSync([
    binary,
    'info',
    '--simulate',
    '--align',
    'pisp',
  ])
  assert.equal(automatic.exitCode, 0, Buffer.from(automatic.stderr).toString())
  for (const args of [
    ['--align', 'unknown'],
    ['--align', 'pisp', '--width', '1', '--height', '3'],
  ]) {
    const path = join(directory, 'rejected.png'),
      result = Bun.spawnSync([
        binary,
        'capture',
        '--simulate',
        '--warmup',
        '0',
        '--output',
        path,
        ...args,
      ])
    assert.notEqual(result.exitCode, 0)
    assert.equal(existsSync(path), false)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
