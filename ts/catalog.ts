import {
  native as n,
  ptr,
  check,
  handle,
  outPointer,
  type Pointer,
} from './ffi'

export type CatalogKind =
  | 'discovery'
  | 'properties'
  | 'controls'
  | 'metadata'
  | 'control-state'
  | 'control-update'
export type ValueKind =
  | 'none'
  | 'boolean'
  | 'byte'
  | 'int32'
  | 'int64'
  | 'float32'
  | 'string'
  | 'rectangle'
  | 'size'
  | 'uint16'
  | 'uint32'
  | 'point'
  | 'opaque'
export type Rectangle = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>
export type Size = Readonly<{ width: number; height: number }>
export type Point = Readonly<{ x: number; y: number }>
export type CatalogScalar =
  boolean | number | bigint | string | Rectangle | Size | Point | null
export interface CatalogValue {
  readonly role:
    | 'current'
    | 'minimum'
    | 'maximum'
    | 'default'
    | 'choice'
    | 'enumerator'
    | number
  readonly kind: ValueKind
  readonly nativeType: number
  readonly isArray: boolean
  readonly littleEndian: boolean
  readonly count: number
  readonly label: string
  /** Exact owned bytes, including unknown native types and string encodings. */
  readonly bytes: Uint8Array
  readonly value: CatalogScalar | readonly CatalogScalar[] | Uint8Array
}
export interface CatalogRecord {
  readonly group: number
  readonly id: number
  /** Existing zig-camera Control ID, or zero if no convenience mapping exists. */
  readonly appId: number
  readonly nativeType: number
  readonly kind: ValueKind
  readonly name: string
  readonly vendor?: string
  readonly input?: boolean
  readonly output?: boolean
  readonly isArray?: boolean
  /** Zero for scalars, null for dynamic arrays; undefined with old headers. */
  readonly extent?: number | null
  readonly enumeratorsKnown: boolean
  readonly flags: number
  readonly values: readonly CatalogValue[]
}
export interface TypedCatalog {
  readonly kind: CatalogKind
  readonly records: readonly CatalogRecord[]
}
export interface CameraDescriptor {
  readonly index: number
  readonly id: string
  readonly backend: 'libcamera' | 'synthetic'
  readonly properties: readonly CatalogRecord[]
}
const kinds: Record<number, ValueKind> = {
  0: 'none',
  1: 'boolean',
  2: 'byte',
  3: 'int32',
  4: 'int64',
  5: 'float32',
  6: 'string',
  7: 'rectangle',
  8: 'size',
  9: 'uint16',
  10: 'uint32',
  11: 'point',
  255: 'opaque',
}
const widths = [0, 1, 1, 4, 8, 4, 1, 16, 8, 2, 4, 8]
const roles = [
  'current',
  'minimum',
  'maximum',
  'default',
  'choice',
  'enumerator',
] as const
const catalogKinds = [
  'discovery',
  'properties',
  'controls',
  'metadata',
  'control-state',
  'control-update',
] as const
const utf8 = new TextDecoder('utf-8', { fatal: true })
const text = new TextDecoder()
const limit = 4 * 1024 * 1024
function invalid(): never {
  throw new Error('invalid typed catalog')
}
function value(
  data: Uint8Array,
  kind: number,
  count: number,
  flags: number,
): CatalogValue['value'] {
  if (kind === 255) return data
  const width = widths[kind]
  if (width === undefined || data.length !== width * count) invalid()
  if (kind === 0) {
    if (count !== 0) invalid()
    return null
  }
  if (kind === 6) return text.decode(data)
  if (!(flags & 1) && count !== 1) invalid()
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength),
    le = !!(flags & 2)
  const items: CatalogScalar[] = []
  for (let i = 0; i < count; i++) {
    const p = i * width
    switch (kind) {
      case 1:
        if (v.getUint8(p) > 1) invalid()
        items.push(!!v.getUint8(p))
        break
      case 2:
        items.push(v.getUint8(p))
        break
      case 3:
        items.push(v.getInt32(p, le))
        break
      case 4:
        items.push(v.getBigInt64(p, le))
        break
      case 5:
        items.push(v.getFloat32(p, le))
        break
      case 7:
        items.push(
          Object.freeze({
            x: v.getInt32(p, le),
            y: v.getInt32(p + 4, le),
            width: v.getUint32(p + 8, le),
            height: v.getUint32(p + 12, le),
          }),
        )
        break
      case 8:
        items.push(
          Object.freeze({
            width: v.getUint32(p, le),
            height: v.getUint32(p + 4, le),
          }),
        )
        break
      case 9:
        items.push(v.getUint16(p, le))
        break
      case 10:
        items.push(v.getUint32(p, le))
        break
      case 11:
        items.push(
          Object.freeze({ x: v.getInt32(p, le), y: v.getInt32(p + 4, le) }),
        )
        break
      default:
        invalid()
    }
  }
  return flags & 1 ? Object.freeze(items) : items[0]
}
/** Validate all lengths/counts before decoding; own every payload independently. */
export function decodeCatalog(bytes: Uint8Array): TypedCatalog {
  if (bytes.length < 16 || bytes.length > limit) invalid()
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u = (p: number) => v.getUint32(p, true)
  if (text.decode(bytes.subarray(0, 4)) !== 'HCAT' || u(4) !== 1) invalid()
  const kind = catalogKinds[u(8) - 1]
  if (!kind || u(12) > (bytes.length - 16) / 44) invalid()
  const records: CatalogRecord[] = []
  let p = 16
  for (let i = 0; i < u(12); i++) {
    if (bytes.length - p < 44) invalid()
    const size = u(p),
      end = p + size,
      nameLen = u(p + 32),
      vendorLen = u(p + 36),
      count = u(p + 40),
      type = u(p + 28),
      flags = u(p + 20)
    if (
      size < 44 ||
      end > bytes.length ||
      nameLen + vendorLen > size - 44 ||
      !kinds[type]
    )
      invalid()
    const start = p + 44
    const name = utf8.decode(bytes.subarray(start, start + nameLen)),
      vendor = utf8.decode(
        bytes.subarray(start + nameLen, start + nameLen + vendorLen),
      )
    let q = start + nameLen + vendorLen
    if (count > (end - q) / 28) invalid()
    const values: CatalogValue[] = []
    for (let j = 0; j < count; j++) {
      if (end - q < 28) invalid()
      const length = u(q),
        labelLen = u(q + 24),
        k = u(q + 8),
        f = u(q + 16),
        elements = u(q + 20),
        role = u(q + 4)
      if (
        length < 28 ||
        length > end - q ||
        labelLen > length - 28 ||
        !kinds[k]
      )
        invalid()
      const label = utf8.decode(bytes.subarray(q + 28, q + 28 + labelLen))
      const data = bytes.slice(q + 28 + labelLen, q + length)
      values.push(
        Object.freeze({
          role: roles[role] ?? role,
          kind: kinds[k],
          nativeType: u(q + 12),
          isArray: !!(f & 1),
          littleEndian: !!(f & 2),
          count: elements,
          label,
          bytes: data,
          value: value(data, k, elements, f),
        }),
      )
      q += length
    }
    if (q !== end) invalid()
    records.push(
      Object.freeze({
        group: u(p + 4),
        id: u(p + 8),
        appId: u(p + 12),
        nativeType: u(p + 16),
        flags,
        kind: kinds[type],
        name,
        vendor: flags & 32 ? vendor : undefined,
        input: flags & 8 ? !!(flags & 1) : undefined,
        output: flags & 8 ? !!(flags & 2) : undefined,
        isArray: flags & 16 ? !!(flags & 4) : undefined,
        extent:
          flags & 16
            ? u(p + 24) === 0xffffffff
              ? null
              : u(p + 24)
            : undefined,
        enumeratorsKnown: !!(flags & 64),
        values: Object.freeze(values),
      }),
    )
    p = end
  }
  if (p !== bytes.length) invalid()
  records.sort(
    (a, b) => a.group - b.group || a.id - b.id || a.name.localeCompare(b.name),
  )
  return Object.freeze({ kind, records: Object.freeze(records) })
}
/** @internal The native snapshot always closes even if allocation/decoding fails. */
export function readCatalog(open: (out: Pointer) => number): TypedCatalog {
  const out = outPointer()
  check(open(ptr(out)), 'catalog snapshot')
  const owned = handle(out)
  try {
    const length = new BigUint64Array(1)
    check(n.zc_catalog_copy(owned, null, 0n, ptr(length)))
    if (length[0] > BigInt(limit)) invalid()
    const bytes = new Uint8Array(Number(length[0]))
    check(
      n.zc_catalog_copy(owned, ptr(bytes), BigInt(bytes.length), ptr(length)),
    )
    if (length[0] !== BigInt(bytes.length)) invalid()
    return decodeCatalog(bytes)
  } finally {
    n.zc_catalog_close(owned)
  }
}
export function cameraDescriptors(
  catalog: TypedCatalog,
  simulate: boolean,
): readonly CameraDescriptor[] {
  if (catalog.kind !== 'discovery') invalid()
  const groups = new Map<number, CatalogRecord[]>()
  for (const r of catalog.records) {
    const records = groups.get(r.group) ?? []
    records.push(r)
    groups.set(r.group, records)
  }
  return Object.freeze(
    [...groups].map(([index, records]) => {
      const ids = records.filter((r) => r.name === 'CameraId' && r.id === 0)
      const id = ids[0]?.values[0]?.value
      if (ids.length !== 1 || typeof id !== 'string') invalid()
      return Object.freeze({
        index,
        id,
        backend: simulate ? ('synthetic' as const) : ('libcamera' as const),
        properties: Object.freeze(records.filter((r) => r !== ids[0])),
      })
    }),
  )
}
