import { isYuv420 } from './processed-format'
import {
  native as n,
  storage,
  ptr,
  view,
  outPointer,
  handle,
  check,
  CameraError,
  toArrayBuffer,
  type Pointer,
} from './ffi'
export interface MappedPlane {
  readonly bytes: Uint8Array
  readonly length: bigint
  readonly bytesUsed: bigint
  readonly offset: bigint
  readonly fd: number
}
const transfer = ArrayBuffer.prototype.transfer
/** Linear owned map. Close detaches every ordinary alias before retiring its native lease. */
export class MappedStream {
  private handle: Pointer
  private buffers: ArrayBuffer[] = []
  private descriptor = storage(208)
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly format: string
  readonly planes: readonly MappedPlane[]
  private rowBytes?: number
  private constructor(owned: Pointer) {
    this.handle = owned
    try {
      check(n.zc_frame_map_stream(owned, ptr(this.descriptor)))
      const d = view(this.descriptor)
      this.width = d.getUint32(0, true)
      this.height = d.getUint32(4, true)
      this.stride = d.getUint32(8, true)
      const count = d.getUint32(12, true)
      if (!this.width || !this.height || count < 1 || count > 4)
        throw new CameraError(-1, 'mapped stream geometry')
      const name = this.descriptor.subarray(16, 48),
        end = name.indexOf(0)
      this.format = new TextDecoder().decode(
        end < 0 ? name : name.subarray(0, end),
      )
      const planes: MappedPlane[] = []
      for (let i = 0; i < count; i++) {
        const p = 48 + i * 40,
          address = d.getBigUint64(p, true),
          length = d.getBigUint64(p + 8, true),
          bytesUsed = d.getBigUint64(p + 16, true)
        if (
          bytesUsed > length ||
          bytesUsed > BigInt(Number.MAX_SAFE_INTEGER) ||
          address > BigInt(Number.MAX_SAFE_INTEGER) ||
          !address
        )
          throw new CameraError(-1, 'mapped plane bounds')
        const buffer = bytesUsed
          ? toArrayBuffer(Number(address), 0, Number(bytesUsed))
          : new ArrayBuffer(0)
        this.buffers.push(buffer)
        planes.push(
          Object.freeze({
            bytes: new Uint8Array(buffer),
            length,
            bytesUsed,
            offset: d.getBigUint64(p + 24, true),
            fd: d.getInt32(p + 32, true),
          }),
        )
      }
      this.planes = Object.freeze(planes)
      const size = new BigUint64Array(1)
      if (
        n.zc_stream_copy_size(ptr(this.descriptor), ptr(size)) === 0 &&
        !isYuv420(this.format)
      )
        this.rowBytes = Number(size[0]) / this.height
    } catch (error) {
      try {
        this.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'mapped stream construction failed',
        )
      }
      throw error
    }
  }
  /** @internal Frame.mapStream validates the owning frame first. */
  static open(camera: Pointer, token: bigint, stream: number) {
    const out = outPointer()
    check(
      n.zc_frame_map_open(camera, token, stream, 1, ptr(out)),
      'map writable stream',
    )
    return new MappedStream(handle(out))
  }
  get closed() {
    return !this.handle
  }
  /** Tight row without padding. Planar components are Y/U/V; NV12/NV21 use Y/interleaved UV or VU. */
  row(y: number, component = 0): Uint8Array {
    if (this.closed) throw new CameraError(-5, 'closed mapping')
    if (
      !Number.isInteger(y) ||
      y < 0 ||
      !Number.isInteger(component) ||
      component < 0
    )
      throw new RangeError('invalid mapped row')
    let plane = 0,
      offset = 0,
      stride = this.stride,
      height = this.height,
      bytes = this.rowBytes
    if (this.format === 'NV12' || this.format === 'NV21') {
      if (
        component > 1 ||
        (this.width | this.height | this.stride) & 1 ||
        ![1, 2].includes(this.planes.length)
      )
        throw new CameraError(-8, 'mapped semi-planar layout')
      bytes = this.width
      if (component) {
        height /= 2
        if (this.planes.length === 2) plane = 1
        else offset = this.stride * this.height
      }
    } else if (this.format === 'YUV420' || this.format === 'YVU420') {
      if (
        component > 2 ||
        (this.width | this.height | this.stride) & 1 ||
        ![1, 3].includes(this.planes.length)
      )
        throw new CameraError(-8, 'mapped I420 layout')
      bytes = component ? this.width / 2 : this.width
      if (component) {
        stride /= 2
        height /= 2
      }
      const physical =
        component && this.format === 'YVU420' ? 3 - component : component
      if (this.planes.length === 3) plane = physical
      else if (physical)
        offset =
          this.stride * this.height +
          (physical - 1) * (this.stride / 2) * (this.height / 2)
    } else if (component || this.planes.length !== 1 || bytes === undefined)
      throw new CameraError(-8, 'mapped row format')
    if (
      y >= height ||
      bytes === undefined ||
      !Number.isInteger(bytes) ||
      stride < bytes
    )
      throw new RangeError('invalid mapped row geometry')
    const start = offset + y * stride,
      data = this.planes[plane].bytes
    if (start + bytes > data.length)
      throw new CameraError(-1, 'truncated mapped row')
    return data.subarray(start, start + bytes)
  }
  close() {
    if (!this.handle) return
    // Detach first. A detachment failure deliberately preserves the native owner.
    for (const buffer of this.buffers)
      if (buffer.byteLength) transfer.call(buffer, 0)
    const owned = this.handle
    this.handle = 0 as Pointer
    check(n.zc_frame_map_close(owned), 'close mapped stream')
  }
  [Symbol.dispose]() {
    this.close()
  }
}
