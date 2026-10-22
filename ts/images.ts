import {
  prepareExif,
  imageExifDescriptor,
  type ImageExif,
  type PreparedExif,
} from './exif'
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
export type ImageStream = 'main' | 'raw' | 'lores'
export type ImageProfile = 'srgb' | Uint8Array
const streams = { main: 0, raw: 1, lores: 2 } as const
export function imageStreamId(stream: ImageStream) {
  if (typeof stream !== 'string' || !Object.hasOwn(streams, stream))
    throw new RangeError('invalid image stream')
  return streams[stream]
}
export function processedImageStream(stream: 'main' | 'lores' = 'main') {
  if (imageStreamId(stream) === 1)
    throw new CameraError(-8, 'raw RGB conversion')
  return stream
}
export function readStreamColorSpace(camera: Pointer, stream: ImageStream) {
  const data = storage(24)
  check(n.zc_get_stream_color_space(camera, imageStreamId(stream), ptr(data)))
  return decodeStreamColorSpace(data)
}
export function decodeStreamColorSpace(data: Uint8Array) {
  const d = view(data)
  return {
    present: !!d.getUint32(4, true),
    primaries:
      (['unknown', 'raw', 'smpte170m', 'rec709', 'rec2020'] as const)[
        d.getUint32(8, true)
      ] ?? 'unknown',
    transfer:
      (['unknown', 'linear', 'srgb', 'rec709'] as const)[
        d.getUint32(12, true)
      ] ?? 'unknown',
    ycbcrEncoding:
      (['unknown', 'none', 'rec601', 'rec709', 'rec2020'] as const)[
        d.getUint32(16, true)
      ] ?? 'unknown',
    range:
      (['unknown', 'full', 'limited'] as const)[d.getUint32(20, true)] ??
      'unknown',
  }
}
export type StreamColorSpace = ReturnType<typeof readStreamColorSpace>
export interface ImageOptions {
  /** Defaults to raw for DNG and main for processed images. */
  stream?: ImageStream
  format?: ImageFormat
  quality?: number
  /** PNG zlib compression level, 0..9; default 1. */
  compressLevel?: number
  pngFilter?: PngFilter
  /** Embed without converting pixels. Bytes are copied when submitting a job.
   * Built-in sRGB requires matching source primaries/transfer; custom RGB ICC
   * bytes are structurally checked and their pixel match is caller-owned. */
  iccProfile?: ImageProfile
  /** JPEG defaults to request-derived Exif. false disables; typed fields override defaults. */
  exif?: ImageExif
}
export interface PreparedImage {
  options: Uint8Array
  path?: Uint8Array
  format: number
  stream: number
  profile?: ImageProfile
  exif?: PreparedExif
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
  const options = {
    format: source.format,
    stream: source.stream,
    quality: source.quality,
    compressLevel: source.compressLevel,
    pngFilter: source.pngFilter,
    iccProfile: source.iccProfile,
    exif: source.exif,
  }
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
  const stream = imageStreamId(
    options.stream ?? (format === 6 ? 'raw' : 'main'),
  )
  if ((format === 6) !== (stream === 1))
    throw new CameraError(-8, 'image format/source combination')
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
  const profile = options.iccProfile
  if (
    profile !== undefined &&
    profile !== 'srgb' &&
    !(profile instanceof Uint8Array)
  )
    throw new TypeError('ICC profile must be srgb or Uint8Array')
  if (
    profile instanceof Uint8Array &&
    (profile.byteLength === 0 || profile.byteLength > 16 * 1024 * 1024)
  )
    throw new RangeError('ICC profile size must be 1..16 MiB')
  const ownedProfile =
    profile instanceof Uint8Array ? new Uint8Array(profile) : profile
  const exif = prepareExif(options.exif, format)
  const exifDescriptor = imageExifDescriptor(exif)
  const descriptor = imageProfileDescriptor(ownedProfile)
  check(
    n.zc_check_image_metadata(
      ptr(data),
      descriptor ? ptr(descriptor) : null,
      exifDescriptor ? ptr(exifDescriptor) : null,
    ),
  )
  return {
    options: data,
    path: path === undefined ? undefined : cstring(path),
    format,
    stream,
    profile: ownedProfile,
    exif,
  }
}
function imageProfileDescriptor(profile?: ImageProfile) {
  if (profile === undefined) return undefined
  const data = storage(24),
    d = view(data)
  d.setUint32(0, 24, true)
  if (profile === 'srgb') d.setUint32(4, 1, true)
  else {
    d.setBigUint64(8, BigInt(ptr(profile)), true)
    d.setBigUint64(16, BigInt(profile.byteLength), true)
  }
  return data
}
export function saveNativeImage(
  camera: Pointer,
  token: bigint,
  options: Uint8Array,
  stream: number,
  path: Uint8Array,
  profile?: ImageProfile,
  exif?: PreparedExif,
) {
  const descriptor = imageProfileDescriptor(profile)
  const exifDescriptor = imageExifDescriptor(exif)
  check(
    n.zc_save_stream_image_metadata(
      camera,
      token,
      stream,
      ptr(path),
      ptr(options),
      descriptor ? ptr(descriptor) : null,
      exifDescriptor ? ptr(exifDescriptor) : null,
    ),
  )
}
export function stageNativeImage(
  output: Pointer,
  camera: Pointer,
  token: bigint,
  options: Uint8Array,
  stream: number,
  profile?: ImageProfile,
  exif?: PreparedExif,
) {
  const descriptor = imageProfileDescriptor(profile)
  const exifDescriptor = imageExifDescriptor(exif)
  check(
    n.zc_image_file_prepare_metadata(
      output,
      camera,
      token,
      stream,
      ptr(options),
      descriptor ? ptr(descriptor) : null,
      exifDescriptor ? ptr(exifDescriptor) : null,
    ),
  )
}
export function encodeNativeImage(
  camera: Pointer,
  token: bigint,
  options: Uint8Array,
  stream = view(options).getUint32(4, true) === 6 ? 1 : 0,
  profile?: ImageProfile,
  exif?: PreparedExif,
): Uint8Array {
  const out = outPointer()
  const descriptor = imageProfileDescriptor(profile)
  const exifDescriptor = imageExifDescriptor(exif)
  check(
    n.zc_encode_stream_image_metadata(
      camera,
      token,
      stream,
      ptr(options),
      descriptor ? ptr(descriptor) : null,
      exifDescriptor ? ptr(exifDescriptor) : null,
      ptr(out),
    ),
  )
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
