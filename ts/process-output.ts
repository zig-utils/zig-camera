import type { ManagedTransport, ManagedTransportHandlers } from './transport-sink'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { ElementaryOutput } from './elementary-output'
import { CameraError, check, libraryPath, native as n, ptr, storage, view } from './ffi'
import { TransportSink } from './transport-sink'

export interface ProcessSinkOptions {
  /** Explicit argv, never interpreted by a shell. Media is written to fd 0. */
  command:readonly string[]
  cwd?:string
  env?:Record<string, string|undefined>
  hostPath?:string
  chunkBytes?:number
  diagnosticBytes?:number
  startupTimeoutMs?:number
  writeTimeoutMs?:number
  finishTimeoutMs?:number
  terminationGraceMs?:number
}
export interface DiagnosticTail {data:Uint8Array; total:bigint; dropped:bigint}
export class ProcessOutputError extends Error {
  constructor(message:string, readonly details:Readonly<{supervisorPid?:number; consumerPid?:number; exitCode?:number; errno?:number; cause?:unknown}>={}) {
    super(message, {cause:details.cause}); this.name = 'ProcessOutputError'
  }
}
class Tail {
  private readonly state = storage(40)
  private readonly arena:Uint8Array
  constructor(readonly capacity:number) {this.arena = new Uint8Array(capacity); check(n.zc_byte_tail_init(BigInt(capacity), ptr(this.state)))}
  append(bytes:Uint8Array) {
    for(let at = 0; at<bytes.length; ) { const count = Math.min(bytes.length - at, 16 * 1024 * 1024), part = bytes.subarray(at, at + count)
    check(n.zc_byte_tail_append(ptr(this.state), this.capacity?ptr(this.arena):null, BigInt(this.capacity), ptr(part), BigInt(count)), 'process diagnostic tail'); at+=count}
  }
  counts() { const d = view(this.state), total = d.getBigUint64(32, true), length = d.getBigUint64(24, true); return {total, dropped:total - length, length}}
  copy():DiagnosticTail {
    const length = new BigUint64Array(1)
    check(n.zc_byte_tail_copy(ptr(this.state), this.capacity?ptr(this.arena):null, BigInt(this.capacity), null, 0n, ptr(length)))
    const data = new Uint8Array(Number(length[0]))
    if(data.length)check(n.zc_byte_tail_copy(ptr(this.state), this.capacity?ptr(this.arena):null, BigInt(this.capacity), ptr(data), BigInt(data.length), ptr(length)))
    return Object.freeze({data, ...this.counts()})
  }
}
type Snapshot = {command:string[]; cwd?:string; env:Record<string, string|undefined>; host:string; diagnostics:number; grace:number; chunk:number; startup?:number; write?:number; finish?:number}
type Session = {supervisorPid:number; consumerPid?:number; supervisorExitCode?:number; consumerExitCode?:number; cancelled:boolean; stdout:Tail; stderr:Tail}
type Context = {current?:Session}
function integer(value:number, min:number, max:number, label:string) { if(!Number.isInteger(value)||value<min||value>max)throw new RangeError(`invalid process ${label}`); return value}
function text(value:unknown, label:string, empty = false) { if(typeof value!=='string'||(!empty&&!value.length)||!value.isWellFormed()||value.includes('\0'))throw new TypeError(`invalid process ${label}`); return value}
function snapshot(source:ProcessSinkOptions):Snapshot {
  if(!source||typeof source!=='object')throw new TypeError('invalid process options')
  const supplied = source.command, cwd = source.cwd, environment = source.env, host = source.hostPath??process.env.ZIG_CAMERA_OUTPUT_HOST??resolve(dirname(libraryPath), '../bin/zig-camera-output-host'),
  diagnostics = source.diagnosticBytes??64 * 1024, grace = source.terminationGraceMs??1000, chunk = source.chunkBytes??65536,
  startup = source.startupTimeoutMs, write = source.writeTimeoutMs, finish = source.finishTimeoutMs
  if(!Array.isArray(supplied))throw new RangeError('invalid process argv')
  const argc=supplied.length
  if(!Number.isInteger(argc)||argc<1||argc>64)throw new RangeError('invalid process argv')
  const command:string[]=[]
  for(let i=0;i<argc;i++)command.push(text(supplied[i],'argument',i!==0))
  let size=0
  for(const item of command)size+=Buffer.byteLength(item)+1
  if(size > 64 * 1024)throw new RangeError('process argv exceeds 64 KiB')
  if(cwd!==undefined)text(cwd, 'working directory')
  if(environment!==undefined&&(environment===null||typeof environment!=='object'||Array.isArray(environment)))throw new TypeError('invalid process environment')
  text(host, 'supervisor path')
  if((cwd&&Buffer.byteLength(cwd) > 4096)||Buffer.byteLength(host) > 4096)throw new RangeError('process path too long')
  const env:Record<string, string|undefined>=Object.create(null)
  let envBytes = 0, envCount = 0
  for(const sourceEnv of [process.env, environment]) {
    if(sourceEnv===undefined)continue
    const keys = Object.keys(sourceEnv)
    if(keys.length > 1024)throw new RangeError('process environment too large')
    for(const key of keys) {
      text(key, 'environment key')
      if(key.includes('='))throw new TypeError('invalid process environment key')
      const value = sourceEnv[key]
      if(value!==undefined)text(value, 'environment value', true)
      if(Object.hasOwn(env, key)) {envBytes-=Buffer.byteLength(key)+Buffer.byteLength(env[key]??'')+2; envCount--}
      if(value===undefined) {delete env[key]; continue}
      envBytes+=Buffer.byteLength(key)+Buffer.byteLength(value)+2; envCount++
      if(envCount > 1024||envBytes > 128 * 1024)throw new RangeError('process environment too large')
      env[key] = value
    }
  }
  return {command, cwd:cwd===undefined?undefined:resolve(cwd), env, host:resolve(host), diagnostics:integer(diagnostics, 0, 1024 * 1024, 'diagnostic bound'), grace:integer(grace, 1, 60000, 'termination grace'), chunk:integer(chunk, 1, 1024 * 1024, 'chunk'), startup, write, finish}
}
function deferred<T>() { let resolve!:(v:T)=>void, reject!:(e:unknown)=>void; const promise = new Promise<T>((a, b)=>{resolve = a; reject = b}); promise.catch(()=>{}); return {promise, resolve, reject}}
async function prepare(options:Snapshot, context:Context, handlers:ManagedTransportHandlers, signal:AbortSignal):Promise<ManagedTransport>{
  context.current = undefined
  signal.throwIfAborted()
  const stdout = new Tail(options.diagnostics), stderr = new Tail(options.diagnostics)
  const child = Bun.spawn([options.host, String(options.grace), '--control-fd4', '--', ...options.command], {
    stdio:['pipe', 'pipe', 'pipe', 'socket-fd', 'socket-fd'], cwd:options.cwd, env:options.env,
  })
  const session:Session = context.current = {supervisorPid:child.pid, cancelled:false, stdout, stderr}
  const fd = child.stdio[3], cancelFd = child.stdio[4]
  if(fd===null||fd===undefined||cancelFd===null||cancelFd===undefined||cancelFd===fd) {child.kill('SIGTERM'); await child.exited; throw new ProcessOutputError('supervisor control descriptor unavailable', {supervisorPid:child.pid})}
  const control = createConnection({fd} as any), cancelControl = createConnection({fd:cancelFd} as any), closed = deferred<void>(), cancelClosed = deferred<void>(), ready = deferred<void>()
  let ending = false, closing = false, result = false, noChildProof = false, terminalProblem = false, protocolBroken = false, cancelSent = false, protocolBytes = 0, held = 0
  let proofChannelError:unknown,cancelChannelError:unknown
  let acknowledged:number|undefined
  let pending:Promise<void>|undefined, inputEnd:Promise<unknown>|undefined, pipeError:unknown
  const frame = storage(32)
  function details(extra:Record<string, unknown>={}) { return {supervisorPid:child.pid, consumerPid:session.consumerPid, ...extra}}
  function cancel() { if(cancelSent||result||terminalProblem)return; cancelSent = true; session.cancelled = true
  try {cancelControl.write(Buffer.from([1]))}catch {}
  // The cancellation fd is separate from proof records: unread late cancel
  // bytes cannot reset the socket carrying the final joined-exit result.
  // Queue cancellation on the inherited fd even before the host installs
  // its handlers. Signalling immediately could kill a still-starting host
  // before it can send its result. Parent-fd EOF follows the same path.
}
function fail(error:unknown) {ready.reject(error); handlers.error(error); cancel()}
cancelControl.on('close',()=>cancelClosed.resolve())
cancelControl.on('error', error=>{cancelChannelError=error;if(!closing&&!cancelSent&&!terminalProblem&&!result)fail(new ProcessOutputError('supervisor cancellation channel failed',details({cause:error})))})
cancelControl.on('data',()=>{protocolBroken=true;fail(new ProcessOutputError('unexpected cancellation channel data',details()))})
control.on('error', error=>{ proofChannelError=error;if(!closing)fail(new ProcessOutputError('supervisor control failed', details({cause:error})))})
control.on('close', ()=>{closed.resolve(); if(!result&&!noChildProof&&!closing)fail(new ProcessOutputError('supervisor closed without a result', details()))})
control.on('data', (bytes:Buffer)=>{
  try {
    protocolBytes+=bytes.length; if(protocolBytes > 64)throw Error('excess supervisor control bytes')
    for(let at = 0; at<bytes.length; ) { const count = Math.min(32 - held, bytes.length - at); frame.set(bytes.subarray(at, at + count), held); held+=count; at+=count
    if(held!==32)continue
    const message = storage(32); check(n.zc_process_output_decode(ptr(frame), 32, ptr(message)), 'supervisor record')
    const d = view(message), kind = d.getUint32(4, true), status = d.getUint32(8, true), supervisor = Number(d.getBigUint64(16, true)), consumer = Number(d.getBigUint64(24, true))
    held = 0
    if(supervisor!==child.pid||result||noChildProof||(session.consumerPid!==undefined&&session.consumerPid!==consumer))throw Error('supervisor identity/order mismatch')
    if(kind===1) { if(session.consumerPid!==undefined)throw Error('duplicate supervisor ready'); session.consumerPid = consumer; ready.resolve()}
    else if(kind===3) { terminalProblem = true; if(consumer)session.consumerPid = consumer; else noChildProof = true; fail(new ProcessOutputError('consumer could not start', details({errno:status})))}
    else {result = true; session.consumerPid = consumer; session.consumerExitCode = status
    if(!ending&&!session.cancelled)fail(new ProcessOutputError('consumer exited before input EOF', details({exitCode:status})))
  }
}
}catch(error) {protocolBroken = true; fail(new ProcessOutputError('invalid supervisor protocol', details({cause:error})))}
})
async function drain(stream:ReadableStream<Uint8Array>, tail:Tail) {
  const reader = stream.getReader()
  try { for(;; ) { const {done, value} = await reader.read(); if(done)return; if(value?.length)tail.append(value)}}
  catch(error) {fail(new ProcessOutputError('process diagnostic read failed', details({cause:error}))); throw error}
  finally {reader.releaseLock()}
}
const readers = Promise.all([drain(child.stdout, stdout), drain(child.stderr, stderr)])
readers.catch(()=>{})
const exited = child.exited.then(code=>{session.supervisorExitCode = code; return code})
const joined = Promise.all([exited, readers, closed.promise, cancelClosed.promise]).then(([code])=>{
  if(protocolBroken||(!result&&!(noChildProof&&code===125))||held)throw new ProcessOutputError('incomplete supervisor exit proof', details({exitCode:code,receivedResult:result,noChildProof,protocolBroken,bufferedProtocolBytes:held,protocolBytes,proofChannelError,cancelChannelError}))
  return code
})
joined.catch(error=>{ if(!closing)fail(error)})
function endInput() { return inputEnd??=Promise.resolve().then(()=>child.stdin.end())}
async function abortable(operation:Promise<unknown>, abortSignal:AbortSignal) {
  const abort = ()=>cancel(); abortSignal.addEventListener('abort', abort, {once:true}); if(abortSignal.aborted)abort()
  try {await operation; abortSignal.throwIfAborted()}
  catch(error) { if(abortSignal.aborted)throw abortSignal.reason; throw error}
  finally {abortSignal.removeEventListener('abort', abort)}
}
const transport:ManagedTransport = {
  write(bytes) {
    if(pipeError!==undefined)throw pipeError
    if(ending||closing)throw new CameraError(-2, 'process stdin closed')
    if(pending)return 0
    let count:number
    const failed = (error:unknown):never=>{pending = undefined; pipeError = new ProcessOutputError('consumer stdin failed', details({cause:error})); fail(pipeError); throw pipeError}
    try {
      if(acknowledged!==undefined) {count = acknowledged; acknowledged = undefined}
      else {
        const result = child.stdin.write(bytes)
        if(typeof result!=='number') {
          pending = Promise.resolve(result).then(value=>{
            if(!Number.isInteger(value)||value < 0||value>bytes.length)throw new Error('invalid pipe progress')
            acknowledged = value; pending = undefined; handlers.writable()
          }).catch(failed)
          pending.catch(()=>{}); return 0
        }
        count = result
      }
      pending = Promise.resolve(child.stdin.flush()).then(async()=>{
        if(!count)await Bun.sleep(0)
        pending = undefined; handlers.writable()
      }).catch(failed)
      pending.catch(()=>{})
    }catch(error) { return failed(error)}
    return count
  },
  async flush(flushSignal) { if(pending)await abortable(pending, flushSignal); flushSignal.throwIfAborted(); if(pipeError!==undefined)throw pipeError},
  async finish(finishSignal) {
    ending = true
    await abortable(endInput(), finishSignal)
    await abortable(joined, finishSignal)
    if(session.supervisorExitCode!==0||session.consumerExitCode!==0)throw new ProcessOutputError('consumer failed at EOF', details({exitCode:session.consumerExitCode??session.supervisorExitCode}))
  },
  async close() {
    closing = true
    if(session.supervisorExitCode===undefined)cancel()
    const input = endInput().catch(()=>{})
    await joined; await input; await pending?.catch(()=>{})
    if(!control.destroyed)control.destroy()
    if(!cancelControl.destroyed)cancelControl.destroy()
  },
}
const abort = ()=>{ready.reject(signal.reason); cancel()}
signal.addEventListener('abort', abort, {once:true}); if(signal.aborted)abort()
try {await ready.promise; signal.throwIfAborted(); return transport}
catch(error) {try {await transport.close()}catch(cleanup) {throw new AggregateError([error, cleanup], 'process setup cleanup failed')}throw error}
finally {signal.removeEventListener('abort', abort)}
}
/** Bounded process stdin sink. The standalone Zig host owns process-group
 * lifecycle; the shared transport engine and native mailbox own producer flow. */
export class ProcessSink extends TransportSink {
  private readonly context:Context
  constructor(source:ProcessSinkOptions) {
    const options = snapshot(source), context:Context = {}
    super({chunkBytes:options.chunk, startupTimeoutMs:options.startup, writeTimeoutMs:options.write, finishTimeoutMs:options.finish,
    open:(handlers, signal)=>prepare(options, context, handlers, signal)})
    this.context = context
  }
  diagnostics():Readonly<{stdout:DiagnosticTail; stderr:DiagnosticTail}>{
    const session = this.context.current
    return Object.freeze({stdout:session?.stdout.copy()??{data:new Uint8Array(), total:0n, dropped:0n}, stderr:session?.stderr.copy()??{data:new Uint8Array(), total:0n, dropped:0n}})
  }
  override stats() { const base = super.stats(), s = this.context.current; return Object.freeze({...base, supervisorPid:s?.supervisorPid, consumerPid:s?.consumerPid, supervisorExitCode:s?.supervisorExitCode, consumerExitCode:s?.consumerExitCode, cancelled:s?.cancelled??false, stdoutBytes:s?.stdout.counts().total??0n, stderrBytes:s?.stderr.counts().total??0n})}
}
/** Video-only raw JPEG/AVC/HEVC consumer. Use MuxedOutput(ProcessSink,'mkv')
 * when a child needs Home timestamps and synchronized audio on the same stdin. */
export class ProcessOutput extends ElementaryOutput<ProcessSink>{
  constructor(target:ProcessSink|ProcessSinkOptions) {super(target instanceof ProcessSink?target:new ProcessSink(target))}
  diagnostics() { return this.sink.diagnostics()}
  stats() { return this.sink.stats()}
}
