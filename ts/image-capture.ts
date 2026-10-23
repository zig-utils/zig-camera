import {
  native as n,
  ptr,
  storage,
  view,
  text,
  check,
  CameraError,
  type Pointer,
} from './ffi'
import {
  imageStreamId,
  readStreamColorSpace,
  resizeNativeRaster,
  type StreamColorSpace,
} from './images'
import { decodeMetadata } from './metadata'
import {
  imageResampleCode,
  type ImageCaptureSettings,
} from './image-settings'

/** Internal owned transfer data, never a native pointer or retained request. */
export interface ImageSnapshot {
  data: Uint8Array
  width: number
  height: number
  bits: 8 | 16
  metadata: ReturnType<typeof decodeMetadata>
  colorSpace: StreamColorSpace
}
/** The caller holds a readable native request for every synchronous call here.
 * Snapshot geometry/precision/color/metadata before release or reconfiguration. */
export function copyNativeImage(
  camera: Pointer,
  token: bigint,
  settings: ImageCaptureSettings,
): ImageSnapshot {
  const id = imageStreamId(settings.stream),
    descriptor = storage(208)
  check(n.zc_get_stream(camera, token, id, ptr(descriptor)))
  const d = view(descriptor),
    width = d.getUint32(0, true),
    height = d.getUint32(4, true),
    wide = text(descriptor, 16, 32).endsWith('161616'),
    bits = settings.bits ?? (wide ? 16 : 8)
  if (bits === 16 && !wide)
    throw new CameraError(-8, 'native image precision')
  if (width * height * 3 * (bits / 8) > 256 * 1024 * 1024)
    throw new RangeError('image pixels exceed 256 MiB')
  if (
    (settings.width ?? width) *
      (settings.height ?? height) *
      3 *
      (bits / 8) >
    256 * 1024 * 1024
  )
    throw new RangeError('resized image pixels exceed 256 MiB')
  const metadata = storage(96)
  check(n.zc_get_frame_metadata(camera, token, ptr(metadata)))
  const colorSpace = readStreamColorSpace(camera, settings.stream),
    data = storage(width * height * 3 * (bits / 8))
  const copy = bits === 16 ? n.zc_copy_stream_rgb16 : n.zc_copy_stream_rgb
  check(copy(camera, token, id, ptr(data), BigInt(data.byteLength)))
  return {
    data,
    width,
    height,
    bits,
    metadata: decodeMetadata(metadata),
    colorSpace,
  }
}
/** This stage needs only owned pixels; the source camera may already be gone. */
export function resizeImageSnapshot(
  image: ImageSnapshot,
  settings: ImageCaptureSettings,
): ImageSnapshot {
  const width = settings.width ?? image.width,
    height = settings.height ?? image.height
  if (width === image.width && height === image.height) return image
  const descriptor = storage(48),
    d = view(descriptor)
  for (const [at, v] of [
    [0, 48],
    [4, image.width],
    [8, image.height],
    [12, 1],
    [16, image.bits],
  ])
    d.setUint32(at, v, true)
  d.setBigUint64(24, BigInt(image.width * 3 * (image.bits / 8)), true)
  d.setBigUint64(32, BigInt(image.data.byteLength), true)
  d.setBigUint64(40, BigInt(ptr(image.data)), true)
  const data = resizeNativeRaster(
    descriptor,
    width,
    height,
    imageResampleCode(settings.resample),
  )
  return { ...image, data, width, height }
}
