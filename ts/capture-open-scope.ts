import { native as n, storage, ptr, view, outPointer, check, CameraError, type Pointer } from './ffi'
/** @internal Generation-checked native scope. Camera ownership remains here
 * through callbacks and actual native-thread retirement, until take succeeds. */
export class CaptureOpenScope {
  private owned: bigint
  constructor(allocation: Pointer, initial: Pointer | undefined, started: boolean, deadline: number) {
    const out = outPointer()
    const timeout = Number.isFinite(deadline) ? Math.min(0xfffffffe, Math.max(0, Math.ceil(deadline - Date.now()))) : 0xffffffff
    check(n.zc_capture_open_scope_open(allocation, initial ?? null, started ? 1 : 0, timeout, ptr(out)), 'open native capture scope')
    this.owned = out[0]
  }
  get id() { return this.owned }
  state() {
    const bytes = storage(40)
    check(n.zc_capture_open_scope_state_get(this.owned, ptr(bytes)), 'native capture scope state')
    const data = view(bytes), address = Number(data.getBigUint64(32, true))
    if (!Number.isSafeInteger(address)) throw new CameraError(-2, 'native capture scope camera pointer')
    return { stage: data.getUint32(4, true), started: !!data.getUint32(8, true), threads: data.getUint32(12, true), active: !!data.getUint32(16, true), pendingFactories: data.getUint32(20, true), cancelled: !!data.getUint32(24, true), aborted: !!data.getUint32(28, true), handle: address as Pointer }
  }
  cancel(fatal = false) { if (this.owned) check(n.zc_capture_open_scope_cancel(this.owned, fatal ? 1 : 0), 'cancel native capture scope') }
  async waitInactive() { while (this.state().active) await Bun.sleep(1) }
  async waitDetached() { while (this.state().threads) await Bun.sleep(1) }
  take() {
    const out = outPointer(), started = new Uint32Array(1)
    check(n.zc_capture_open_scope_take(this.owned, ptr(out), ptr(started)), 'take native capture scope camera')
    const address = Number(out[0])
    if (!Number.isSafeInteger(address)) throw new CameraError(-2, 'native capture scope camera pointer')
    return { handle: address as Pointer, started: !!started[0] }
  }
  /** Joined caller only. BUSY/cleanup failure preserves this scope for retry. */
  async close() {
    if (!this.owned) return
    check(n.zc_capture_open_scope_close(this.owned), 'close native capture scope')
    this.owned = 0n
  }
}
