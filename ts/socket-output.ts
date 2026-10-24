import type { ByteSink, CustomOutput, OutputPacket, OutputStreams } from './outputs'
import { createConnection, isIP } from 'node:net'
import { CameraError, check, native as n, ptr, storage } from './ffi'
import { socketOwners as owners } from './socket-ownership'

export interface SocketTransport {
  /** Accepted bytes are owned by the transport. Zero means wait for writable.
   * UDP must accept the entire supplied datagram or zero. */
  write(data: Uint8Array): number
  /** Join any buffered accepted tail before completing a producer write. */
  flush?(signal: AbortSignal): void | Promise<void>
  /** Finish accepted local writes. This is not a receiver acknowledgement. */
  finish?(signal: AbortSignal): void | Promise<void>
  /** Resolve only after retirement; failure retains this owner for retry. */
  close(): void | Promise<void>
}
export interface SocketTransportHandlers {
  writable(): void
  error(error: unknown): void
}
export type SocketTransportFactory = (
  endpoint: Readonly<{ protocol: 'tcp' | 'udp'; address: string; port: number }>,
  handlers: SocketTransportHandlers,
  signal: AbortSignal,
) => Promise<SocketTransport>
export interface SocketSinkOptions {
  protocol?: 'tcp' | 'udp'
  address: string
  port: number
  /** UDP raw split size, default 1200; TCP syscall chunk, default 65536. */
  chunkBytes?: number
  connectTimeoutMs?: number
  writeTimeoutMs?: number
  finishTimeoutMs?: number
  socketFactory?: SocketTransportFactory
}
const active = new Set<SocketSink>()
const errorValue = (e: unknown) => e ?? new Error('socket transport failed')
const timeout = (value: number) => {
  if (!Number.isFinite(value) || value <= 0 || value > 60000)
    throw new RangeError('invalid socket deadline')
  return value
}
const defaultFactory: SocketTransportFactory = async (endpoint, handlers, signal) => {
  signal.throwIfAborted()
  if (endpoint.protocol === 'udp') {
    const socket = await Bun.udpSocket({
      hostname: isIP(endpoint.address) === 6 ? '::' : '0.0.0.0',
      connect: { hostname: endpoint.address, port: endpoint.port },
      socket: {
        drain: () => handlers.writable(),
        error: (_, e) => handlers.error(e),
      },
    })
    if (signal.aborted) { socket.close(); signal.throwIfAborted() }
    return {
      write(bytes) {
        if (socket.closed) throw new CameraError(-2, 'closed UDP socket')
        return socket.send(bytes) ? bytes.length : 0
      },
      close() { socket.close() },
    }
  }
  // Node-compatible sockets give us a cancellable handle before connect. Only
  // one owned bounded chunk can be queued; never use its unlimited write queue.
  const socket = createConnection({ host: endpoint.address, port: endpoint.port, allowHalfOpen: true })
  let closing = false, pending = false, closed = false
  let flushed: ((error?: unknown) => void) | undefined
  const joined = new Promise<void>(resolve => socket.once('close', () => { closed = true; resolve() }))
  socket.on('error', e => handlers.error(e))
  // A peer may close its write half while continuing to receive our media.
  socket.on('close', () => { if (!closing) handlers.error(new CameraError(-2, 'TCP peer closed')) })
  socket.resume()
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off('connect', connected); socket.off('error', failed)
        socket.off('close', ended); signal.removeEventListener('abort', aborted)
      }
      const connected = () => { cleanup(); resolve() }
      const failed = (e: unknown) => { cleanup(); reject(e) }
      const ended = () => failed(new CameraError(-2, 'TCP connect closed'))
      const aborted = () => { closing = true; socket.destroy(); failed(signal.reason) }
      socket.once('connect', connected); socket.once('error', failed); socket.once('close', ended)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
    socket.setNoDelay(true)
  } catch (e) { closing = true; socket.destroy(); await joined; throw e }
  return {
    write(data) {
      if (closed || closing || socket.destroyed) throw new CameraError(-2, 'closed TCP socket')
      if (pending) return 0
      pending = true
      try {
        // Own at most one chunk until the runtime completes its write callback.
        socket.write(Buffer.from(data), e => {
          pending = false
          if (e) handlers.error(e)
          flushed?.(e ?? undefined)
          handlers.writable()
        })
      } catch (e) { pending = false; throw e }
      return data.length
    },
    async flush(flushSignal) {
      flushSignal.throwIfAborted()
      if (!pending) return
      await new Promise<void>((resolve, reject) => {
        const complete = (error?: unknown) => {
          flushed = undefined
          flushSignal.removeEventListener('abort', aborted)
          error === undefined ? resolve() : reject(error)
        }
        const aborted = () => {
          closing = true
          socket.destroy()
          complete(flushSignal.reason)
        }
        flushed = complete
        flushSignal.addEventListener('abort', aborted, { once: true })
        if (flushSignal.aborted) aborted()
      })
    },
    async finish(finishSignal) {
      finishSignal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off('error', failed); socket.off('close', ended)
          finishSignal.removeEventListener('abort', aborted)
        }
        const failed = (e: unknown) => { cleanup(); reject(e) }
        const ended = () => failed(new CameraError(-2, 'TCP closed before finish'))
        const aborted = () => { closing = true; socket.destroy(); failed(finishSignal.reason) }
        socket.once('error', failed); socket.once('close', ended)
        finishSignal.addEventListener('abort', aborted, { once: true })
        if (finishSignal.aborted) aborted()
        else socket.end(() => { cleanup(); closing = true; resolve() })
      })
    },
    async close() { closing = true; socket.destroy(); await joined },
  }
}

/** Reusable bounded TCP byte sink or raw UDP splitter. A pending write borrows
 * its input until settlement. Recorder output bytes already have native mailbox
 * ownership; direct callers must retain immutable bytes through the promise. */
export class SocketSink implements ByteSink, AsyncDisposable {
  private readonly endpoint: Readonly<{ protocol: 'tcp' | 'udp'; address: string; port: number }>
  private readonly chunk: number
  private readonly connectMs: number
  private readonly writeMs: number
  private readonly finishMs: number
  private readonly factory: SocketTransportFactory
  private phase: 'idle' | 'starting' | 'prepared' | 'active' | 'stopping' | 'stopped' = 'idle'
  private socket?: SocketTransport
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
  constructor(source: SocketSinkOptions) {
    if (!source || typeof source !== 'object') throw new TypeError('invalid socket options')
    const protocol = source.protocol ?? 'tcp', address = source.address, port = source.port,
    chunk = source.chunkBytes ?? (protocol === 'udp' ? 1200 : 65536),
    connectMs = source.connectTimeoutMs ?? 5000, writeMs = source.writeTimeoutMs ?? 2000,
    finishMs = source.finishTimeoutMs ?? 2000, factory = source.socketFactory ?? defaultFactory
    if (!['tcp', 'udp'].includes(protocol) || typeof address !== 'string' || !isIP(address) || address.includes('%') ||
    !Number.isInteger(port) || port < 1 || port > 65535 || typeof factory !== 'function')
    throw new RangeError('invalid socket endpoint/factory')
    if (!Number.isInteger(chunk) || chunk < 1 || chunk > (protocol === 'udp' ? 65507 : 1024 * 1024))
      throw new RangeError('invalid socket chunk size')
    this.endpoint = Object.freeze({ protocol, address, port }); this.chunk = chunk
    this.connectMs = timeout(connectMs); this.writeMs = timeout(writeMs); this.finishMs = timeout(finishMs); this.factory = factory
  }
  private fail(e: unknown) {
    this.failure ??= errorValue(e)
    this.wake?.()
    this.flushing?.abort(this.failure)
    this.finishing?.abort(this.failure)
  }
  start(): Promise<void> {
    if (this.stopping || (this.phase !== 'idle' && this.phase !== 'stopped')) return Promise.reject(new CameraError(-4, 'socket sink active'))
    if (active.size >= 16) return Promise.reject(new CameraError(-4, 'socket sink capacity'))
    active.add(this); this.phase = 'starting'; this.failure = undefined; this.observed = false; this.discarded = false
    this.bytes = 0n; this.chunks = 0n; this.waits = 0n
    const generation = ++this.generation, controller = this.controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new CameraError(-3, 'socket connect deadline')), this.connectMs)
    this.opening = Promise.resolve().then(async () => {
      try {
        const socket = await this.factory(this.endpoint, {
          writable: () => { if (generation === this.generation) { this.epoch++; this.wake?.() } },
          error: e => { if (generation === this.generation) this.fail(e) },
        }, controller.signal)
        if (!socket || typeof socket.write !== 'function' || typeof socket.close !== 'function' ||
        (socket.finish !== undefined && typeof socket.finish !== 'function') ||
        (socket.flush !== undefined && typeof socket.flush !== 'function')) throw new TypeError('invalid socket transport')
        if (owners.has(socket)) throw new CameraError(-4, 'socket transport already owned')
        owners.set(socket, this); this.socket = socket
        controller.signal.throwIfAborted()
        if (this.failure !== undefined) throw this.failure
        if (this.phase === 'starting') this.phase = 'prepared'
      } catch (e) {
        this.fail(e); this.observed = true; this.phase = 'stopping'
        try { await this.retire() } catch (cleanup) { throw new AggregateError([e, cleanup], 'socket setup cleanup failed') }
        throw e
      } finally { clearTimeout(timer) }
    })
    return this.opening
  }
  commit() {
    if (this.phase !== 'prepared' || this.failure !== undefined) throw this.failure ?? new CameraError(-2, 'socket sink not prepared')
    this.phase = 'active'
  }
  private async writable(epoch: number, deadline: number) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new CameraError(-3, 'socket write deadline')
    this.waits++
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.wake = undefined; resolve() }
      const timer = setTimeout(() => { this.wake = undefined; reject(new CameraError(-3, 'socket write deadline')) }, remaining)
      this.wake = done
      if (this.epoch !== epoch || this.failure !== undefined || this.discarded) done()
    })
  }
  write(data: Uint8Array): Promise<void> {
    if (this.phase !== 'active' || this.failure !== undefined || this.flight) {
      if (this.failure !== undefined) this.observed = true
      return Promise.reject(this.failure ?? new CameraError(-4, 'socket sink unavailable'))
    }
    if (!(data instanceof Uint8Array) || data.length > 16 * 1024 * 1024) return Promise.reject(new RangeError('invalid socket write bytes'))
    const cursor = storage(32), offset = new BigUint64Array(1), size = new Uint32Array(1)
    check(n.zc_socket_write_init(BigInt(data.length), this.chunk, +(this.endpoint.protocol === 'udp'), ptr(cursor)))
    const deadline = performance.now() + this.writeMs
    this.flight = Promise.resolve().then(async () => {
      try {
        let burst = 0
        for (;; ) {
          if (this.failure !== undefined) throw this.failure
          if (this.discarded) throw new CameraError(-2, 'socket write discarded')
          if (performance.now() > deadline) throw new CameraError(-3, 'socket write deadline')
          check(n.zc_socket_write_next(ptr(cursor), ptr(offset), ptr(size)))
          if (!size[0]) break
          const epoch = this.epoch, begin = Number(offset[0]), count = this.socket!.write(data.subarray(begin, begin + size[0]))
          if (!Number.isInteger(count) || count < 0 || count > size[0]) throw new CameraError(-6, 'invalid socket write progress')
          check(n.zc_socket_write_accept(ptr(cursor), count), 'socket write progress')
          if (!count) { await this.writable(epoch, deadline); continue }
          this.bytes += BigInt(count); this.chunks++
          if (++burst === 32) { burst = 0; await Bun.sleep(0) }
        }
        if (this.socket?.flush) {
          const remaining = deadline - performance.now()
          if (remaining <= 0) throw new CameraError(-3, 'socket write deadline')
          const controller = this.flushing = new AbortController()
          const timer = setTimeout(() => controller.abort(new CameraError(-3, 'socket write deadline')), remaining)
          try { await this.socket.flush(controller.signal) }
          finally { clearTimeout(timer); this.flushing = undefined }
        }
        if (this.failure !== undefined) throw this.failure
      } catch (e) { this.fail(e); this.observed = true; throw e }
    }).finally(() => { this.flight = undefined })
    return this.flight
  }
  private async retire() {
    if (this.socket) { await this.socket.close(); owners.delete(this.socket); this.socket = undefined }
    active.delete(this); this.phase = 'stopped'
  }
  stop(reason?: { discard: boolean }): Promise<void> {
    const discard = reason?.discard ?? false
    if (typeof discard !== 'boolean') return Promise.reject(new TypeError('invalid socket discard'))
    if (this.phase === 'idle' || this.phase === 'stopped') return Promise.resolve()
    if (discard) {
      this.discarded = true
      this.controller?.abort(new CameraError(-2, 'socket setup discarded'))
      this.finishing?.abort(new CameraError(-2, 'socket finish discarded'))
      this.flushing?.abort(new CameraError(-2, 'socket flush discarded'))
      this.wake?.()
    }
    if (this.stopping) return this.stopping
    this.phase = 'stopping'
    const opening = this.opening, flight = this.flight
    this.stopping = Promise.resolve().then(async () => {
      let error: unknown
      try {
        await opening; await flight
        if (!this.discarded && this.failure === undefined && this.socket?.finish) {
          const controller = this.finishing = new AbortController()
          const timer = setTimeout(() => controller.abort(new CameraError(-3, 'socket finish deadline')), this.finishMs)
          try { await this.socket.finish(controller.signal) } finally { clearTimeout(timer); this.finishing = undefined }
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

/** Video-only elementary Annex B/JPEG output, matching raw FileOutput socket
 * semantics. UDP chunks carry no timestamps, sequencing or reassembly header;
 * use RtpOutput for framed AVC/HEVC/AAC. Use MuxedOutput(sink,'mkv') for A/V. */
export class SocketOutput implements CustomOutput, AsyncDisposable {
  readonly format = 'packets' as const
  readonly sink: SocketSink
  private first = true
  private codec?: number
  constructor(target: SocketSink | SocketSinkOptions) { this.sink = target instanceof SocketSink ? target : new SocketSink(target) }
  resources() { return [this.sink] }
  async start() { this.first = true; this.codec = undefined; await this.sink.start() }
  streams(info: OutputStreams) {
    const codec = info.codec, audio = info.audio
    if (audio) throw new RangeError('raw socket output is video-only')
    if (![3, 1, 2].includes(codec)) throw new RangeError('unsupported elementary codec')
    this.codec = codec
  }
  commit() { if (this.codec === undefined) throw new CameraError(-2, 'socket streams unavailable'); this.sink.commit() }
  async outputframe(packet: OutputPacket) {
    const { audio, codec, annexB, keyframe, data } = packet
    if (audio || codec !== this.codec || (codec !== 3 && !annexB)) throw new RangeError('invalid elementary packet')
    if (this.first && !keyframe) return
    await this.sink.write(data); this.first = false
  }
  stop(reason?: { discard: boolean }) { return this.sink.stop(reason) }
  close() { return this.sink.close() }
  async [Symbol.asyncDispose]() { await this.close() }
}
