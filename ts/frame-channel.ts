import {
  native as n, ptr, check, outPointer, handle, storage, view,
  toArrayBuffer, CameraError, type Pointer,
} from './ffi'
import { decodeFrameExportInfo } from './frame-export'
import { decodeCatalog } from './catalog'
import { imageStreamId, type ImageStream } from './images'
import { adoptCapturedImage } from './image-object'
const transfer = ArrayBuffer.prototype.transfer
const receiveAdmission = Symbol('receive remote frame')
function cookie(value: bigint) {
  if (typeof value !== 'bigint' || value <= 0n || value > 0xffffffffffffffffn)
    throw new RangeError('cookie must be a nonzero uint64 bigint')
  return value
}
function fd(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    throw new RangeError('invalid descriptor')
  return value
}
/** Low-level full-duplex local descriptor channel. Owns its endpoint, with no
 * process supervision or implicit sender retirement. Use one message role per
 * direction: receive frames on the peer, acknowledgements on the sender. */
export class FrameChannel implements Disposable {
  #fd: number
  private constructor(owned: number) { this.#fd = owned }
  static pair(): readonly [FrameChannel, FrameChannel] {
    const values = new Int32Array(2)
    check(n.zc_frame_channel_pair(ptr(values)))
    return Object.freeze([new FrameChannel(values[0]), new FrameChannel(values[1])])
  }
  /** Duplicates an explicitly inherited local datagram endpoint. Borrowed input
   * is not consumed; close that original independently when no longer needed. */
  static fromFd(borrowed: number) {
    const value = new Int32Array(1)
    check(n.zc_frame_channel_duplicate(fd(borrowed), ptr(value)))
    return new FrameChannel(value[0])
  }
  /** Borrowed endpoint, e.g. for explicit Bun.spawn stdio inheritance. */
  get fd() {
    if (this.#fd < 0) throw new CameraError(-5, 'closed frame channel')
    return this.#fd
  }
  get closed() { return this.#fd < 0 }
  /** Undefined means no record is currently available. Invalid records are
   * consumed with every received fd cleaned. Initial slot/preparation admission
   * failure leaves the record queued; later payload admission errors consume it. */
  tryReceive() { return RemoteFrame[receiveAdmission](this.fd) }
  /** Caller must first close all remote maps for this unique live cookie. */
  tryAcknowledge(value: bigint) {
    const rc = n.zc_frame_channel_ack(this.fd, cookie(value))
    if (rc === -3) return false
    check(rc)
    return true
  }
  tryReceiveAcknowledgement() {
    const value = new BigUint64Array(1), rc = n.zc_frame_channel_receive_ack(this.fd, ptr(value))
    if (rc === -3) return undefined
    check(rc)
    return value[0]
  }
  close() {
    const owned = this.#fd
    this.#fd = -1
    if (owned >= 0) check(n.zc_frame_channel_close(owned))
  }
  [Symbol.dispose]() { this.close() }
}
/** Owns receiver-local fds/maps and independent full metadata. The sender still
 * owns the camera lease. Close before ACK; all calls are caller-serialized. */
export class RemoteFrame implements Disposable {
  #owned: Pointer | undefined
  #writing = false
  #views: ArrayBuffer[] = []
  readonly cookie: bigint
  private constructor(owned: Pointer, cookie: bigint) {
    this.#owned = owned
    this.cookie = cookie
  }
  /** @internal */
  static [receiveAdmission](fd: number) {
    const output = outPointer(), cookie = new BigUint64Array(1)
    const rc = n.zc_frame_channel_receive(fd, ptr(output), ptr(cookie))
    if (rc === -3) return undefined
    check(rc)
    return new RemoteFrame(handle(output), cookie[0])
  }
  #open() {
    if (!this.#owned) throw new CameraError(-5, 'closed remote frame')
    return this.#owned
  }
  get closed() { return !this.#owned }
  info() {
    const bytes = storage(736)
    check(n.zc_remote_frame_info(this.#open(), ptr(bytes)))
    return decodeFrameExportInfo(bytes)
  }
  metadataCatalog() {
    const owned = this.#open(), size = new BigUint64Array(1)
    check(n.zc_remote_frame_catalog_copy(owned, null, 0n, ptr(size)))
    const bytes = storage(Number(size[0]))
    check(n.zc_remote_frame_catalog_copy(owned, ptr(bytes), BigInt(bytes.byteLength), ptr(size)))
    return decodeCatalog(bytes)
  }
  #stream(stream: ImageStream) {
    const id = imageStreamId(stream), bytes = storage(208)
    check(n.zc_remote_frame_stream(this.#open(), id, ptr(bytes)))
    return bytes
  }
  #planes(stream: ImageStream, writable: boolean) {
    const descriptor = this.#stream(stream), d = view(descriptor)
    const planes: Uint8Array[] = []
    for (let i = 0; i < d.getUint32(12, true); i++) {
      const at = 48 + i * 40, address = d.getBigUint64(at, true), used = d.getBigUint64(at + 16, true)
      if (address <= 0n || address > BigInt(Number.MAX_SAFE_INTEGER) || used > 256n * 1024n * 1024n)
        throw new CameraError(-1, 'remote mapped plane bounds')
      const buffer = used ? toArrayBuffer(Number(address), 0, Number(used)) : new ArrayBuffer(0)
      this.#views.push(buffer)
      // Read-only maps never escape as a mutable JS view. Normal read access is
      // an explicit owned copy; native const views remain available through C/Zig.
      planes.push(writable ? new Uint8Array(buffer) : new Uint8Array(buffer).slice())
    }
    return Object.freeze(planes)
  }
  #detach() {
    for (const buffer of this.#views) if (buffer.byteLength) transfer.call(buffer, 0)
    this.#views = []
  }
  /** Owned physical plane bytes, including used padding; can outlive close. */
  copyPlanes(stream: ImageStream = 'main') {
    this.#open()
    if (this.#writing) throw new CameraError(-4, 'active remote write context')
    try { return this.#planes(stream, false) }
    finally { this.#detach() }
  }
  /** Explicit mutable borrowed planes. Synchronous context; every escaped alias
   * detaches before return/throw. Do not transfer borrowed buffers or pointers to
   * other workers; use slice() for independent data. Sender write permission is mandatory. */
  withWritablePlanes<T>(stream: ImageStream, run: (planes: readonly Uint8Array[]) => T): T {
    this.#open()
    if (typeof run !== 'function') throw new TypeError('write callback required')
    if (!this.info().writable) throw new CameraError(-8, 'read-only remote export')
    if (this.#writing) throw new CameraError(-4, 'active remote write context')
    this.#writing = true
    try {
      const result = run(this.#planes(stream, true))
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result)
        throw new TypeError('remote write context must be synchronous')
      return result
    } finally {
      try { this.#detach() }
      finally { this.#writing = false }
    }
  }
  /** Native-precision owned RGB image using the shared Home conversion/encoding
   * path. It and its provenance can outlive this remote request and the camera. */
  makeImage(stream: 'main' | 'lores' = 'main', bits?: 8 | 16) {
    const owned = this.#open()
    if (this.#writing) throw new CameraError(-4, 'active remote write context')
    const info = this.info(), selected = info.streams.find(s => s.stream === stream)
    if (stream !== 'main' && stream !== 'lores') throw new RangeError('invalid image stream')
    if (!selected) throw new CameraError(-8, 'remote stream unavailable')
    const depth = bits ?? (selected.format.endsWith('161616') ? 16 : 8)
    if (depth !== 8 && depth !== 16) throw new RangeError('invalid image bit depth')
    const size = new BigUint64Array(1), id = imageStreamId(stream)
    check(n.zc_remote_frame_copy_rgb(owned, id, depth, null, 0n, ptr(size)))
    const bytes = storage(Number(size[0]))
    check(n.zc_remote_frame_copy_rgb(owned, id, depth, ptr(bytes), BigInt(bytes.byteLength), ptr(size)))
    return adoptCapturedImage(bytes, selected.width, selected.height, depth, info.metadata, selected.colorSpace)
  }
  /** Detaches views, unmaps/closes all receiver resources. Does not send ACK or
   * close the sender's export. Consumes even if native cleanup reports I/O. */
  close() {
    if (this.#writing) throw new CameraError(-4, 'active remote write context')
    this.#detach()
    const owned = this.#owned
    this.#owned = undefined
    if (owned) check(n.zc_remote_frame_close(owned))
  }
  [Symbol.dispose]() { this.close() }
}
