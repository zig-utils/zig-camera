import {
  native as n,
  storage,
  ptr,
  view,
  cstring,
  check,
  CameraError,
  outPointer,
  handle,
  type Pointer,
} from './ffi'
type LowerImageFormat =
  'jpeg' | 'jpg' | 'png' | 'bmp' | 'tiff' | 'tif' | 'ppm' | 'dng'
export type ImageFormat = LowerImageFormat | Uppercase<LowerImageFormat>
export type PngFilter = 'adaptive' | 'none' | 'sub' | 'up' | 'average' | 'paeth'
export interface ImageOptions {
  format?: ImageFormat
  quality?: number
  /** PNG zlib compression level, 0..9; default 1. */
  compressLevel?: number
  pngFilter?: PngFilter
}
export interface PreparedImage {
  options: Uint8Array
  path?: Uint8Array
  format: number
}
const formats: Record<LowerImageFormat, number> = {
  jpeg: 1,
  jpg: 1,
  png: 2,
  bmp: 3,
  tiff: 4,
  tif: 4,
  ppm: 5,
  dng: 6,
}
const filters: Record<PngFilter, number> = {
  adaptive: 0,
  none: 1,
  sub: 2,
  up: 3,
  average: 4,
  paeth: 5,
}
export function prepareImage(
  source: ImageOptions = {},
  path?: string,
): PreparedImage {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new RangeError('invalid image options')
  const options = { ...source }
  const requested =
    options.format ??
    (path === undefined
      ? 'jpeg'
      : path.slice(path.lastIndexOf('.') + 1).toLowerCase())
  const name =
    typeof requested === 'string' ? requested.toLowerCase() : requested
  if (typeof name !== 'string' || !Object.hasOwn(formats, name))
    throw new CameraError(-8, 'image format')
  const format = formats[name as LowerImageFormat],
    quality = options.quality ?? 98,
    compression = options.compressLevel ?? 1,
    filter = options.pngFilter ?? 'adaptive'
  if (
    !Number.isInteger(quality) ||
    quality < 0 ||
    quality > 0xffffffff ||
    (format === 1 && (quality < 1 || quality > 100))
  )
    throw new RangeError('invalid JPEG quality')
  if (!Number.isInteger(compression) || compression < 0 || compression > 9)
    throw new RangeError('invalid PNG compression level')
  if (typeof filter !== 'string' || !Object.hasOwn(filters, filter))
    throw new RangeError('invalid PNG filter')
  const data = storage(20),
    v = view(data)
  n.zc_default_image_options(ptr(data))
  v.setUint32(4, format, true)
  v.setUint32(8, quality, true)
  v.setUint32(12, compression, true)
  v.setUint32(16, filters[filter as PngFilter], true)
  return {
    options: data,
    path: path === undefined ? undefined : cstring(path),
    format,
  }
}
export function encodeNativeImage(
  camera: Pointer,
  token: bigint,
  options: Uint8Array,
): Uint8Array {
  const out = outPointer()
  check(n.zc_encode_image(camera, token, ptr(options), ptr(out)))
  const blob = handle(out)
  try {
    const length = new BigUint64Array(1)
    check(n.zc_image_blob_copy(blob, null, 0n, ptr(length)))
    if (length[0] > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError('encoded image too large')
    const bytes = new Uint8Array(Number(length[0]))
    check(n.zc_image_blob_copy(blob, ptr(bytes), length[0], ptr(length)))
    return bytes
  } finally {
    n.zc_image_blob_close(blob)
  }
}
