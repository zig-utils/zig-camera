import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const args = process.argv.slice(2),
  value = (_key: string, fallback: string) => {
    const index = args.indexOf(_key)
    return index < 0 ? fallback : args[index + 1]
  }
const repeats = Number(value('--repeats', '5')),
  output = value('--output', 'bench/results/native.json')
assert(Number.isInteger(repeats) && repeats > 0)
const command = [
  './zig-out/bin/zig-camera',
  'bench',
  '--width',
  value('--width', '1920'),
  '--height',
  value('--height', '1080'),
  '--frames',
  value('--frames', '300'),
  '--warmup',
  '60',
  '--fifo',
]
if (args.includes('--simulate')) command.push('--simulate')
const rows = []
for (let i = 0; i < repeats; i++) {
  const result = Bun.spawnSync(command)
  assert.equal(result.exitCode, 0, result.stderr.toString())
  rows.push(JSON.parse(result.stdout.toString()))
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(
  output,
  JSON.stringify(
    {
      command,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      rows,
    },
    null,
    2,
  ),
)
console.log(output)
