import { strict as assert } from 'node:assert'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkvFrames } from './media'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera'),
  dir = mkdtempSync(join(tmpdir(), 'zc-quality-cli-'))
function run(args: string[]) {
  return Bun.spawnSync([binary, ...args])
}
try {
  for (const [tier, quality] of [
    ['very-low', 25],
    ['low', 35],
    ['medium', 50],
    ['high', 65],
    ['very-high', 80],
  ] as const) {
    const named = join(dir, `${tier}.mkv`),
      numeric = join(dir, `${quality}.mkv`)
    const common = [
      'record',
      '--simulate',
      '--fifo',
      '--width',
      '32',
      '--height',
      '24',
      '--frames',
      '3',
      '--warmup',
      '0',
    ]
    for (const [args, path] of [
      [['--quality', '99', '--quality-tier', tier], named],
      [['--quality', String(quality)], numeric],
    ] as const) {
      const result = run([...common, ...args, '--output', path])
      assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
    }
    assert.deepEqual(mkvFrames(named), mkvFrames(numeric))
  }
  for (const [command, tier] of [
    ['record', 'HIGH'],
    ['capture', 'medium'],
  ] as const) {
    const path = join(
        dir,
        command === 'capture' ? 'invalid.jpeg' : 'invalid.mkv',
      ),
      result = run([
        command,
        '--simulate',
        '--quality-tier',
        tier,
        '--frames',
        '1',
        '--warmup',
        '0',
        '--output',
        path,
      ])
    assert.notEqual(result.exitCode, 0)
    assert.equal(existsSync(path), false)
  }
  console.log(
    'named JPEG recording tiers match numeric CLI encoding; invalid policy has no output',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
