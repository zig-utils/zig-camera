import { native as n, ptr, check } from './ffi'
const tiers = ['very-low', 'low', 'medium', 'high', 'very-high'] as const
export type QualityTierName = (typeof tiers)[number]
export type RecordingQuality = number | QualityTierName
export const QualityTier = Object.freeze({
  'very-low': 'very-low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'very-high': 'very-high',
} as const)
export function qualityTierCode(value?: RecordingQuality): number | undefined {
  if (typeof value === 'string') {
    const index = tiers.indexOf(value)
    if (index < 0) throw new RangeError('invalid quality tier')
    return index
  }
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 100)
  )
    throw new RangeError('quality must be 1..100 or a named tier')
  return undefined
}
/** Pure Home policy planning: no camera, encoder, file or output hook is opened. */
export function planRecordingQuality(options: {
  width: number
  height: number
  fps?: number
  codec?: 'mjpeg' | 'h264' | 'hevc'
  quality: QualityTierName
}) {
  const { width, height, fps = 30, codec = 'mjpeg', quality } = options
  const codecs = { mjpeg: 3, h264: 1, hevc: 2 } as const
  const tier = qualityTierCode(quality)
  if (tier === undefined || !Object.hasOwn(codecs, codec))
    throw new RangeError('invalid tier planning policy')
  for (const value of [width, height, fps])
    if (!Number.isInteger(value) || value < 1 || value > 0xffffffff)
      throw new RangeError('invalid quality planning geometry/rate')
  const cfg = new Uint32Array([width, height, fps, 1, codecs[codec], 0, 90, 0])
  check(n.zc_video_apply_quality_tier(ptr(cfg), tier), 'quality plan')
  return Object.freeze({
    width,
    height,
    fps,
    codec,
    quality: cfg[6],
    bitrate: cfg[5],
    mode: codec === 'mjpeg' ? ('jpeg' as const) : ('abr' as const),
  })
}
