// Process-isolated filesystem fault injection; never replace the main suite's fs.
import { mock } from 'bun:test'
import * as filesystem from 'node:fs'
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const real = { ...filesystem }
let fault = '',
  stats = 0
const owned = new Set<number>()
const fail = (name: string) => {
  throw Error(`injected ${name}`)
}
mock.module('node:fs', () => ({
  ...real,
  openSync(...args: Parameters<typeof filesystem.openSync>) {
    const fd = real.openSync(...args)
    owned.add(fd)
    return fd
  },
  fstatSync(...args: any[]) {
    if (fault === 'stat' && stats++ === 0) fail('stat')
    return (real.fstatSync as any)(...args)
  },
  writeSync(...args: any[]) {
    if (fault.includes('write')) fail('write')
    return (real.writeSync as any)(...args)
  },
  readSync(...args: any[]) {
    if (fault.includes('read')) fail('read')
    return (real.readSync as any)(...args)
  },
  renameSync(...args: Parameters<typeof filesystem.renameSync>) {
    if (fault === 'rename') fail('rename')
    return real.renameSync(...args)
  },
  closeSync(fd: number) {
    assert(owned.delete(fd), 'descriptor closed more than once')
    real.closeSync(fd)
    if (fault.includes('close')) fail('close')
  },
  unlinkSync(...args: Parameters<typeof filesystem.unlinkSync>) {
    if (fault.includes('unlink')) fail('unlink')
    return real.unlinkSync(...args)
  },
}))
const { TuningDocument, loadTuningFile } = await import('../../ts/tuning')
const directory = real.mkdtempSync(join(tmpdir(), 'zc-tuning-io-'))
try {
  using document = TuningDocument.parse('{"one":1}')
  const target = join(directory, 'one.json')
  real.writeFileSync(target, '{"old":1}')
  for (const scenario of ['stat', 'write', 'rename', 'close', 'write-unlink']) {
    fault = scenario
    stats = 0
    let error: any
    try {
      document.save(target)
    } catch (caught) {
      error = caught
    }
    assert(error, `missing ${scenario} failure`)
    assert.equal(owned.size, 0)
    assert.equal(real.readFileSync(target, 'utf8'), '{"old":1}')
    const staged = real
      .readdirSync(directory)
      .filter((name) => name.startsWith('.zc-tuning-'))
    if (scenario === 'write-unlink') {
      assert(error instanceof AggregateError)
      assert.match(error.errors[0].message, /injected write/)
      assert.match(error.errors[1].message, /injected unlink/)
      assert.equal(staged.length, 1)
      real.unlinkSync(join(directory, staged[0]))
    } else assert.deepEqual(staged, [])
  }
  for (const scenario of ['read', 'close', 'read-close']) {
    fault = scenario
    let error: any
    try {
      loadTuningFile(target)
    } catch (caught) {
      error = caught
    }
    assert(error)
    assert.equal(owned.size, 0)
    if (scenario === 'read-close') {
      assert(error instanceof AggregateError)
      assert.match(error.errors[0].message, /injected read/)
      assert.match(error.errors[1].message, /injected close/)
    }
  }
} finally {
  real.rmSync(directory, { recursive: true, force: true })
}
