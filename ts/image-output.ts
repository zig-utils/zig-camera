import { CameraError } from './ffi'
import type { BunJob } from './jobs'

/** Caller-owned sequential destination. Never closed by image jobs. */
export interface ImageOutput {
  /** A positive byte count accepts that prefix; undefined accepts all bytes.
   * Each offered chunk is an independent copy, at most 64 KiB. */
  write(bytes: Uint8Array): number | void | PromiseLike<number | void>
  /** Called once after all bytes, and joined before successful completion. */
  flush?(): unknown | PromiseLike<unknown>
}
const active = new WeakSet<object>()
/** @internal Snapshot accessors before native input admission. */
export function prepareImageOutput(output: ImageOutput) {
  if (!output || typeof output !== 'object') throw new TypeError('invalid image output')
  const write = output.write,
    flush = output.flush
  if (typeof write !== 'function' || (flush !== undefined && typeof flush !== 'function'))
    throw new TypeError('invalid image output methods')
  return {
    owner: output,
    write: (bytes: Uint8Array) => write.call(output, bytes),
    flush: flush ? () => flush.call(output) : undefined,
  }
}
/** @internal No raced promises: cancellation always joins an accepted write or
 * flush before rejecting. Accepted prefixes cannot be rolled back. */
export async function writeImageOutput<T>(
  bytes: Uint8Array,
  output: ReturnType<typeof prepareImageOutput>,
  job: BunJob<T>,
  deadline: number,
) {
  const checkpoint = () => {
    if (Date.now() >= deadline && !job.cancelRequested) job.cancel(new CameraError(-3, 'image output deadline'))
    job.check()
  }
  checkpoint()
  if (active.has(output.owner)) throw new CameraError(-4, 'image output already writing')
  active.add(output.owner)
  try {
    let offset = 0, calls = 0
    while (offset < bytes.byteLength) {
      checkpoint()
      const size = Math.min(64 * 1024, bytes.byteLength - offset)
      const accepted = await output.write(bytes.slice(offset, offset + size))
      // Keep sink failures observable if cancellation arrived during this call.
      const count = accepted === undefined ? size : accepted
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0 || count > size)
        throw new RangeError('image output must accept a positive byte count within the offered chunk')
      offset += count
      checkpoint()
      // Promise-only synchronous writers must also allow timers/abort to run.
      if (++calls % 32 === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        checkpoint()
      }
    }
    checkpoint()
    if (output.flush) { await output.flush(); checkpoint() }
  } finally {
    active.delete(output.owner)
  }
}
