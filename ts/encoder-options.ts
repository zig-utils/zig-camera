import { native as n, ptr, check } from './ffi'

export const EncoderProfile = {
  default: 0,
  baseline: 1,
  main: 2,
  high: 3,
  'constrained-baseline': 4,
} as const
export const EncoderPreset = {
  veryfast: 0,
  ultrafast: 1,
  superfast: 2,
  faster: 3,
  fast: 4,
  medium: 5,
  slow: 6,
  slower: 7,
  veryslow: 8,
  placebo: 9,
} as const
export interface EncoderOptions {
  /** Compatibility ceiling: AVC baseline/main/high; HEVC main. */
  profile?: keyof typeof EncoderProfile
  preset?: keyof typeof EncoderPreset
  /** 1..51 constant QP, or zero/default for quality/bitrate mode. */
  qp?: number
}
export function snapshotEncoderOptions(value: EncoderOptions) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('invalid encoder options')
  return Object.freeze({ ...value })
}
export function encodeEncoderOptions(value?: EncoderOptions) {
  const profile = value?.profile ?? 'default',
    preset = value?.preset ?? 'veryfast',
    qp = value?.qp ?? 0
  if (
    !Object.hasOwn(EncoderProfile, profile) ||
    !Object.hasOwn(EncoderPreset, preset) ||
    !Number.isInteger(qp) ||
    qp < 0 ||
    qp > 51
  )
    throw new RangeError('invalid encoder options')
  return new Uint32Array([
    16,
    EncoderProfile[profile],
    EncoderPreset[preset],
    qp,
  ])
}
export function readEncoderOptions(
  handle: Parameters<typeof n.zc_video_get_codec_options>[0],
) {
  const bytes = new Uint32Array(4)
  check(n.zc_video_get_codec_options(handle, ptr(bytes)), 'encoder options')
  return Object.freeze({
    profile: Object.keys(EncoderProfile).find(
      (key) => EncoderProfile[key as keyof typeof EncoderProfile] === bytes[1],
    ) as keyof typeof EncoderProfile,
    preset: Object.keys(EncoderPreset).find(
      (key) => EncoderPreset[key as keyof typeof EncoderPreset] === bytes[2],
    ) as keyof typeof EncoderPreset,
    qp: bytes[3],
  })
}
