import { expect, test, spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeVideoI420, type Track } from './media'

function fixture(exitCode = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'zc-decoder-diagnostics-'))
  const source = join(dir, 'source')
  mkdirSync(source)
  const path = join(source, 'clip.mp4')
  writeFileSync(path, 'encoded-file-evidence')
  const decoder = join(dir, 'decoder.ts')
  writeFileSync(
    decoder,
    String.raw`#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.ZC_DECODED_I420_FAILURE!, Buffer.alloc(384, 17))
process.stderr.write('frame=0 component=1 mean_abs=9.5\n')
process.exit(${exitCode})
`,
    { mode: 0o755 },
  )
  const video: Track = {
    id: 1,
    kind: 'vide',
    codec: 'avc1',
    rate: 1000000,
    duration: 40000n,
    mediaDuration: 40000n,
    times: [0n],
    durations: [40000],
    keys: [true],
    width: 16,
    height: 16,
    config: Buffer.from([
      1, 66, 0, 30, 255, 225, 0, 2, 0x67, 0, 1, 0, 2, 0x68, 0,
    ]),
    samples: [Buffer.from([0, 0, 0, 2, 0x65, 0x88])],
  }
  const previousDecoder = process.env.ZC_INDEPENDENT_DECODER
  const previousDestination = process.env.ZC_MEDIA_FAILURE_DIR
  process.env.ZC_INDEPENDENT_DECODER = decoder
  process.env.ZC_MEDIA_FAILURE_DIR = join(dir, 'retained')
  return {
    dir,
    source,
    path,
    video,
    restore() {
      if (previousDecoder === undefined)
        delete process.env.ZC_INDEPENDENT_DECODER
      else process.env.ZC_INDEPENDENT_DECODER = previousDecoder
      if (previousDestination === undefined)
        delete process.env.ZC_MEDIA_FAILURE_DIR
      else process.env.ZC_MEDIA_FAILURE_DIR = previousDestination
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('failed independent video readback retains encoded reference and decoded evidence before source cleanup', () => {
  const f = fixture()
  try {
    const reference = new Uint8Array(384).fill(29)
    expect(() => decodeVideoI420(f.path, f.video, [reference])).toThrow(
      'frame=0 component=1 mean_abs=9.5',
    )
    const destination = join(f.dir, 'retained', 'source', 'clip.mp4')
    const accessUnits = readFileSync(`${f.path}.aus`)
    rmSync(f.source, { recursive: true })
    expect(readFileSync(destination, 'utf8')).toBe('encoded-file-evidence')
    expect(readFileSync(`${destination}.aus`)).toEqual(accessUnits)
    expect(readFileSync(`${destination}.i420`)).toEqual(Buffer.from(reference))
    expect(readFileSync(`${destination}.decoded-i420`)).toEqual(
      Buffer.alloc(384, 17),
    )
    expect(readFileSync(`${destination}.decoder.txt`, 'utf8')).toContain(
      'mean_abs=9.5',
    )
    expect(
      JSON.parse(readFileSync(`${destination}.reference.json`, 'utf8')),
    ).toEqual({ codec: 'avc1', width: 16, height: 16, frames: 1, exitCode: 1 })
  } finally {
    f.restore()
  }
})

test('failure to retain evidence preserves the original decoder failure', () => {
  const f = fixture()
  const consoleError = spyOn(console, 'error').mockImplementation(() => {})
  try {
    writeFileSync(process.env.ZC_MEDIA_FAILURE_DIR!, 'occupied')
    expect(() =>
      decodeVideoI420(f.path, f.video, [new Uint8Array(384)]),
    ).toThrow('frame=0 component=1 mean_abs=9.5')
    expect(consoleError).toHaveBeenCalledTimes(1)
  } finally {
    consoleError.mockRestore()
    f.restore()
  }
})

test('successful independent readback creates no failure archive', () => {
  const f = fixture(0)
  try {
    decodeVideoI420(f.path, f.video, [new Uint8Array(384)])
    expect(existsSync(process.env.ZC_MEDIA_FAILURE_DIR!)).toBe(false)
  } finally {
    f.restore()
  }
})
