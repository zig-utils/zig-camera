import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkvFrames, mp4, decodeVideo } from './media'
const dir = process.argv[2] ?? 'zig-out'
if (process.argv.includes('--orientation')) {
  const bytes = readFileSync(join(dir, 'oriented.ppm'))
  const header = Buffer.from('P6\n3 2\n255\n')
  assert(bytes.subarray(0, header.length).equals(header))
  assert.deepEqual(
    [...bytes.subarray(header.length)],
    [2, 0, 0, 1, 0, 0, 0, 0, 0, 2, 1, 0, 1, 1, 0, 0, 1, 0],
  )
  process.exit(0)
}
if (process.argv.includes('--lores')) {
  const path = join(dir, 'lores.ppm')
  const meta = JSON.parse(readFileSync(`${path}.json`, 'utf8'))
  assert.equal(meta.sensor_width, 640)
  assert.equal(meta.lores_width, 18)
  assert.equal(readFileSync(`${path}.lores.i420`).length, 270)
  process.exit(0)
}
if (process.argv.includes('--rotation')) {
  const files = readdirSync(dir).filter((name) =>
    /^rotation-\d+\.mkv$/.test(name),
  )
  assert(files.length > 1)
  assert.equal(
    files.reduce((count, file) => count + mkvFrames(join(dir, file)).length, 0),
    40,
  )
  console.log('40 rotation frames accounted for')
  process.exit(0)
}
for (const file of readdirSync(dir)) {
  const path = join(dir, file)
  if (file === 'home.mkv') {
    const frames = mkvFrames(path)
    assert.equal(frames.length, 12)
    if (process.env.ZC_JPEG_DECODER)
      for (let i = 0; i < frames.length; i++) {
        const frame = `${path}.${i}.jpg`
        writeFileSync(frame, frames[i])
        assert.equal(
          Bun.spawnSync([process.env.ZC_JPEG_DECODER, frame, '128', '96'])
            .exitCode,
          0,
        )
      }
  }
  if (file === 'home.jpg' || file === 'test.jpg') {
    const data = readFileSync(path)
    assert.equal(data.readUInt16BE(), 0xffd8)
    assert.equal(data.readUInt16BE(data.length - 2), 0xffd9)
    if (process.env.ZC_JPEG_DECODER)
      assert.equal(
        Bun.spawnSync([
          process.env.ZC_JPEG_DECODER,
          path,
          file === 'home.jpg' ? '128' : '65',
          file === 'home.jpg' ? '96' : '33',
        ]).exitCode,
        0,
      )
  }
  if (/^cli-(h264|hevc)\.mp4$/.test(file)) {
    const track = mp4(path).get(1)!
    assert.equal(track.samples.length, 12)
    assert.deepEqual(
      track.times,
      Array.from({ length: 12 }, (_, i) => BigInt(Math.floor((i * 1e6) / 24))),
    )
    assert.deepEqual(
      track.keys.flatMap((key, i) => (key ? [i] : [])),
      [0, 4, 8],
    )
    decodeVideo(
      path,
      track,
      Array.from({ length: 12 }, (_, i) => BigInt(i)),
    )
  }
}
console.log('native media fixtures validated with Bun')
