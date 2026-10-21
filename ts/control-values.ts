import type {
  TypedCatalog,
  CatalogRecord,
  Rectangle,
  Size,
  Point,
} from './catalog'
export type NativeControl = {
  id: number
  replay?: boolean
  name?: string
  vendor?: string
} & (
  | { kind: 'boolean'; value: boolean | readonly boolean[] }
  | {
      kind: 'byte' | 'int32' | 'uint16' | 'uint32' | 'float32'
      value:
        | number
        | readonly number[]
        | Uint8Array
        | Uint16Array
        | Uint32Array
        | Int32Array
        | Float32Array
    }
  | { kind: 'int64'; value: bigint | readonly bigint[] | BigInt64Array }
  | { kind: 'string'; value: string }
  | { kind: 'rectangle'; value: Rectangle | readonly Rectangle[] }
  | { kind: 'size'; value: Size | readonly Size[] }
  | { kind: 'point'; value: Point | readonly Point[] }
)
export interface NativeControlSnapshot {
  revision: bigint
  controls: TypedCatalog
}
const kinds = {
  boolean: 1,
  byte: 2,
  int32: 3,
  int64: 4,
  float32: 5,
  string: 6,
  rectangle: 7,
  size: 8,
  uint16: 9,
  uint32: 10,
  point: 11,
} as const
const limit = 4 * 1024 * 1024
const utf8 = new TextEncoder()
function bad(): never {
  throw new RangeError('invalid native control value')
}
const number = (value: unknown, min: number, max: number) => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    bad()
  return value
}
function string(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    !value.isWellFormed()
  )
    bad()
  return utf8.encode(value)
}
function join(parts: Uint8Array[]) {
  const length = parts.reduce((n, p) => n + p.length, 0)
  if (length > limit) bad()
  const out = new Uint8Array(length)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
const words = (values: number[]) => {
  const out = new Uint8Array(values.length * 4),
    v = new DataView(out.buffer)
  values.forEach((n, i) => v.setUint32(i * 4, n, true))
  return out
}
function record(
  id: number,
  kind: number,
  bytes: Uint8Array,
  count: number,
  flags: number,
  recordFlags: number,
  name: Uint8Array,
  vendor: Uint8Array,
  nativeType = 0,
) {
  const value = join([
    words([28 + bytes.length, 0, kind, nativeType, flags, count, 0]),
    bytes,
  ])
  return join([
    words([
      44 + name.length + vendor.length + value.length,
      0,
      id,
      0,
      nativeType,
      recordFlags,
      0,
      kind,
      name.length,
      vendor.length,
      1,
    ]),
    name,
    vendor,
    value,
  ])
}
export function encodeNativeControls(
  controls: readonly NativeControl[],
): Uint8Array {
  if (!Array.isArray(controls)) bad()
  const admittedCount = controls.length
  if (
    !Number.isInteger(admittedCount) ||
    admittedCount < 1 ||
    admittedCount > 256
  )
    bad()
  const ids = new Set<number>(),
    records: Uint8Array[] = []
  let encodedLength = 16
  for (let controlIndex = 0; controlIndex < admittedCount; controlIndex++) {
    const source = controls[controlIndex]
    const control = {
      id: source?.id,
      kind: source?.kind,
      value: source?.value,
      replay: source?.replay,
      name: source?.name,
      vendor: source?.vendor,
    }
    if (!control || typeof control !== 'object') bad()
    const id = number(control.id, 1, 0xffffffff)
    if (ids.has(id)) bad()
    ids.add(id)
    if (control.replay !== undefined && typeof control.replay !== 'boolean')
      bad()
    const kind = kinds[control.kind as keyof typeof kinds]
    if (!kind) bad()
    const name = string(control.name ?? ''),
      vendor = string(control.vendor ?? '')
    let bytes: Uint8Array,
      count: number,
      flags = 2
    if (kind === 6) {
      bytes = string(control.value)
      count = bytes.length
      flags |= 1
    } else {
      const raw = control.value
      const array =
        Array.isArray(raw) ||
        (ArrayBuffer.isView(raw) && !(raw instanceof DataView))
      if (array) flags |= 1
      count = array ? (raw as ArrayLike<unknown>).length : 1
      const width =
        kind === 4 || kind === 8 || kind === 11
          ? 8
          : kind === 7
            ? 16
            : kind === 9
              ? 2
              : kind === 1 || kind === 2
                ? 1
                : 4
      if (
        !Number.isInteger(count) ||
        count < 0 ||
        count > Math.floor(limit / width)
      )
        bad()
      bytes = new Uint8Array(count * width)
      const data = new DataView(bytes.buffer)
      for (let i = 0; i < count; i++) {
        const value = array ? (raw as ArrayLike<unknown>)[i] : raw
        const p = i * width
        if (kind === 1) {
          if (typeof value !== 'boolean') bad()
          data.setUint8(p, value ? 1 : 0)
        } else if (kind === 2) data.setUint8(p, number(value, 0, 255))
        else if (kind === 3)
          data.setInt32(p, number(value, -0x80000000, 0x7fffffff), true)
        else if (kind === 4) {
          if (
            typeof value !== 'bigint' ||
            value < -0x8000000000000000n ||
            value > 0x7fffffffffffffffn
          )
            bad()
          data.setBigInt64(p, value, true)
        } else if (kind === 5) {
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            !Number.isFinite(Math.fround(value))
          )
            bad()
          data.setFloat32(p, value, true)
        } else if (kind === 9) data.setUint16(p, number(value, 0, 65535), true)
        else if (kind === 10)
          data.setUint32(p, number(value, 0, 0xffffffff), true)
        else {
          if (!value || typeof value !== 'object' || Array.isArray(value)) bad()
          const geometry = value as {
            x?: number
            y?: number
            width?: number
            height?: number
          }
          if (kind === 7 || kind === 11) {
            data.setInt32(p, number(geometry.x, -0x80000000, 0x7fffffff), true)
            data.setInt32(
              p + 4,
              number(geometry.y, -0x80000000, 0x7fffffff),
              true,
            )
          }
          if (kind === 7 || kind === 8) {
            const q = p + (kind === 7 ? 8 : 0)
            data.setUint32(q, number(geometry.width, 0, 0xffffffff), true)
            data.setUint32(q + 4, number(geometry.height, 0, 0xffffffff), true)
          }
        }
      }
    }
    encodedLength += 72 + name.length + vendor.length + bytes.length
    if (encodedLength > limit) bad()
    records.push(
      record(
        id,
        kind,
        bytes,
        count,
        flags,
        (control.replay === false ? 128 : 0) |
          (control.vendor !== undefined ? 32 : 0),
        name,
        vendor,
      ),
    )
  }
  return join([utf8.encode('HCAT'), words([1, 6, records.length]), ...records])
}
export function encodeNativeSnapshot(snapshot: NativeControlSnapshot) {
  const source = snapshot?.controls?.records
  if (
    !snapshot ||
    typeof snapshot.revision !== 'bigint' ||
    snapshot.revision < 0n ||
    snapshot.revision > 0xffffffffffffffffn ||
    snapshot.controls?.kind !== 'control-state' ||
    !Array.isArray(source)
  )
    bad()
  const count = source.length
  if (!Number.isInteger(count) || count < 0 || count > 256) bad()
  const records: Uint8Array[] = [],
    ids = new Set<number>()
  let encodedLength = 16
  for (let i = 0; i < count; i++) {
    const entry = source[i]
    const id = number(entry.id, 1, 0xffffffff)
    if (ids.has(id) || entry.values.length !== 1) bad()
    ids.add(id)
    const value = entry.values[0],
      kind = kinds[value.kind as keyof typeof kinds]
    if (!kind || value.role !== 'current' || value.label || entry.flags & 128)
      bad()
    const name = string(entry.name),
      vendor = string(entry.vendor ?? '')
    if (!(value.bytes instanceof Uint8Array)) bad()
    encodedLength += 72 + name.length + vendor.length + value.bytes.length
    if (encodedLength > limit) bad()
    records.push(
      record(
        id,
        kind,
        value.bytes.slice(),
        value.count,
        (value.isArray ? 1 : 0) | (value.littleEndian ? 2 : 0),
        entry.vendor !== undefined ? 32 : 0,
        name,
        vendor,
        entry.nativeType,
      ),
    )
  }
  return join([utf8.encode('HCAT'), words([1, 5, records.length]), ...records])
}
export function nativeAppIds(catalog: TypedCatalog) {
  return new Set(
    catalog.records.map((r: CatalogRecord) => r.appId).filter(Boolean),
  )
}
