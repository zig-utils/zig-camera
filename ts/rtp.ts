import {
  native as n,
  ptr,
  storage,
  view,
  check,
  outPointer,
  handle,
  CameraError,
  type Pointer,
} from './ffi'
export type RtpCodec = 'h264' | 'hevc' | 'aac'
export type RtpFormat = 'annex-b' | 'length4' | 'raw'
export interface RtpPacketizerOptions {
  codec: RtpCodec
  format?: RtpFormat
  mtu?: number
  payloadType?: number
  sequence?: number
  timestamp?: number
  ssrc?: number
}
export function uint(value: unknown, max: number, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new RangeError(`invalid ${name}`)
  return value
}
export function ns(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn)
    throw new RangeError(`invalid ${name}`)
  return value
}
/** Owned copied access unit. Native limits: 16 cursors / 64 MiB, each AU 16 MiB,
 * 4096 NALs / 65536 packets; AAC raw AUs at most 8191 bytes. */
export class RtpPacketizer implements Disposable {
  private owned?: Pointer
  constructor(data: Uint8Array, source: RtpPacketizerOptions) {
    if (
      !source ||
      typeof source !== 'object' ||
      !(data instanceof Uint8Array) ||
      !data.byteLength ||
      data.byteLength > 16 * 1024 * 1024
    )
      throw new RangeError('invalid RTP input')
    const codec = source.codec,
      requestedFormat = source.format,
      mtu = source.mtu ?? 1200,
      payloadType = source.payloadType ?? 96,
      sequence = source.sequence ?? 0,
      timestamp = source.timestamp ?? 0,
      ssrc = source.ssrc ?? 1
    const format = requestedFormat ?? (codec === 'aac' ? 'raw' : 'length4')
    if (
      !['h264', 'hevc', 'aac'].includes(codec) ||
      !['annex-b', 'length4', 'raw'].includes(format) ||
      (codec === 'aac') !== (format === 'raw')
    )
      throw new RangeError('invalid RTP codec/format')
    uint(mtu, 65507, 'RTP MTU')
    if (mtu < 64) throw new RangeError('invalid RTP MTU')
    const cfg = storage(32),
      d = view(cfg)
    d.setUint32(0, 32, true)
    d.setUint32(4, { h264: 1, hevc: 2, aac: 3 }[codec], true)
    d.setUint32(8, { 'annex-b': 0, length4: 1, raw: 2 }[format], true)
    d.setUint32(12, mtu, true)
    for (const [offset, value, max, label] of [
      [16, payloadType, 127, 'RTP payload type'],
      [20, sequence, 65535, 'RTP sequence'],
      [24, timestamp, 0xffffffff, 'RTP timestamp'],
      [28, ssrc, 0xffffffff, 'RTP SSRC'],
    ] as const)
      d.setUint32(offset, uint(value, max, label), true)
    const out = outPointer()
    check(
      n.zc_rtp_packetizer_open(
        ptr(cfg),
        ptr(data),
        BigInt(data.byteLength),
        ptr(out),
      ),
      'open RTP access unit',
    )
    this.owned = handle(out)
  }
  private open() {
    if (!this.owned) throw new CameraError(-5, 'closed RTP cursor')
    return this.owned
  }
  state() {
    const bytes = storage(24)
    check(n.zc_rtp_packetizer_state(this.open(), ptr(bytes)), 'RTP state')
    const d = view(bytes)
    return Object.freeze({
      total: d.getUint32(4, true),
      emitted: d.getUint32(8, true),
      nextSequence: d.getUint32(12, true),
      timestamp: d.getUint32(16, true),
      nextBytes: d.getUint32(20, true),
    })
  }
  nextInto(destination: Uint8Array) {
    if (
      !(destination instanceof Uint8Array) ||
      destination.byteLength > 0xffffffff
    )
      throw new TypeError('invalid RTP destination')
    const count = new Uint32Array(1)
    check(
      n.zc_rtp_packetizer_next(
        this.open(),
        destination.byteLength ? ptr(destination) : null,
        destination.byteLength,
        ptr(count),
      ),
      'RTP packet',
    )
    return count[0]
  }
  next(): Uint8Array | undefined {
    const count = this.state().nextBytes
    if (!count) return
    const out = storage(count)
    this.nextInto(out)
    return out
  }
  close() {
    if (this.owned) {
      check(n.zc_rtp_packetizer_close(this.owned), 'close RTP cursor')
      this.owned = undefined
    }
  }
  [Symbol.dispose]() {
    this.close()
  }
}
export function rtpTimestamp(
  timestampNs: bigint,
  clockRate: number,
  origin = 0,
) {
  if (
    typeof timestampNs !== 'bigint' ||
    timestampNs < -0x8000000000000000n ||
    timestampNs > 0xffffffffffffffffn
  )
    throw new RangeError('invalid RTP nanoseconds')
  uint(clockRate, 0xffffffff, 'RTP clock')
  if (!clockRate) throw new RangeError('invalid RTP clock')
  uint(origin, 0xffffffff, 'RTP origin')
  const out = new Uint32Array(1)
  check(
    timestampNs < 0n
      ? n.zc_rtp_timestamp_signed(timestampNs, clockRate, origin, ptr(out))
      : n.zc_rtp_timestamp(timestampNs, clockRate, origin, ptr(out)),
    'RTP timestamp',
  )
  return out[0]
}
export interface RtcpSenderReport {
  ssrc: number
  unixNs: bigint
  rtpTimestamp: number
  packets: number
  octets: number
  cname: string
  bye?: boolean
}
export function rtcpSenderReport(source: RtcpSenderReport) {
  if (!source || typeof source !== 'object')
    throw new TypeError('invalid RTCP report')
  const ssrc = source.ssrc,
    unixNs = source.unixNs,
    timestamp = source.rtpTimestamp,
    packets = source.packets,
    octets = source.octets,
    cname = source.cname,
    bye = source.bye ?? false
  if (
    typeof cname !== 'string' ||
    !cname.length ||
    !cname.isWellFormed() ||
    cname.includes('\0') ||
    Buffer.byteLength(cname) > 255 ||
    typeof bye !== 'boolean'
  )
    throw new RangeError('invalid RTCP CNAME/bye')
  ns(unixNs, 'RTCP Unix nanoseconds')
  const config = storage(32),
    d = view(config)
  d.setUint32(0, 32, true)
  for (const [offset, value, label] of [
    [4, ssrc, 'RTCP SSRC'],
    [8, timestamp, 'RTCP timestamp'],
    [12, packets, 'RTCP packets'],
    [16, octets, 'RTCP octets'],
  ] as const)
    d.setUint32(offset, uint(value, 0xffffffff, label), true)
  d.setUint32(20, bye ? 1 : 0, true)
  d.setBigUint64(24, unixNs, true)
  const name = new TextEncoder().encode(cname),
    out = storage(304),
    count = new Uint32Array(1)
  check(
    n.zc_rtcp_sender_report(
      ptr(config),
      ptr(name),
      name.length,
      ptr(out),
      out.length,
      ptr(count),
    ),
    'RTCP sender report',
  )
  return out.slice(0, count[0])
}
/** General HEVC SPS profile prefix for SDP; not a complete SPS validator. */
export function rtpHevcProfile(nal: Uint8Array) {
  if (!(nal instanceof Uint8Array) || nal.byteLength > 1024 * 1024)
    throw new RangeError('invalid HEVC SPS')
  const bytes = storage(32)
  check(
    n.zc_rtp_hevc_profile(
      nal.byteLength ? ptr(nal) : null,
      nal.byteLength,
      ptr(bytes),
    ),
    'HEVC RTP profile',
  )
  const d = view(bytes)
  return Object.freeze({
    space: d.getUint32(4, true),
    tier: d.getUint32(8, true),
    id: d.getUint32(12, true),
    compatibility: d.getUint32(16, true),
    level: d.getUint32(20, true),
    constraints: d.getBigUint64(24, true),
  })
}
