import type { Socket } from 'node:net'
import { CameraError } from './ffi'
import type { ManagedTransportHandlers } from './transport-sink'

/** One bounded queued chunk for an exclusively owned connected/dialing socket. */
export function tcpTransport(socket: Socket, handlers: ManagedTransportHandlers) {
  let closing = false, pending = false, closed = false
  let flushed: ((error?: unknown) => void) | undefined
  const joined = new Promise<void>(resolve => socket.once('close', () => { closed = true; resolve() }))
  socket.on('error', e => handlers.error(e))
  // A peer may close its write half while continuing to receive our media.
  socket.on('close', () => { if (!closing) handlers.error(new CameraError(-2, 'TCP peer closed')) })
  socket.resume()
  async function connect(signal: AbortSignal) {
    try {
      signal.throwIfAborted()
      if (!socket.connecting) {
        if (socket.destroyed) throw new CameraError(-2, 'closed TCP socket')
        socket.setNoDelay(true)
        return
      }
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
  }
  return {
    connect,
    write(data: Uint8Array) {
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
    async flush(flushSignal: AbortSignal) {
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
    async finish(finishSignal: AbortSignal) {
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
