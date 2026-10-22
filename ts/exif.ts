import {
  native as n,
  storage,
  ptr,
  view,
  check,
  outPointer,
  handle,
} from './ffi'
export type ExifRational = readonly [number, number]
export type ExifGroup =
  'image' | 'exif' | 'gps' | 'interoperability' | 'thumbnail'
export type ExifType =
  | 'byte'
  | 'ascii'
  | 'short'
  | 'long'
  | 'rational'
  | 'sbyte'
  | 'undefined'
  | 'sshort'
  | 'slong'
  | 'srational'
  | 'float'
  | 'double'
export interface ExifTag {
  group: ExifGroup
  tag: number
  type: ExifType
  /** Numeric field values, fractions, ASCII text, or prepacked little-endian bytes. */
  value:
    number | string | Uint8Array | readonly number[] | readonly ExifRational[]
}
export interface ExifOptions {
  /** Fill missing fields using this request. Defaults to true. */
  captureMetadata?: boolean
  /** Complete caller Exif. May be combined with captureMetadata, but not typed fields. */
  raw?: Uint8Array
  make?: string
  model?: string
  software?: string
  artist?: string
  copyright?: string
  description?: string
  lensMake?: string
  lensModel?: string
  dateTime?: string
  dateTimeOriginal?: string
  dateTimeDigitized?: string
  offsetTime?: string
  offsetTimeOriginal?: string
  offsetTimeDigitized?: string
  orientation?: number
  exposureTime?: ExifRational
  fNumber?: ExifRational
  exposureBias?: ExifRational
  focalLength?: ExifRational
  iso?: number
  gps?: {
    latitude?: number
    longitude?: number
    altitude?: number
    dateStamp?: string
    timestamp?: readonly [ExifRational, ExifRational, ExifRational]
  }
  thumbnail?: Uint8Array
  /** Duplicate tags (including typed fields) reject; IFD pointers are generated. */
  tags?: readonly ExifTag[]
}
export type ImageExif = boolean | Uint8Array | ExifOptions
export interface PreparedExif {
  captureMetadata: boolean
  data?: Uint8Array
}
const groups: Record<ExifGroup, number> = {
  image: 0,
  exif: 1,
  gps: 2,
  interoperability: 3,
  thumbnail: 4,
}
const types: Record<ExifType, number> = {
  byte: 1,
  ascii: 2,
  short: 3,
  long: 4,
  rational: 5,
  sbyte: 6,
  undefined: 7,
  sshort: 8,
  slong: 9,
  srational: 10,
  float: 11,
  double: 12,
}
const widths = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]
const limit = 16 * 1024 * 1024
interface Field {
  group: number
  tag: number
  type: number
  count: number
  data: Uint8Array
}
function integer(value: unknown, min: number, max: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new RangeError('Exif integer is outside its field range')
  return value
}
function copyBytes(value: unknown, label: string) {
  if (!(value instanceof Uint8Array))
    throw new TypeError(`${label} must be Uint8Array`)
  if (value.byteLength === 0 || value.byteLength > limit)
    throw new RangeError(`${label} size must be 1..16 MiB`)
  return new Uint8Array(value)
}
function ascii(value: unknown) {
  if (typeof value !== 'string' || value.length >= limit)
    throw new TypeError('Exif text must be an ASCII string')
  const data = new Uint8Array(value.length + 1)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0 || code > 127)
      throw new TypeError('Exif text must be ASCII without embedded NUL')
    data[i] = code
  }
  return data
}
function field(
  group: ExifGroup,
  tag: number,
  type: ExifType,
  value: ExifTag['value'],
): Field {
  if (
    typeof group !== 'string' ||
    !Object.hasOwn(groups, group) ||
    typeof type !== 'string' ||
    !Object.hasOwn(types, type)
  )
    throw new TypeError('invalid Exif group or type')
  integer(tag, 0, 65535)
  const code = types[type],
    width = widths[code]!
  if (value instanceof Uint8Array) {
    if (value.byteLength > limit || value.byteLength % width !== 0)
      throw new RangeError('invalid Exif field byte length')
    const data = new Uint8Array(value)
    return {
      group: groups[group],
      tag,
      type: code,
      count: data.length / width,
      data,
    }
  }
  if (type === 'ascii') {
    const data = ascii(value)
    return { group: groups[group], tag, type: code, count: data.length, data }
  }
  if (typeof value === 'string')
    throw new TypeError('Exif numeric field cannot contain text')
  const rational = type === 'rational' || type === 'srational'
  let values: readonly unknown[]
  if (rational) {
    if (!Array.isArray(value))
      throw new TypeError('Exif rational must be a numerator/denominator pair')
    values =
      value.length === 2 && typeof value[0] === 'number' ? [value] : value
  } else values = Array.isArray(value) ? value : [value]
  if (values.length > Math.floor(limit / width))
    throw new RangeError('Exif field is too large')
  const data = new Uint8Array(values.length * width),
    d = view(data)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    const at = i * width
    if (rational) {
      if (!Array.isArray(v) || v.length !== 2)
        throw new TypeError('invalid Exif rational')
      const signed = type === 'srational',
        min = signed ? -2147483648 : 0,
        max = signed ? 2147483647 : 0xffffffff
      const numerator = integer(v[0], min, max),
        denominator = integer(v[1], min, max)
      if (denominator === 0)
        throw new RangeError('Exif denominator must be nonzero')
      if (signed) {
        d.setInt32(at, numerator, true)
        d.setInt32(at + 4, denominator, true)
      } else {
        d.setUint32(at, numerator, true)
        d.setUint32(at + 4, denominator, true)
      }
    } else if (type === 'float' || type === 'double') {
      if (
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        (type === 'float' && !Number.isFinite(Math.fround(v)))
      )
        throw new RangeError('invalid Exif floating value')
      if (type === 'float') d.setFloat32(at, v, true)
      else d.setFloat64(at, v, true)
    } else {
      const signed = type === 'sbyte' || type === 'sshort' || type === 'slong',
        bits = width * 8
      const num = integer(
        v,
        signed ? -(2 ** (bits - 1)) : 0,
        signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1,
      )
      if (width === 1) {
        if (signed) d.setInt8(at, num)
        else d.setUint8(at, num)
      } else if (width === 2) {
        if (signed) d.setInt16(at, num, true)
        else d.setUint16(at, num, true)
      } else {
        if (signed) d.setInt32(at, num, true)
        else d.setUint32(at, num, true)
      }
    }
  }
  return { group: groups[group], tag, type: code, count: values.length, data }
}
function scalarSpecial(
  group: number,
  tag: number,
  type: number,
  value: number,
): Field {
  const data = new Uint8Array(type === 256 ? 8 : 4),
    d = view(data)
  if (type === 256) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new RangeError('invalid Exif GPS value')
    d.setFloat64(0, value, true)
  } else d.setUint32(0, integer(value, 1, 0xffffffff), true)
  return { group, tag, type, count: 1, data }
}
function encode(fields: Field[], thumbnail?: Uint8Array) {
  if (fields.length > 4090) throw new RangeError('too many Exif fields')
  if (fields.reduce((total, f) => total + f.data.length, 0) > limit)
    throw new RangeError('Exif fields exceed 16 MiB')
  const descriptors = storage(fields.length * 32),
    d = view(descriptors)
  fields.forEach((f, i) => {
    const at = i * 32
    d.setUint16(at, f.group, true)
    d.setUint16(at + 2, f.tag, true)
    d.setUint16(at + 4, f.type, true)
    d.setUint32(at + 8, f.count, true)
    d.setBigUint64(at + 16, BigInt(f.data.length ? ptr(f.data) : 0), true)
    d.setBigUint64(at + 24, BigInt(f.data.length), true)
  })
  const out = outPointer()
  check(
    n.zc_exif_build(
      fields.length ? ptr(descriptors) : null,
      fields.length,
      thumbnail ? ptr(thumbnail) : null,
      BigInt(thumbnail?.length ?? 0),
      ptr(out),
    ),
  )
  const blob = handle(out)
  try {
    const length = new BigUint64Array(1)
    check(n.zc_image_blob_copy(blob, null, 0n, ptr(length)))
    if (length[0] > BigInt(limit)) throw new RangeError('Exif exceeds 16 MiB')
    const bytes = new Uint8Array(Number(length[0]))
    check(n.zc_image_blob_copy(blob, ptr(bytes), length[0], ptr(length)))
    return bytes
  } finally {
    n.zc_image_blob_close(blob)
  }
}
export function prepareExif(
  source: ImageExif | undefined,
  format: number,
): PreparedExif | undefined {
  const input = source === undefined ? format === 1 : source
  if (input === false) return { captureMetadata: false }
  if (input === true) return { captureMetadata: true }
  if (input instanceof Uint8Array)
    return { captureMetadata: false, data: copyBytes(input, 'Exif') }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('invalid Exif options')
  // Read each documented user property once, before native calls/admission.
  const options = {
    captureMetadata: input.captureMetadata,
    raw: input.raw,
    make: input.make,
    model: input.model,
    software: input.software,
    artist: input.artist,
    copyright: input.copyright,
    description: input.description,
    lensMake: input.lensMake,
    lensModel: input.lensModel,
    dateTime: input.dateTime,
    dateTimeOriginal: input.dateTimeOriginal,
    dateTimeDigitized: input.dateTimeDigitized,
    offsetTime: input.offsetTime,
    offsetTimeOriginal: input.offsetTimeOriginal,
    offsetTimeDigitized: input.offsetTimeDigitized,
    orientation: input.orientation,
    exposureTime: input.exposureTime,
    fNumber: input.fNumber,
    exposureBias: input.exposureBias,
    focalLength: input.focalLength,
    iso: input.iso,
    gps: input.gps,
    thumbnail: input.thumbnail,
    tags: input.tags,
  }
  const captureMetadata = options.captureMetadata ?? true
  if (typeof captureMetadata !== 'boolean')
    throw new TypeError('Exif captureMetadata must be boolean')
  const fields: Field[] = []
  let fieldBytes = 0
  const add = (f: Field) => {
    if (fields.length >= 4090 || f.data.length > limit - fieldBytes)
      throw new RangeError('Exif fields exceed bounds')
    fieldBytes += f.data.length
    fields.push(f)
  }
  for (const [name, group, tag] of [
    ['make', 'image', 0x010f],
    ['model', 'image', 0x0110],
    ['software', 'image', 0x0131],
    ['artist', 'image', 0x013b],
    ['copyright', 'image', 0x8298],
    ['description', 'image', 0x010e],
    ['lensMake', 'exif', 0xa433],
    ['lensModel', 'exif', 0xa434],
    ['dateTime', 'image', 0x0132],
    ['dateTimeOriginal', 'exif', 0x9003],
    ['dateTimeDigitized', 'exif', 0x9004],
    ['offsetTime', 'exif', 0x9010],
    ['offsetTimeOriginal', 'exif', 0x9011],
    ['offsetTimeDigitized', 'exif', 0x9012],
  ] as const)
    if (options[name] !== undefined)
      add(field(group, tag, 'ascii', options[name]!))
  if (options.orientation !== undefined)
    add(field('image', 0x0112, 'short', integer(options.orientation, 1, 8)))
  for (const [name, tag, type] of [
    ['exposureTime', 0x829a, 'rational'],
    ['fNumber', 0x829d, 'rational'],
    ['focalLength', 0x920a, 'rational'],
    ['exposureBias', 0x9204, 'srational'],
  ] as const)
    if (options[name] !== undefined)
      add(field('exif', tag, type, options[name]!))
  if (options.iso !== undefined) add(scalarSpecial(1, 0x8833, 257, options.iso))
  if (options.gps !== undefined) {
    const g = options.gps
    if (!g || typeof g !== 'object' || Array.isArray(g))
      throw new TypeError('invalid Exif GPS options')
    const gps = {
      latitude: g.latitude,
      longitude: g.longitude,
      altitude: g.altitude,
      dateStamp: g.dateStamp,
      timestamp: g.timestamp,
    }
    if (gps.latitude !== undefined) add(scalarSpecial(2, 2, 256, gps.latitude))
    if (gps.longitude !== undefined)
      add(scalarSpecial(2, 4, 256, gps.longitude))
    if (gps.altitude !== undefined) add(scalarSpecial(2, 6, 256, gps.altitude))
    if (gps.dateStamp !== undefined)
      add(field('gps', 29, 'ascii', gps.dateStamp))
    if (gps.timestamp !== undefined)
      add(field('gps', 7, 'rational', gps.timestamp))
  }
  if (options.tags !== undefined) {
    if (!Array.isArray(options.tags) || options.tags.length > 4090)
      throw new RangeError('invalid Exif tags')
    for (const tag of options.tags) {
      if (!tag || typeof tag !== 'object')
        throw new TypeError('invalid Exif tag')
      const snapshot = {
        group: tag.group,
        tag: tag.tag,
        type: tag.type,
        value: tag.value,
      }
      add(field(snapshot.group, snapshot.tag, snapshot.type, snapshot.value))
    }
  }
  const thumbnail =
    options.thumbnail === undefined
      ? undefined
      : copyBytes(options.thumbnail, 'Exif thumbnail')
  if (options.raw !== undefined) {
    if (fields.length || thumbnail)
      throw new TypeError(
        'raw Exif cannot be combined with typed fields or thumbnail',
      )
    return { captureMetadata, data: copyBytes(options.raw, 'Exif') }
  }
  return fields.length || thumbnail
    ? { captureMetadata, data: encode(fields, thumbnail) }
    : { captureMetadata }
}
export function imageExifDescriptor(exif?: PreparedExif) {
  if (!exif) return undefined
  const data = storage(24),
    d = view(data)
  d.setUint32(0, 24, true)
  d.setUint32(4, exif.captureMetadata ? 1 : 0, true)
  if (exif.data) {
    d.setBigUint64(8, BigInt(ptr(exif.data)), true)
    d.setBigUint64(16, BigInt(exif.data.length), true)
  }
  return data
}
