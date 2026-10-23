import {
  native as n,
  ptr,
  storage,
  view,
  check,
  outPointer,
  handle,
  text,
  CameraError,
  type Pointer,
} from './ffi'
import { decodeMetadata } from './metadata'
import { decodeCatalog } from './catalog'
import { decodeStreamColorSpace } from './images'
const admission = Symbol('frame export admission')
const processAdmission = Symbol('native process ownership transfer')
/** Low-level retained export. Caller must join remote consumers before close;
 * this object does not supervise child processes or infer their completion. */
export class FrameExport implements Disposable {
  private constructor(private owned: Pointer | undefined) {}
  /** @internal */
  static [admission](
    camera: Pointer,
    token: bigint,
    streams: number,
    writable: boolean,
  ) {
    const out = outPointer()
    check(
      n.zc_frame_export_open(
        camera,
        token,
        streams,
        writable ? 1 : 0,
        ptr(out),
      ),
    )
    return new FrameExport(handle(out))
  }
  private open() {
    if (!this.owned) throw new CameraError(-5, 'closed frame export')
    return this.owned
  }
  /** @internal Native session consumes only on success. */
  [processAdmission](session: Pointer, args: Uint8Array, resultCapacity: number) {
    const cookie = new BigUint64Array(1), worker = new Uint32Array(1), generation = new BigUint64Array(1)
    check(n.zc_process_submit(session,this.open(),ptr(args),BigInt(args.byteLength),BigInt(resultCapacity),ptr(cookie),ptr(worker),ptr(generation)))
    this.owned = undefined
    return {cookie:cookie[0],worker:worker[0],generation:generation[0]}
  }
  get closed() {
    return !this.owned
  }
  /** All fd numbers are borrowed from this export, not independent owners. */
  info() {
    const bytes = storage(736)
    check(n.zc_frame_export_info(this.open(), ptr(bytes)))
    return decodeFrameExportInfo(bytes)
  }
  /** Low-level send. Hold this owner until all remote views retire and ACK/exit is verified. */
  trySend(channelFd: number, cookie: bigint) {
    if (!Number.isInteger(channelFd) || channelFd < 0 || channelFd > 0x7fffffff || typeof cookie !== 'bigint' || cookie <= 0n || cookie > 0xffffffffffffffffn) throw new RangeError('invalid channel or cookie')
    const rc = n.zc_frame_channel_send(channelFd, this.open(), cookie)
    if (rc === -3) return false
    check(rc)
    return true
  }
  metadataCatalog() {
    const owner = this.open(),
      size = new BigUint64Array(1)
    check(n.zc_frame_export_catalog_copy(owner, null, 0n, ptr(size)))
    const bytes = storage(Number(size[0]))
    check(
      n.zc_frame_export_catalog_copy(
        owner,
        ptr(bytes),
        BigInt(bytes.byteLength),
        ptr(size),
      ),
    )
    return decodeCatalog(bytes)
  }
  /** Consumes even when DMA/requeue cleanup reports an error. */
  close() {
    const owned = this.owned
    this.owned = undefined
    if (owned) check(n.zc_frame_export_close(owned))
  }
  [Symbol.dispose]() {
    this.close()
  }
}
/** @internal Frame holds a readable source reference for this entire call. */
export function exportNativeFrame(
  camera: Pointer,
  token: bigint,
  streams: number,
  writable: boolean,
) {
  return FrameExport[admission](camera, token, streams, writable)
}
export interface FrameExportOptions {
  streams?: readonly ('main' | 'raw' | 'lores')[]
  writable?: boolean
}
/** @internal Keeps native ownership in the process session, never a JS queue. */
export function transferExportToProcess(loan: FrameExport, session: Pointer, args: Uint8Array, resultCapacity: number) {
  return loan[processAdmission](session,args,resultCapacity)
}

/** @internal Shared pointer-free descriptor decoder. */
export function decodeFrameExportInfo(bytes: Uint8Array) {
  const d = view(bytes)
    const streamCount = d.getUint32(4, true),
      planeCount = d.getUint32(8, true),
      flags = d.getUint32(12, true)
    const streams = Array.from({ length: streamCount }, (_, i) => {
      const at = 184 + i * 56
      return Object.freeze({
        stream: (['main', 'raw', 'lores'] as const)[d.getUint32(at, true)]!,
        width: d.getUint32(at + 4, true),
        height: d.getUint32(at + 8, true),
        stride: d.getUint32(at + 12, true),
        planeCount: d.getUint32(at + 16, true),
        firstPlane: d.getUint32(at + 20, true),
        format: text(bytes, at + 24, 32),
        colorSpace: Object.freeze(
          decodeStreamColorSpace(
            bytes.subarray(112 + i * 24, 136 + i * 24),
          ),
        ),
      })
    })
    const planes = Array.from({ length: planeCount }, (_, i) => {
      const at = 352 + i * 32,
        p = d.getUint32(at + 4, true)
      return Object.freeze({
        fd: d.getInt32(at, true),
        writable: !!(p & 1),
        staged: !!(p & 2),
        offset: d.getBigUint64(at + 8, true),
        length: d.getBigUint64(at + 16, true),
        bytesUsed: d.getBigUint64(at + 24, true),
      })
    })
    const metadata = decodeMetadata(bytes.subarray(16, 112))
    return Object.freeze({
      writable: !!(flags & 1),
      staged: !!(flags & 2),
      streams: Object.freeze(streams),
      planes: Object.freeze(planes),
      metadata: Object.freeze({
        ...metadata,
        crop: Object.freeze({ ...metadata.crop }),
      }),
    })
}
