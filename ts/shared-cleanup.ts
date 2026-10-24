import { native, storage, ptr, view, check } from './ffi'

/** Process-wide deferred owners only; currently live frame owners are excluded. */
export function sharedCleanupState() {
  const bytes = storage(24)
  check(native.zc_shared_cleanup_state_get(ptr(bytes)))
  const data = view(bytes)
  return {
    exports: data.getUint32(4, true),
    remoteFrames: data.getUint32(8, true),
    busy: data.getUint32(12, true),
    retainedBytes: data.getBigUint64(16, true),
  }
}

/** One bounded retry pass. Consumed export/remote handles must never be reused.
 * Throws on an unmap failure or when another drain still owns pending work. */
export function drainSharedMappings() {
  check(native.zc_shared_cleanup_drain())
}
