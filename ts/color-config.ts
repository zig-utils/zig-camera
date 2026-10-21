import {
  native as n,
  storage,
  ptr,
  view,
  check,
  CameraError,
  type Pointer,
} from './ffi'
import { decodeStreamColorSpace, type StreamColorSpace } from './images'
export type ColorSpacePreset =
  'srgb' | 'sycc' | 'smpte170m' | 'rec709' | 'rec2020'
export interface ColorSpaceDescription {
  primaries: 'smpte170m' | 'rec709' | 'rec2020'
  transfer: 'linear' | 'srgb' | 'rec709'
  ycbcrEncoding: 'none' | 'rec601' | 'rec709' | 'rec2020'
  range: 'full' | 'limited'
}
export type ColorSpaceRequest = ColorSpacePreset | ColorSpaceDescription
export interface ColorNegotiation {
  configured: boolean
  strict: boolean
  normalized: boolean
  adjusted: boolean
  format: 'BGR888' | 'YUV420'
  requested?: StreamColorSpace
  effective?: StreamColorSpace
  actual: StreamColorSpace
}
const presets = {
  srgb: 1,
  sycc: 2,
  smpte170m: 3,
  rec709: 4,
  rec2020: 5,
} as const
export function snapshotColorSpace(
  value: ColorSpaceRequest | undefined,
): ColorSpaceRequest | undefined {
  if (value === undefined || typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('invalid color space request')
  return {
    primaries: value.primaries,
    transfer: value.transfer,
    ycbcrEncoding: value.ycbcrEncoding,
    range: value.range,
  }
}
function code(table: Record<string, number>, value: string, field: string) {
  if (typeof value !== 'string' || !Object.hasOwn(table, value))
    throw new RangeError(`invalid color space ${field}`)
  return table[value]
}
export function prepareProcessedOptions(
  format: number,
  pipeline: Uint8Array,
  requested: ColorSpaceRequest | undefined,
  strict: boolean | undefined,
): Uint8Array | undefined {
  if (strict !== undefined && typeof strict !== 'boolean')
    throw new RangeError('invalid strict color space option')
  if (strict && requested === undefined)
    throw new RangeError('strict color space requires a request')
  if (requested === undefined && strict === undefined) return undefined
  const result = storage(36),
    d = view(result)
  n.zc_default_processed_options(ptr(result))
  d.setUint32(4, format, true)
  d.setUint32(8, strict ? 1 : 0, true)
  if (requested !== undefined) result.set(encodeColorSpace(requested), 12)
  check(
    n.zc_check_processed_options(ptr(result), ptr(pipeline)),
    'processed color configuration',
  )
  return result
}
export function readColorNegotiation(
  camera: Pointer,
  stream: 'main' | 'lores',
): ColorNegotiation {
  const data = storage(88),
    d = view(data)
  check(
    n.zc_get_color_negotiation(camera, stream === 'main' ? 0 : 2, ptr(data)),
  )
  const flags = d.getUint32(4, true),
    format = d.getUint32(8, true)
  if (format > 1) throw new CameraError(-8, 'negotiated color format')
  return {
    configured: !!(flags & 1),
    strict: !!(flags & 2),
    normalized: !!(flags & 4),
    adjusted: !!(flags & 8),
    format: format === 1 ? 'BGR888' : 'YUV420',
    ...(flags & 1
      ? {
          requested: decodeStreamColorSpace(data.subarray(16, 40)),
          effective: decodeStreamColorSpace(data.subarray(40, 64)),
        }
      : {}),
    actual: decodeStreamColorSpace(data.subarray(64, 88)),
  }
}

/** Encode a copied portable description; role-specific policy is checked by the caller. */
export function encodeColorSpace(requested: ColorSpaceRequest): Uint8Array {
  const result = storage(24),
    d = view(result)
  d.setUint32(0, 24, true)
  if (typeof requested === 'string') {
    if (!Object.hasOwn(presets, requested))
      throw new RangeError('invalid color space preset')
    check(
      n.zc_color_space_preset(
        presets[requested as ColorSpacePreset],
        ptr(result),
      ),
    )
  } else if (requested !== undefined) {
    d.setUint32(4, 1, true)
    d.setUint32(
      8,
      code(
        { smpte170m: 2, rec709: 3, rec2020: 4 },
        requested.primaries,
        'primaries',
      ),
      true,
    )
    d.setUint32(
      12,
      code({ linear: 1, srgb: 2, rec709: 3 }, requested.transfer, 'transfer'),
      true,
    )
    d.setUint32(
      16,
      code(
        { none: 1, rec601: 2, rec709: 3, rec2020: 4 },
        requested.ycbcrEncoding,
        'matrix',
      ),
      true,
    )
    d.setUint32(
      20,
      code({ full: 1, limited: 2 }, requested.range, 'range'),
      true,
    )
  }
  return result
}
