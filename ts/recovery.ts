import { native as n, ptr, storage, view, check, CameraError } from './ffi'
import { BunJob, snapshotJobOptions, type JobOptions } from './jobs'
export interface ReconnectOptions<T = unknown> extends JobOptions<T> {
  maxAttempts?: number
  initialDelayMs?: number
  maximumDelayMs?: number
  /** Discovery refresh bound even if a backend omits an event. Default: 250 ms. */
  pollMs?: number
  /** Default: the source camera's admitted running intent. */
  start?: boolean
  dropFrames?: number
  autofocus?: boolean
  /** Restore the source preview/view/owned overlay snapshot. Default: true. */
  preview?: boolean
}
export function reconnectOptions<T>(
  source: ReconnectOptions<T>,
  started: boolean,
) {
  const maxAttempts = source.maxAttempts ?? 8,
    initialDelayMs = source.initialDelayMs ?? 50,
    maximumDelayMs = source.maximumDelayMs ?? 1000,
    pollMs = source.pollMs ?? 250,
    start = source.start ?? started,
    dropFrames = source.dropFrames ?? 0,
    autofocus = source.autofocus ?? false,
    preview = source.preview ?? true,
    job = snapshotJobOptions(source, 30000)
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 1024 ||
    !Number.isInteger(initialDelayMs) ||
    initialDelayMs < 0 ||
    initialDelayMs > 60000 ||
    !Number.isInteger(maximumDelayMs) ||
    maximumDelayMs < initialDelayMs ||
    maximumDelayMs > 60000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 60000 ||
    !Number.isInteger(dropFrames) ||
    dropFrames < 0 ||
    dropFrames > 0xffffffff ||
    typeof start !== 'boolean' ||
    typeof autofocus !== 'boolean' ||
    typeof preview !== 'boolean' ||
    (!start && (dropFrames !== 0 || autofocus))
  )
    throw new RangeError('invalid camera reconnection policy')
  return {
    maxAttempts,
    initialDelayMs,
    maximumDelayMs,
    pollMs,
    start,
    dropFrames,
    autofocus,
    preview,
    job,
  }
}
export interface ReconnectState {
  readonly attempts: number
  readonly maxAttempts: number
  readonly exhausted: boolean
  readonly retryPending: boolean
  /** Relative to this job's private monotonic epoch; not a sensor timestamp. */
  readonly deadlineNs: bigint
}
/** @internal All arithmetic/admission uses Home's native policy. */
export class RecoveryRetry {
  private data = storage(40)
  private epoch = performance.now()
  lastError: unknown
  constructor(options: {
    maxAttempts: number
    initialDelayMs: number
    maximumDelayMs: number
  }) {
    check(
      n.zc_recovery_retry_init(
        options.maxAttempts,
        BigInt(options.initialDelayMs) * 1000000n,
        BigInt(options.maximumDelayMs) * 1000000n,
        ptr(this.data),
      ),
      'reconnection retry policy',
    )
  }
  private now() {
    const ns = BigInt(
      Math.floor(Math.max(0, performance.now() - this.epoch) * 1000000),
    )
    return ns > 0xffffffffffffffffn ? 0xffffffffffffffffn : ns
  }
  get state(): Readonly<ReconnectState> {
    const d = view(this.data),
      attempts = d.getUint32(8, true),
      maxAttempts = d.getUint32(4, true)
    return Object.freeze({
      attempts,
      maxAttempts,
      exhausted: attempts >= maxAttempts,
      retryPending: !!d.getUint32(12, true),
      deadlineNs: d.getBigUint64(32, true),
    })
  }
  claim() {
    const result = n.zc_recovery_retry_poll(ptr(this.data), this.now(), 1)
    if (result < 0) throw new CameraError(result, 'reconnection retry claim')
    return result === 1
  }
  complete(failed: boolean) {
    check(
      n.zc_recovery_retry_observe(ptr(this.data), this.now(), failed ? 1 : 0),
      'reconnection retry completion',
    )
  }
  waitMs(cap: number) {
    const state = this.state
    if (!state.retryPending) return cap
    const remaining = state.deadlineNs - this.now()
    return Math.min(cap, Math.max(1, Number((remaining + 999999n) / 1000000n)))
  }
}
export class ReconnectJob<T> extends BunJob<T> {
  constructor(
    operation: (job: BunJob<T>) => Promise<T>,
    release: () => void,
    options: JobOptions<T>,
    readonly cameraId: string,
    private retry: RecoveryRetry,
  ) {
    super(operation, release, options)
  }
  get recoveryState() {
    return this.retry.state
  }
  get lastOpenError() {
    return this.retry.lastError
  }
}
