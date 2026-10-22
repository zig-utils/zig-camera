import { native as n, storage, ptr, view, check, type Pointer } from './ffi'
export interface DeviceState {
  connected: boolean
  running: boolean
  leased: number
  ready: number
  status: number
  /** Last completed event when the first loss notification was accepted. */
  disconnectEvent: bigint
}
export function decodeDeviceState(data: Uint8Array): Readonly<DeviceState> {
  const d = view(data)
  return Object.freeze({
    connected: !!d.getUint32(4, true),
    running: !!d.getUint32(8, true),
    leased: d.getUint32(12, true),
    status: d.getInt32(16, true),
    ready: d.getUint32(20, true),
    disconnectEvent: d.getBigUint64(24, true),
  })
}
export function readDeviceState(handle: Pointer) {
  const data = storage(32)
  check(n.zc_get_device_state(handle, ptr(data)), 'device state')
  return decodeDeviceState(data)
}
export function pollDisconnected(handle: Pointer, data = storage(32)) {
  const code = n.zc_wait_disconnected(handle, 0, ptr(data))
  if (code === -3) return undefined
  check(code, 'wait for camera disconnection')
  return decodeDeviceState(data)
}
/** One poll per camera turn, independently cancellable bounded subscribers. */
export class DisconnectObserver {
  private timer?: ReturnType<typeof setTimeout>
  private pending = new Map<
    symbol,
    (error?: unknown, state?: Readonly<DeviceState>) => void
  >()
  constructor(private poll: () => Readonly<DeviceState> | undefined) {}
  wait(signal: AbortSignal): Promise<Readonly<DeviceState>> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      if (this.pending.size >= 32) {
        reject(Error('disconnection observer capacity'))
        return
      }
      const token = Symbol(),
        abort = () => finish(signal.reason)
      const finish = (error?: unknown, state?: Readonly<DeviceState>) => {
        if (!this.pending.delete(token)) return
        signal.removeEventListener('abort', abort)
        if (!this.pending.size && this.timer !== undefined) {
          clearTimeout(this.timer)
          this.timer = undefined
        }
        if (state) resolve(state)
        else reject(error)
      }
      this.pending.set(token, finish)
      signal.addEventListener('abort', abort, { once: true })
      this.schedule()
    })
  }
  private schedule() {
    if (this.timer === undefined && this.pending.size)
      this.timer = setTimeout(() => this.tick(), 2)
  }
  private tick() {
    this.timer = undefined
    if (!this.pending.size) return
    try {
      const state = this.poll()
      if (state)
        for (const finish of [...this.pending.values()])
          finish(undefined, state)
    } catch (error) {
      for (const finish of [...this.pending.values()]) finish(error)
    }
    this.schedule()
  }
}
