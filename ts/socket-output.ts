import { createConnection, isIP } from 'node:net'
import { ElementaryOutput } from './elementary-output'
import { CameraError } from './ffi'

export type {ManagedTransport as SocketTransport, ManagedTransportHandlers as SocketTransportHandlers} from './transport-sink'
import {TransportSink, type ManagedTransport as SocketTransport, type ManagedTransportHandlers as SocketTransportHandlers} from './transport-sink'
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
export class SocketSink extends TransportSink {
  constructor(source:SocketSinkOptions) {
    if(!source||typeof source!=='object')throw new TypeError('invalid socket options')
    const protocol = source.protocol??'tcp', address = source.address, port = source.port, chunk = source.chunkBytes??(protocol==='udp'?1200:65536), factory = source.socketFactory??defaultFactory,
    startupTimeoutMs = source.connectTimeoutMs, writeTimeoutMs = source.writeTimeoutMs, finishTimeoutMs = source.finishTimeoutMs
    if(!['tcp', 'udp'].includes(protocol)||typeof address!=='string'||!isIP(address)||address.includes('%')||!Number.isInteger(port)||port < 1||port > 65535||typeof factory!=='function')throw new RangeError('invalid socket endpoint/factory')
    const endpoint = Object.freeze({protocol, address, port})
    super({datagram:protocol==='udp', chunkBytes:chunk, startupTimeoutMs, writeTimeoutMs, finishTimeoutMs, open:(handlers, signal)=>factory(endpoint, handlers, signal)})
  }
}
/** Video-only raw Annex B/JPEG over a managed TCP/UDP sink. */
export class SocketOutput extends ElementaryOutput<SocketSink> {
  constructor(target:SocketSink|SocketSinkOptions) {super(target instanceof SocketSink?target:new SocketSink(target))}
}
