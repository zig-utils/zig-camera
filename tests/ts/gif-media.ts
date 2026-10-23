import assert from 'node:assert/strict'
export function decodeGif(path: string) {
  const decoder = process.env.ZC_GIF_DECODER
  assert(decoder, 'independent GIF decoder must be configured')
  const result = Bun.spawnSync([decoder, path])
  assert.equal(new TextDecoder().decode(result.stderr), '')
  assert.equal(result.exitCode, 0)
  const data = Buffer.from(result.stdout)
  assert.equal(data.toString('ascii', 0, 4), 'ZCGF')
  const width = data.readUInt32BE(4),
    height = data.readUInt32BE(8)
  assert.equal(data.length, 12 + width * height * 4)
  return { width, height, pixels: data.subarray(12) }
}
