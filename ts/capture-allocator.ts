import { native as n, storage, ptr, view, outPointer, handle, check, CameraError, type Pointer } from './ffi'

export interface CaptureAllocatorOptions {
  simulate?: boolean
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
const owners = new WeakMap<CaptureAllocator, { handle?: Pointer; simulate: boolean }>()
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
    if (selected.simulate !== undefined && typeof selected.simulate !== 'boolean')
      throw new RangeError('invalid allocator backend')
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
      if (selected.simulate || typeof selected.heapPath !== 'string' || !selected.heapPath.length ||
          selected.heapPath.includes('\0') || !selected.heapPath.isWellFormed())
        throw new RangeError('invalid allocator heap path')
      path = new TextEncoder().encode(selected.heapPath)
      if (path.length > 4096) throw new RangeError('allocator heap path too long')
    }
    const out = outPointer()
    check(n.zc_capture_allocator_open(ptr(config), path ? ptr(path) : null, path?.length ?? 0, ptr(out)), 'open capture allocator')
    owners.set(this, { handle: handle(out), simulate: selected.simulate ?? false })
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
    check(n.zc_capture_allocator_close(owner.handle), 'close capture allocator')
    owner.handle = undefined
  }
}
