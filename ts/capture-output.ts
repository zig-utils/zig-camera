import { CameraError } from './ffi'
import type { BunJob } from './jobs'
import { writeImageOutput, type prepareImageOutput } from './image-output'

export interface ImageOutputCapture<S> {
  capture(source: S): void
  publish(): Promise<void>
}
/** @internal Keep the parent-owned native job through source retirement,
 * request callbacks/restoration and sink I/O. Never race accepted operations. */
export async function withImageOutputCapture<S, T>(
  output: ReturnType<typeof prepareImageOutput> | undefined,
  current: BunJob<T>,
  deadline: number,
  encode: (source: S, consume: (bytes: Uint8Array) => Promise<void>) => Promise<unknown>,
  operation: (stage: ImageOutputCapture<S> | undefined) => Promise<T>,
): Promise<T> {
  if (!output) return operation(undefined)
  let ready!: () => void, discard!: (reason: unknown) => void
  const barrier = new Promise<void>((resolve, reject) => {
    ready = resolve
    discard = reject
  })
  void barrier.catch(() => {})
  let pending: Promise<unknown> | undefined, captured = false, published = false
  const stage: ImageOutputCapture<S> = {
    capture(source) {
      current.check()
      if (captured) throw new CameraError(-2, 'image output already captured')
      captured = true
      // runImageJob admits/copies synchronously before its first await. Its
      // consume callback retains Home admission until this barrier and I/O join.
      pending = encode(source, async bytes => {
        await barrier
        current.check()
        await writeImageOutput(bytes, output, current, deadline)
      })
      void pending.catch(() => {})
    },
    async publish() {
      current.check()
      if (!pending || published) throw new CameraError(-2, 'image output is not prepared')
      published = true
      ready()
      await pending
      current.check()
    },
  }
  let failed = false, failure: unknown, value: T | undefined
  try {
    value = await operation(stage)
  } catch (error) {
    failed = true
    failure = error
  }
  if (!published) {
    if (!failed) {
      failed = true
      failure = new CameraError(-2, 'image output was not published')
    }
    discard(failure)
  }
  if (pending) {
    try {
      await pending
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      } else if (error !== failure && (!current.cancelRequested || error !== current.cancellationReason)) {
        failure = new AggregateError([failure, error], 'capture and image encoding failed')
      }
    }
  }
  if (failed) throw failure
  return value as T
}
