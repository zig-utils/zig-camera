import type { Pointer } from './ffi'
import type { JobOptions } from './jobs'
import { cameraDescriptors, readCatalog } from './catalog'
import {
  CameraError,
  check,
  handle,
  native as n,
  outPointer,
  ptr,
  storage,
  view,
} from './ffi'
import { BunJob, JobCancelledError, snapshotJobOptions } from './jobs'
import { guardOutputHook } from './outputs'
import { guardRequestCallback } from './request-hooks'

export interface CameraWatchOptions {
  simulate?: boolean
  capacity?: number
}
export interface CameraEvent {
  readonly backend: 'synthetic' | 'libcamera'
  readonly kind: 'added' | 'removed' | 'rescan'
  /** No ID for a rescan marker. IDs are exact, without normalization. */
  readonly id?: string
  readonly sequence: bigint
  /** Cumulative native queue evictions/invalid IDs. Rescan whenever this changes. */
  readonly missed: bigint
}
export interface CameraWatchState {
  readonly backend: 'synthetic' | 'libcamera'
  readonly capacity: number
  readonly queued: number
  readonly sequence: bigint
  readonly missed: bigint
  readonly stopped: boolean
  readonly waiters: number
}
type Pending = {
  job: BunJob<Readonly<CameraEvent>>
  resolve: (value: Readonly<CameraEvent>) => void
  reject: (reason: unknown) => void
  abort: () => void
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
function guard() {
  guardOutputHook()
  guardRequestCallback()
}
/** A bounded consuming watch. One event satisfies one next() job; use separate
 * watches for independent subscribers. It pins tuning/manager lifetime through
 * camera close/reopen gaps. Open before discovery, then rescan on events/loss. */
export class CameraWatch {
  private handle?: Pointer
  private readonly simulate: boolean
  private scratch = storage(4128)
  private pending: Pending[] = []
  private jobs = new Set<BunJob<Readonly<CameraEvent>>>()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private closing = false
  private closingJob?: Promise<void>
  constructor(options: CameraWatchOptions = {}) {
    guard()
    const simulate = options.simulate ?? false,
      capacity = options.capacity ?? 32
    if (
      typeof simulate !== 'boolean' ||
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 64
    )
      throw new RangeError('invalid camera watch configuration')
    this.simulate = simulate
    const out = outPointer()
    check(
      n.zc_camera_watch_open(simulate ? 0 : 1, capacity, ptr(out)),
      'open camera watch',
    )
    this.handle = handle(out)
  }
  private open(active = true): Pointer {
    guard()
    if (!this.handle || this.closing || (active && this.stopped))
      throw new CameraError(-2, 'camera watch closed or stopped')
    return this.handle
  }
  state(): Readonly<CameraWatchState> {
    const owned = this.open(false),
      data = storage(40)
    check(n.zc_camera_watch_get_state(owned, ptr(data)), 'camera watch state')
    const d = view(data)
    return Object.freeze({
      backend: this.simulate ? 'synthetic' : 'libcamera',
      capacity: d.getUint32(8, true),
      queued: d.getUint32(12, true),
      sequence: d.getBigUint64(16, true),
      missed: d.getBigUint64(24, true),
      stopped: !!d.getUint32(32, true),
      waiters: d.getUint32(36, true),
    })
  }
  discover() {
    this.open()
    return cameraDescriptors(
      readCatalog((out) => n.zc_discover(this.simulate ? 0 : 1, out)),
      this.simulate,
    )
  }
  next(options: JobOptions<Readonly<CameraEvent>> = {}) {
    this.open()
    const effective = snapshotJobOptions(options, 30000)
    this.open() // Accessors above may re-enter stop/close.
    if (this.jobs.size >= 32)
      throw new CameraError(-4, 'camera watch job queue')
    const job = new BunJob<Readonly<CameraEvent>>(
      (current) =>
        new Promise((resolve, reject) => {
          current.check()
          const abort = () => this.remove(entry, current.signal.reason)
          const entry: Pending = { job: current, resolve, reject, abort }
          this.pending.push(entry)
          current.signal.addEventListener('abort', abort, { once: true })
          this.schedule()
        }),
      () => {},
      effective,
    )
    // AbortSignal methods are application-accessible too. Construction may
    // re-enter stop/close or fill this queue; retire the unclaimed job instead
    // of adding work after close has captured its operation prefix.
    if (!this.handle || this.closing || this.stopped || this.jobs.size >= 32) {
      job.cancel(
        new CameraError(
          this.jobs.size >= 32 ? -4 : -2,
          'camera watch admission changed',
        ),
      )
      return job
    }
    this.jobs.add(job)
    void job.operationDone.then(() => this.jobs.delete(job))
    void job.start()
    return job
  }
  private remove(entry: Pending, reason?: unknown) {
    const index = this.pending.indexOf(entry)
    if (index === -1) return
    this.pending.splice(index, 1)
    entry.job.signal.removeEventListener('abort', entry.abort)
    if (!this.pending.length && this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (reason !== undefined) entry.reject(reason)
  }
  private schedule() {
    if (
      this.timer === undefined &&
      this.pending.length &&
      !this.closing &&
      !this.stopped
    )
      this.timer = setTimeout(() => this.tick(), 2)
  }
  private tick() {
    this.timer = undefined
    while (
      this.pending.length &&
      this.handle &&
      !this.closing &&
      !this.stopped
    ) {
      const entry = this.pending[0]
      try {
        entry.job.check()
        const code = n.zc_camera_watch_wait(this.handle, 0, ptr(this.scratch))
        if (code === -3) break
        check(code, 'camera hotplug event')
        const d = view(this.scratch),
          kind = d.getUint32(8, true),
          length = d.getUint32(12, true)
        if (
          d.getUint32(0, true) !== 4128 ||
          kind < 1 ||
          kind > 3 ||
          length > 4096 ||
          (kind === 3 ? length !== 0 : length === 0)
        )
          throw Error('invalid camera event')
        const event = Object.freeze({
          backend: this.simulate
            ? ('synthetic' as const)
            : ('libcamera' as const),
          kind:
            kind === 1
              ? ('added' as const)
              : kind === 2
                ? ('removed' as const)
                : ('rescan' as const),
          id: length
            ? utf8.decode(this.scratch.subarray(32, 32 + length))
            : undefined,
          sequence: d.getBigUint64(16, true),
          missed: d.getBigUint64(24, true),
        })
        // Seal in the same JS turn as native consumption. Cancellation cannot
        // remove an event after it was reserved for this job.
        entry.job.seal()
        this.remove(entry)
        entry.resolve(event)
      } catch (error) {
        this.remove(entry, error)
      }
    }
    this.schedule()
  }
  /** Diagnostic injection into this watch only; does not emulate USB topology. */
  simulateEvent(kind: 'added' | 'removed', id: string) {
    const owned = this.open()
    if (
      (kind !== 'added' && kind !== 'removed') ||
      typeof id !== 'string' ||
      !id.length ||
      id.includes('\0') ||
      !id.isWellFormed()
    )
      throw new RangeError('invalid camera event')
    const bytes = new TextEncoder().encode(id)
    if (bytes.length > 4096) throw new RangeError('camera ID too long')
    check(
      n.zc_camera_watch_simulate_event(
        owned,
        kind === 'added' ? 1 : 2,
        ptr(bytes),
        bytes.length,
      ),
      'simulate camera event',
    )
  }
  stop() {
    const owned = this.open(false)
    this.stopOwned(owned)
  }
  private stopOwned(owned: Pointer) {
    if (this.stopped) return
    this.stopped = true
    check(n.zc_camera_watch_stop(owned), 'stop camera watch')
    for (const job of this.jobs)
      job.cancel(new JobCancelledError('camera watch stopped'))
  }
  close(): Promise<void> {
    guard()
    if (this.closingJob) return this.closingJob
    if (!this.handle) return Promise.resolve()
    this.closing = true
    const owned = this.handle
    // Publish the close promise before aborting jobs: user abort listeners may
    // synchronously re-enter close and must join this same owner retirement.
    this.closingJob = Promise.resolve()
      .then(async () => {
        this.stopOwned(owned)
        await Promise.all([...this.jobs].map((job) => job.operationDone))
        check(n.zc_camera_watch_close(owned), 'close camera watch')
        this.handle = undefined
      })
      .finally(() => {
        this.closing = false
        this.closingJob = undefined
      })
    return this.closingJob
  }
  [Symbol.asyncDispose]() {
    return this.close()
  }
}
