import type { ByteSink } from './outputs'
import { CameraError, check, native as n, ptr, storage } from './ffi'
import { socketOwners as owners } from './socket-ownership'

export interface ManagedTransport {
  write(data:Uint8Array):number
  flush?(signal:AbortSignal):void|Promise<void>
  finish?(signal:AbortSignal):void|Promise<void>
  close():void|Promise<void>
}
export interface ManagedTransportHandlers {writable():void; error(error:unknown):void}
export type ManagedTransportFactory = (handlers:ManagedTransportHandlers, signal:AbortSignal)=>Promise<ManagedTransport>
export interface TransportSinkOptions {datagram?:boolean; chunkBytes?:number; startupTimeoutMs?:number; writeTimeoutMs?:number; finishTimeoutMs?:number; open:ManagedTransportFactory}
const active = new Set<TransportSink>()
const errorValue = (e:unknown)=>e??new Error('transport failed')
function timeout(value:number) { if(!Number.isFinite(value)||value<=0||value > 60000)throw new RangeError('invalid transport deadline'); return value}
/** Internal shared lifecycle. Native mailbox owns recording queues; the Home
 * cursor owns prefix/datagram progress. One borrowed input, 16 active sinks. */
export class TransportSink implements ByteSink, AsyncDisposable {
  private readonly datagram: boolean
  private readonly chunk: number
  private readonly connectMs: number
  private readonly writeMs: number
  private readonly finishMs: number
  private readonly factory: ManagedTransportFactory
  private phase: 'idle' | 'starting' | 'prepared' | 'active' | 'stopping' | 'stopped' = 'idle'
  private transport?: ManagedTransport
  private opening?: Promise<void>
  private flight?: Promise<void>
  private stopping?: Promise<void>
  private controller?: AbortController
  private finishing?: AbortController
  private flushing?: AbortController
  private wake?: () => void
  private epoch = 0
  private generation = 0
  private failure: unknown
  private observed = false
  private discarded = false
  private bytes = 0n
  private chunks = 0n
  private waits = 0n
  constructor(source:TransportSinkOptions) {
    const datagram = source.datagram??false, chunk = source.chunkBytes??65536, factory = source.open
    if(typeof datagram!=='boolean'||!Number.isInteger(chunk)||chunk < 1||chunk>(datagram?65507:1024 * 1024)||typeof factory!=='function')throw new RangeError('invalid transport configuration')
    this.datagram = datagram; this.chunk = chunk; this.factory = factory
    this.connectMs = timeout(source.startupTimeoutMs??5000); this.writeMs = timeout(source.writeTimeoutMs??2000); this.finishMs = timeout(source.finishTimeoutMs??2000)
  }
  private fail(e: unknown) {
    this.failure ??= errorValue(e)
    this.wake?.()
    this.flushing?.abort(this.failure)
    this.finishing?.abort(this.failure)
  }
  start(): Promise<void> {
    if (this.stopping || (this.phase !== 'idle' && this.phase !== 'stopped')) return Promise.reject(new CameraError(-4, 'transport sink active'))
    if (active.size >= 16) return Promise.reject(new CameraError(-4, 'transport sink capacity'))
    active.add(this); this.phase = 'starting'; this.failure = undefined; this.observed = false; this.discarded = false
    this.bytes = 0n; this.chunks = 0n; this.waits = 0n
    const generation = ++this.generation, controller = this.controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new CameraError(-3, 'transport setup deadline')), this.connectMs)
    this.opening = Promise.resolve().then(async () => {
      try {
        const transport = await this.factory({
          writable: () => { if (generation === this.generation) { this.epoch++; this.wake?.() } },
          error: e => { if (generation === this.generation) this.fail(e) },
        }, controller.signal)
        if (!transport || typeof transport.write !== 'function' || typeof transport.close !== 'function' ||
        (transport.finish !== undefined && typeof transport.finish !== 'function') ||
        (transport.flush !== undefined && typeof transport.flush !== 'function')) throw new TypeError('invalid transport')
        if (owners.has(transport)) throw new CameraError(-4, 'transport already owned')
        owners.set(transport, this); this.transport = transport
        controller.signal.throwIfAborted()
        if (this.failure !== undefined) throw this.failure
        if (this.phase === 'starting') this.phase = 'prepared'
      } catch (e) {
        this.fail(e); this.observed = true; this.phase = 'stopping'
        try { await this.retire() } catch (cleanup) { throw new AggregateError([e, cleanup], 'transport setup cleanup failed') }
        throw e
      } finally { clearTimeout(timer) }
    })
    return this.opening
  }
  commit() {
    if (this.phase !== 'prepared' || this.failure !== undefined) throw this.failure ?? new CameraError(-2, 'transport sink not prepared')
    this.phase = 'active'
  }
  private async writable(epoch: number, deadline: number) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new CameraError(-3, 'transport write deadline')
    this.waits++
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.wake = undefined; resolve() }
      const timer = setTimeout(() => { this.wake = undefined; reject(new CameraError(-3, 'transport write deadline')) }, remaining)
      this.wake = done
      if (this.epoch !== epoch || this.failure !== undefined || this.discarded) done()
    })
  }
  write(data: Uint8Array): Promise<void> {
    if (this.phase !== 'active' || this.failure !== undefined || this.flight) {
      if (this.failure !== undefined) this.observed = true
      return Promise.reject(this.failure ?? new CameraError(-4, 'transport sink unavailable'))
    }
    if (!(data instanceof Uint8Array) || data.length > 16 * 1024 * 1024) return Promise.reject(new RangeError('invalid transport write bytes'))
    const cursor = storage(32), offset = new BigUint64Array(1), size = new Uint32Array(1)
    check(n.zc_socket_write_init(BigInt(data.length), this.chunk, +this.datagram, ptr(cursor)))
    const deadline = performance.now() + this.writeMs
    this.flight = Promise.resolve().then(async () => {
      try {
        let burst = 0
        for (;; ) {
          if (this.failure !== undefined) throw this.failure
          if (this.discarded) throw new CameraError(-2, 'transport write discarded')
          if (performance.now() > deadline) throw new CameraError(-3, 'transport write deadline')
          check(n.zc_socket_write_next(ptr(cursor), ptr(offset), ptr(size)))
          if (!size[0]) break
          const epoch = this.epoch, begin = Number(offset[0]), count = this.transport!.write(data.subarray(begin, begin + size[0]))
          if (!Number.isInteger(count) || count < 0 || count > size[0]) throw new CameraError(-6, 'invalid transport write progress')
          check(n.zc_socket_write_accept(ptr(cursor), count), 'transport write progress')
          if (!count) { await this.writable(epoch, deadline); continue }
          this.bytes += BigInt(count); this.chunks++
          if (++burst === 32) { burst = 0; await Bun.sleep(0) }
        }
        if (this.transport?.flush) {
          const remaining = deadline - performance.now()
          if (remaining <= 0) throw new CameraError(-3, 'transport write deadline')
          const controller = this.flushing = new AbortController()
          const timer = setTimeout(() => controller.abort(new CameraError(-3, 'transport write deadline')), remaining)
          try { await this.transport.flush(controller.signal) }
          finally { clearTimeout(timer); this.flushing = undefined }
        }
        if (this.failure !== undefined) throw this.failure
      } catch (e) { this.fail(e); this.observed = true; throw e }
    }).finally(() => { this.flight = undefined })
    return this.flight
  }
  private async retire() {
    if (this.transport) { await this.transport.close(); owners.delete(this.transport); this.transport = undefined }
    active.delete(this); this.phase = 'stopped'
  }
  stop(reason?: { discard: boolean }): Promise<void> {
    const discard = reason?.discard ?? false
    if (typeof discard !== 'boolean') return Promise.reject(new TypeError('invalid transport discard'))
    if (this.phase === 'idle' || this.phase === 'stopped') return Promise.resolve()
    if (discard) {
      this.discarded = true
      this.controller?.abort(new CameraError(-2, 'transport setup discarded'))
      this.finishing?.abort(new CameraError(-2, 'transport finish discarded'))
      this.flushing?.abort(new CameraError(-2, 'transport flush discarded'))
      this.wake?.()
    }
    if (this.stopping) return this.stopping
    this.phase = 'stopping'
    const opening = this.opening, flight = this.flight
    this.stopping = Promise.resolve().then(async () => {
      let error: unknown
      try {
        await opening; await flight
        if (!this.discarded && this.failure === undefined && this.transport?.finish) {
          const controller = this.finishing = new AbortController()
          const timer = setTimeout(() => controller.abort(new CameraError(-3, 'transport finish deadline')), this.finishMs)
          try { await this.transport.finish(controller.signal) } finally { clearTimeout(timer); this.finishing = undefined }
        }
      } catch (e) { if (!this.discarded && !this.observed) { error = errorValue(e); this.fail(e) } }
      finally {
        try { await this.retire() } catch (e) { error = errorValue(e) }
      }
      if (!this.discarded && !this.observed) error ??= this.failure
      if (error !== undefined) { this.observed = true; throw error }
    }).finally(() => { this.stopping = undefined })
    return this.stopping
  }
  stats() { return Object.freeze({ phase: this.phase, session: this.generation, inFlight: !!this.flight, bytes: this.bytes, chunks: this.chunks, waits: this.waits, error: this.failure }) }
  close() { return this.stop({ discard: true }) }
  async [Symbol.asyncDispose]() { await this.close() }
}
