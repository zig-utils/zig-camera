// Receiver-side reference, deliberately independent of Home's sender/parser.
import assert from 'node:assert/strict'
export function units(bytes: Uint8Array) {
  const b = Buffer.from(bytes),
    out: Buffer[] = []
  for (let i = 0; i < b.length;) {
    assert.ok(i + 4 <= b.length)
    const size = b.readUInt32BE(i)
    i += 4
    assert.ok(size && size <= b.length - i)
    out.push(b.subarray(i, i + size))
    i += size
  }
  return out
}
export const length4 = (units: readonly Uint8Array[]) =>
  Buffer.concat(
    units.map((value) => {
      const size = Buffer.alloc(4)
      size.writeUInt32BE(value.length)
      return Buffer.concat([size, value])
    }),
  )
export const annex = (values: readonly Uint8Array[]) =>
  Buffer.concat(
    values.flatMap((value) => [Buffer.from([0, 0, 0, 1]), Buffer.from(value)]),
  )
export function reassemble(
  packets: readonly Uint8Array[],
  codec: 'h264' | 'hevc' | 'aac',
  pt: number,
  ssrc: number,
) {
  let seq: number | undefined,
    ts: number | undefined,
    fragment: Buffer[] | undefined,
    expectedAudio = 0
  const au: Buffer[] = []
  const result: { timestamp: number; data: Buffer; nals: Buffer[] }[] = []
  for (const packet of packets) {
    const b = Buffer.from(packet)
    assert.ok(b.length >= 13)
    assert.equal(b[0], 0x80)
    assert.equal(b[1] & 127, pt)
    assert.equal(b.readUInt32BE(8), ssrc)
    const current = b.readUInt16BE(2)
    if (seq !== undefined) assert.equal(current, (seq + 1) & 65535)
    seq = current
    const timestamp = b.readUInt32BE(4)
    if (ts === undefined) ts = timestamp
    assert.equal(timestamp, ts)
    const p = b.subarray(12)
    if (codec === 'aac') {
      assert.equal(p.readUInt16BE(0), 16)
      assert.equal(p.readUInt16BE(2) & 7, 0)
      const size = p.readUInt16BE(2) >> 3
      if (!fragment) {
        fragment = []
        expectedAudio = size
      } else assert.equal(size, expectedAudio)
      fragment.push(p.subarray(4))
    } else {
      const type = codec === 'h264' ? p[0] & 31 : (p[0] >> 1) & 63
      if (type === (codec === 'h264' ? 28 : 49)) {
        const header = codec === 'h264' ? p[1] : p[2],
          start = !!(header & 128),
          end = !!(header & 64)
        assert.ok(!(start && end))
        if (start) {
          assert.equal(fragment, undefined)
          fragment = [
            Buffer.from(
              codec === 'h264'
                ? [(p[0] & 0xe0) | (header & 31)]
                : [(p[0] & 0x81) | ((header & 63) << 1), p[1]],
            ),
          ]
        }
        assert.ok(fragment)
        fragment.push(p.subarray(codec === 'h264' ? 2 : 3))
        if (end) {
          au.push(Buffer.concat(fragment))
          fragment = undefined
        }
      } else {
        assert.equal(fragment, undefined)
        assert.ok(type < (codec === 'h264' ? 24 : 48))
        au.push(p)
      }
    }
    if (b[1] & 128) {
      if (codec === 'aac') {
        assert.ok(fragment)
        const raw = Buffer.concat(fragment)
        assert.equal(raw.length, expectedAudio)
        result.push({ timestamp: ts, data: raw, nals: [] })
        fragment = undefined
      } else {
        assert.equal(fragment, undefined)
        result.push({ timestamp: ts, data: annex(au), nals: [...au] })
      }
      au.length = 0
      ts = undefined
    }
  }
  assert.equal(fragment, undefined)
  assert.equal(ts, undefined)
  assert.equal(au.length, 0)
  return result
}
export function report(bytes: Uint8Array) {
  const b = Buffer.from(bytes)
  assert.equal(b[0], 128)
  assert.equal(b[1], 200)
  assert.equal(b.readUInt16BE(2), 6)
  assert.equal(b[28], 129)
  assert.equal(b[29], 202)
  const size = (b.readUInt16BE(30) + 1) * 4
  assert.equal(b.readUInt32BE(4), b.readUInt32BE(32))
  assert.equal(b[36], 1)
  const cname = b.subarray(38, 38 + b[37]).toString()
  for (let p = 38 + b[37]; p < 28 + size; p++) assert.equal(b[p], 0)
  const bye = b.length > 28 + size
  if (bye) {
    assert.equal(b.length, 28 + size + 8)
    assert.equal(b[29 + size], 203)
    assert.equal(b.readUInt32BE(32 + size), b.readUInt32BE(4))
  }
  return {
    ssrc: b.readUInt32BE(4),
    ntp: b.readBigUInt64BE(8),
    timestamp: b.readUInt32BE(16),
    packets: b.readUInt32BE(20),
    octets: b.readUInt32BE(24),
    cname,
    bye,
  }
}
export const videoHeaders = length4([
  Buffer.from([0x67, 0x42, 0, 0x1f]),
  Buffer.from([0x68, 0x80]),
])
export const fakeStreams = {
  width: 64,
  height: 48,
  fps: 25,
  codec: 1,
  headers: videoHeaders,
}
