import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkvFrames } from './media'
const root = mkdtempSync(join(tmpdir(), 'zc-cli-rotation-'))
const record = (dir: string) =>
  Bun.spawnSync([
    resolve('zig-out/bin/zig-camera'),
    'record',
    '--simulate',
    '--width',
    '32',
    '--height',
    '24',
    '--frames',
    '40',
    '--warmup',
    '0',
    '--rotate-pattern',
    join(dir, 'rotation-{index:03}.mkv'),
    '--rotate-ms',
    '100',
  ])
try {
  const normal = join(root, 'normal')
  mkdirSync(normal)
  const result = record(normal)
  assert.equal(result.exitCode, 0, result.stderr.toString())
  const files = readdirSync(normal).filter((name) =>
    /^rotation-\d+\.mkv$/.test(name),
  )
  assert(files.length > 1)
  assert.equal(
    files.reduce((n, file) => n + mkvFrames(join(normal, file)).length, 0),
    40,
  )
  const collision = join(root, 'collision')
  mkdirSync(collision)
  const existing = join(collision, 'rotation-001.mkv')
  writeFileSync(existing, 'preserve-existing')
  assert.notEqual(record(collision).exitCode, 0)
  assert.equal(readFileSync(existing, 'utf8'), 'preserve-existing')
  console.log(
    'CLI rotation: all 40 frames across multiple segments; exclusive collision preserved',
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
