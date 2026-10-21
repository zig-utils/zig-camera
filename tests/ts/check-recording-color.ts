// CLI fixture verification: independent container and SPS/VUI field inspection.
import assert from 'node:assert/strict'
import { mp4 } from './media'
import { bitstreamColor } from './color-signaling'
const [path, preset] = process.argv.slice(2)
const expected = {
  rec709: { primaries: 1, transfer: 1, matrix: 1, fullRange: false },
  rec2020: { primaries: 9, transfer: 1, matrix: 9, fullRange: false },
  smpte170m: { primaries: 6, transfer: 1, matrix: 6, fullRange: false },
}[preset]
assert(
  expected,
  'usage: check-recording-color.ts file.mp4 rec709|rec2020|smpte170m',
)
const video = mp4(path).get(1)!
assert.equal(video.samples.length, 4)
assert.deepEqual(video.color, expected)
assert.deepEqual(bitstreamColor(video), expected)
