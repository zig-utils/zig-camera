import { expect, test } from 'bun:test'
import {
  RtpPacketizer,
  rtpTimestamp,
  rtcpSenderReport,
  CameraError,
} from '../../ts'
import { length4, annex, reassemble, report } from './rtp-reference'
for (const codec of ['h264', 'hevc', 'aac'] as const)
  for (const mtu of [64, 1200])
    test(`${codec} RTP packets independently reconstruct exact access units at MTU ${mtu}`, () => {
      const nals = [
        Buffer.from(codec === 'hevc' ? [0x27, 0x15, 0x55] : [0x65, 0x55]),
        Buffer.concat([
          Buffer.from(codec === 'hevc' ? [0x03, 0x19] : [0x61]),
          Buffer.alloc(4000, 0x55),
        ]),
      ]
      for (const format of codec === 'aac'
        ? ['raw' as const]
        : (['annex-b', 'length4'] as const)) {
        const bytes =
          codec === 'aac'
            ? Buffer.alloc(4096, 0x55)
            : format === 'annex-b'
              ? annex(nals)
              : length4(nals)
        const expected = Buffer.from(bytes)
        using cursor = new RtpPacketizer(bytes, {
          codec,
          format,
          mtu,
          sequence: 65535,
          timestamp: 0xabcdefff,
          ssrc: 123,
          payloadType: 98,
        })
        bytes.fill(0)
        const before = cursor.state()
        expect(() => cursor.nextInto(new Uint8Array(1))).toThrow(CameraError)
        expect(cursor.state()).toEqual(before)
        const packets: Uint8Array[] = []
        for (;;) {
          const p = cursor.next()
          if (!p) break
          expect(p.length).toBeLessThanOrEqual(mtu)
          packets.push(p)
        }
        const decoded = reassemble(packets, codec, 98, 123)
        expect(decoded.length).toBe(1)
        expect(decoded[0].timestamp).toBe(0xabcdefff)
        expect(decoded[0].data).toEqual(
          codec === 'aac' ? expected : annex(nals),
        )
        expect(cursor.state().emitted).toBe(packets.length)
        expect(cursor.next()).toBeUndefined()
      }
    })
test('RTP clocks and RTCP wire reports retain signed priming, integer endpoints and compound identity', () => {
  expect(rtpTimestamp(1_000_000_000n, 90000, 0xfffffffe)).toBe(89998)
  expect(rtpTimestamp(-42_666_666n, 48000)).toBe(0xfffff800)
  expect(rtpTimestamp(-1n, 48000)).toBe(0xffffffff)
  for (const invalid of [-0x8000000000000001n, 0x10000000000000000n])
    expect(() => rtpTimestamp(invalid, 90000)).toThrow(RangeError)
  const b = rtcpSenderReport({
    ssrc: 123,
    unixNs: 1_500_000_000n,
    rtpTimestamp: 99,
    packets: 4,
    octets: 22,
    cname: 'trail',
    bye: true,
  })
  expect(report(b)).toEqual({
    ssrc: 123,
    ntp: (2208988801n << 32n) | 0x80000000n,
    timestamp: 99,
    packets: 4,
    octets: 22,
    cname: 'trail',
    bye: true,
  })
})
test('native RTP admission rejects malformed AUs without consuming its bounded owner quota', () => {
  for (const bytes of [
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 2, 0x65]),
    Buffer.from([0, 0, 0, 1, 0x80]),
  ])
    expect(() => new RtpPacketizer(bytes, { codec: 'h264' })).toThrow()
  const list: RtpPacketizer[] = []
  try {
    for (let i = 0; i < 16; i++)
      list.push(
        new RtpPacketizer(length4([Buffer.from([0x65, 0x80])]), {
          codec: 'h264',
        }),
      )
    expect(
      () =>
        new RtpPacketizer(length4([Buffer.from([0x65, 0x80])]), {
          codec: 'h264',
        }),
    ).toThrow(CameraError)
  } finally {
    for (const p of list) p.close()
  }
  using next = new RtpPacketizer(length4([Buffer.from([0x65, 0x80])]), {
    codec: 'h264',
  })
  next.close()
  next.close()
  expect(() => next.next()).toThrow(CameraError)
})
test('RTCP maximum UTF-8 CNAME keeps the final BYE within its complete bounded buffer', () => {
  const cname = 'x'.repeat(255)
  const bytes = rtcpSenderReport({
    ssrc: 1,
    unixNs: 0n,
    rtpTimestamp: 0,
    packets: 0,
    octets: 0,
    cname,
    bye: true,
  })
  expect(bytes.length).toBe(304)
  expect(report(bytes).cname).toBe(cname)
  expect(report(bytes).bye).toBe(true)
})
