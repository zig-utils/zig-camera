import { CaptureFactoryClient, type CaptureBufferFactory } from './capture-factory-client'
import { native as n, storage, ptr, view, outPointer, handle, check, CameraError, type Pointer } from './ffi'

export interface CaptureAllocatorOptions {
  simulate?: boolean
  /** Linux FD-backed storage explicitly provisioned with importBuffers. */
  imported?: boolean
  /** Runs on the creating Bun thread when a native configuration needs storage. */
  factory?: CaptureBufferFactory
  maxEntries?: number
  maxBytes?: number
  /** Explicit Linux heap path; defaults discover Pi/CMA heaps. */
  heapPath?: string
}
export interface CaptureAllocatorState {
  backend: 'synthetic' | 'libcamera'
  maxEntries: number
  entries: number
  borrowed: number
  pins: number
  retiring: number
  closing: boolean
  maxBytes: bigint
  usedBytes: bigint
  highBytes: bigint
  preparations: bigint
  reuses: bigint
  retired: bigint
  allocations: bigint
  writableMaps: bigint
  cleanupErrors: bigint
  lastErrno: number
}
const owners = new WeakMap<CaptureAllocator, { handle?: Pointer; simulate: boolean; imported: boolean; factory?: CaptureFactoryClient }>()
/** Internal configuration admission. Keep class owners on the main thread;
 * workers receive only native pointers protected by explicit native pins. */
export function captureAllocatorHandle(value: CaptureAllocator | undefined, simulate?: boolean): Pointer | undefined {
  if (value === undefined) return undefined
  const owner = owners.get(value)
  if (!owner) throw new RangeError('invalid capture allocator')
  if (!owner.handle) throw new CameraError(-2, 'capture allocator closed')
  if (simulate !== undefined && simulate !== owner.simulate)
    throw new RangeError('capture allocator backend differs from camera')
  return owner.handle
}
/** Persistent bounded camera backing. Close cameras and join mode jobs before
 * close; BUSY and cleanup failures retain this owner for explicit retry. */
export class CaptureAllocator {
  constructor(options: CaptureAllocatorOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new RangeError('invalid capture allocator options')
    const selected = { ...options }
    if (selected.factory !== undefined) {
      if (typeof selected.factory !== 'function' || selected.imported === false) throw new RangeError('invalid capture buffer factory')
      selected.imported = true
    }
    if (selected.simulate !== undefined && typeof selected.simulate !== 'boolean')
      throw new RangeError('invalid allocator backend')
    if (selected.imported !== undefined && typeof selected.imported !== 'boolean') throw new RangeError('invalid imported allocator mode')
    const config = storage(24)
    n.zc_default_capture_allocator_config(ptr(config))
    const bytes = view(config)
    bytes.setUint32(4, selected.simulate ? 0 : 1, true)
    if (selected.maxEntries !== undefined) {
      if (!Number.isInteger(selected.maxEntries) || selected.maxEntries < 1 || selected.maxEntries > 16)
        throw new RangeError('allocator entries must be 1..16')
      bytes.setUint32(8, selected.maxEntries, true)
    }
    if (selected.maxBytes !== undefined) {
      if (!Number.isSafeInteger(selected.maxBytes) || selected.maxBytes < 1 || selected.maxBytes > 8 * 1024 ** 3)
        throw new RangeError('allocator bytes must be 1..8 GiB')
      bytes.setBigUint64(16, BigInt(selected.maxBytes), true)
    }
    let path: Uint8Array | undefined
    if (selected.heapPath !== undefined) {
      if (selected.imported || selected.simulate || typeof selected.heapPath !== 'string' || !selected.heapPath.length ||
          selected.heapPath.includes('\0') || !selected.heapPath.isWellFormed())
        throw new RangeError('invalid allocator heap path')
      path = new TextEncoder().encode(selected.heapPath)
      if (path.length > 4096) throw new RangeError('allocator heap path too long')
    }
    const out = outPointer()
    check(selected.imported ? n.zc_capture_allocator_open_imported(ptr(config), ptr(out)) : n.zc_capture_allocator_open(ptr(config), path ? ptr(path) : null, path?.length ?? 0, ptr(out)), 'open capture allocator')
    const nativeHandle = handle(out)
    const owner = { handle: nativeHandle as Pointer | undefined, simulate: selected.simulate ?? false, imported: selected.imported ?? false, factory: undefined as CaptureFactoryClient | undefined }
    owners.set(this, owner)
    if (selected.factory) {
      try { owner.factory = new CaptureFactoryClient(nativeHandle, selected.factory); factoryClients.set(nativeHandle, owner.factory) }
      catch (error) { n.zc_capture_allocator_close(nativeHandle); owner.handle = undefined; throw error }
    }
  }
  get hasFactory() { return !!owners.get(this)?.factory }
  takeFactoryErrors() { return owners.get(this)?.factory?.takeErrors() ?? [] }
  get imported() { return owners.get(this)?.imported ?? false }
  importBuffers(layout: CaptureLayout, buffers: readonly (readonly CaptureImportBuffer[])[]) {
    const owner = owners.get(this)
    if (!owner || !owner.imported) throw new RangeError('allocator is not an imported owner')
    if (!layout || typeof layout !== 'object' || (layout.backend !== 'synthetic' && layout.backend !== 'libcamera') ||
        (layout.backend === 'synthetic') !== owner.simulate || !Array.isArray(layout.streams) || !Array.isArray(buffers))
      throw new RangeError('invalid capture import layout')
    const { id, descriptions, descriptors, count, streamCount } = encodeCaptureImport(layout, buffers)
    check(n.zc_capture_allocator_import(captureAllocatorHandle(this)!, ptr(id), id.length, ptr(descriptions), streamCount, ptr(descriptors), count), 'import capture buffers')
  }
  get closed() { return !owners.get(this)?.handle }
  get state(): Readonly<CaptureAllocatorState> {
    const bytes = storage(112)
    check(n.zc_capture_allocator_state_get(captureAllocatorHandle(this)!, ptr(bytes)), 'capture allocator state')
    const data = view(bytes), u32 = (offset: number) => data.getUint32(offset, true), u64 = (offset: number) => data.getBigUint64(offset, true)
    if (u32(0) !== 112) throw new CameraError(-2, 'capture allocator state ABI')
    return Object.freeze({
      backend: u32(4) === 0 ? 'synthetic' : 'libcamera', maxEntries: u32(8), entries: u32(12),
      borrowed: u32(16), pins: u32(20), retiring: u32(24), closing: u32(108) !== 0,
      maxBytes: u64(32), usedBytes: u64(40), highBytes: u64(48), preparations: u64(56),
      reuses: u64(64), retired: u64(72), allocations: u64(80), writableMaps: u64(88), cleanupErrors: u64(96),
      lastErrno: data.getInt32(104, true),
    })
  }
  trim() { check(n.zc_capture_allocator_trim(captureAllocatorHandle(this)!), 'trim capture allocator') }
  close() {
    const owner = owners.get(this)
    if (!owner) throw new RangeError('invalid capture allocator')
    if (!owner.handle) return
    if (owner.factory?.busy) throw new CameraError(-4, 'capture factory callbacks still active')
    check(n.zc_capture_allocator_close(owner.handle), 'close capture allocator')
    owner.factory?.close()
    factoryClients.delete(owner.handle)
    owner.handle = undefined
  }
}

export interface CaptureImportBuffer { fd: number; offset?: number | bigint }
export interface CaptureLayoutStream {
  width: number; height: number; stride: number; bufferCount: number;
  frameBytes: bigint; modifier: bigint; format: string;
}
export interface CaptureLayout {
  backend: 'synthetic' | 'libcamera'; cameraId: string;
  streams: readonly Readonly<CaptureLayoutStream>[];
}
function integer(value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError('invalid import integer')
  return value
}
function unsigned(value: number | bigint, maximum: bigint, zero: boolean) {
  if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new RangeError('invalid import size')
  const result = BigInt(value)
  if (result < (zero ? 0n : 1n) || result > maximum) throw new RangeError('import size out of range')
  return result
}
function encodeIdentity(value: string) {
  if (typeof value !== 'string' || !value.length || !value.isWellFormed() || value.includes('\0')) throw new RangeError('invalid import camera ID')
  const result = new TextEncoder().encode(value)
  if (result.length > 4096) throw new RangeError('import camera ID too long')
  return result
}
/** @internal Owned scalar snapshot; no FD or camera pointer escapes. */
export function readCaptureLayout(camera: Pointer): Readonly<CaptureLayout> {
  const bytes = storage(4304)
  check(n.zc_camera_capture_layout_get(camera, ptr(bytes)), 'capture allocation layout')
  return decodeCaptureLayout(bytes)
}
/** @internal Decode a pointer-free native factory/configuration snapshot. */
export function decodeCaptureLayout(bytes: Uint8Array): Readonly<CaptureLayout> {
  const data = view(bytes), count = data.getUint32(8, true), length = data.getUint32(12, true)
  if (data.getUint32(0, true) !== 4304 || data.getUint32(4, true) > 1 || count < 1 || count > 3 || length < 1 || length > 4096) throw new CameraError(-2, 'capture layout ABI')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const streams = Array.from({ length: count }, (_, index) => {
    const at = 4112 + index * 64, format = bytes.subarray(at + 32, at + 64), end = format.indexOf(0)
    if (end <= 0) throw new CameraError(-2, 'capture layout format ABI')
    return Object.freeze({ width: data.getUint32(at, true), height: data.getUint32(at + 4, true), stride: data.getUint32(at + 8, true), bufferCount: data.getUint32(at + 12, true), frameBytes: data.getBigUint64(at + 16, true), modifier: data.getBigUint64(at + 24, true), format: decoder.decode(format.subarray(0, end)) })
  })
  return Object.freeze({ backend: data.getUint32(4, true) === 0 ? 'synthetic' : 'libcamera', cameraId: decoder.decode(bytes.subarray(16, 16 + length)), streams: Object.freeze(streams) })
}

/** @internal Checked owned copies for both explicit and factory imports. */
export function encodeCaptureImport(layout: CaptureLayout, buffers: readonly (readonly CaptureImportBuffer[])[]) {
    const id = encodeIdentity(layout.cameraId)
    const streams = Array.from(layout.streams), supplied = Array.from(buffers)
    if (!streams.length || streams.length > 3 || supplied.length !== streams.length) throw new RangeError('invalid capture import stream count')
    const descriptions = storage(streams.length * 64)
    const plans = streams.map((stream, index) => {
      if (!stream || typeof stream !== 'object' || !Array.isArray(supplied[index])) throw new RangeError('invalid import stream')
      const list = Array.from(supplied[index]), data = view(descriptions), offset = index * 64
      const count = integer(stream.bufferCount, 2, 64)
      if (list.length !== count) throw new RangeError('import buffer count differs from layout')
      data.setUint32(offset, integer(stream.width, 1, 0xffffffff), true)
      data.setUint32(offset + 4, integer(stream.height, 1, 0xffffffff), true)
      data.setUint32(offset + 8, integer(stream.stride, 1, 0xffffffff), true)
      data.setUint32(offset + 12, count, true)
      data.setBigUint64(offset + 16, unsigned(stream.frameBytes, 0xffffffffn, false), true)
      data.setBigUint64(offset + 24, unsigned(stream.modifier, 0xffffffffffffffffn, true), true)
      if (typeof stream.format !== 'string' || !stream.format.length || !stream.format.isWellFormed() || stream.format.includes('\0')) throw new RangeError('invalid import format')
      const format = new TextEncoder().encode(stream.format)
      if (format.length > 31) throw new RangeError('import format too long')
      descriptions.set(format, offset + 32)
      return list.map(buffer => {
        if (!buffer || typeof buffer !== 'object') throw new RangeError('invalid import buffer')
        return { fd: integer(buffer.fd, 0, 0x7fffffff), offset: unsigned(buffer.offset ?? 0n, 0xffffffffn, true) }
      })
    }).flat()
    const descriptors = storage(plans.length * 16), data = view(descriptors)
    plans.forEach((buffer, index) => {
      data.setInt32(index * 16, buffer.fd, true)
      data.setBigUint64(index * 16 + 8, buffer.offset, true)
    })
  return { id, descriptions, descriptors, count: plans.length, streamCount: streams.length }
}
const factoryClients = new Map<Pointer, CaptureFactoryClient>()
/** @internal Main-thread factory lifetime; native workers receive only pointers. */
export function captureAllocatorFactory(pointer: Pointer) { return factoryClients.get(pointer) }
