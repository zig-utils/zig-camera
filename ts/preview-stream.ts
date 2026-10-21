import {
  native as n,
  storage,
  view,
  ptr,
  text,
  check,
  CameraError,
  type Pointer,
} from './ffi'
import { decodeStreamColorSpace, type StreamColorSpace } from './images'
export type PreviewStream = 'main' | 'lores' | null
export interface PreviewStreamInfo {
  stream: PreviewStream
  width: number
  height: number
  format?: 'BGR888' | 'YUV420'
  colorSpace?: StreamColorSpace
  suspended: boolean
}
export interface PreparedPreviewInput {
  readonly info: Readonly<Omit<PreviewStreamInfo, 'suspended'>>
  readonly id: number
}
export function snapshotPreviewStream(stream: PreviewStream | undefined) {
  if (
    stream !== undefined &&
    stream !== null &&
    stream !== 'main' &&
    stream !== 'lores'
  )
    throw new RangeError('invalid preview stream')
  return stream
}
export function readPreviewInput(
  camera: Pointer,
  requested: PreviewStream | undefined,
): PreparedPreviewInput {
  const stream = requested === undefined ? 'main' : requested
  const main = storage(680)
  check(n.zc_get_info(camera, ptr(main)))
  let width = view(main).getUint32(8, true),
    height = view(main).getUint32(12, true),
    format = text(main, 24, 32)
  if (stream === null)
    return { info: Object.freeze({ stream, width, height }), id: 0 }
  const id = stream === 'main' ? 0 : 2
  if (stream === 'lores') {
    const pipeline = storage(224),
      d = view(pipeline)
    check(n.zc_get_pipeline_info(camera, ptr(pipeline)))
    if (!d.getUint32(28, true))
      throw new CameraError(-8, 'preview lores stream disabled')
    width = d.getUint32(16, true)
    height = d.getUint32(20, true)
    format = text(pipeline, 32, 32)
  }
  if (format !== 'BGR888' && format !== 'YUV420')
    throw new CameraError(-8, 'preview stream format')
  const color = storage(24)
  check(n.zc_get_stream_color_space(camera, id, ptr(color)))
  check(
    n.zc_preview_check_color(format === 'YUV420' ? 0 : 1, ptr(color)),
    'preview color space',
  )
  return {
    info: Object.freeze({
      stream,
      width,
      height,
      format,
      colorSpace: Object.freeze(decodeStreamColorSpace(color)),
    }),
    id,
  }
}
export function copyPreviewStreamInfo(
  input: PreparedPreviewInput,
  suspended: boolean,
): PreviewStreamInfo {
  return {
    ...input.info,
    ...(input.info.colorSpace
      ? { colorSpace: { ...input.info.colorSpace } }
      : {}),
    suspended,
  }
}
