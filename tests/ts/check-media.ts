import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkvFrames, mp4, decodeVideo } from './media'
const dir = process.argv[2] ?? 'zig-out'
if (process.argv.includes('--recording-streams')) {
  const frames = mkvFrames(join(dir, 'lores-video.mkv'))
  assert.equal(frames.length, 4)
  const decoder = process.env.ZC_IMAGE_DECODER
  assert(decoder)
  for (let i = 0; i < frames.length; i++) {
    const path = join(dir, `lores-video-${i}.jpg`)
    writeFileSync(path, frames[i])
    const result: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync([
      decoder,
      'jpeg',
      path,
    ])
    assert.equal(result.exitCode, 0)
    const bytes = Buffer.from(result.stdout!)
    assert.equal(bytes.readUInt32LE(0), 32)
    assert.equal(bytes.readUInt32LE(4), 24)
  }
  process.exit(0)
}
if (process.argv.includes('--stream-images')) {
  const decoder = process.env.ZC_IMAGE_DECODER
  assert(decoder)
  for (const name of ['rgb', 'i420']) {
    const path = join(dir, `stream-${name}.png`)
    const meta = JSON.parse(readFileSync(`${path}.json`, 'utf8'))
    assert.equal(meta.image_stream, 2)
    assert.equal(meta.image_width, 18)
    assert.equal(meta.image_height, 10)
    assert.equal(meta.source_color_space.range, 1)
    assert.equal(meta.source_color_space.ycbcr_encoding, name === 'rgb' ? 1 : 2)
    const result: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync([
      decoder,
      'png',
      path,
    ])
    assert.equal(result.exitCode, 0)
    const decoded = Buffer.from(result.stdout!)
    assert.equal(decoded.readUInt32LE(0), 18)
    assert.equal(decoded.readUInt32LE(4), 10)
    if (name === 'rgb') {
      for (let y = 0; y < 10; y++)
        for (let x = 0; x < 18; x++) {
          assert.deepEqual(
            [...decoded.subarray(8 + (y * 18 + x) * 3, 11 + (y * 18 + x) * 3)],
            [Math.floor((x * 64) / 18), Math.floor((y * 48) / 10), 0],
          )
        }
    } else {
      const raw = readFileSync(`${path}.lores.i420`)
      assert.equal(raw.length, 270)
      for (let y = 0; y < 10; y++)
        for (let x = 0; x < 18; x++) {
          const l = raw[y * 18 + x],
            cb = raw[180 + Math.floor(y / 2) * 9 + Math.floor(x / 2)] - 128,
            cr = raw[225 + Math.floor(y / 2) * 9 + Math.floor(x / 2)] - 128,
            expected = [
              l + 1.402 * cr,
              l - 0.3441362862 * cb - 0.7141362862 * cr,
              l + 1.772 * cb,
            ].map((v) => Math.min(255, Math.max(0, Math.round(v))))
          assert.deepEqual(
            [...decoded.subarray(8 + (y * 18 + x) * 3, 11 + (y * 18 + x) * 3)],
            expected,
          )
        }
    }
  }
  process.exit(0)
}
if (process.argv.includes('--still-images')) {
  const decoder = process.env.ZC_IMAGE_DECODER
  assert(decoder)
  const expected = Buffer.from(
    Array.from({ length: 9 }, (_, y) =>
      Array.from({ length: 17 }, (_, x) => [x, y, 0]).flat(),
    ).flat(),
  )
  for (const format of ['png', 'bmp', 'tiff']) {
    const result: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync([
      decoder,
      format,
      join(dir, `cli-image.${format}`),
    ])
    assert.equal(result.exitCode, 0)
    const bytes = Buffer.from(result.stdout!)
    assert.equal(bytes.readUInt32LE(0), 17)
    assert.equal(bytes.readUInt32LE(4), 9)
    assert(bytes.subarray(8).equals(expected))
  }
  process.exit(0)
}
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
