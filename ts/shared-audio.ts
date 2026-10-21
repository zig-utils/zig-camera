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
export interface AudioConsumerStats {
  id: bigint
  nextTimestampNs: bigint | undefined
  admittedFrames: bigint
  overruns: bigint
  cancelledBatches: bigint
  active: boolean
  pending: boolean
}
export interface SharedAudioStats {
  closed: boolean
  frames: bigint
  blocks: bigint
  maxFrames: bigint
  maxBlocks: bigint
  highFrames: bigint
  highBlocks: bigint
  capturedFrames: bigint
  evictedFrames: bigint
  sampleRate: number
  channels: number
  clockErrorNs: bigint
  reads: bigint
  pendingFuture: boolean
  errorCode: number
}
export interface NativeAudioBatch {
  inputs: Uint8Array
  count: number
  ticket: bigint
}
function state(out: Uint8Array): AudioConsumerStats {
  const d = view(out),
    flags = d.getUint32(48, true)
  return {
    id: d.getBigUint64(0, true),
    nextTimestampNs: flags & 8 ? d.getBigUint64(8, true) : undefined,
    admittedFrames: d.getBigUint64(24, true),
    overruns: d.getBigUint64(32, true),
    cancelledBatches: d.getBigUint64(40, true),
    active: !!(flags & 1),
    pending: !!(flags & 2),
  }
}
/** One camera owns a capture cursor. All payload storage is native and bounded. */
export class SharedAudio {
  private handle: Pointer
  count = 0
  private originFrame?: bigint
  private final?: SharedAudioStats
  constructor(
    source: Pointer,
    frames: number,
    blocks: number,
    readonly fps: number,
  ) {
    const cfg = storage(16),
      d = view(cfg),
      out = outPointer()
    d.setUint32(0, 16, true)
    d.setUint32(4, frames, true)
    d.setUint32(8, blocks, true)
    check(
      n.zc_audio_fanout_open(source, ptr(cfg), ptr(out)),
      'shared microphone cursor',
    )
    this.handle = handle(out)
  }
  add() {
    const out = new BigUint64Array(1)
    check(n.zc_audio_fanout_add(this.handle, ptr(out)))
    this.count++
    return out[0]
  }
  timestamp(offered: bigint, real: bigint, synthetic: boolean) {
    this.originFrame ??= offered
    return synthetic
      ? ((offered - this.originFrame) * 1_000_000_000n) / BigInt(this.fps)
      : real
  }
  fill(timestamp: bigint) {
    check(
      n.zc_audio_fanout_fill(
        this.handle,
        timestamp + 1_000_000_000n / BigInt(this.fps),
        256,
      ),
      'shared audio capture',
    )
  }
  prepare(id: bigint, minimum: bigint): NativeAudioBatch {
    const inputs = storage(256 * 24),
      batch = storage(32)
    check(
      n.zc_audio_fanout_prepare(
        this.handle,
        id,
        minimum,
        minimum + 1_000_000_000n / BigInt(this.fps),
        ptr(inputs),
        256,
        ptr(batch),
      ),
      'shared audio window (retention overrun or invalid batch)',
    )
    return {
      inputs,
      count: view(batch).getUint32(24, true),
      ticket: view(batch).getBigUint64(0, true),
    }
  }
  finish(id: bigint, ticket: bigint, accepted: boolean) {
    const out = storage(56)
    check(
      n.zc_audio_fanout_finish(
        this.handle,
        id,
        ticket,
        Number(accepted),
        ptr(out),
      ),
    )
    return state(out)
  }
  check(id: bigint) {
    check(
      n.zc_audio_fanout_check(this.handle, id),
      'shared audio retention overrun',
    )
  }
  state(id: bigint) {
    const out = storage(56)
    check(n.zc_audio_fanout_state(this.handle, id, ptr(out)))
    return state(out)
  }
  retire(id: bigint) {
    const out = storage(56)
    check(n.zc_audio_fanout_retire(this.handle, id, ptr(out)))
    this.count--
    return state(out)
  }
  stats(): SharedAudioStats {
    if (this.final) return { ...this.final }
    const out = storage(96),
      d = view(out),
      u = (offset: number) => d.getBigUint64(offset, true)
    check(n.zc_audio_fanout_stats(this.handle, ptr(out)))
    return {
      closed: false,
      frames: u(0),
      blocks: u(8),
      maxFrames: u(16),
      maxBlocks: u(24),
      highFrames: u(32),
      highBlocks: u(40),
      capturedFrames: u(48),
      evictedFrames: u(56),
      sampleRate: d.getUint32(64, true),
      channels: d.getUint32(68, true),
      clockErrorNs: d.getBigInt64(72, true),
      reads: u(80),
      pendingFuture: !!d.getUint32(88, true),
      errorCode: d.getInt32(92, true),
    }
  }
  close() {
    if (this.handle) {
      const final = this.stats()
      check(n.zc_audio_fanout_close(this.handle))
      this.final = {
        ...final,
        closed: true,
        frames: 0n,
        blocks: 0n,
        pendingFuture: false,
      }
      this.handle = 0 as Pointer
    }
  }
}
