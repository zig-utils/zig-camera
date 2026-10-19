import { native as n, storage, ptr, view, cstring } from './ffi'
import type { CameraOptions } from './index'
export function copyConfiguration(options: CameraOptions): CameraOptions {
  return {
    ...options,
    sensor: options.sensor ? { ...options.sensor } : undefined,
    lores: options.lores ? { ...options.lores } : undefined,
  }
}
export function cameraConfiguration(options: CameraOptions) {
  const config = storage(72),
    pipeline = storage(44)
  n.zc_default_config(ptr(config))
  n.zc_default_pipeline_options(ptr(pipeline))
  const put = (
    target: Uint8Array,
    offset: number,
    value: number | undefined,
  ) => {
    if (value === undefined) return
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new RangeError('unsigned configuration value required')
    view(target).setUint32(offset, value, true)
  }
  ;[
    options.width,
    options.height,
    options.buffers,
    options.cameraIndex,
    options.fifo ? 0 : 1,
  ].forEach((x, i) => put(config, i * 4, x))
  if (options.raw) put(config, 36, 1)
  if (options.rawFormat) {
    const name = cstring(options.rawFormat)
    if (name.length > 32) throw new RangeError('raw format too long')
    config.set(name, 40)
  }
  if (
    options.role !== undefined &&
    !['still', 'preview', 'video'].includes(options.role)
  )
    throw new RangeError('invalid camera role')
  put(pipeline, 8, { still: 0, preview: 1, video: 2 }[options.role ?? 'still'])
  put(pipeline, 12, options.unpackedRaw ? 1 : 0)
  if (options.sensor)
    [
      options.sensor.width,
      options.sensor.height,
      options.sensor.bitDepth,
    ].forEach((x, i) => put(pipeline, 20 + i * 4, x))
  if (options.lores) {
    put(pipeline, 32, options.lores.width)
    put(pipeline, 36, options.lores.height)
    put(pipeline, 40, options.lores.rgb ? 1 : 0)
  }
  return { config, pipeline }
}
