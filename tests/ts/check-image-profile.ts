import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
const [path, output] = process.argv.slice(2)
const bytes = Buffer.from(await Bun.file(path).arrayBuffer())
assert.equal(bytes.toString('ascii', 37, 41), 'iCCP')
const length = bytes.readUInt32BE(33)
assert.equal(bytes.toString('ascii', 41, 51), 'Home ICC\0\0')
const profile = inflateSync(bytes.subarray(51, 41 + length), {
  maxOutputLength: 16 * 1024 * 1024,
})
assert.equal(profile.readUInt32BE(0), profile.length)
assert.equal(profile.toString('ascii', 36, 40), 'acsp')
assert.equal(profile.toString('ascii', 16, 20), 'RGB ')
await Bun.write(output, profile)
