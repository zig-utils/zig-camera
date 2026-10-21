import {
  native as n,
  ptr,
  storage,
  view,
  outPointer,
  handle,
  check,
  type Pointer,
} from './ffi'
export type RecordingBackpressure = 'wait' | 'drop'
export interface CaptureConsumerStats {
  id: bigint
  submitted: bigint
  completed: bigint
  skipped: bigint
  failures: bigint
  cancelled: bigint
  active: boolean
  pending: boolean
  failed: boolean
  retiring: boolean
  backpressure: RecordingBackpressure
}
function decode(data: Uint8Array): CaptureConsumerStats {
  const d = view(data),
    flags = d.getUint32(64, true)
  return {
    id: d.getBigUint64(0, true),
    submitted: d.getBigUint64(8, true),
    completed: d.getBigUint64(16, true),
    skipped: d.getBigUint64(24, true),
    failures: d.getBigUint64(32, true),
    cancelled: d.getBigUint64(40, true),
    active: !!(flags & 1),
    pending: !!(flags & 2),
    failed: !!(flags & 4),
    retiring: !!(flags & 8),
    backpressure: flags & 16 ? 'drop' : 'wait',
  }
}
/** Native state only stores identities and counters. Recorder workers own bytes. */
export class FrameFanout {
  private handle: Pointer
  constructor() {
    const out = outPointer()
    check(n.zc_fanout_open(ptr(out)))
    this.handle = handle(out)
  }
  add(policy: RecordingBackpressure) {
    const out = new BigUint64Array(1)
    check(
      n.zc_fanout_add(this.handle, policy === 'wait' ? 0 : 1, ptr(out)),
      'encoder attachment capacity',
    )
    return out[0]
  }
  ready() {
    return !!n.zc_fanout_ready(this.handle)
  }
  offer() {
    const out = new BigUint64Array(1)
    check(n.zc_fanout_offer(this.handle, ptr(out)))
    return out[0]
  }
  claim(id: bigint, frame: bigint) {
    const out = new BigUint64Array(1)
    const code = n.zc_fanout_claim(this.handle, id, frame, ptr(out))
    if (code === -3) return
    check(code)
    return out[0]
  }
  state(id: bigint) {
    const out = storage(72)
    check(n.zc_fanout_state_get(this.handle, id, ptr(out)))
    return decode(out)
  }
  finish(id: bigint, ticket: bigint, outcome: 0 | 1 | 2) {
    const out = storage(72)
    check(n.zc_fanout_finish(this.handle, id, ticket, outcome, ptr(out)))
    return decode(out)
  }
  fail(id: bigint) {
    const out = storage(72)
    check(n.zc_fanout_fail(this.handle, id, ptr(out)))
    return decode(out)
  }
  retire(id: bigint) {
    const out = storage(72)
    check(n.zc_fanout_retire(this.handle, id, ptr(out)))
    return decode(out)
  }
  close() {
    if (this.handle) {
      check(n.zc_fanout_close(this.handle))
      this.handle = 0 as Pointer
    }
  }
}
