import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Camera, CameraError } from '../ts'
const args = process.argv.slice(2),
  value = (_key: string, fallback: string) => {
    const index = args.indexOf(_key)
    return index < 0 ? fallback : args[index + 1]
  }
const frames = Number(value('--frames', '1000')),
  cycles = Number(value('--cycles', '10')),
  output = value('--output', 'bench/results/pi-check')
assert(
  Number.isInteger(frames) &&
    frames > 0 &&
    Number.isInteger(cycles) &&
    cycles > 0,
)
mkdirSync(output, { recursive: true })
const cam = new Camera({
  simulate: args.includes('--simulate'),
  width: Number(value('--width', '1280')),
  height: Number(value('--height', '720')),
  fifo: true,
  raw: args.includes('--raw'),
})
const samples: {
  cycle: number
  rss: number
  delivered: bigint
  first: bigint
  last: bigint
}[] = []
try {
  for (let cycle = 0; cycle < cycles; cycle++) {
    cam.start()
    const held = Array.from({ length: cam.info().buffers }, () =>
      cam.acquire(5000),
    )
    assert.equal(cam.stats().leased, held.length)
    try {
      cam.acquire(1)
      assert.fail('all buffers leased')
    } catch (error) {
      assert(error instanceof CameraError && error.code === -3)
    }
    const before = held[0].copyRGB()
    await cam.stop()
    assert.deepEqual(held[0].copyRGB(), before)
    assert.throws(() => cam.start())
    for (const frame of held) frame.release()
    cam.start()
    let first = 0n,
      last = 0n,
      lastTime = -1n
    for (let i = 0; i < frames; i++) {
      using frame = cam.acquire(5000)
      assert(
        args.includes('--simulate')
          ? frame.timestampNs >= lastTime
          : frame.timestampNs > lastTime,
      )
      lastTime = frame.timestampNs
      if (i === 0) first = frame.sequence
      last = frame.sequence
      if (i === frames - 1 && cycle === 0)
        frame.saveJPEG(join(output, 'sample.jpg'))
    }
    samples.push({
      cycle,
      rss: process.memoryUsage().rss,
      delivered: cam.stats().delivered,
      first,
      last,
    })
    await cam.stop()
  }
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(
      {
        info: cam.info(),
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        samples,
      },
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  )
} finally {
  await cam.close()
}
console.log(
  `saved ${output}/report.json; physical quality/sync/performance still requires measurement`,
)
