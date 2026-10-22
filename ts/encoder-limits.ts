import { native as n, ptr, check, type Pointer } from './ffi'

export interface EncoderLimits {
  /** Decoder requirement ceiling * 10: 41 = 4.1. Zero selects automatic. */
  level?: number
  /** Bits/sec; positive multiples of 1000, paired with bufferBits. */
  maxBitrate?: number
  /** CPB capacity in bits, positive multiples of 1000. */
  bufferBits?: number
}
export function snapshotEncoderLimits(value: EncoderLimits) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('invalid encoder limits')
  return Object.freeze({ ...value })
}
export function encodeEncoderLimits(value?: EncoderLimits) {
  const fields = [
    value?.level ?? 0,
    value?.maxBitrate ?? 0,
    value?.bufferBits ?? 0,
  ]
  if (fields.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffffffff))
    throw new RangeError('invalid encoder limits')
  return new Uint32Array([16, ...fields])
}
export function readEncoderLimits(handle: Pointer) {
  const bytes = new Uint32Array(4)
  check(n.zc_video_get_codec_limits(handle, ptr(bytes)), 'encoder limits')
  return Object.freeze({
    level: bytes[1],
    maxBitrate: bytes[2],
    bufferBits: bytes[3],
  })
}
