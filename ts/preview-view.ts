import type { PreviewStream } from './preview-stream'
import type {PreparedDrmPreview} from './drm-preview'
import { native as n, storage, view, ptr, check } from './ffi'
import {
  prepareImageTransform,
  type ImageTransformOptions,
} from './image-transform'
export type PreviewTransform = ImageTransformOptions
export interface PreviewRectangle {
  x: number
  y: number
  width: number
  height: number
}
export interface PreviewWindow {
  x?: number
  y?: number
  width: number
  height: number
}
export interface PreviewViewOptions {
  window?: PreviewWindow
  transform?: PreviewTransform
  keepAspect?: boolean
  overlay?: { rectangle?: PreviewRectangle; transform?: PreviewTransform }
}
/** @internal Immutable scalar snapshot; native bytes never escape public APIs. */
export interface PreparedPreviewView {
  readonly data: Uint8Array
  readonly options: Readonly<PreviewViewOptions>
  readonly customized: boolean
}
export interface PreviewConfiguration {
  readonly backend: 'sdl' | 'headless' | 'drm'
  readonly drm?:PreparedDrmPreview
  readonly title: string
  readonly stream?: PreviewStream
  readonly view: PreparedPreviewView
}
function uint(value: number, max = 0xffffffff) {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new RangeError('invalid preview integer')
  return value
}
function object(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`invalid preview ${label}`)
}
function transform(value: PreviewTransform | undefined) {
  return prepareImageTransform(value, 'preview')
}
function position(value: number | undefined) {
  const result = value ?? 0
  if (!Number.isInteger(result) || Math.abs(result) > 1_000_000)
    throw new RangeError('invalid preview window position')
  return result
}
export function preparePreviewView(
  options: PreviewViewOptions,
): PreparedPreviewView {
  object(options, 'view')
  const window = options.window,
    image = options.transform,
    aspect = options.keepAspect,
    overlay = options.overlay
  if (aspect !== undefined && typeof aspect !== 'boolean')
    throw new RangeError('invalid preview aspect flag')
  const main = transform(image)
  let over: ReturnType<typeof transform> = {
      orientation: 1,
      snapshot: undefined,
    },
    rectangle: PreviewRectangle | undefined
  if (overlay !== undefined) {
    object(overlay, 'overlay view')
    const r = overlay.rectangle,
      t = overlay.transform
    over = transform(t)
    if (r !== undefined) {
      object(r, 'rectangle')
      rectangle = Object.freeze({
        x: uint(r.x),
        y: uint(r.y),
        width: uint(r.width),
        height: uint(r.height),
      })
    }
  }
  let placement: PreviewWindow | undefined,
    positioned = false
  if (window !== undefined) {
    object(window, 'window')
    const x = window.x,
      y = window.y,
      width = uint(window.width, 16384),
      height = uint(window.height, 16384)
    if (!width || !height) throw new RangeError('invalid preview window size')
    positioned = x !== undefined || y !== undefined
    placement = Object.freeze({
      width,
      height,
      ...(positioned ? { x: position(x), y: position(y) } : {}),
    })
  }
  const data = storage(48),
    d = view(data)
  n.zc_default_preview_view(ptr(data))
  d.setUint32(
    4,
    ((aspect ?? true) ? 1 : 0) |
      (placement ? 2 : 0) |
      (positioned ? 4 : 0) |
      (rectangle ? 8 : 0),
    true,
  )
  d.setUint32(8, main.orientation, true)
  d.setUint32(12, over.orientation, true)
  if (placement) {
    d.setInt32(16, placement.x ?? 0, true)
    d.setInt32(20, placement.y ?? 0, true)
    d.setUint32(24, placement.width, true)
    d.setUint32(28, placement.height, true)
  }
  if (rectangle) {
    d.setUint32(32, rectangle.x, true)
    d.setUint32(36, rectangle.y, true)
    d.setUint32(40, rectangle.width, true)
    d.setUint32(44, rectangle.height, true)
  }
  const snapshot = Object.freeze({
    ...(placement ? { window: placement } : {}),
    ...(main.snapshot ? { transform: main.snapshot } : {}),
    ...(aspect !== undefined ? { keepAspect: aspect } : {}),
    ...(overlay !== undefined
      ? {
          overlay: Object.freeze({
            ...(rectangle ? { rectangle } : {}),
            ...(over.snapshot ? { transform: over.snapshot } : {}),
          }),
        }
      : {}),
  })
  return Object.freeze({
    data,
    options: snapshot,
    customized:
      window !== undefined ||
      image !== undefined ||
      aspect !== undefined ||
      overlay !== undefined,
  })
}
export function validatePreviewView(
  prepared: PreparedPreviewView,
  width: number,
  height: number,
) {
  check(
    n.zc_preview_check_view(width, height, ptr(prepared.data)),
    'preview view',
  )
}
export function copyPreviewViewOptions(
  prepared: PreparedPreviewView,
): PreviewViewOptions {
  const o = prepared.options
  return {
    ...(o.window ? { window: { ...o.window } } : {}),
    ...(o.transform ? { transform: { ...o.transform } } : {}),
    ...(o.keepAspect !== undefined ? { keepAspect: o.keepAspect } : {}),
    ...(o.overlay
      ? {
          overlay: {
            ...(o.overlay.rectangle
              ? { rectangle: { ...o.overlay.rectangle } }
              : {}),
            ...(o.overlay.transform
              ? { transform: { ...o.overlay.transform } }
              : {}),
          },
        }
      : {}),
  }
}
