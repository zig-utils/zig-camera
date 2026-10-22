import { native as n, ptr, storage, view, check, cstring } from './ffi'
import { copyConfiguration, cameraConfiguration } from './config'
import type { CameraOptions } from './index'
export interface AlignmentOptions {
  /** Explicit deployment recipe; default PiSP for Pi 5. This is not detection. */
  platform?: 'pisp' | 'vc4'
  optimal?: boolean
}
export interface StreamGeometry {
  width: number
  height: number
  /** A planning label; alignment does not imply backend pixel-format support. */
  format: string
}
export interface AlignedStream extends StreamGeometry {
  widthAlignment: number
  heightAlignment: number
}
function policy(source: AlignmentOptions) {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new TypeError('invalid alignment options')
  const platform = source.platform ?? 'pisp',
    optimal = source.optimal ?? true
  if (platform !== 'pisp' && platform !== 'vc4')
    throw new RangeError('invalid alignment platform')
  if (typeof optimal !== 'boolean')
    throw new RangeError('invalid alignment policy')
  return { profile: platform === 'pisp' ? 1 : 0, optimal: optimal ? 1 : 0 }
}
function unsigned(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new RangeError('invalid stream extent')
  return value
}
export function alignStream(
  source: StreamGeometry,
  options: AlignmentOptions = {},
): AlignedStream {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new TypeError('invalid stream geometry')
  const width = unsigned(source.width),
    height = unsigned(source.height),
    format = source.format,
    selected = policy(options)
  if (
    typeof format !== 'string' ||
    !format.length ||
    format.length > 31 ||
    !format.isWellFormed()
  )
    throw new RangeError('invalid stream format label')
  const label = cstring(format)
  if (label.length < 2 || label.length > 32)
    throw new RangeError('invalid stream format label')
  const layout =
    format === 'YUV420' || format === 'YVU420'
      ? 1
      : ['XBGR8888', 'XRGB8888', 'RGB161616', 'BGR161616'].includes(format)
        ? 2
        : 0
  const data = storage(20),
    result = view(data)
  check(
    n.zc_align_stream_geometry(
      width,
      height,
      layout,
      selected.profile,
      selected.optimal,
      ptr(data),
    ),
    'stream alignment',
  )
  return {
    width: result.getUint32(4, true),
    height: result.getUint32(8, true),
    format,
    widthAlignment: result.getUint32(12, true),
    heightAlignment: result.getUint32(16, true),
  }
}
export function alignConfiguration(
  source: CameraOptions,
  options: AlignmentOptions = {},
): CameraOptions {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new TypeError('invalid camera configuration')
  const snapshot = copyConfiguration(source),
    selected = policy(options),
    encoded = cameraConfiguration(snapshot),
    processed = encoded.processed ?? storage(36)
  if (!encoded.processed) {
    n.zc_default_processed_options(ptr(processed))
    view(processed).setUint32(4, encoded.mainFormat, true)
  }
  const config = storage(72),
    pipeline = storage(44)
  check(
    n.zc_align_camera_configuration(
      ptr(encoded.config),
      ptr(encoded.pipeline),
      ptr(processed),
      selected.profile,
      selected.optimal,
      ptr(config),
      ptr(pipeline),
    ),
    'configuration alignment',
  )
  const c = view(config),
    p = view(pipeline)
  if (snapshot.width !== undefined) snapshot.width = c.getUint32(0, true)
  if (snapshot.height !== undefined) snapshot.height = c.getUint32(4, true)
  if (snapshot.lores) {
    snapshot.lores.width = p.getUint32(32, true)
    snapshot.lores.height = p.getUint32(36, true)
  }
  return snapshot
}
