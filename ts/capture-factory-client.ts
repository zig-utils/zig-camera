import { JSCallback, FFIType } from 'bun:ffi'
import { native as n, storage, ptr, view, check, CameraError, type Pointer } from './ffi'
import { decodeCaptureLayout, encodeCaptureImport, type CaptureLayout, type CaptureImportBuffer } from './capture-allocator'
export interface CaptureFactoryContext {
  readonly layout: Readonly<CaptureLayout>
  readonly signal: AbortSignal
  readonly restoring: boolean
  readonly requestId: bigint
  readonly operationId: bigint
}
/** Input descriptors remain application-owned. release runs exactly once after
 * the import attempt (also on cancellation) and is joined before publication.
 * A failed release is reported with this returned object for caller recovery. */
export interface CaptureFactoryBuffers {
  readonly buffers: readonly (readonly CaptureImportBuffer[])[]
  release?(): void | PromiseLike<void>
}
export type CaptureBufferFactory = (context: Readonly<CaptureFactoryContext>) => CaptureFactoryBuffers | PromiseLike<CaptureFactoryBuffers>
export class CaptureFactoryError extends AggregateError {
  readonly requestId: bigint
  readonly operationId: bigint
  readonly returnedInputs?: CaptureFactoryBuffers
  constructor(errors: unknown[], context: Pick<CaptureFactoryContext, 'requestId' | 'operationId'>, returned?: CaptureFactoryBuffers) {
    super(errors, 'capture buffer factory failed')
    this.name = 'CaptureFactoryError'
    this.requestId = context.requestId; this.operationId = context.operationId; this.returnedInputs = returned
  }
}
function scopeState(scope: bigint) {
  const bytes = storage(40), code = n.zc_capture_open_scope_state_get(scope, ptr(bytes))
  if (code === -5) return undefined
  check(code, 'capture factory scope state')
  const data = view(bytes)
  return { pending: data.getUint32(20, true), cancelled: !!data.getUint32(24, true), aborted: !!data.getUint32(28, true) }
}
/** @internal One main-thread callback owner for one native imported allocator. */
export class CaptureFactoryClient {
  private callback: JSCallback
  private activities = new Map<bigint, { scope: bigint; done: Promise<void> }>()
  private errors = new Map<bigint, CaptureFactoryError[]>()
  private closed = false
  private reservedErrors = 0
  private errorCount = 0
  constructor(private allocation: Pointer, private create: CaptureBufferFactory) {
    this.callback = new JSCallback((_context: Pointer, ticket: bigint) => {
      this.dispatch(ticket)
    }, { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void, threadsafe: true })
    try { check(n.zc_capture_allocator_factory_set(allocation, this.callback.ptr, allocation), 'register capture factory') }
    catch (error) { this.callback.close(); throw error }
  }
  get busy() { return this.activities.size !== 0 }
  private dispatch(ticket: bigint) {
    if (this.closed) return
    const layoutBytes = storage(4304), stateBytes = storage(24)
    const begun = n.zc_capture_allocator_factory_begin(this.allocation, ticket, ptr(layoutBytes), ptr(stateBytes))
    if (begun === -4 || begun === -5) return // duplicate or already retired notice
    // Native begin has only OK/BUSY/STALE transitions for a registered notice.
    // Do not throw through a marshalled C callback if a future ABI rejects it.
    if (begun !== 0) return
    const state = view(stateBytes), scope = state.getBigUint64(16, true)
    const done = this.run(ticket, scope, layoutBytes, stateBytes)
    this.activities.set(ticket, { scope, done })
    void done.then(() => this.activities.delete(ticket), () => this.activities.delete(ticket))
  }
  private remember(scope: bigint, error: CaptureFactoryError) {
    const errors = this.errors.get(scope) ?? []
    // A diagnostic slot was reserved before invoking application work. Never
    // silently discard a returned input owner whose release failed.
    errors.push(error); this.errorCount++
    this.errors.set(scope, errors)
  }
  private async run(ticket: bigint, scope: bigint, layoutBytes: Uint8Array, stateBytes: Uint8Array) {
    const state = view(stateBytes), controller = new AbortController()
    let context: CaptureFactoryContext | undefined, returned: CaptureFactoryBuffers | undefined
    let release: CaptureFactoryBuffers['release'], code = 0, timer: ReturnType<typeof setInterval> | undefined
    const errors: unknown[] = []
    let reserved = false
    try {
      if (!state.getUint32(4, true)) return
      // Reserve diagnostics before application code can create input owners.
      // Raw C callers must consume errors too; stale scopes never erase them.
      if (this.errorCount + this.reservedErrors >= 64) { code = -4; return }
      this.reservedErrors++; reserved = true
      context = Object.freeze({ layout: decodeCaptureLayout(layoutBytes), signal: controller.signal, restoring: !!state.getUint32(8, true), requestId: ticket, operationId: scope })
      const observeCancellation = () => {
        const current = scopeState(scope)
        if (!current || current.aborted || (current.cancelled && !context!.restoring))
          controller.abort(new CameraError(-10, 'capture allocation cancelled'))
      }
      observeCancellation()
      timer = setInterval(observeCancellation, 10)
      if (controller.signal.aborted) throw controller.signal.reason
      returned = await this.create(context)
      if (!returned || typeof returned !== 'object') throw new TypeError('capture factory must return a buffer set')
      release = returned.release
      if (release !== undefined && typeof release !== 'function') throw new TypeError('invalid capture factory input release')
      if (controller.signal.aborted) throw controller.signal.reason
      const encoded = encodeCaptureImport(context.layout, returned.buffers)
      check(n.zc_capture_allocator_factory_supply(this.allocation, ticket, ptr(encoded.descriptors), encoded.count), 'supply capture factory buffers')
    } catch (error) {
      code = error instanceof CameraError && error.code >= -11 && error.code < 0 ? error.code : -6
      if (!(controller.signal.aborted && error === controller.signal.reason)) errors.push(error)
    } finally {
      if (release && returned) {
        try { await release.call(returned) }
        catch (error) { errors.push(error); code = -6 }
      }
      if (timer) clearInterval(timer)
      if (!code && controller.signal.aborted) code = -10
      const finished = n.zc_capture_allocator_factory_finish(this.allocation, ticket, code)
      if (finished !== 0) {
        errors.push(new CameraError(finished, 'finish capture factory'))
        // An invalid success (no supplied payload) leaves the claim live. Report
        // failure to retire it rather than stranding the native notification.
        if (finished === -2) n.zc_capture_allocator_factory_finish(this.allocation, ticket, -6)
      }
      if (reserved) this.reservedErrors--
      if (errors.length) {
        // Diagnostic identity does not decode a second time in a finally block.
        this.remember(scope, new CaptureFactoryError(errors, { requestId: ticket, operationId: scope }, returned))
      }
    }
  }
  async join(scope: bigint) {
    while (true) {
      const active = Array.from(this.activities.values()).filter(item => item.scope === scope)
      if (active.length) await Promise.all(active.map(item => item.done))
      // A marshalled callback may still be queued on Bun's main thread. Native
      // accounting retains that notification even before dispatch sees it.
      const state = scopeState(scope)
      if (!state || (!state.pending && !Array.from(this.activities.values()).some(item => item.scope === scope))) return
      await Bun.sleep(1)
    }
  }
  takeErrors(scope?: bigint): readonly CaptureFactoryError[] {
    if (scope !== undefined) { const errors = this.errors.get(scope) ?? []; this.errors.delete(scope); this.errorCount -= errors.length; return errors }
    const errors = Array.from(this.errors.values()).flat(); this.errors.clear(); this.errorCount = 0; return errors
  }
  close() {
    if (this.busy) throw new CameraError(-4, 'capture factory callbacks active')
    this.closed = true; this.callback.close()
  }
}
