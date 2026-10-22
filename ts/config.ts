import { snapshotColorSpace, prepareProcessedOptions } from './color-config'
import { native as n, storage, ptr, view, cstring, check } from './ffi'
import type { CameraOptions } from './index'
export function copyConfiguration(options: CameraOptions): CameraOptions {
  const snapshot = { ...options }
  if (
    snapshot.transform !== undefined &&
    (typeof snapshot.transform !== 'object' ||
      snapshot.transform === null ||
      Array.isArray(snapshot.transform))
  )
    throw new RangeError('invalid camera transform')
  return {
    ...snapshot,
    colorSpace: snapshotColorSpace(snapshot.colorSpace),
    sensor: snapshot.sensor ? { ...snapshot.sensor } : undefined,
    lores: snapshot.lores ? { ...snapshot.lores } : undefined,
    transform: snapshot.transform ? { ...snapshot.transform } : undefined,
  }
}
export function cameraIdentity(options: CameraOptions) {
  if (options.cameraId === undefined) return undefined
  if (options.cameraIndex !== undefined)
    throw new RangeError('cameraId and cameraIndex are mutually exclusive')
  const id = options.cameraId
  if (
    typeof id !== 'string' ||
    !id.length ||
    id.includes('\0') ||
    !id.isWellFormed()
  )
    throw new RangeError('invalid camera ID')
  const bytes = new TextEncoder().encode(id)
  if (bytes.length > 4096)
    throw new RangeError('camera ID exceeds 4096 UTF-8 bytes')
  return bytes
}
export function cameraConfiguration(options: CameraOptions, preflight = false) {
  const cameraId = cameraIdentity(options)
  const format = options.format === undefined ? 'BGR888' : options.format
  if (format !== 'BGR888' && format !== 'YUV420')
    throw new RangeError('invalid main stream format')
  const mainFormat = format === 'YUV420' ? 0 : 1
  if (options.writable !== undefined && typeof options.writable !== 'boolean')
    throw new RangeError('invalid writable buffer option')
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
  const transform = options.transform
  let orientation = 1
  if (transform !== undefined) {
    if (!transform || typeof transform !== 'object' || Array.isArray(transform))
      throw new RangeError('invalid camera transform')
    const rotation = transform.rotation ?? 0
    if (![0, 90, 180, 270].includes(rotation))
      throw new RangeError('rotation must be 0, 90, 180 or 270')
    for (const flag of [
      transform.hflip,
      transform.vflip,
      transform.transpose,
      transform.strict,
    ])
      if (flag !== undefined && typeof flag !== 'boolean')
        throw new RangeError('invalid camera transform flag')
    const encoded = new Uint32Array(1)
    check(
      n.zc_orientation_from_transform(
        rotation,
        transform.hflip ? 1 : 0,
        transform.vflip ? 1 : 0,
        transform.transpose ? 1 : 0,
        ptr(encoded),
      ),
    )
    orientation = encoded[0]
  }
  const processed = prepareProcessedOptions(
    mainFormat,
    pipeline,
    options.colorSpace,
    options.strictColorSpace,
  )
  // Series admission validates every mode before it owns the camera lifecycle.
  // Existing mode jobs keep reporting structural open failures on their jobs.
  if (preflight) {
    const checkedProcessed = processed ?? storage(36)
    if (!processed) {
      n.zc_default_processed_options(ptr(checkedProcessed))
      view(checkedProcessed).setUint32(4, mainFormat, true)
    }
    check(
      n.zc_check_camera_configuration(
        ptr(config),
        ptr(pipeline),
        ptr(checkedProcessed),
        orientation,
        transform?.strict ? 1 : 0,
      ),
      'camera configuration',
    )
  }
  return {
    config,
    pipeline,
    mainFormat,
    processed,
    cameraId,
    writable: options.writable ?? false,
    orientation,
    strictOrientation: transform?.strict ?? false,
  }
}
