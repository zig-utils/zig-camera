import { ptr, check, storage, type Pointer } from './ffi'
import { decodeCatalog, type TypedCatalog, type CatalogRecord, type ValueKind } from './catalog'
import { processedFormatName } from './processed-format'

const base = 0x5a430000, limit = 64 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })
function invalid(): never { throw new Error('invalid request configuration') }

/** @internal Two-pass copy from an immutable, caller-owned native snapshot. */
export function readConfigurationCatalog(copy: (data: Pointer | null, capacity: bigint, length: Pointer) => number) {
  const size = new BigUint64Array(1)
  check(copy(null, 0n, ptr(size)))
  if (size[0] < 16n || size[0] > BigInt(limit)) invalid()
  const bytes = storage(Number(size[0])), expected = size[0]
  check(copy(ptr(bytes), expected, ptr(size)))
  if (size[0] !== expected) invalid()
  return decodeCatalog(bytes)
}

/** @internal Strict schema reader; the catalog API preserves unknown extensions. */
export function decodeFrameConfiguration(catalog: TypedCatalog) {
  if (catalog.kind !== 'configuration') invalid()
  const records = new Map<string, CatalogRecord>()
  for (const record of catalog.records) {
    if (record.vendor !== 'zig-camera' || record.group < base || record.group > base + 12) continue
    const key = `${record.group}:${record.id}`
    if (records.has(key)) invalid()
    records.set(key, record)
  }
  function get(group: number, id: number, name: string, kind: ValueKind) {
    const record = records.get(`${base + group}:${id}`)
    if (!record || record.name !== `Config.${name}` || record.kind !== kind || record.input !== false || record.output !== true || record.values.length !== 1) invalid()
    const value = record.values[0]!
    if (value.role !== 'current' || value.kind !== kind || !value.littleEndian || value.isArray !== (kind === 'string') || record.isArray !== (kind === 'string') || (kind !== 'string' && (value.count !== 1 || record.extent !== 0))) invalid()
    if (kind === 'string') {
      if (record.extent !== value.count) invalid()
      return utf8.decode(value.bytes)
    }
    return value.value
  }
  const uint = (g: number, id: number, name: string) => {
    const value = get(g, id, name, 'uint32')
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) invalid()
    return value
  }
  const bool = (g: number, id: number, name: string) => {
    const value = get(g, id, name, 'boolean')
    if (typeof value !== 'boolean') invalid()
    return value
  }
  const float = (id: number, name: string) => {
    const value = get(1, id, name, 'float32')
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
    return value
  }
  const string = (g: number, id: number, name: string) => {
    const value = get(g, id, name, 'string')
    if (typeof value !== 'string') invalid()
    return value
  }
  function choice<const T extends readonly unknown[]>(value: number, choices: T): T[number] {
    if (value >= choices.length) invalid()
    return choices[value]!
  }
  const policy = (value: number) => choice(value, ['fifo', 'latest'] as const)
  const orientation = (value: number) => {
    if (value < 1 || value > 8) invalid()
    return value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  }
  function color(g: number, id: number) {
    return Object.freeze({
      present: bool(g, id, 'ColorPresent'),
      primaries: choice(uint(g, id + 1, 'Primaries'), ['unknown', 'raw', 'smpte170m', 'rec709', 'rec2020'] as const),
      transfer: choice(uint(g, id + 2, 'Transfer'), ['unknown', 'linear', 'srgb', 'rec709'] as const),
      ycbcrEncoding: choice(uint(g, id + 3, 'YCbCrEncoding'), ['unknown', 'none', 'rec601', 'rec709', 'rec2020'] as const),
      range: choice(uint(g, id + 4, 'Range'), ['unknown', 'full', 'limited'] as const),
    })
  }
  const sensor = (g: number, id: number) => Object.freeze({ width: uint(g, id, 'SensorWidth'), height: uint(g, id + 1, 'SensorHeight'), bitDepth: uint(g, id + 2, 'SensorBitDepth') })
  function stream(g: number) {
    if (![...records.values()].some(r => r.group === base + g)) return undefined
    const width = uint(g, 1, 'Width'), height = uint(g, 2, 'Height'), stride = uint(g, 3, 'Stride'), planeCount = uint(g, 4, 'PlaneCount'), frameSize = get(g, 6, 'FrameSize', 'int64'), format = string(g, 5, 'Format')
    if (!width || !height || !stride || !planeCount || planeCount > 4 || !format || typeof frameSize !== 'bigint' || frameSize <= 0n) invalid()
    return Object.freeze({ width, height, stride, planeCount, format, frameSize, colorSpace: color(g, 7) })
  }
  if (uint(0, 1, 'SchemaVersion') !== 1) invalid()
  const streams = Object.freeze({ main: stream(10), raw: stream(11), lores: stream(12) })
  if (!streams.main) invalid()
  return Object.freeze({
    schemaVersion: 1 as const,
    cameraId: string(0, 2, 'CameraId'),
    backend: choice(uint(0, 3, 'Backend'), ['synthetic', 'libcamera'] as const),
    buffers: uint(0, 4, 'BufferCount'),
    policy: policy(uint(0, 5, 'QueuePolicy')),
    orientation: Object.freeze({ requested: orientation(uint(0, 6, 'RequestedOrientation')), actual: orientation(uint(0, 7, 'Orientation')), adjusted: bool(0, 8, 'OrientationAdjusted'), strict: bool(0, 9, 'StrictOrientation') }),
    sensor: sensor(0, 10),
    /** Startup hints, distinct from applied per-request runtime controls. */
    requested: Object.freeze({
      width: uint(1, 1, 'Width'), height: uint(1, 2, 'Height'), buffers: uint(1, 3, 'BufferCount'), cameraIndex: uint(1, 4, 'CameraIndex'), policy: policy(uint(1, 5, 'QueuePolicy')),
      exposureUs: uint(1, 6, 'ExposureTime'), frameDurationUs: uint(1, 7, 'FrameDuration'), analogueGain: float(8, 'AnalogueGain'), lensPosition: float(9, 'LensPosition'), raw: bool(1, 10, 'Raw'), rawFormat: string(1, 11, 'RawFormat'),
      role: choice(uint(1, 12, 'Role'), ['still', 'preview', 'video'] as const), unpackedRaw: bool(1, 13, 'UnpackedRaw'), noiseReduction: uint(1, 14, 'NoiseReduction'), sensor: sensor(1, 15),
      lores: Object.freeze({ width: uint(1, 18, 'LoresWidth'), height: uint(1, 19, 'LoresHeight'), format: processedFormatName(uint(1, 20, 'LoresFormat')) }),
      format: processedFormatName(uint(1, 21, 'MainFormat')), colorSpace: color(1, 22), strictColor: bool(1, 27, 'StrictColor'),
    }),
    streams,
  })
}
export type FrameConfiguration = ReturnType<typeof decodeFrameConfiguration>
