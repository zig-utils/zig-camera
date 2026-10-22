/** Chunk platform timers at the signed 32-bit limit and use a monotonic deadline.
 * A large timeout must never become the runtime's overflow-to-1ms timeout. */
export function armDeadline(
  durationMs: number,
  expire: () => void,
  host: {
    now: () => number
    schedule: (callback: () => void, delayMs: number) => unknown
    cancel: (handle: unknown) => void
  } = {
    now: () => performance.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
) {
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new RangeError('invalid job deadline')
  const deadline = host.now() + durationMs
  let handle: unknown,
    retired = false
  const tick = () => {
    if (retired) return
    const remaining = deadline - host.now()
    if (remaining <= 0) {
      retired = true
      expire()
    } else handle = host.schedule(tick, Math.min(remaining, 0x7fffffff))
  }
  handle = host.schedule(tick, Math.min(durationMs, 0x7fffffff))
  return () => {
    if (!retired) {
      retired = true
      host.cancel(handle)
    }
  }
}
