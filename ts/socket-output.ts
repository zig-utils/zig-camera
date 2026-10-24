import { createConnection, isIP } from 'node:net'
import { ElementaryOutput } from './elementary-output'
import { CameraError } from './ffi'
import { tcpTransport } from './tcp-transport'

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
  const socket = createConnection({ host: endpoint.address, port: endpoint.port, allowHalfOpen: true })
  const transport = tcpTransport(socket, handlers)
  await transport.connect(signal)
  return transport
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
