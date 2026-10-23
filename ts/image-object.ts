import {
  native as n,
  ptr,
  storage,
  view,
  check,
  outPointer,
  handle,
  CameraError,
} from './ffi'
import {
  prepareImage,
  resizeNativeRaster,
  imageProfileDescriptor,
  type ImageOptions,
  type StreamColorSpace,
} from './images'
import { imageExifDescriptor } from './exif'
import { BunJob, snapshotJobOptions, type JobOptions } from './jobs'
import { withStagedImageFile } from './staged-image'
import type { decodeMetadata } from './metadata'
export type RasterFormat = 'gray' | 'rgb' | 'rgba'
export type RasterEndian = 'little' | 'big'
export interface ImageRaster {
  data: Uint8Array
  width: number
  height: number
  stride?: number
  format?: RasterFormat
  bits?: 8 | 16
  endian?: RasterEndian
  /** Declares source interpretation; encoding does not convert color spaces. */
  colorSpace?: StreamColorSpace
}
export type ImageObjectOptions = Omit<ImageOptions, 'stream'>
export {
  snapshotCaptureImageOptions,
  type ImageResample,
  type ImageResizeOptions,
  type CaptureImageOptions,
} from './image-settings'
import {
  imageResampleCode,
  type ImageResizeOptions,
} from './image-settings'
import type { ImageSnapshot } from './image-capture'
type Metadata = ReturnType<typeof decodeMetadata>
const captureAdmission = Symbol('capture image admission')
export type ImageSourceMetadata = Readonly<Omit<Metadata, 'crop'>> & {
  readonly crop: Readonly<Metadata['crop']>
}
const kinds = { gray: 0, rgb: 1, rgba: 2 } as const
const primaries = [
  'unknown',
  'raw',
  'smpte170m',
  'rec709',
  'rec2020',
] as const
const transfers = ['unknown', 'linear', 'srgb', 'rec709'] as const
const encodings = [
  'unknown',
  'none',
  'rec601',
  'rec709',
  'rec2020',
] as const
const ranges = ['unknown', 'full', 'limited'] as const
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new RangeError('invalid image geometry or format')
  return value
}
function kind(value: unknown): RasterFormat {
  if (typeof value !== 'string' || !Object.hasOwn(kinds, value))
    throw new RangeError('invalid raster format')
  return value as RasterFormat
}
function depth(value: unknown): 8 | 16 {
  if (value !== 8 && value !== 16)
    throw new RangeError('invalid raster bit depth')
  return value
}
function order(value: unknown): RasterEndian {
  if (value !== 'little' && value !== 'big')
    throw new RangeError('invalid raster endian')
  return value
}
const typed = Object.getPrototypeOf(Uint8Array.prototype)
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!
function actual(data: Uint8Array) {
  if (!(data instanceof Uint8Array))
    throw new TypeError('image pixels must be Uint8Array')
  return new Uint8Array(
    buffer.call(data),
    offset.call(data),
    length.call(data),
  )
}
function description(
  bytes: Uint8Array,
  width: number,
  height: number,
  format: RasterFormat,
  bits: 8 | 16,
  endian: RasterEndian,
  stride: number,
) {
  const data = storage(48),
    d = view(data)
  for (const [at, value] of [
    [0, 48],
    [4, width],
    [8, height],
    [12, kinds[format]],
    [16, bits],
    [20, endian === 'big' ? 1 : 0],
  ])
    d.setUint32(at, value, true)
  d.setBigUint64(24, BigInt(stride), true)
  d.setBigUint64(32, BigInt(bytes.byteLength), true)
  d.setBigUint64(40, BigInt(ptr(bytes)), true)
  return { data, bytes }
}
function color(value?: StreamColorSpace) {
  if (value === undefined) return undefined
  const present = value.present,
    p = value.primaries,
    t = value.transfer,
    e = value.ycbcrEncoding,
    r = value.range
  if (typeof present !== 'boolean')
    throw new TypeError('invalid image color description')
  const fields = [
    primaries.indexOf(p),
    transfers.indexOf(t),
    encodings.indexOf(e),
    ranges.indexOf(r),
  ]
  if (fields.some((value) => value < 0))
    throw new RangeError('invalid image color description')
  const bytes = storage(24),
    d = view(bytes)
  d.setUint32(0, 24, true)
  d.setUint32(4, present ? 1 : 0, true)
  fields.forEach((v, i) => d.setUint32(8 + i * 4, v, true))
  return {
    bytes,
    value: Object.freeze({
      present,
      primaries: p,
      transfer: t,
      ycbcrEncoding: e,
      range: r,
    }),
  }
}
type Info = {
  width: number
  height: number
  format: RasterFormat
  bits: 8 | 16
  endian: RasterEndian
  stride: number
}
function copied(source: ReturnType<typeof description>, info: Info) {
  const size = new BigUint64Array(1)
  check(
    n.zc_raster_convert(
      ptr(source.data),
      kinds[info.format],
      info.bits,
      info.endian === 'big' ? 1 : 0,
      null,
      0n,
      ptr(size),
    ),
  )
  const bytes = storage(Number(size[0]))
  check(
    n.zc_raster_convert(
      ptr(source.data),
      kinds[info.format],
      info.bits,
      info.endian === 'big' ? 1 : 0,
      ptr(bytes),
      BigInt(bytes.byteLength),
      ptr(size),
    ),
  )
  return bytes
}
/** Private pixels are copied at public admission; capture adopts an already
 * owned Zig copy. Every native pixel pointer is borrowed synchronously only. */
export class CapturedImage implements Disposable {
  private pixels?: Uint8Array
  private constructor(
    bytes: Uint8Array,
    private readonly info: Readonly<Info>,
    private readonly sourceColor?: ReturnType<typeof color>,
    readonly sourceMetadata?: ImageSourceMetadata,
  ) {
    this.pixels = bytes
  }
  static fromRaster(source: ImageRaster) {
    if (!source || typeof source !== 'object')
      throw new TypeError('invalid image raster')
    const data = source.data,
      w = source.width,
      h = source.height,
      s = source.stride,
      f = source.format ?? 'rgb',
      b = source.bits ?? 8,
      e = source.endian ?? 'little',
      c = color(source.colorSpace)
    const width = integer(w, 1, 0x7fffffff),
      height = integer(h, 1, 0x7fffffff),
      format = kind(f),
      bits = depth(b),
      endian = order(e)
    const row = width * [1, 3, 4][kinds[format]]! * (bits / 8),
      stride = integer(s ?? row, row, Number.MAX_SAFE_INTEGER)
    const bytes = actual(data),
      sourceView = description(
        bytes,
        width,
        height,
        format,
        bits,
        endian,
        stride,
      )
    const info = Object.freeze({
      width,
      height,
      format,
      bits,
      endian,
      stride: row,
    })
    return new CapturedImage(copied(sourceView, info), info, c)
  }
  /** @internal Only Frame's fresh owned RGB copy may be adopted. */
  static [captureAdmission](
    bytes: Uint8Array,
    width: number,
    height: number,
    bits: 8 | 16,
    metadata: Metadata,
    space: StreamColorSpace,
  ) {
    if (bytes.byteLength > 256 * 1024 * 1024)
      throw new RangeError('image pixels exceed 256 MiB')
    return new CapturedImage(
      bytes,
      Object.freeze({
        width,
        height,
        bits,
        format: 'rgb',
        endian: 'little',
        stride: width * 3 * (bits / 8),
      }),
      color(space),
      Object.freeze({
        ...metadata,
        crop: Object.freeze({ ...metadata.crop }),
      }),
    )
  }
  private open() {
    if (!this.pixels) throw new CameraError(-5, 'closed image')
    return this.pixels
  }
  private descriptor() {
    return description(
      actual(this.open()),
      this.width,
      this.height,
      this.format,
      this.bits,
      this.endian,
      this.stride,
    )
  }
  get width() {
    return this.info.width
  }
  get height() {
    return this.info.height
  }
  get format() {
    return this.info.format
  }
  get bits() {
    return this.info.bits
  }
  get endian() {
    return this.info.endian
  }
  get stride() {
    return this.info.stride
  }
  get closed() {
    return !this.pixels
  }
  get colorSpace() {
    return this.sourceColor?.value
  }
  copyPixels() {
    return this.open().slice()
  }
  getPixel16(
    x: number,
    y: number,
  ): readonly [number, number, number, number] {
    integer(x, 0, this.width - 1)
    integer(y, 0, this.height - 1)
    const source = this.descriptor(),
      out = new Uint16Array(4)
    check(n.zc_raster_pixel16(ptr(source.data), x, y, ptr(out)))
    return [out[0]!, out[1]!, out[2]!, out[3]!]
  }
  getPixel(
    x: number,
    y: number,
  ): readonly [number, number, number, number] {
    return this.getPixel16(x, y).map((value) => value >> 8) as [
      number,
      number,
      number,
      number,
    ]
  }
  clone() {
    return this.convert()
  }
  resize(width: number, height: number, options: ImageResizeOptions = {}) {
    integer(width, 1, 0x7fffffff)
    integer(height, 1, 0x7fffffff)
    const code = imageResampleCode(options.resample ?? 'bicubic'),
      source = this.descriptor()
    const bytes = resizeNativeRaster(source.data, width, height, code)
    return new CapturedImage(
      bytes,
      Object.freeze({
        ...this.info,
        width,
        height,
        stride: width * [1, 3, 4][kinds[this.format]]! * (this.bits / 8),
      }),
      this.sourceColor,
      this.sourceMetadata,
    )
  }
  convert(
    options: {
      format?: RasterFormat
      bits?: 8 | 16
      endian?: RasterEndian
    } = {},
  ) {
    const f = options.format ?? this.format,
      b = options.bits ?? this.bits,
      e = options.endian ?? this.endian
    const format = kind(f),
      bits = depth(b),
      endian = order(e),
      info = Object.freeze({
        ...this.info,
        format,
        bits,
        endian,
        stride: this.width * [1, 3, 4][kinds[format]]! * (bits / 8),
      })
    return new CapturedImage(
      copied(this.descriptor(), info),
      info,
      format === 'gray' ? undefined : this.sourceColor,
      this.sourceMetadata,
    )
  }
  crop(x: number, y: number, width: number, height: number) {
    integer(x, 0, this.width)
    integer(y, 0, this.height)
    integer(width, 1, this.width)
    integer(height, 1, this.height)
    const source = this.descriptor(),
      size = new BigUint64Array(1)
    check(
      n.zc_raster_crop(
        ptr(source.data),
        x,
        y,
        width,
        height,
        null,
        0n,
        ptr(size),
      ),
    )
    const bytes = storage(Number(size[0]))
    check(
      n.zc_raster_crop(
        ptr(source.data),
        x,
        y,
        width,
        height,
        ptr(bytes),
        BigInt(bytes.byteLength),
        ptr(size),
      ),
    )
    return new CapturedImage(
      bytes,
      Object.freeze({
        ...this.info,
        width,
        height,
        stride: width * [1, 3, 4][kinds[this.format]]! * (this.bits / 8),
      }),
      this.sourceColor,
      this.sourceMetadata,
    )
  }
  private prepared(options: ImageObjectOptions, path?: string) {
    const result = prepareImage(options, path, false)
    if (result.stream !== 0 || result.format === 6)
      throw new CameraError(-8, 'image objects have processed pixels')
    if (result.exif?.captureMetadata)
      throw new CameraError(
        -8,
        'image object Exif must be explicit; use request encoding for capture-derived Exif',
      )
    this.open()
    return result
  }
  encode(options: ImageObjectOptions = {}) {
    const prepared = this.prepared(options),
      source = this.descriptor(),
      p = imageProfileDescriptor(prepared.profile),
      e = imageExifDescriptor(prepared.exif),
      out = outPointer()
    check(
      n.zc_raster_encode(
        ptr(source.data),
        ptr(prepared.options),
        p ? ptr(p) : null,
        e ? ptr(e) : null,
        this.sourceColor ? ptr(this.sourceColor.bytes) : null,
        ptr(out),
      ),
    )
    const blob = handle(out)
    try {
      const size = new BigUint64Array(1)
      check(n.zc_image_blob_copy(blob, null, 0n, ptr(size)))
      const data = storage(Number(size[0]))
      check(
        n.zc_image_blob_copy(
          blob,
          ptr(data),
          BigInt(data.byteLength),
          ptr(size),
        ),
      )
      return data
    } finally {
      n.zc_image_blob_close(blob)
    }
  }
  save(path: string, options: ImageObjectOptions = {}) {
    if (typeof path !== 'string')
      throw new TypeError('image path must be a string')
    const prepared = this.prepared(options, path),
      source = this.descriptor(),
      p = imageProfileDescriptor(prepared.profile),
      e = imageExifDescriptor(prepared.exif)
    check(
      n.zc_raster_save(
        ptr(source.data),
        ptr(prepared.path!),
        ptr(prepared.options),
        p ? ptr(p) : null,
        e ? ptr(e) : null,
        this.sourceColor ? ptr(this.sourceColor.bytes) : null,
      ),
    )
  }
  saveAsync(
    path: string,
    options: ImageObjectOptions & JobOptions<void> = {},
  ) {
    if (typeof path !== 'string')
      throw new TypeError('image path must be a string')
    const prepared = this.prepared(options, path),
      admitted = snapshotJobOptions(options, 30000),
      source = this.descriptor(),
      p = imageProfileDescriptor(prepared.profile),
      e = imageExifDescriptor(prepared.exif),
      deadline = Date.now() + (admitted.timeoutMs ?? Infinity)
    const job = new BunJob<void>(
      async (current) => {
        current.check()
        await withStagedImageFile(prepared.path, current, async (file) => {
          await Promise.resolve()
          current.check()
          check(
            n.zc_image_file_prepare_raster(
              file!.handle!,
              ptr(source.data),
              ptr(prepared.options),
              p ? ptr(p) : null,
              e ? ptr(e) : null,
              this.sourceColor ? ptr(this.sourceColor.bytes) : null,
            ),
          )
          await file!.publish(current, deadline)
          current.seal()
        })
      },
      () => {},
      admitted,
    )
    void job.start()
    return job
  }
  close() {
    this.pixels = undefined
  }
  [Symbol.dispose]() {
    this.close()
  }
}
/** @internal Frame passes a fresh owned native copy, never borrowed pixels. */
export function adoptCapturedImage(
  bytes: Uint8Array,
  width: number,
  height: number,
  bits: 8 | 16,
  metadata: Metadata,
  space: StreamColorSpace,
) {
  return CapturedImage[captureAdmission](
    bytes,
    width,
    height,
    bits,
    metadata,
    space,
  )
}

/** @internal The native copy or worker transfer owns all pixels independently. */
export function adoptImageSnapshot(image: ImageSnapshot) {
  return adoptCapturedImage(
    image.data,
    image.width,
    image.height,
    image.bits,
    image.metadata,
    image.colorSpace,
  )
}
