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
  private outcome?: { committed: boolean; result: number; cleanup: number }
  describe<T extends Error>(error: T): T {
    return this.outcome
      ? Object.assign(error, {
          imageFilePublished: this.outcome.committed,
          imageFileResultCode: this.outcome.result,
          imageFileCleanupCode: this.outcome.cleanup,
        })
      : error
  }
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
      if (data.getUint32(16, true)) {
        const outcome = {
          committed: !!data.getUint32(20, true),
          result: data.getInt32(24, true),
          cleanup: data.getInt32(28, true),
        }
        this.outcome = outcome
        return outcome
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  async prepareBytes<T>(bytes:Uint8Array,job:BunJob<T>) {
    job.check()
    check(n.zc_image_file_prepare_bytes(this.handle!,ptr(bytes),BigInt(bytes.byteLength)),'stage encoded bytes')
    const result=new Int32Array(1)
    for(;;){
      const rc=n.zc_image_file_preparation_result(this.handle!,ptr(result))
      if(rc!==-3){check(rc,'encoded staging state');if(result[0]!==-5)check(result[0],'stage encoded bytes');job.check();check(result[0],'stage encoded bytes');return}
      job.check();await new Promise<void>(resolve=>setTimeout(resolve,1))
    }
  }
  async publish<T>(job: BunJob<T>, deadline: number) {
    if (Date.now() >= deadline && !job.cancelRequested)
      job.cancel(new CameraError(-3, 'image file deadline'))
    job.check()
    check(n.zc_image_file_finish(this.handle!, 1), 'publish image file')
    this.released = true
    // Native publication now owns the irreversible decision; cancellationGuard
    // rejects subsequent cancellation until the joined I/O result is observed.
    Atomics.store(new Int32Array(job.cancellation), 1, 6)
    const result = await this.wait()
    if (result.result)
      throw this.describe(new CameraError(result.result, 'publish image file'))
    if (result.cleanup)
      throw this.describe(new CameraError(result.cleanup, 'image file cleanup'))
    if (!result.committed)
      throw this.describe(new CameraError(-2, 'image file was not committed'))
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
    const closed = n.zc_image_file_close(this.handle)
    if (closed) throw this.describe(new CameraError(closed, 'close image file'))
    this.handle = undefined
    if (result.cleanup)
      throw this.describe(new CameraError(result.cleanup, 'image file cleanup'))
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
        throw file!.describe(
          new AggregateError(
            [failure, cleanupError],
            'capture and staged file cleanup failed',
          ),
        )
      else throw cleanupError
    } finally {
      if (file) job.setCancellationGuard(undefined)
    }
  }
}
