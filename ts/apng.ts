import { BunJob, snapshotJobOptions, type JobOptions } from './jobs'
import {
  native as n,
  ptr,
  storage,
  view,
  outPointer,
  handle,
  check,
  cstring,
  CameraError,
  type Pointer,
} from './ffi'
import { withStagedImageFile } from './staged-image'
import type { PngFilter } from './images'

export interface PngRaster {
  data: Uint8Array
  width: number
  height: number
  stride?: number
  format?: 'gray' | 'rgb' | 'rgba'
  bits?: 8 | 16
  endian?: 'little' | 'big'
}
export interface PngAnimationFrame extends PngRaster {
  x?: number
  y?: number
  delayMs?: number
  delay?: { numerator: number; denominator: number }
  dispose?: 'none' | 'background' | 'previous'
  blend?: 'source' | 'over'
}
export interface PngAnimationLimits {
  plays?: number
  compressLevel?: number
  pngFilter?: PngFilter
  /** Active copied pixels, default 64 MiB; 1..256 MiB. */
  maxInputBytes?: number
  /** Encoded payload cap, default 64 MiB; 1..256 MiB. */
  maxOutputBytes?: number
}
export interface PngAnimation extends PngAnimationLimits {
  width: number
  height: number
  frames: readonly PngAnimationFrame[]
  defaultImage?: PngRaster
}
const formats = { gray: 0, rgb: 1, rgba: 2 } as const
const filters = {
  adaptive: 0,
  none: 1,
  sub: 2,
  up: 3,
  average: 4,
  paeth: 5,
} as const
const disposals = { none: 0, background: 1, previous: 2 } as const
const blends = { source: 0, over: 1 } as const
const cap = 256 * 1024 * 1024
export function apngInteger(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new RangeError(`invalid APNG ${name}`)
  return value
}
function named<T extends Record<string, number>>(
  values: T,
  key: unknown,
  name: string,
): number {
  if (typeof key !== 'string' || !Object.hasOwn(values, key))
    throw new RangeError(`invalid APNG ${name}`)
  return values[key]!
}
export function apngDelay(ms: number) {
  apngInteger(ms, 0, 0xffffffff, 'delay')
  let a = ms,
    b = 1000
  while (b) [a, b] = [b, a % b]
  return {
    numerator: apngInteger(ms / a, 0, 65535, 'delay numerator'),
    denominator: 1000 / a,
  }
}
function raster(source: PngRaster) {
  if (!source || typeof source !== 'object')
    throw new TypeError('invalid APNG raster')
  const data = source.data,
    width = source.width,
    height = source.height,
    stride = source.stride,
    format = source.format ?? 'rgb',
    bits = source.bits ?? 8,
    endian = source.endian ?? 'little'
  return { data, width, height, stride, format, bits, endian }
}
function frame(source: PngAnimationFrame) {
  const pixels = raster(source),
    x = source.x ?? 0,
    y = source.y ?? 0,
    delayMs = source.delayMs,
    delay = source.delay,
    dispose = source.dispose ?? 'none',
    blend = source.blend ?? 'source'
  if (delay !== undefined && delayMs !== undefined)
    throw new RangeError('choose APNG delay or delayMs')
  const duration =
    delay === undefined
      ? apngDelay(delayMs ?? 40)
      : { numerator: delay.numerator, denominator: delay.denominator }
  return { ...pixels, x, y, duration, dispose, blend }
}
export function apngSettings(source: PngAnimationLimits) {
  // Read application accessors before validation, native admission or file owners.
  const plays = source.plays ?? 0,
    compression = source.compressLevel ?? 1,
    filter = source.pngFilter ?? 'adaptive',
    maxInput = source.maxInputBytes ?? 64 * 1024 * 1024,
    maxOutput = source.maxOutputBytes ?? 64 * 1024 * 1024
  return {
    plays: apngInteger(plays, 0, 0x7fffffff, 'plays'),
    compression: apngInteger(compression, 0, 9, 'compression'),
    filter: named(filters, filter, 'filter'),
    maxInput: apngInteger(maxInput, 1, cap, 'input cap'),
    maxOutput: apngInteger(maxOutput, 1, cap, 'output cap'),
  }
}
export function prepareApng(source: PngAnimation) {
  if (!source || typeof source !== 'object')
    throw new TypeError('invalid APNG animation')
  const width = source.width,
    height = source.height,
    list = source.frames,
    poster = source.defaultImage,
    settings = apngSettings(source)
  if (!Array.isArray(list)) throw new TypeError('APNG frames must be an array')
  const count = apngInteger(list.length, 1, 256, 'frame count')
  const frames = Array.from({ length: count }, (_, i) => frame(list[i]!))
  return {
    width,
    height,
    frames,
    poster: poster === undefined ? undefined : raster(poster),
    settings,
  }
}
type Prepared = ReturnType<typeof prepareApng>
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const actualBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!
const actualOffset = Object.getOwnPropertyDescriptor(
  typedArray,
  'byteOffset',
)!.get!
const actualLength = Object.getOwnPropertyDescriptor(
  typedArray,
  'byteLength',
)!.get!
function descriptor(
  data: Uint8Array,
  at: number,
  source: ReturnType<typeof raster>,
  keep: Uint8Array[],
) {
  if (!(source.data instanceof Uint8Array))
    throw new TypeError('APNG data must be Uint8Array')
  const bytes = new Uint8Array(
    actualBuffer.call(source.data),
    actualOffset.call(source.data),
    actualLength.call(source.data),
  )
  const width = apngInteger(source.width, 1, 0x7fffffff, 'width'),
    height = apngInteger(source.height, 1, 0x7fffffff, 'height'),
    format = named(formats, source.format, 'format'),
    bits = apngInteger(source.bits, 8, 16, 'depth')
  if (bits !== 8 && bits !== 16) throw new RangeError('invalid APNG depth')
  if (source.endian !== 'little' && source.endian !== 'big')
    throw new RangeError('invalid APNG endian')
  const row = width * [1, 3, 4][format]! * (bits / 8),
    stride = apngInteger(
      source.stride ?? row,
      row,
      Number.MAX_SAFE_INTEGER,
      'stride',
    )
  const needed = (height - 1) * stride + row
  if (!Number.isSafeInteger(needed) || bytes.byteLength < needed)
    throw new RangeError('short APNG raster')
  const d = view(data)
  for (const [offset, value] of [
    [0, 48],
    [4, width],
    [8, height],
    [12, format],
    [16, bits],
    [20, source.endian === 'big' ? 1 : 0],
  ])
    d.setUint32(at + offset!, value!, true)
  d.setBigUint64(at + 24, BigInt(stride), true)
  d.setBigUint64(at + 32, BigInt(bytes.byteLength), true)
  d.setBigUint64(at + 40, BigInt(ptr(bytes)), true)
  keep.push(bytes)
}
function encodeDescriptors(prepared: Prepared) {
  const config = storage(40),
    frames = storage(prepared.frames.length * 72),
    poster = prepared.poster ? storage(48) : undefined,
    keep: Uint8Array[] = []
  n.zc_default_apng_config(ptr(config))
  const d = view(config),
    s = prepared.settings
  for (const [offset, value] of [
    [4, prepared.width],
    [8, prepared.height],
    [12, s.plays],
    [16, s.compression],
    [20, s.filter],
  ])
    d.setUint32(
      offset!,
      apngInteger(value, 0, 0x7fffffff, 'configuration'),
      true,
    )
  d.setBigUint64(24, BigInt(s.maxInput), true)
  d.setBigUint64(32, BigInt(s.maxOutput), true)
  const f = view(frames)
  prepared.frames.forEach((frame, i) => {
    descriptor(frames, i * 72, frame, keep)
    for (const [offset, value, max] of [
      [48, frame.x, 0x7fffffff],
      [52, frame.y, 0x7fffffff],
      [56, frame.duration.numerator, 65535],
      [60, frame.duration.denominator, 65535],
      [64, named(disposals, frame.dispose, 'dispose'), 2],
      [68, named(blends, frame.blend, 'blend'), 1],
    ])
      f.setUint32(
        i * 72 + offset!,
        apngInteger(value, 0, max!, 'frame control'),
        true,
      )
  })
  if (poster) descriptor(poster, 0, prepared.poster!, keep)
  return { config, frames, poster, keep }
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
/** @internal Copies at native admission and joins the worker before return/error. */
export async function runApng<T>(
  prepared: Prepared,
  current: BunJob<T>,
  file?: Pointer,
): Promise<Uint8Array | undefined> {
  current.check()
  const encoded = encodeDescriptors(prepared),
    output = outPointer()
  check(
    n.zc_apng_encode_async(
      ptr(encoded.config),
      ptr(encoded.frames),
      prepared.frames.length,
      encoded.poster ? ptr(encoded.poster) : null,
      file ?? null,
      ptr(output),
    ),
    'APNG admission',
  )
  // The native owner has copied every active row. Release private descriptor
  // references so camera-owned JS copies can retire while compression runs.
  encoded.keep.length = 0
  for (const frame of prepared.frames) frame.data = new Uint8Array(0)
  if (prepared.poster) prepared.poster.data = new Uint8Array(0)
  const owned = handle(output),
    cancel = () => {
      n.zc_apng_job_cancel(owned)
    }
  current.signal.addEventListener('abort', cancel, { once: true })
  if (current.cancelRequested) cancel()
  const state = storage(32),
    d = view(state)
  let failure: unknown
  let workerFinished = false
  try {
    for (;;) {
      check(n.zc_apng_job_state_get(owned, ptr(state)), 'APNG state')
      if (d.getUint32(8, true)) break
      await pause()
    }
    workerFinished = true
    const code = d.getInt32(12, true)
    if (code && code !== -10 && code !== -5) check(code, 'APNG encoding')
    current.check()
    check(code, 'APNG encoding')
    if (file) return undefined
    const blobOut = outPointer()
    check(n.zc_apng_job_take_blob(owned, ptr(blobOut)), 'APNG result')
    const blob = handle(blobOut)
    try {
      const length = new BigUint64Array(1)
      check(n.zc_image_blob_copy(blob, null, 0n, ptr(length)))
      if (length[0]! > BigInt(Number.MAX_SAFE_INTEGER))
        throw new RangeError('APNG result too large')
      const bytes = storage(Number(length[0]))
      check(
        n.zc_image_blob_copy(
          blob,
          ptr(bytes),
          BigInt(bytes.length),
          ptr(length),
        ),
      )
      return bytes
    } finally {
      n.zc_image_blob_close(blob)
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    current.signal.removeEventListener('abort', cancel)
    if (!workerFinished) n.zc_apng_job_cancel(owned)
    let closed: number
    while ((closed = n.zc_apng_job_close(owned)) === -4) await pause()
    if (closed) {
      const error = new CameraError(closed, 'APNG close')
      if (failure !== undefined)
        throw new AggregateError([failure, error], 'APNG cleanup failed')
      throw error
    }
  }
}
export function encodePngAnimationAsync(
  animation: PngAnimation,
  options: JobOptions<Uint8Array> = {},
) {
  const effective = snapshotJobOptions(options),
    prepared = prepareApng(animation)
  const job = new BunJob<Uint8Array>(
    async (current) => {
      const result = await runApng(prepared, current)
      current.seal()
      return result!
    },
    () => {},
    effective,
  )
  void job.start()
  return job
}
export function savePngAnimationAsync(
  path: string,
  animation: PngAnimation,
  options: JobOptions<void> = {},
) {
  if (typeof path !== 'string') throw new TypeError('invalid APNG path')
  const effective = snapshotJobOptions(options),
    prepared = prepareApng(animation),
    name = cstring(path)
  const job = new BunJob<void>(
    (current) =>
      withStagedImageFile(name, current, async (file) => {
        await runApng(prepared, current, file!.handle!)
        current.check()
        await file!.publish(current, Infinity)
        current.seal()
      }),
    () => {},
    effective,
  )
  void job.start()
  return job
}
