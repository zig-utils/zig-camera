import {
  native as n,
  ptr,
  storage,
  view,
  text,
  check,
  type Pointer,
} from './ffi'
import { decodeMetadata } from './metadata'
export type StreamName = 'main' | 'raw' | 'lores'
export interface PackedStream {
  width: number
  height: number
  format: string
  rowBytes: number
  data: Uint8Array
}
export interface CapturedStreams {
  streams: Partial<Record<StreamName, PackedStream>>
  metadata: ReturnType<typeof decodeMetadata>
}
const ids = { main: 0, raw: 1, lores: 2 } as const
/** Snapshot the indexed names once. Never invoke a caller-provided iterator. */
export function streamNames(streams: readonly StreamName[]): StreamName[] {
  if (!Array.isArray(streams))
    throw new TypeError('stream names must be an array')
  const length = streams.length
  if (length < 1 || length > 3)
    throw new RangeError('1..3 distinct stream names required')
  const result: StreamName[] = []
  for (let i = 0; i < length; i++) {
    const name = streams[i]
    if (typeof name !== 'string' || !Object.hasOwn(ids, name))
      throw new RangeError('1..3 distinct stream names required')
    const selected = name as StreamName
    if (result.includes(selected))
      throw new RangeError('1..3 distinct stream names required')
    result.push(selected)
  }
  return result
}
/** Caller owns the readable lease for both synchronous calls. Each returned
 * data view owns its range in one compact backing allocation; no native pointer
 * or retained reference escapes. Native copy revalidates the lease and writer. */
export function copyNativeStreams(
  camera: Pointer,
  token: bigint,
  names: readonly StreamName[],
): CapturedStreams {
  const streams = Uint32Array.from(names, (name) => ids[name]),
    layouts = storage(names.length * 64),
    metadata = storage(96),
    size = new BigUint64Array(1)
  const copy = (data?: Uint8Array) =>
    check(
      n.zc_copy_frame_streams(
        camera,
        token,
        ptr(streams),
        names.length,
        ptr(layouts),
        names.length,
        data ? ptr(data) : null,
        BigInt(data?.length ?? 0),
        ptr(size),
        ptr(metadata),
      ),
      'copy request streams',
    )
  copy()
  if (size[0] > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('streams too large')
  const data = storage(Number(size[0]))
  copy(data)
  return decodePackedStreams(names, layouts, data, decodeMetadata(metadata))
}
/** @internal Shared checked native bundle representation. */
export function decodePackedStreams(names:readonly StreamName[],layouts:Uint8Array,data:Uint8Array,metadata:CapturedStreams['metadata']):CapturedStreams {
  const d = view(layouts), result:CapturedStreams = {streams:{},metadata}
  for (let i = 0; i < names.length; i++) {
    const at = i * 64,
      offset = Number(d.getBigUint64(at + 48, true)),
      length = Number(d.getBigUint64(at + 56, true))
    result.streams[names[i]] = {
      width: d.getUint32(at + 4, true),
      height: d.getUint32(at + 8, true),
      rowBytes: d.getUint32(at + 12, true),
      format: text(layouts, at + 16, 32),
      data: data.subarray(offset, offset + length),
    }
  }
  return result
}
