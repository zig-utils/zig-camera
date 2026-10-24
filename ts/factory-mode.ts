import { native as n, ptr, type Pointer } from './ffi'
import { CaptureOpenScope } from './capture-open-scope'
import type { CaptureFactoryClient } from './capture-factory-client'
import type { ModeRequest, ModeResponse, ModeRequestHook } from './mode-worker'
export class FactoryScopeCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly owner: CaptureOpenScope, readonly dispatched: boolean) {
    super(errors, 'native camera scope retained for cleanup')
  }
}
/** Native scope, notification pins and TLS attachment independently own their
 * lifetimes. A Bun worker close event is never used as native retirement proof. */
export async function runFactoryMode(request: ModeRequest, factory: CaptureFactoryClient, hook?: (request: ModeRequestHook) => void): Promise<ModeResponse> {
  const scope = new CaptureOpenScope(request.allocation!, request.handle || undefined, request.previousStarted, request.deadline)
  let worker: Worker | undefined, callbackError: unknown, dispatched = false
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    worker = new Worker(new URL('./mode-worker.ts', import.meta.url).href)
    const current = worker
    const response = new Promise<ModeResponse>((resolve, reject) => {
      let settled = false
      current.onmessage = event => {
        if (settled) return
        if (event.data?.kind === 'request-hook') {
          const notice = event.data as ModeRequestHook
          const state = request.requestHooks && new Int32Array(request.requestHooks.control)
          if (!state || notice.ticket !== Atomics.load(state, 0) || Atomics.compareExchange(state, 1, 0, 1) !== 0) return
          let code = 0
          try {
            if (Atomics.load(new Int32Array(request.cancel), 0) || Date.now() >= request.deadline) code = -5
            else hook?.(notice)
          } catch (error) { callbackError ??= error; code = -6 }
          finally { Atomics.store(state, 2, code); Atomics.store(state, 1, 2); Atomics.notify(state, 1) }
          return
        }
        settled = true; resolve(event.data as ModeResponse)
      }
      current.onerror = event => { if (!settled) { settled = true; reject(new Error(event.message)) } }
    })
    const cancel = () => {
      if (Atomics.load(new Int32Array(request.cancel), 0) || Date.now() >= request.deadline) scope.cancel()
    }
    cancel(); timer = setInterval(cancel, 5)
    let result: ModeResponse
    try {
      current.postMessage({ ...request, openScope: scope.id })
      dispatched = true
      result = await response
    } catch (error) {
      // Stop preparation cooperatively before terminating its worker. Pending
      // main-thread producers still join even if they ignore cancellation.
      scope.cancel(true)
      await scope.waitInactive()
      current.terminate()
      await scope.waitDetached()
      await factory.join(scope.id)
      const state = scope.state()
      result = { handle: state.handle, code: -6, restoreCode: 0, controlCode: 0, restoreControlCode: 0,
        controlRevision: request.controlRevision, target: state.stage === 1, started: state.started }
      callbackError ??= error
      if (!dispatched) throw error
    }
    await scope.waitInactive()
    await factory.join(scope.id)
    current.terminate()
    await scope.waitDetached()
    const state = scope.state()
    // Scope state is authoritative even when the worker failed to publish its
    // last stop/open. No raw pointer from an error response becomes an owner.
    result.handle = state.handle; result.started = state.started
    result.target = state.stage === 1
    if (result.handle) {
      const count = new Uint32Array(1), revision = new BigUint64Array(1)
      const code = n.zc_get_controls(result.handle, null, 0, ptr(count), ptr(revision))
      if (code) result.code ||= code
      else result.controlRevision = revision[0]
    }
    const errors = factory.takeErrors(scope.id)
    if (errors.length) callbackError = new AggregateError([...(callbackError === undefined ? [] : [callbackError]), ...errors], 'camera factory callbacks failed')
    const taken = scope.take()
    result.handle = taken.handle; result.started = taken.started
    await scope.close()
    return { ...result, callbackError }
  } catch (error) {
    scope.cancel(true)
    await scope.waitInactive()
    worker?.terminate()
    await scope.waitDetached()
    await factory.join(scope.id)
    // A dispatch failure leaves the caller's original handle intact. Restore
    // that ownership before releasing the empty native scope.
    if (!dispatched && request.handle) scope.take()
    try { await scope.close() }
    catch (cleanup) { throw new FactoryScopeCleanupError([error, cleanup], scope, dispatched) }
    if (dispatched) throw new FactoryScopeCleanupError([error], scope, true)
    throw error
  } finally { if (timer) clearInterval(timer) }
}
