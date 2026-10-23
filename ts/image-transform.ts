import { native as n, ptr, check } from './ffi'
export interface ImageTransformOptions {
  /** Clockwise rotation, then flips in output axes, then diagonal transpose. */
  rotation?: 0 | 90 | 180 | 270
  hflip?: boolean
  vflip?: boolean
  transpose?: boolean
}
/** One scalar snapshot; image/preview geometry uses Home's native mapping. */
export function prepareImageTransform(
  value: ImageTransformOptions | undefined,
  label = 'image',
) {
  if (value === undefined) return { orientation: 1, snapshot: undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`invalid ${label} transform`)
  const requestedRotation = value.rotation,
    requestedHflip = value.hflip,
    requestedVflip = value.vflip,
    requestedTranspose = value.transpose,
    rotation = requestedRotation === undefined ? 0 : requestedRotation,
    hflip = requestedHflip === undefined ? false : requestedHflip,
    vflip = requestedVflip === undefined ? false : requestedVflip,
    transpose = requestedTranspose === undefined ? false : requestedTranspose,
    strict = (value as ImageTransformOptions & { strict?: unknown }).strict
  if (strict !== undefined || ![0, 90, 180, 270].includes(rotation))
    throw new RangeError(`invalid ${label} transform`)
  for (const flag of [hflip, vflip, transpose])
    if (typeof flag !== 'boolean')
      throw new RangeError(`invalid ${label} transform flag`)
  const out = new Uint32Array(1)
  check(n.zc_orientation_from_transform(
    rotation, hflip ? 1 : 0, vflip ? 1 : 0, transpose ? 1 : 0, ptr(out),
  ))
  return {
    orientation: out[0]!,
    snapshot: Object.freeze({ rotation, hflip, vflip, transpose }),
  }
}
