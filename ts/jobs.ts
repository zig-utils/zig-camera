import { native as n, storage, ptr, view, check, CameraError } from './ffi'
export interface JobOptions<T = unknown> {
  timeoutMs?: number
  signal?: AbortSignal
  signalFunction?: (job: BunJob<T>) => void | Promise<void>
}
export class JobCancelledError extends Error {
  constructor(message = 'job cancelled') {
    super(message)
    this.name = 'JobCancelledError'
  }
}
export class BunJob<T> implements PromiseLike<T> {
  private gate = storage(8)
  private resolve!: (value: T) => void
  private reject!: (error: unknown) => void
  private completion: Promise<T>
  private claimed = false
  private settled = false
  private requested = false
  private reason: unknown = new JobCancelledError()
  private timer?: ReturnType<typeof setTimeout>
  private abort?: () => void
  private operation: ((job: BunJob<T>) => Promise<T>) | undefined
  private controller = new AbortController()
  readonly signal = this.controller.signal
  readonly cancellation = new SharedArrayBuffer(8)
  error: unknown
  callbackError: unknown
  value?: T
  operationDone: Promise<void>
  private releaseOperation!: () => void
  cleanupDone: Promise<void>
  private releaseCleanup!: () => void
  constructor(
    operation: (job: BunJob<T>) => Promise<T>,
    private release: () => void,
    private options: JobOptions<T> = {},
  ) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
    )
      throw new RangeError('invalid job deadline')
    n.zc_default_preparation_state(ptr(this.gate))
    this.operation = operation
    this.completion = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.completion.catch(() => {})
    this.operationDone = new Promise((resolve) => {
      this.releaseOperation = resolve
    })
    this.cleanupDone = new Promise((resolve) => {
      this.releaseCleanup = resolve
    })
    if (options.timeoutMs !== undefined)
      this.timer = setTimeout(
        () => this.cancel(new CameraError(-3, 'job deadline')),
        options.timeoutMs,
      )
    if (options.signal) {
      this.abort = () =>
        this.cancel(options.signal!.reason ?? new JobCancelledError())
      options.signal.addEventListener('abort', this.abort, { once: true })
      if (options.signal.aborted) queueMicrotask(this.abort)
    }
  }
  get done() {
    return this.settled
  }
  get state() {
    return this.settled ? 'finished' : this.claimed ? 'running' : 'queued'
  }
  get cancelRequested() {
    return this.requested
  }
  get cancellationReason() {
    return this.reason
  }
  get progress() {
    return Atomics.load(new Int32Array(this.cancellation), 1)
  }
  get phase() {
    return view(this.gate).getUint32(0, true)
  }
  check() {
    if (this.requested) throw this.reason
  }
  seal() {
    this.check()
    if (this.phase === 3) return
    if (
      n.zc_preparation_step(ptr(this.gate), 2) !== 1 ||
      n.zc_preparation_step(ptr(this.gate), 3) !== 1
    )
      throw new Error('job publication rejected')
  }
  cancel(reason: unknown = new JobCancelledError()) {
    if (this.settled || n.zc_preparation_step(ptr(this.gate), 4) !== 1)
      return false
    this.requested = true
    this.reason = reason
    Atomics.store(new Int32Array(this.cancellation), 0, 1)
    this.controller.abort(reason)
    if (!this.claimed) this.finish(undefined, reason)
    return true
  }
  async start() {
    if (this.options.timeoutMs !== undefined && this.options.timeoutMs === 0) {
      this.cancel(new CameraError(-3, 'job deadline'))
      return
    }
    if (this.settled || n.zc_preparation_step(ptr(this.gate), 1) !== 1) return
    this.claimed = true
    try {
      const result = await this.operation!(this)
      this.check()
      this.seal()
      this.finish(result)
    } catch (error) {
      if (this.requested && error === this.reason)
        n.zc_preparation_step(ptr(this.gate), 5)
      else n.zc_preparation_step(ptr(this.gate), 6)
      this.finish(
        undefined,
        error === undefined ? new Error('job threw undefined') : error,
      )
    }
  }
  private finish(value?: T, error?: unknown) {
    if (this.settled) return
    this.settled = true
    this.value = value
    this.error = error
    this.operation = undefined
    this.releaseOperation()
    if (this.timer) clearTimeout(this.timer)
    if (this.abort)
      this.options.signal!.removeEventListener('abort', this.abort)
    if (error !== undefined) this.reject(error)
    else this.resolve(value as T)
    if (!this.options.signalFunction) {
      this.release()
      this.releaseCleanup()
      return
    }
    void Promise.resolve()
      .then(() => this.options.signalFunction?.(this))
      .catch((error) => {
        this.callbackError = error
      })
      .finally(() => {
        this.release()
        this.releaseCleanup()
      })
  }
  wait() {
    return this.completion
  }
  result() {
    return this.completion
  }
  then<A = T, B = never>(
    fulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.completion.then(fulfilled, rejected)
  }
}
