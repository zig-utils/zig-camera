import {
  native as n,
  ptr,
  storage,
  view,
  outPointer,
  handle,
  check,
  CameraError,
  type Pointer,
} from './ffi'
import type { BunJob } from './jobs'
class StagedImageFile {
  handle?: Pointer
  private released = false
  constructor(path: Uint8Array) {
    const out = outPointer()
    check(n.zc_image_file_create(ptr(path), ptr(out)), 'stage image file')
    this.handle = handle(out)
  }
  cancel() {
    return (
      this.handle !== undefined && n.zc_image_file_cancel(this.handle) === 1
    )
  }
  private async wait() {
    const bytes = storage(32),
      data = view(bytes)
    for (;;) {
      check(n.zc_image_file_state_get(this.handle!, ptr(bytes)))
      if (data.getUint32(16, true))
        return {
          committed: !!data.getUint32(20, true),
          result: data.getInt32(24, true),
          cleanup: data.getInt32(28, true),
        }
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  async publish<T>(job: BunJob<T>, deadline: number) {
    if (Date.now() >= deadline && !job.cancelRequested)
      job.cancel(new CameraError(-3, 'mode deadline'))
    job.check()
    check(n.zc_image_file_finish(this.handle!, 1), 'publish image file')
    this.released = true
    // Native publication now owns the irreversible decision; cancellationGuard
    // rejects subsequent cancellation until the joined I/O result is observed.
    Atomics.store(new Int32Array(job.cancellation), 1, 6)
    const result = await this.wait()
    check(result.result, 'publish image file')
    check(result.cleanup, 'image file cleanup')
    if (!result.committed)
      throw new CameraError(-2, 'image file was not committed')
  }
  async close() {
    if (this.handle === undefined) return
    if (!this.released) {
      this.cancel()
      const bytes = storage(32),
        data = view(bytes)
      for (;;) {
        check(n.zc_image_file_state_get(this.handle, ptr(bytes)))
        if (!data.getUint32(8, true)) break
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
      }
      if (!data.getUint32(12, true))
        check(n.zc_image_file_finish(this.handle, 0), 'discard image file')
      this.released = true
    }
    const result = await this.wait()
    check(n.zc_image_file_close(this.handle), 'close image file')
    this.handle = undefined
    check(result.cleanup, 'image file cleanup')
  }
}
/** Main owns the native object before handing it to a worker, and joins its
 * disposal even when worker creation, callbacks, restoration or publication fail. */
export async function withStagedImageFile<T>(
  path: Uint8Array | undefined,
  job: BunJob<T>,
  operation: (file?: StagedImageFile) => Promise<T>,
): Promise<T> {
  const file = path === undefined ? undefined : new StagedImageFile(path)
  if (file) job.setCancellationGuard(() => file.cancel())
  let failed = false,
    failure: unknown
  try {
    return await operation(file)
  } catch (error) {
    failed = true
    failure = error
    throw error
  } finally {
    try {
      await file?.close()
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError(
          [failure, cleanupError],
          'capture and staged file cleanup failed',
        )
      else throw cleanupError
    } finally {
      if (file) job.setCancellationGuard(undefined)
    }
  }
}
