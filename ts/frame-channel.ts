import {
  native as n, ptr, check, outPointer, handle, storage, view,
  toArrayBuffer, cstring, CameraError, type Pointer,
} from './ffi'
import { decodeFrameExportInfo, decodeRawMetadata } from './frame-export'
import { decodeCatalog } from './catalog'
import { imageStreamId, type ImageStream } from './images'
import { adoptCapturedImage, type ImageObjectOptions } from './image-object'
import { streamNames,decodePackedStreams,type StreamName,type CapturedStreams } from './streams'
export interface RemoteArray {
  /** Owned, tight row-major values; RGB16 uses native LE words. Raw retains packing as bytes. */
  data:Uint8Array|Uint16Array
  shape:readonly number[]
  format:string
  rowBytes:number
}
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
  info() { return this.#info() }
  #info() {
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
  rawMetadata() {
    const bytes=storage(184)
    check(n.zc_remote_frame_raw_metadata(this.#open(),ptr(bytes)))
    return decodeRawMetadata(bytes)
  }
  #readable() {
    const owned=this.#open()
    if(this.#writing)throw new CameraError(-4,'active remote write context')
    return owned
  }
  /** One owned compact backing for the selected streams; padding is removed,
   * format, channel/plane order and sensor packing are preserved. */
  copyStreams(streams:readonly StreamName[]=['main']):CapturedStreams {
    const names=streamNames(streams),owned=this.#readable(),ids=Uint32Array.from(names,name=>imageStreamId(name)),layouts=storage(names.length*64),size=new BigUint64Array(1)
    const copy=(data?:Uint8Array)=>check(n.zc_remote_frame_copy_streams(owned,ptr(ids),names.length,ptr(layouts),names.length,data?ptr(data):null,BigInt(data?.byteLength??0),ptr(size)))
    copy()
    const bytes=storage(Number(size[0]));copy(bytes)
    return decodePackedStreams(names,layouts,bytes,this.#info().metadata)
  }
  copyStream(stream:StreamName='main') {
    return this.copyStreams([stream]).streams[stream]!
  }
  /** Flat physical used bytes, including used row padding, in plane order.
   * One native pixel copy into an independent allocation. */
  makeBuffer(stream:StreamName='main') {
    const id=imageStreamId(stream),owned=this.#readable(),size=new BigUint64Array(1)
    check(n.zc_remote_frame_copy_buffer(owned,id,null,0n,ptr(size)))
    const bytes=storage(Number(size[0]))
    if(bytes.byteLength)check(n.zc_remote_frame_copy_buffer(owned,id,ptr(bytes),BigInt(bytes.byteLength),ptr(size)))
    return bytes
  }
  /** Tight shaped array; YUV rows concatenate stored planes without conversion.
   * Raw is [height,rowBytes] packed u8. Use copyRaw16 for decoded samples. */
  makeArray(stream:StreamName='main'):RemoteArray {
    const copy=this.copyStream(stream),{width:w,height:h,format:f,rowBytes}=copy
    let data:Uint8Array|Uint16Array=copy.data,shape:readonly number[]
    if(f==='BGR161616'||f==='RGB161616'){
      data=new Uint16Array(data.buffer,data.byteOffset,data.byteLength/2);shape=[h,w,3]
    }else if(f==='BGR888'||f==='RGB888')shape=[h,w,3]
    else if(f==='XBGR8888'||f==='XRGB8888')shape=[h,w,4]
    else if(f==='YUV420'||f==='YVU420'||f==='NV12'||f==='NV21')shape=[h*3/2,w]
    else if(['YUYV','YVYU','UYVY','VYUY'].includes(f))shape=[h,w,2]
    else shape=[h,rowBytes]
    return {data,shape:Object.freeze(shape),format:f,rowBytes}
  }
  /** Home-decoded sensor samples; no scaling, demosaicing or color conversion. */
  copyRaw16() {
    const owned=this.#readable(),size=new BigUint64Array(1)
    check(n.zc_remote_frame_copy_raw16(owned,null,0n,ptr(size)))
    const bytes=storage(Number(size[0]))
    check(n.zc_remote_frame_copy_raw16(owned,ptr(bytes),BigInt(bytes.byteLength),ptr(size)))
    return new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2)
  }
  /** Owned DNG bytes with this request's sensor calibration. */
  encodeDng() {
    const out=outPointer()
    check(n.zc_remote_frame_encode_dng(this.#readable(),ptr(out)))
    const blob=handle(out)
    try {
      const size=new BigUint64Array(1)
      check(n.zc_image_blob_copy(blob,null,0n,ptr(size)))
      const bytes=storage(Number(size[0]))
      check(n.zc_image_blob_copy(blob,ptr(bytes),BigInt(bytes.byteLength),ptr(size)))
      return bytes
    }finally{n.zc_image_blob_close(blob)}
  }
  /** Synchronous streaming atomic DNG save. A process job cancellation cannot
   * roll back a successfully published file. */
  saveDng(path:string) {
    if(typeof path!=='string')throw new TypeError('image path must be a string')
    const encoded=cstring(path)
    check(n.zc_remote_frame_save_dng(this.#readable(),ptr(encoded)))
  }
  /** Owned processed image save. Request-derived Exif is not synthesized here;
   * supply explicit metadata or encode from the source request. */
  save(path:string,options:ImageObjectOptions={},stream:'main'|'lores'='main') {
    using image=this.makeImage(stream)
    image.save(path,options)
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
    if (!this.#info().writable) throw new CameraError(-8, 'read-only remote export')
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
    const info = this.#info(), selected = info.streams.find(s => s.stream === stream)
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
