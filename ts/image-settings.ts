import { processedImageStream } from './images'
export type ImageResample =
  'nearest' | 'bilinear' | 'bicubic' | 'lanczos2' | 'lanczos3'
export interface ImageResizeOptions {
  /** Home Mitchell-Netravali bicubic by default; no gamma/gamut conversion. */
  resample?: ImageResample
}
export interface CaptureImageOptions extends ImageResizeOptions {
  stream?: 'main' | 'lores'
  bits?: 8 | 16
  /** Omitted dimensions retain that source dimension. Configuring a stream at
   * the required size avoids this explicit owned copy and software resampling. */
  width?: number
  height?: number
}
const algorithms = [
  'nearest',
  'bilinear',
  'bicubic',
  'lanczos2',
  'lanczos3',
] as const
function algorithm(value: unknown): ImageResample {
  if (!algorithms.includes(value as ImageResample))
    throw new RangeError('invalid image resampler')
  return value as ImageResample
}
/** @internal Snapshot user properties before accessing a request/native view. */
export function snapshotCaptureImageOptions(options: CaptureImageOptions) {
  const stream = options.stream ?? 'main',
    bits = options.bits,
    width = options.width,
    height = options.height,
    filter = options.resample ?? 'bicubic'
  processedImageStream(stream)
  if (bits !== undefined && bits !== 8 && bits !== 16)
    throw new RangeError('invalid raster bit depth')
  if (width !== undefined) dimension(width)
  if (height !== undefined) dimension(height)
  return Object.freeze({
    stream,
    bits,
    width,
    height,
    resample: algorithm(filter),
  })
}

function dimension(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 0x7fffffff
  )
    throw new RangeError('invalid image geometry or format')
}
export type ImageCaptureSettings = ReturnType<
  typeof snapshotCaptureImageOptions
>
export function imageResampleCode(value: unknown) {
  return algorithms.indexOf(algorithm(value))
}
