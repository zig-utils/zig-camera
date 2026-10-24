import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const binary = resolve(process.argv[2] ?? 'zig-out/bin/zig-camera')
for (const action of ['get', 'on', 'off'])
  for (const selector of [
    [],
    ['--camera', '0'],
    ['--camera-id', 'synthetic'],
  ]) {
    const result = Bun.spawnSync([
      binary,
      'sensor-hdr',
      action,
      '--simulate',
      ...selector,
    ])
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
    const state = JSON.parse(new TextDecoder().decode(result.stdout))
    assert.equal(state.camera_id, 'synthetic')
    assert.equal(state.backend, 'synthetic')
    assert.equal(state.status, 0)
    assert.equal(state.enabled, action === 'on')
    assert.equal(state.write_attempted, action === 'on')
  }
for (const args of [
  [],
  ['bad'],
  ['get', '--camera', '0', '--camera-id', 'synthetic'],
  ['get', '--camera', '4294967295'],
  ['get', '--camera', '1'],
  ['get', '--camera-id', 'wrong'],
  ['on', '--simulate'],
  ['get', '--camera'],
]) {
  assert.notEqual(
    Bun.spawnSync([binary, 'sensor-hdr', ...args, '--simulate']).exitCode,
    0,
  )
}
for (const mode of [
  'off',
  'single-exposure',
  'multi-exposure',
  'night',
  'multi-exposure-unmerged',
])
  assert.equal(
    Bun.spawnSync([
      binary,
      'info',
      '--simulate',
      '--width',
      '32',
      '--height',
      '24',
      '--hdr-mode',
      mode,
    ]).exitCode,
    0,
  )
assert.notEqual(
  Bun.spawnSync([binary, 'info', '--simulate', '--hdr-mode', 'wrong']).exitCode,
  0,
)
console.log(
  'sensor HDR CLI strict selectors, structured observations and runtime modes passed',
)
