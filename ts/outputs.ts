import type { StreamColorSpace } from './images'
import { AsyncLocalStorage } from 'node:async_hooks'
import { open, lstat, unlink, type FileHandle } from 'node:fs/promises'
import { fstatSync, statSync } from 'node:fs'
import {
  native as n,
  ptr,
  view,
  storage,
  outPointer,
  handle,
  check,
  CameraError,
  type Pointer,
} from './ffi'
export interface OutputPacket {
  data: Uint8Array
  sourceTimestampNs: bigint
  timestampNs: bigint
  codec: number
  keyframe: boolean
  audio: boolean
  annexB: boolean
}
export interface OutputStreams {
  /** Encoded YCbCr description; absent for MJPEG. Header and MP4 tags agree. */
  colorSpace?: StreamColorSpace
  width: number
  height: number
  fps: number
  codec: number
  headers: Uint8Array
  audio?: { sampleRate: number; channels: number }
}
export interface CustomOutput {
  format?: 'packets' | 'mp4' | 'mkv'
  start?: () => void | Promise<void>
  streams?: (streams: OutputStreams) => void | Promise<void>
  commit?: () => void | Promise<void>
  outputframe?: (packet: OutputPacket) => void | Promise<void>
  write?: (data: Uint8Array) => void | number | Promise<void | number>
  patch?: (
    offset: bigint,
    data: Uint8Array,
  ) => void | number | Promise<void | number>
  stop?: (reason?: { discard: boolean }) => void | Promise<void>
  resources?: () => readonly object[]
  descriptors?: () => { file?: number; pts?: number; secondaryPts?: number }
}
export interface ByteSink {
  write(data: Uint8Array): void | number | Promise<void | number>
  patch?(
    offset: bigint,
    data: Uint8Array,
  ): void | number | Promise<void | number>
}
export interface HostOutputQueueStats {
  queuedBytes: bigint
  queuedOperations: bigint
  acceptedOperations: bigint
  completedOperations: bigint
  rejectedOperations: bigint
  highBytes: bigint
  highOperations: bigint
  maxBytes: bigint
  maxOperations: bigint
  acceptedBytes: bigint
  completedBytes: bigint
  waitRequests: bigint
  blockedWaits: bigint
  satisfiedWaits: bigint
  timedOutWaits: bigint
  cancelledWaits: bigint
  closedWaits: bigint
  pendingWaits: bigint
  totalWaitNs: bigint
  highWaitNs: bigint
  errorCode: number
  error: unknown
  inFlight: boolean
  inFlightBytes: bigint
  inFlightSequence: bigint
  abandonedBytes: bigint
  abandonedOperations: bigint
  closed: boolean
  retiring: boolean
}
export interface OutputCapacityOptions {
  minBytes?: number
  minOperations?: number
  timeoutMs?: number
}
const hooks = new AsyncLocalStorage<boolean>()
const claims = new WeakMap<object, object>()
type DescriptorClaim = { scope: OutputScope; role: number }
const descriptors = new Map<string, Set<DescriptorClaim>>()
/** Native path writers must respect host descriptors until their stop fence. */
export function guardHostPath(path: string) {
  let key: string
  try {
    const stat = statSync(path, { bigint: true })
    key = `${stat.dev}:${stat.ino}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (descriptors.has(key))
    throw new CameraError(-4, 'path aliases an owned host descriptor')
}
export interface OutputScope {
  owner: object
  id: bigint | symbol
}
const outputScope = Symbol('output scope')
export function guardOutputHook() {
  if (hooks.getStore())
    throw new CameraError(-2, 'output hook cannot re-enter camera/recorder')
}
function failure(error: unknown) {
  return error === undefined ? new Error('output hook threw undefined') : error
}
async function call<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  return hooks.run(true, operation)
}
/** @internal Share the camera/recorder reentrancy guard with still sink hooks. */
export {call as invokeOutputHook}
async function completeWrite(
  write: (
    data: Uint8Array,
    offset: number,
  ) => void | number | Promise<void | number>,
  data: Uint8Array,
) {
  let offset = 0
  while (offset < data.length) {
    const result = await write(data.subarray(offset), offset)
    if (result === undefined) return
    if (
      !Number.isInteger(result) ||
      result <= 0 ||
      result > data.length - offset
    )
      throw new CameraError(-6, 'invalid partial output progress')
    offset += result
  }
}
export class OutputBridge {
  readonly callbacks = storage(56)
  private handle: Pointer
  private claimed: object[] = []
  private timer?: ReturnType<typeof setTimeout>
  private pumping?: Promise<void>
  private enabled = false
  private freed = false
  private completed = 0n
  private issued = 0n
  private detached = false
  private discarded = false
  private retired?: Promise<void>
  private finalQueueStats?: HostOutputQueueStats
  private flight?: { bytes: bigint; sequence: bigint }
  private descriptorClaims: { key: string; claim: DescriptorClaim }[] = []
  error: unknown
  stopError: unknown
  onError?: (error: unknown) => void
  onRetired?: (stats: HostOutputQueueStats) => void
  constructor(
    readonly output: CustomOutput,
    options: {
      maxBytes?: number
      maxOperations?: number
      waitMs?: number
    } = {},
    readonly scope: OutputScope = { owner: {}, id: Symbol() },
  ) {
    const format = output.format ?? 'packets'
    if (!['packets', 'mp4', 'mkv'].includes(format))
      throw new RangeError('invalid output format')
    if (format === 'packets' && typeof output.outputframe !== 'function')
      throw new TypeError('packet output requires outputframe')
    if (format !== 'packets' && typeof output.write !== 'function')
      throw new TypeError('muxed output requires write')
    const resources = [
      output,
      ...hooks.run(true, () => output.resources?.() ?? []),
    ]
    for (const resource of resources) {
      if (
        (typeof resource !== 'object' && typeof resource !== 'function') ||
        resource === null
      )
        throw new TypeError('invalid output resource')
      if (claims.has(resource))
        throw new CameraError(-4, 'output resource already active')
    }
    const bytes = options.maxBytes ?? 16 * 1024 * 1024,
      operations = options.maxOperations ?? 4096
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > 1024 ** 3 ||
      !Number.isInteger(operations) ||
      operations <= 0 ||
      operations > 65536
    )
      throw new RangeError('invalid output mailbox bounds')
    const wait = options.waitMs ?? 100
    if (!Number.isFinite(wait) || wait < 0 || wait > 60000)
      throw new RangeError('invalid host backpressure deadline')
    const out = outPointer()
    check(n.zc_output_mailbox_open(BigInt(bytes), operations, ptr(out)))
    this.handle = handle(out)
    check(
      n.zc_output_mailbox_backpressure(
        this.handle,
        BigInt(Math.floor(wait * 1e6)),
      ),
    )
    for (const resource of new Set(resources)) {
      claims.set(resource, this)
      this.claimed.push(resource)
    }
    check(
      n.zc_output_mailbox_callbacks(
        this.handle,
        { packets: 0, mp4: 1, mkv: 2 }[format],
        ptr(this.callbacks),
      ),
    )
  }
  async start(streams: OutputStreams) {
    try {
      await call(() =>
        (
          this.output as CustomOutput & {
            [outputScope]?: (scope: OutputScope) => void
          }
        )[outputScope]?.(this.scope),
      )
      await call(() => this.output.start?.())
      await call(() =>
        this.output.streams?.({
          ...streams,
          headers: streams.headers.slice(),
          audio: streams.audio ? { ...streams.audio } : undefined,
        }),
      )
      const fds = await call(() => this.output.descriptors?.() ?? {})
      for (const [role, fd] of [
        fds.file,
        fds.pts,
        fds.secondaryPts,
      ].entries()) {
        if (fd === undefined || fd < 0) continue
        const stat = fstatSync(fd, { bigint: true }),
          key = `${stat.dev}:${stat.ino}`
        const claim = { scope: this.scope, role }
        const owners = descriptors.get(key) ?? new Set<DescriptorClaim>()
        for (const other of owners) {
          if (
            role !== 2 ||
            other.role !== 2 ||
            other.scope.owner !== claim.scope.owner ||
            other.scope.id !== claim.scope.id
          )
            throw new CameraError(-4, 'descriptor aliases an owned host output')
        }
        owners.add(claim)
        descriptors.set(key, owners)
        this.descriptorClaims.push({ key, claim })
      }
      view(this.callbacks).setInt32(40, fds.file ?? -1, true)
      view(this.callbacks).setInt32(44, fds.pts ?? -1, true)
      view(this.callbacks).setInt32(48, fds.secondaryPts ?? -1, true)
    } catch (error) {
      this.fail(error)
      throw this.error
    }
  }
  async enable() {
    try {
      await call(() => this.output.commit?.())
      this.enabled = true
      this.schedule()
    } catch (error) {
      this.fail(error)
      throw this.error
    }
  }
  stats(): HostOutputQueueStats {
    if (this.freed) return { ...this.finalQueueStats! }
    const data = storage(168)
    check(n.zc_output_mailbox_stats_get(this.handle, ptr(data)))
    const d = view(data),
      value = (offset: number) => d.getBigUint64(offset, true)
    return {
      queuedBytes: value(0),
      queuedOperations: value(8),
      acceptedOperations: value(16),
      completedOperations: value(24),
      rejectedOperations: value(32),
      highBytes: value(40),
      highOperations: value(48),
      maxBytes: value(56),
      maxOperations: value(64),
      acceptedBytes: value(72),
      completedBytes: value(80),
      waitRequests: value(88),
      blockedWaits: value(96),
      satisfiedWaits: value(104),
      timedOutWaits: value(112),
      cancelledWaits: value(120),
      closedWaits: value(128),
      pendingWaits: value(136),
      totalWaitNs: value(144),
      highWaitNs: value(152),
      errorCode: d.getInt32(160, true),
      error: this.error,
      inFlight: this.flight !== undefined,
      inFlightBytes: this.flight?.bytes ?? 0n,
      inFlightSequence: this.flight?.sequence ?? 0n,
      abandonedBytes: 0n,
      abandonedOperations: 0n,
      closed: this.freed,
      retiring: this.detached,
    }
  }
  capacityWait({
    minBytes = 0,
    minOperations = 1,
    timeoutMs = 100,
  }: OutputCapacityOptions) {
    if (this.detached || this.freed) throw new CameraError(-2, 'output retired')
    if (
      !Number.isSafeInteger(minBytes) ||
      minBytes < 0 ||
      !Number.isInteger(minOperations) ||
      minOperations < 1 ||
      minOperations > 65536 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 60000
    )
      throw new RangeError('invalid output capacity wait')
    const ticket = new BigUint64Array(1)
    check(
      n.zc_output_mailbox_wait_open(
        this.handle,
        BigInt(minBytes),
        minOperations,
        BigInt(Math.floor(timeoutMs * 1e6)),
        ptr(ticket),
      ),
      'output capacity wait',
    )
    let released = false
    return {
      close: () => {
        if (released) return
        released = true
        if (!this.freed) n.zc_output_mailbox_wait_close(this.handle, ticket[0])
      },
      wait: async (checkCancellation: () => void) => {
        while (true) {
          checkCancellation()
          if (this.detached || this.freed)
            throw new CameraError(-2, 'output retired')
          const state = storage(16)
          check(
            n.zc_output_mailbox_wait_poll(this.handle, ticket[0], ptr(state)),
          )
          const d = view(state)
          if (d.getUint32(12, true)) {
            check(d.getInt32(8, true), 'output capacity wait')
            return
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 1))
        }
      },
    }
  }
  private schedule() {
    if (
      !this.timer &&
      !this.detached &&
      this.enabled &&
      this.error === undefined
    )
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.pump()
      }, 1)
  }
  private pump(): Promise<void> {
    if (this.freed) return Promise.resolve()
    if (this.pumping) return this.pumping
    this.pumping = (async () => {
      try {
        for (
          let count = 0;
          count < 64 && !this.discarded && this.error === undefined;
          count++
        ) {
          const event = storage(48),
            code = n.zc_output_mailbox_peek(this.handle, ptr(event))
          if (code === -3) break
          check(code, 'output mailbox')
          const d = view(event),
            sequence = d.getBigUint64(0, true),
            offset = d.getBigUint64(8, true),
            timestampNs = d.getBigUint64(16, true),
            size = Number(d.getBigUint64(24, true)),
            kind = d.getUint32(32, true),
            codec = d.getUint32(36, true),
            flags = d.getUint32(40, true)
          const data = storage(size)
          if (size)
            check(
              n.zc_output_mailbox_copy(
                this.handle,
                sequence,
                ptr(data),
                BigInt(size),
              ),
            )
          this.flight = { bytes: BigInt(size), sequence }
          if (kind === 0) {
            if (this.output.outputframe)
              await call(() =>
                this.output.outputframe!({
                  data,
                  timestampNs,
                  sourceTimestampNs: offset,
                  codec,
                  keyframe: !!(flags & 1),
                  audio: !!(flags & 2),
                  annexB: !!(flags & 4),
                }),
              )
          } else if (kind === 1)
            await call(() =>
              completeWrite((bytes) => this.output.write!(bytes), data),
            )
          else {
            if (!this.output.patch)
              throw new CameraError(-8, 'output requires random-access patch')
            await call(() =>
              completeWrite(
                (bytes, index) =>
                  this.output.patch!(offset + BigInt(index), bytes),
                data,
              ),
            )
          }
          if (!this.discarded && this.error === undefined) {
            check(n.zc_output_mailbox_ack(this.handle, sequence))
            this.completed = sequence
          }
        }
      } catch (error) {
        this.fail(error)
      } finally {
        this.flight = undefined
      }
    })().finally(() => {
      this.pumping = undefined
      this.schedule()
    })
    return this.pumping
  }
  fail(error: unknown) {
    if (this.error !== undefined || this.discarded) return
    this.error = failure(error)
    if (!this.freed) n.zc_output_mailbox_fail(this.handle, -6)
    this.onError?.(this.error)
  }
  prefix() {
    if (this.freed) return this.issued
    const value = new BigUint64Array(1)
    check(n.zc_output_mailbox_prefix(this.handle, ptr(value)))
    this.issued = value[0]
    return value[0]
  }
  async drain(target = this.prefix()) {
    while (true) {
      if (this.pollDrain(target)) return
      await this.pump()
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  /** @internal A nonblocking poll; the bridge owns its pump and hook lifetime. */
  pollDrain(target: bigint) {
    if (target <= this.completed) return true
    if (this.freed) {
      if (this.error !== undefined) throw this.error
      throw new CameraError(-5, 'output retired before delivery')
    }
    const code = n.zc_output_mailbox_poll(this.handle, target)
    if (code === 0) return true
    if (code !== -3) {
      if (this.error !== undefined) throw this.error
      check(code, 'output delivery')
    }
    return false
  }
  retire(discard = false): Promise<void> {
    if (this.retired) return this.retired
    this.detached = true
    n.zc_output_mailbox_retire(this.handle)
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (discard) {
      this.discarded = true
      n.zc_output_mailbox_fail(this.handle, -5)
    }
    this.retired = (async () => {
      try {
        if (this.pumping) await this.pumping
        if (!discard) await this.drain()
      } catch (error) {
        this.error ??= failure(error)
      }
      try {
        await call(() => this.output.stop?.({ discard }))
      } catch (error) {
        this.stopError = failure(error)
        this.error ??= this.stopError
      } finally {
        this.issued = this.prefix()
        const final = this.stats()
        this.finalQueueStats = {
          ...final,
          closed: true,
          queuedBytes: 0n,
          queuedOperations: 0n,
          abandonedBytes: final.queuedBytes,
          abandonedOperations: final.queuedOperations,
        }
        n.zc_output_mailbox_close(this.handle)
        this.freed = true
        for (const resource of this.claimed)
          if (claims.get(resource) === this) claims.delete(resource)
        this.claimed = []
        for (const { key, claim } of this.descriptorClaims) {
          const owners = descriptors.get(key)
          owners?.delete(claim)
          if (owners?.size === 0) descriptors.delete(key)
        }
        this.descriptorClaims = []
        this.onRetired?.({ ...this.finalQueueStats })
      }
      if (this.error !== undefined) throw this.error
    })()
    return this.retired
  }
}
export class FileSink implements ByteSink {
  private file?: FileHandle
  private position = 0
  private created = false
  constructor(
    readonly path: string,
    readonly exclusive = true,
  ) {}
  async start() {
    if (this.file) throw new CameraError(-4, 'file sink active')
    this.position = 0
    this.created = false
    if (this.exclusive) {
      this.file = await open(this.path, 'wx+')
      this.created = true
    } else {
      try {
        this.file = await open(this.path, 'r+')
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error
        this.file = await open(this.path, 'wx+')
        this.created = true
      }
    }
  }
  async commit() {
    await this.file!.truncate(0)
  }
  get fd() {
    return this.file?.fd ?? -1
  }
  async write(data: Uint8Array) {
    const result = await this.file!.write(data, 0, data.length, this.position)
    this.position += result.bytesWritten
    return result.bytesWritten
  }
  async patch(offset: bigint, data: Uint8Array) {
    if (offset > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError('file offset overflow')
    return (await this.file!.write(data, 0, data.length, Number(offset)))
      .bytesWritten
  }
  async stop(reason?: { discard: boolean }) {
    const file = this.file
    this.file = undefined
    if (!file) return
    let owned: { dev: bigint; ino: bigint } | undefined
    let failure: unknown
    if (reason?.discard && this.created) {
      try {
        const stat = await file.stat({ bigint: true })
        owned = { dev: stat.dev, ino: stat.ino }
      } catch (error) {
        failure = error
      }
    }
    try {
      await file.close()
    } catch (error) {
      failure ??= error
    }
    if (owned) {
      try {
        const current = await lstat(this.path, { bigint: true })
        if (current.dev === owned.dev && current.ino === owned.ino)
          await unlink(this.path)
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
}
export class FileOutput implements CustomOutput {
  readonly format = 'packets' as const
  readonly sink: FileSink
  readonly pts?: FileSink
  constructor(
    path: string,
    options: { exclusive?: boolean; pts?: string } = {},
  ) {
    this.sink = new FileSink(path, options.exclusive ?? true)
    if (options.pts)
      this.pts = new FileSink(options.pts, options.exclusive ?? true)
  }
  resources() {
    return [this.sink, ...(this.pts ? [this.pts] : [])]
  }
  descriptors() {
    return { file: this.sink.fd, pts: this.pts?.fd }
  }
  async start() {
    await this.sink.start()
    await this.pts?.start()
  }
  async commit() {
    await this.sink.commit()
    await this.pts?.commit()
  }
  async outputframe(packet: OutputPacket) {
    if (packet.audio) return
    await completeWrite((data) => this.sink.write(data), packet.data)
    if (this.pts) {
      const text = storage(32),
        length = new Uint32Array(1)
      check(
        n.zc_format_pts(packet.timestampNs / 1000n, ptr(text), 32, ptr(length)),
      )
      await completeWrite(
        (data) => this.pts!.write(data),
        text.subarray(0, length[0]),
      )
    }
  }
  async stop(reason?: { discard: boolean }) {
    let failure: unknown
    try {
      await this.sink.stop(reason)
    } catch (error) {
      failure = error
    }
    try {
      await this.pts?.stop(reason)
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }
}
export class MuxedOutput implements CustomOutput {
  readonly sink: ByteSink & Partial<CustomOutput>
  constructor(
    target: string | ByteSink,
    readonly format: 'mp4' | 'mkv' = 'mp4',
    options: { exclusive?: boolean } = {},
  ) {
    this.sink =
      typeof target === 'string'
        ? new FileSink(target, options.exclusive ?? true)
        : target
  }
  resources() {
    return [this.sink, ...(this.sink.resources?.() ?? [])]
  }
  descriptors() {
    return this.sink instanceof FileSink
      ? { file: this.sink.fd }
      : (this.sink.descriptors?.() ?? {})
  }
  async start() {
    await this.sink.start?.()
  }
  async streams(streams: OutputStreams) {
    await this.sink.streams?.(streams)
  }
  async commit() {
    await this.sink.commit?.()
  }
  async outputframe(packet: OutputPacket) {
    await this.sink.outputframe?.(packet)
  }
  write(data: Uint8Array) {
    return this.sink.write(data)
  }
  patch(offset: bigint, data: Uint8Array) {
    if (!this.sink.patch)
      throw new CameraError(-8, 'AAC MP4 requires a patchable sink')
    return this.sink.patch(offset, data)
  }
  async stop(reason?: { discard: boolean }) {
    await this.sink.stop?.(reason)
  }
}

interface PtsLease {
  scope: OutputScope
  done: Promise<void>
  write(
    packet: Pick<OutputPacket, 'audio' | 'sourceTimestampNs'>,
  ): Promise<void>
  release(discard?: boolean): void
}
/** Explicitly owned shared video PTS sink. Close after every segment retires. */
export class PtsStream {
  private clock = storage(24)
  private active = 0
  private tail?: Pick<PtsLease, 'scope' | 'done'>
  private committed = false
  private committing?: Promise<void>
  private closed?: Promise<void>
  private resources: object[] = []
  error: unknown
  private constructor(readonly sink: ByteSink & Partial<CustomOutput>) {
    n.zc_default_pts_clock(ptr(this.clock))
  }
  static async open(
    target: string | ByteSink,
    options: { exclusive?: boolean } = {},
  ) {
    guardOutputHook()
    const sink =
      typeof target === 'string'
        ? new FileSink(target, options.exclusive ?? true)
        : target
    if (typeof sink.write !== 'function')
      throw new TypeError('PTS sink requires write')
    const stream = new PtsStream(sink)
    const resources = [
      stream,
      sink,
      ...(await call(
        () => (sink as Partial<CustomOutput>).resources?.() ?? [],
      )),
    ]
    for (const resource of resources) {
      if (
        !resource ||
        (typeof resource !== 'object' && typeof resource !== 'function')
      )
        throw new TypeError('invalid PTS resource')
      if (claims.has(resource)) throw new CameraError(-4, 'PTS resource active')
    }
    stream.resources = [...new Set(resources)]
    for (const resource of stream.resources) claims.set(resource, stream)
    try {
      await call(() => stream.sink.start?.())
      return stream
    } catch (error) {
      try {
        await stream.close()
      } catch {}
      throw error
    }
  }
  descriptor() {
    return this.sink instanceof FileSink
      ? this.sink.fd
      : (this.sink.descriptors?.().file ?? -1)
  }
  async commit() {
    if (this.error !== undefined) throw this.error
    if (this.closed) throw new CameraError(-2, 'PTS stream closed')
    if (this.committed) return
    if (!this.committing)
      this.committing = (async () => {
        try {
          await this.sink.commit?.()
          this.committed = true
        } catch (error) {
          this.error = failure(error)
          throw this.error
        }
      })()
    await this.committing
  }
  lease(scope: OutputScope): PtsLease {
    if (this.closed) throw new CameraError(-2, 'PTS stream closed')
    if (this.error !== undefined) throw this.error
    const previous = this.tail
    if (
      previous &&
      (previous.scope.owner !== scope.owner || previous.scope.id !== scope.id)
    )
      throw new CameraError(-4, 'shared PTS requires one logical output')
    let finish!: () => void
    let released = false
    const own = new Promise<void>((resolve) => {
      finish = resolve
    })
    const done = own
    const fence = { scope, done }
    const lease: PtsLease = {
      scope,
      done,
      write: async (packet) => {
        if (packet.audio) return
        await previous?.done
        if (released) throw new CameraError(-5, 'PTS lease retired')
        if (this.error !== undefined) throw this.error
        try {
          const timestamp = new BigUint64Array(1),
            text = storage(32),
            length = new Uint32Array(1)
          check(
            n.zc_pts_clock_accept(
              ptr(this.clock),
              packet.sourceTimestampNs,
              ptr(timestamp),
            ),
            'shared PTS clock',
          )
          check(
            n.zc_format_pts(timestamp[0], ptr(text), text.length, ptr(length)),
          )
          await completeWrite(
            (bytes) => this.sink.write(bytes),
            text.subarray(0, length[0]),
          )
        } catch (error) {
          this.error = failure(error)
          throw this.error
        }
      },
      release: (discard = false) => {
        if (released) return
        released = true
        this.active--
        // An unpublished replacement must leave the active predecessor's
        // fence in place. It must not add a pending promise per cancellation.
        if (discard && this.tail === fence) this.tail = previous
        finish()
      },
    }
    this.active++
    this.tail = fence
    return lease
  }
  close(): Promise<void> {
    guardOutputHook()
    if (this.closed) return this.closed
    if (this.active) throw new CameraError(-4, 'PTS stream still leased')
    this.closed = (async () => {
      try {
        await this.tail?.done
        await call(() => this.sink.stop?.({ discard: !this.committed }))
      } catch (error) {
        this.error ??= failure(error)
      } finally {
        for (const resource of this.resources)
          if (claims.get(resource) === this) claims.delete(resource)
        this.resources = []
      }
      if (this.error !== undefined) throw this.error
    })()
    return this.closed
  }
  async [Symbol.asyncDispose]() {
    await this.close()
  }
}
/** Adds a shared source-clock PTS observer without changing segment-local PTS. */
export class PtsOutput implements CustomOutput {
  readonly format: 'packets' | 'mp4' | 'mkv'
  private scope?: OutputScope
  private lease?: PtsLease
  constructor(
    readonly output: CustomOutput,
    readonly pts: PtsStream,
  ) {
    this.format = output.format ?? 'packets'
  }
  [outputScope](scope: OutputScope) {
    this.scope = scope
  }
  resources() {
    return [this.output, ...(this.output.resources?.() ?? [])]
  }
  descriptors() {
    const fds = this.output.descriptors?.() ?? {}
    if (fds.secondaryPts !== undefined && fds.secondaryPts >= 0)
      throw new CameraError(-8, 'secondary PTS already assigned')
    return { ...fds, secondaryPts: this.pts.descriptor() }
  }
  async start() {
    await this.output.start?.()
    this.lease = this.pts.lease(this.scope!)
  }
  async streams(info: OutputStreams) {
    await this.output.streams?.(info)
  }
  async commit() {
    await this.output.commit?.()
    await this.pts.commit()
  }
  async outputframe(packet: OutputPacket) {
    const { audio, sourceTimestampNs } = packet
    await this.output.outputframe?.(packet)
    await this.lease!.write({ audio, sourceTimestampNs })
  }
  write(bytes: Uint8Array) {
    return this.output.write!(bytes)
  }
  patch(offset: bigint, bytes: Uint8Array) {
    if (!this.output.patch) throw new CameraError(-8, 'output requires patch')
    return this.output.patch(offset, bytes)
  }
  async stop(reason?: { discard: boolean }) {
    try {
      await this.output.stop?.(reason)
    } finally {
      this.lease?.release(reason?.discard)
      this.lease = undefined
    }
  }
}

/** Factory callbacks follow the same no-reentry rule as output hooks. */
export function invokeOutputFactory<T>(operation: () => T | Promise<T>) {
  return call(operation)
}
/** Claim before discarding a late/invalid factory result; never stop an active sink. */
export async function discardFactoryOutput(output: CustomOutput) {
  if (!output || (typeof output !== 'object' && typeof output !== 'function'))
    return
  const resources = [output, ...(await call(() => output.resources?.() ?? []))]
  for (const resource of resources) {
    if (
      !resource ||
      (typeof resource !== 'object' && typeof resource !== 'function')
    )
      throw new TypeError('invalid factory resource')
    if (claims.has(resource))
      throw new CameraError(-4, 'factory returned an active resource')
  }
  const owner = {}
  for (const resource of resources) claims.set(resource, owner)
  try {
    await call(() => output.stop?.({ discard: true }))
  } finally {
    for (const resource of resources)
      if (claims.get(resource) === owner) claims.delete(resource)
  }
}
