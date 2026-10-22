import type { PreviewOptions } from './index'
import { cstring } from './ffi'
import { snapshotPreviewStream } from './preview-stream'
import { preparePreviewView, type PreviewConfiguration } from './preview-view'
/** Owned scalar/native snapshot without opening a window or camera. */
export function preparePreviewConfiguration(
  options: string | PreviewOptions = 'zig-camera',
): PreviewConfiguration {
  if (
    options === null ||
    (typeof options !== 'string' && typeof options !== 'object')
  )
    throw new TypeError('invalid preview options')
  const backend =
      typeof options === 'string' ? 'sdl' : (options.backend ?? 'sdl'),
    title =
      typeof options === 'string' ? options : (options.title ?? 'zig-camera')
  if (backend !== 'sdl' && backend !== 'headless')
    throw new RangeError('invalid preview backend')
  if (typeof title !== 'string') throw new TypeError('invalid preview title')
  cstring(title)
  const stream = snapshotPreviewStream(
      typeof options === 'string' ? undefined : options.stream,
    ),
    view = preparePreviewView(typeof options === 'string' ? {} : options)
  return Object.freeze({
    backend,
    title,
    view,
    ...(stream !== undefined ? { stream } : {}),
  })
}
