// Bounded independent SPS/VUI oracle adapted from Home's MIT color_signal test.
// Supports the 8-bit, single-sublayer, no-scaling-list adapter output. Unexpected
// syntax fails explicitly; it never searches for a desired color byte pattern.
import assert from 'node:assert/strict'
import type { Track } from './media'
class Bits {
  bit = 0
  constructor(readonly bytes: Uint8Array) {}
  read(n: number): number {
    assert(n >= 0 && n <= 32 && this.bit + n <= this.bytes.length * 8)
    let result = 0
    while (n--) {
      result =
        result * 2 + ((this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1)
      this.bit++
    }
    return result
  }
  skip(n: number) {
    while (n) {
      const step = Math.min(n, 32)
      this.read(step)
      n -= step
    }
  }
  flag() {
    return this.read(1) !== 0
  }
  ue() {
    let zeros = 0
    while (!this.flag()) assert(++zeros <= 30)
    return 2 ** zeros - 1 + this.read(zeros)
  }
}
function sps(track: Track) {
  const c = track.config
  if (track.codec === 'avc1') {
    assert(c[5] & 31)
    const length = c.readUInt16BE(6)
    assert(length > 1 && length <= c.length - 8)
    return c.subarray(8, 8 + length)
  }
  let at = 23
  for (let i = 0; i < c[22]; i++) {
    const type = c[at++] & 63,
      count = c.readUInt16BE(at)
    at += 2
    for (let j = 0; j < count; j++) {
      const length = c.readUInt16BE(at)
      at += 2
      assert(length > 1 && at + length <= c.length)
      if (type === 33) return c.subarray(at, at + length)
      at += length
    }
  }
  throw Error('missing SPS')
}
export function bitstreamColor(track: Track) {
  const avc = track.codec === 'avc1',
    nal = sps(track),
    rbsp: number[] = []
  let zeros = 0
  for (const byte of nal.subarray(avc ? 1 : 2)) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    rbsp.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  const b = new Bits(Uint8Array.from(rbsp))
  if (avc) {
    assert.equal(b.read(8), 100)
    b.skip(16)
    b.ue()
    assert.equal(b.ue(), 1)
    assert.equal(b.ue(), 0)
    assert.equal(b.ue(), 0)
    b.skip(1)
    assert(!b.flag(), 'unexpected scaling list')
    b.ue()
    const poc = b.ue()
    if (poc === 0) b.ue()
    else assert.equal(poc, 2)
    b.ue()
    b.skip(1)
    b.ue()
    b.ue()
    if (!b.flag()) b.skip(1)
    b.skip(1)
    if (b.flag()) for (let i = 0; i < 4; i++) b.ue()
  } else {
    b.skip(4)
    assert.equal(b.read(3), 0)
    b.skip(97)
    b.ue()
    assert.equal(b.ue(), 1)
    b.ue()
    b.ue()
    if (b.flag()) for (let i = 0; i < 4; i++) b.ue()
    assert.equal(b.ue(), 0)
    assert.equal(b.ue(), 0)
    const pocBits = b.ue() + 4
    b.flag()
    for (let i = 0; i < 9; i++) b.ue()
    if (b.flag()) assert(!b.flag(), 'unexpected scaling list')
    b.skip(2)
    if (b.flag()) {
      b.skip(8)
      b.ue()
      b.ue()
      b.skip(1)
    }
    const sets = b.ue()
    assert(sets <= 64)
    for (let i = 0; i < sets; i++) {
      if (i) assert(!b.flag(), 'unexpected predicted reference set')
      const count = b.ue() + b.ue()
      assert(count <= 64)
      for (let j = 0; j < count; j++) {
        b.ue()
        b.skip(1)
      }
    }
    if (b.flag()) {
      const count = b.ue()
      assert(count <= 32)
      for (let i = 0; i < count; i++) b.skip(pocBits + 1)
    }
    b.skip(2)
  }
  assert(b.flag(), 'missing VUI')
  if (b.flag() && b.read(8) === 255) b.skip(32)
  if (b.flag()) b.skip(1)
  assert(b.flag(), 'missing video signal')
  b.skip(3)
  const fullRange = b.flag()
  assert(b.flag(), 'missing color description')
  return {
    primaries: b.read(8),
    transfer: b.read(8),
    matrix: b.read(8),
    fullRange,
  }
}
