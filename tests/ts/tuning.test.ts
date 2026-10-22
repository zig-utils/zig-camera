import { expect, test } from 'bun:test'
import {
  Camera,
  TuningDocument,
  loadTuningFile,
  findTuningAlgorithm,
  TUNING_MAX_BYTES,
} from '../../ts'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  openSync,
  ftruncateSync,
  closeSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
function directory(run: (path: string) => void) {
  const path = mkdtempSync(join(tmpdir(), 'zc-tuning-'))
  try {
    run(path)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}
test('both tuning layouts retain unknown fields and exact number text across edits', () => {
  for (const text of [
    '{"rpi.af":{"n":9007199254740993,"x":1.2300000000000000001e-20},"unknown":"湖"}',
    '{"version":2,"algorithms":[{"rpi.af":{"n":9007199254740993,"x":1.2300000000000000001e-20}}],"unknown":"湖"}',
  ]) {
    using doc = TuningDocument.parse(text)
    expect(doc.json()).toBe(text)
    expect(doc.algorithmJSON('rpi.af')).toBe(
      '{"n":9007199254740993,"x":1.2300000000000000001e-20}',
    )
    doc.replaceAlgorithmJSON('rpi.af', '{"n":123456789012345678901234567890}')
    expect(doc.algorithmJSON('rpi.af')).toBe(
      '{"n":123456789012345678901234567890}',
    )
    expect(doc.toObject().unknown).toBe('湖')
    const view = findTuningAlgorithm(doc, 'rpi.af') as { n: number }
    view.n = 0
    expect(doc.algorithmJSON('rpi.af')).toContain(
      '123456789012345678901234567890',
    )
  }
})
test('source bytes are owned and document closure is idempotent and final', () => {
  const bytes = new TextEncoder().encode('{"rpi.af":true}')
  using doc = TuningDocument.parse(bytes)
  bytes.fill(0)
  expect(doc.version).toBe(1)
  expect(Camera.findTuningAlgorithm(doc, 'rpi.af')).toBe(true)
  doc.close()
  doc.close()
  for (const run of [
    () => doc.json(),
    () => doc.version,
    () => doc.algorithmJSON('rpi.af'),
    () => doc.replaceAlgorithm('rpi.af', false),
  ])
    expect(run).toThrow('closed tuning document')
})
test('strict schemas, duplicate JSON keys and inexact version numbers reject', () => {
  for (const text of [
    '{} {}',
    '[]',
    '{"version":3}',
    '{"version":"2"}',
    '{"version":2}',
    '{"version":2,"algorithms":[1]}',
    '{"one":1,"one":2}',
    '{"version":2.00000000000000000001,"algorithms":[]}',
    '{"version":1.99999999999999999999}',
  ])
    expect(() => TuningDocument.parse(text)).toThrow()
  for (const text of ['1', '10e-1', '2.0', '0.002e3']) {
    using doc = TuningDocument.parse(`{"version":${text},"algorithms":[]}`)
    expect(Number(doc.version)).toBe(Number(text))
  }
})
test('missing and ambiguous algorithms and invalid edits preserve the original', () => {
  const text = '{"version":2,"algorithms":[{"same":1},{"same":2},{"one":3}]}'
  using doc = TuningDocument.parse(text)
  for (const run of [
    () => doc.findAlgorithm('same'),
    () => doc.replaceAlgorithm('same', 4),
    () => doc.findAlgorithm('missing'),
    () => doc.replaceAlgorithm('missing', 4),
    () => doc.replaceAlgorithmJSON('one', '['),
  ]) {
    expect(run).toThrow()
    expect(doc.json()).toBe(text)
  }
  doc.replaceAlgorithm('one', { map: [1, 2], enabled: false })
  expect(doc.findAlgorithm('one')).toEqual({ map: [1, 2], enabled: false })
})
test('native byte, token and depth budgets protect parsing and transactional edits', () => {
  expect(() => TuningDocument.parse(' '.repeat(TUNING_MAX_BYTES + 1))).toThrow()
  expect(() => TuningDocument.parse(new Uint8Array())).toThrow()
  expect(() =>
    TuningDocument.parse(
      new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]),
    ),
  ).toThrow()
  expect(() =>
    TuningDocument.parse('{"a":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}'),
  ).toThrow()
  expect(() =>
    TuningDocument.parse('{"a":[' + '0,'.repeat(262144) + '0]}'),
  ).toThrow()
  using doc = TuningDocument.parse('{"one":1}')
  expect(() =>
    doc.replaceAlgorithmJSON('one', '['.repeat(64) + '0' + ']'.repeat(64)),
  ).toThrow()
  expect(doc.json()).toBe('{"one":1}')
})
test('object snapshots reject lossy and non-JSON data without calling toJSON', () => {
  const cycle: any = {}
  cycle.self = cycle
  let called = 0
  for (const value of [
    cycle,
    { x: undefined },
    { x: NaN },
    { x: Infinity },
    { x: 9007199254740992 },
    { x: 1n },
    { x: new Date() },
    {
      toJSON() {
        called++
        return {}
      },
    },
  ])
    expect(() => TuningDocument.fromObject(value as any)).toThrow()
  expect(called).toBe(0)
  const shared = { okay: true }
  using doc = TuningDocument.fromObject({ one: shared, two: shared })
  expect(doc.toObject()).toEqual({ one: shared, two: shared })
})
test('snapshot getters run once and array iterators are not called', () => {
  let reads = 0
  const array = [1, 2]
  array[Symbol.iterator] = () => {
    throw Error('caller iterator')
  }
  using doc = TuningDocument.fromObject({
    get one() {
      reads++
      return array
    },
  })
  expect(reads).toBe(1)
  expect(doc.findAlgorithm('one')).toEqual([1, 2])
  using proto = TuningDocument.fromObject(
    JSON.parse('{"__proto__":{"safe":true}}'),
  )
  expect(proto.findAlgorithm('__proto__')).toEqual({ safe: true })
})
test('a reentrant value getter closing the document cannot publish an edit', () => {
  using doc = TuningDocument.parse('{"one":1}')
  expect(() =>
    doc.replaceAlgorithm('one', {
      get nested() {
        doc.close()
        return 2
      },
    }),
  ).toThrow('closed tuning document')
})
test('algorithm names and tuning paths have explicit UTF-8 bounds', () => {
  using doc = TuningDocument.parse('{"one":1}')
  for (const name of ['', 'a\0b', 'a'.repeat(257), '湖'.repeat(86), '\ud800'])
    expect(() => doc.findAlgorithm(name)).toThrow()
  for (const path of ['', 'a\0b', 'a'.repeat(4097), '\ud800'])
    expect(() => loadTuningFile(path)).toThrow()
  for (const options of [
    { platform: 'bad' },
    { directory: 'a', directories: ['b'] },
    { directories: [] },
    { directories: Array(33).fill('a') },
  ])
    expect(() => loadTuningFile('one.json', options as any)).toThrow()
})
test('search order, explicit directory, absolute paths and owned save round trip', () =>
  directory((path) => {
    const a = join(path, 'a'),
      b = join(path, 'b')
    mkdirSync(a)
    mkdirSync(b)
    writeFileSync(join(a, 'one.json'), '{"one":1}')
    writeFileSync(join(b, 'one.json'), '{"one":2}')
    using first = loadTuningFile('one.json', { directories: [a, b] })
    using second = Camera.loadTuningFile('one.json', {
      directory: b,
      platform: 'vc4',
    })
    using absolute = loadTuningFile(join(a, 'one.json'), {
      directory: '/absent',
    })
    expect(first.findAlgorithm('one')).toBe(1)
    expect(second.findAlgorithm('one')).toBe(2)
    expect(absolute.findAlgorithm('one')).toBe(1)
    first
      .replaceAlgorithmJSON('one', '9007199254740993')
      .save(join(b, 'one.json'))
    using saved = loadTuningFile('one.json', { directory: b })
    expect(saved.algorithmJSON('one')).toBe('9007199254740993')
    expect(statSync(join(b, 'one.json')).mode & 0o777).toBe(0o600)
    expect(readdirSync(b)).toEqual(['one.json'])
  }))
test('missing/nonregular files skip but corrupt or oversized first files do not fall through', () =>
  directory((path) => {
    const a = join(path, 'a'),
      b = join(path, 'b')
    mkdirSync(a)
    mkdirSync(b)
    writeFileSync(join(b, 'one.json'), '{"one":2}')
    mkdirSync(join(a, 'one.json'))
    using doc = loadTuningFile('one.json', { directories: [a, b] })
    expect(doc.findAlgorithm('one')).toBe(2)
    rmSync(join(a, 'one.json'), { recursive: true })
    writeFileSync(join(a, 'one.json'), '[')
    expect(() => loadTuningFile('one.json', { directories: [a, b] })).toThrow()
    const fd = openSync(join(a, 'one.json'), 'w')
    try {
      ftruncateSync(fd, TUNING_MAX_BYTES + 1)
    } finally {
      closeSync(fd)
    }
    expect(() => loadTuningFile('one.json', { directories: [a, b] })).toThrow(
      'byte budget',
    )
    expect(() => loadTuningFile('missing.json', { directory: path })).toThrow(
      'not found',
    )
  }))
test('failed publication retires the staged inode and preserves existing destinations', () =>
  directory((path) => {
    using doc = TuningDocument.parse('{"one":1}')
    const target = join(path, 'existing')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'old')
    expect(() => doc.save(target)).toThrow()
    expect(readdirSync(path)).toEqual(['existing'])
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('old')
    const victim = join(path, 'victim')
    writeFileSync(victim, 'unchanged')
    const link = join(path, 'link')
    symlinkSync(victim, link)
    doc.save(link)
    expect(readFileSync(victim, 'utf8')).toBe('unchanged')
    expect(readFileSync(link, 'utf8')).toBe('{"one":1}')
  }))
test('file failures close owned descriptors and retain primary plus cleanup errors', () => {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-tuning-io.ts')],
    { env: process.env },
  )
  expect(Buffer.from(result.stderr).toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
test('tuning data operations preserve camera and process tuning state', () => {
  const previous = process.env.LIBCAMERA_RPI_TUNING_FILE
  const camera = new Camera({ simulate: true, width: 16, height: 16 })
  try {
    camera.start()
    using doc = TuningDocument.fromObject({ 'rpi.af': { map: [1, 2] } })
    doc.replaceAlgorithm('rpi.af', { map: [3, 4] })
    using frame = camera.acquire()
    expect(frame.metadata().sequence).toBeGreaterThanOrEqual(0n)
    expect(process.env.LIBCAMERA_RPI_TUNING_FILE).toBe(previous)
  } finally {
    camera.close()
  }
})
