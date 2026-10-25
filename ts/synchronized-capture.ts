import { native as n, ptr, storage, view, check, CameraError } from './ffi'
import { BunJob, snapshotJobOptions, type JobOptions } from './jobs'
import type { Frame, CaptureOptions } from './index'

export interface SynchronizedCaptureOptions extends JobOptions<SynchronizedFrames> {
  /** Inclusive first-pixel timestamp span; defaults to one millisecond. */
  maxSkewNs?: bigint
  /** Total qualifying candidates across all members, including replacements. */
  maxFrames?: number
  /** Shared admission-time freshness threshold; defaults to true. */
  flush?: boolean | bigint
  /** Distinct requests skipped on each camera before its first candidate. */
  dropFrames?: number
  /** Require backend SyncReady on every candidate; defaults to true. */
  syncReady?: boolean
}

/** Cleanup errors retain every frame whose native release still needs retry. */
export class SynchronizedCaptureCleanupError extends AggregateError {
  private pending: Frame[]
  constructor(errors: unknown[], frames: readonly Frame[]) {
    super(errors, 'synchronized capture frame cleanup failed')
    this.name = 'SynchronizedCaptureCleanupError'
    this.pending = [...frames]
  }
  get unreleasedFrames(): readonly Frame[] { return Object.freeze([...this.pending]) }
  retryCleanup() {
    const failed: Frame[] = [], errors: unknown[] = []
    for (const frame of this.pending) {
      try { frame.release() } catch (error) { if (!frame.closed) failed.push(frame); errors.push(error) }
    }
    this.pending = failed
    if (errors.length) { this.errors = errors; throw this }
  }
}
function releaseFrames(frames: readonly Frame[]) {
  const failed: Frame[] = [], errors: unknown[] = []
  for (const frame of frames) {
    try { frame.release() } catch (error) { if (!frame.closed) failed.push(frame); errors.push(error) }
  }
  if (errors.length) throw new SynchronizedCaptureCleanupError(errors, failed)
}
export class SynchronizedFrames implements Disposable {
  readonly frames: readonly Frame[]
  readonly timestampsNs: readonly bigint[]
  readonly earliestNs: bigint
  readonly latestNs: bigint
  readonly skewNs: bigint
  private released = false
  /** @internal Native matching and ownership admission precede construction. */
  constructor(frames: readonly Frame[], timestamps: readonly bigint[], readonly candidateCount: number) {
    this.frames = Object.freeze([...frames])
    this.timestampsNs = Object.freeze([...timestamps])
    this.earliestNs = timestamps.reduce((a, b) => a < b ? a : b)
    this.latestNs = timestamps.reduce((a, b) => a > b ? a : b)
    this.skewNs = this.latestNs - this.earliestNs
  }
  get closed() { return this.released }
  release() {
    if (this.released) return
    releaseFrames(this.frames)
    this.released = true
  }
  [Symbol.dispose]() { this.release() }
}
/** @internal Snapshot all application accessors before reserving any camera. */
export function prepareSynchronizedCapture(source: SynchronizedCaptureOptions, count: number, clock: () => bigint) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('invalid synchronized capture options')
  const job = snapshotJobOptions(source, 5000), maxSkewNs = source.maxSkewNs ?? 1_000_000n,
    maxFrames = source.maxFrames ?? 4096, flush = source.flush ?? true,
    dropFrames = source.dropFrames ?? 0, syncReady = source.syncReady ?? true
  if (typeof maxSkewNs !== 'bigint' || maxSkewNs < 0n || maxSkewNs > 0xffffffffffffffffn) throw new RangeError('invalid synchronized timestamp tolerance')
  if (!Number.isInteger(maxFrames) || maxFrames < count || maxFrames > 65536) throw new RangeError('invalid synchronized candidate limit')
  if (!Number.isInteger(dropFrames) || dropFrames < 0 || dropFrames > 0xffffffff) throw new RangeError('invalid synchronized frame drops')
  if (typeof syncReady !== 'boolean') throw new TypeError('invalid synchronized readiness policy')
  if (typeof flush !== 'boolean' && typeof flush !== 'bigint') throw new TypeError('invalid synchronized freshness threshold')
  const threshold = flush === true ? clock() : flush === false ? undefined : flush
  if (threshold !== undefined && (threshold < 0n || threshold > 0xffffffffffffffffn)) throw new RangeError('invalid synchronized freshness threshold')
  return { job, maxSkewNs, maxFrames, dropFrames, syncReady, threshold }
}
export interface SynchronizedCapturePort {
  capture(options: CaptureOptions<Frame>, owner: BunJob<SynchronizedFrames>): BunJob<Frame>
}
/** @internal One retained candidate per camera; each child and release is joined. */
export async function runSynchronizedCapture(ports: readonly SynchronizedCapturePort[], plan: ReturnType<typeof prepareSynchronizedCapture>, current: BunJob<SynchronizedFrames>) {
  const held: Array<Frame | undefined> = Array(ports.length), stamps = new BigUint64Array(ports.length),
    last: Array<bigint | undefined> = Array(ports.length), events: Array<bigint | undefined> = Array(ports.length),
    decision = storage(32)
  let candidates = 0, published = false, failed = false, failure: unknown
  const collect = async (indices: number[], initial: boolean) => {
    if (candidates + indices.length > plan.maxFrames) throw new CameraError(-3, 'synchronized candidate limit')
    const pending: BunJob<Frame>[] = [], outcomes: Promise<void>[] = []
    let rejected = false, reason: unknown
    const abort = (error: unknown) => {
      if (!rejected) { rejected = true; reason = error }
      for (const child of pending) child.cancel(error)
    }
    try {
      for (const index of indices) {
        current.check()
        const child = ports[index].capture({ signal: current.signal, timeoutMs: plan.job.timeoutMs,
          flush: plan.threshold, dropFrames: initial ? plan.dropFrames : 0, syncReady: plan.syncReady }, current)
        candidates++
        pending.push(child)
        outcomes.push(child.wait().then(frame => {
          held[index] = frame
          const metadata = frame.metadata(), stamp = metadata.timestampNs
          if (!(metadata.validMask & 16)) throw new CameraError(-8, 'synchronized sensor timestamp unavailable')
          if ((last[index] !== undefined && stamp < last[index]!) || (events[index] !== undefined && metadata.eventId <= events[index]!))
            throw new CameraError(-9, 'synchronized request timestamps or identities regressed')
          last[index] = stamps[index] = stamp
          events[index] = metadata.eventId
        }).catch(error => { abort(error); throw error }))
      }
    } catch (error) { abort(error) }
    await Promise.allSettled(outcomes)
    await Promise.all(pending.map(child => child.cleanupDone))
    if (rejected) throw reason
    current.check()
  }
  try {
    await collect(ports.map((_, i) => i), true)
    while (true) {
      current.check()
      check(n.zc_match_frame_timestamps(ptr(stamps), stamps.length, plan.maxSkewNs, ptr(decision)), 'synchronized timestamp match')
      const mask = view(decision).getUint32(4, true)
      if (mask === 0) {
        const result = new SynchronizedFrames(held as Frame[], [...stamps], candidates)
        current.seal()
        published = true
        return result
      }
      const replace: number[] = []
      for (let i = 0; i < ports.length; i++) if (mask & (1 << i)) {
        held[i]!.release()
        held[i] = undefined
        replace.push(i)
      }
      await collect(replace, false)
    }
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    if (!published) {
      try { releaseFrames(held.filter((frame): frame is Frame => frame !== undefined)) }
      catch (cleanup) {
        if (failed && cleanup instanceof AggregateError) { cleanup.errors.unshift(failure); cleanup.cause = failure }
        throw cleanup
      }
    }
  }
}
