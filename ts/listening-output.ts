import { createServer, isIP, type Socket } from 'node:net'
import { CameraError } from './ffi'
import { ElementaryOutput } from './elementary-output'
import { TransportSink, type ManagedTransport, type ManagedTransportHandlers } from './transport-sink'
import { tcpTransport } from './tcp-transport'

export interface ListeningSocketSinkOptions {
  address: string
  /** Zero requests an ephemeral local port; inspect listenerStats().local. */
  port: number
  chunkBytes?: number
  /** Covers bind plus the first peer accept. Default 5000, max 60000. */
  acceptTimeoutMs?: number
  writeTimeoutMs?: number
  finishTimeoutMs?: number
}
export interface ListeningEndpoint { readonly address: string; readonly port: number; readonly family: 'IPv4' | 'IPv6' }
type Context = {current:State;session:number}
type State = { local?: Readonly<ListeningEndpoint>; peer?: Readonly<ListeningEndpoint>; listening: boolean; accepted: boolean }
const endpoint = (address: string, port: number, family: string): Readonly<ListeningEndpoint> => Object.freeze({address,port,family:family==='IPv6'?'IPv6':'IPv4'})
async function acceptPeer(config:Readonly<ListeningSocketSinkOptions>, handlers:ManagedTransportHandlers, signal:AbortSignal, state:State):Promise<ManagedTransport> {
  state.local=undefined;state.peer=undefined;state.listening=false;state.accepted=false
  signal.throwIfAborted()
  const server=createServer({allowHalfOpen:true,pauseOnConnect:true})
  server.maxConnections=1
  let bindPending=true,settleBind!:()=>void
  const bound=new Promise<void>(resolve=>{settleBind=()=>{bindPending=false;resolve()}})
  let ownedSocket:Socket|undefined
  let transport: ReturnType<typeof tcpTransport>|undefined, cancelled=false, stopping:Promise<void>|undefined
  let accept!:(value:ManagedTransport)=>void,reject!:(error:unknown)=>void
  const accepted=new Promise<ManagedTransport>((resolve,fail)=>{accept=resolve;reject=fail})
  const stopListener=()=>{
    if(stopping)return stopping
    state.listening=false
    const close=()=>new Promise<void>((resolve,fail)=>{
      server.close(error=>{if(error && (error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING')fail(error);else resolve()})
    })
    // Bind may still be queued. Closing a not-yet-listening server can report
    // NOT_RUNNING before a later bind succeeds, so join bind before retirement.
    stopping=bindPending?bound.then(close):close()
    stopping.catch(()=>{})
    return stopping
  }
  const retire=async()=>{
    const results=await Promise.allSettled([transport?.close(),stopListener()])
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[])
    if(errors.length===1)throw errors[0]
    if(errors.length)throw new AggregateError(errors,'TCP listener retirement failed')
  }
  const abort=()=>{cancelled=true;reject(signal.reason);void stopListener();ownedSocket?.destroy()}
  server.on('error',error=>{settleBind();handlers.error(error);reject(error)})
  server.on('close',()=>{state.listening=false;if(!state.accepted&&!cancelled)reject(new CameraError(-2,'TCP listener closed before accept'))})
  server.on('connection',(socket:Socket)=>{
    if(cancelled || signal.aborted || state.accepted){socket.destroy();return}
    state.accepted=true;ownedSocket=socket
    state.peer=endpoint(socket.remoteAddress??'',socket.remotePort??0,socket.remoteFamily??'IPv4')
    transport=tcpTransport(socket,handlers)
    // Stop accepting immediately, but its close callback joins the live peer.
    // Waiting for it here would deadlock before any media could be delivered.
    void stopListener()
    transport.connect(signal).then(()=>accept(transport!),reject)
  })
  server.once('listening',()=>{
    settleBind()
    if(cancelled || signal.aborted){void stopListener();return}
    const address=server.address()
    if(!address || typeof address==='string'){reject(new CameraError(-2,'invalid TCP listener address'));return}
    state.local=endpoint(address.address,address.port,address.family);state.listening=true
  })
  signal.addEventListener('abort',abort,{once:true})
  try {
    if(signal.aborted){settleBind();abort()}
    else {
      try{server.listen({host:config.address,port:config.port,backlog:1,ipv6Only:isIP(config.address)===6})}
      catch(error){settleBind();throw error}
    }
    const connection=await accepted
    signal.throwIfAborted()
    return {
      write:bytes=>connection.write(bytes),
      flush:flushSignal=>connection.flush?.(flushSignal),
      finish:finishSignal=>connection.finish?.(finishSignal),
      close:retire,
    }
  }catch(error){
    try{await retire()}catch(cleanup){throw new AggregateError([error,cleanup],'TCP listener setup cleanup failed')}
    throw error
  }finally{signal.removeEventListener('abort',abort)}
}
/** One accepted TCP peer per session; no queue of waiting media consumers.
 * Shares Home progress and the native mailbox with dialing/process outputs. */
export class ListeningSocketSink extends TransportSink {
  private readonly context:Context
  constructor(source:ListeningSocketSinkOptions){
    if(!source || typeof source!=='object')throw new TypeError('invalid TCP listener options')
    const {address,port,chunkBytes,acceptTimeoutMs,writeTimeoutMs,finishTimeoutMs}=source
    if(typeof address!=='string'||!isIP(address)||address.includes('%')||!Number.isInteger(port)||port<0||port>65535)throw new RangeError('invalid TCP listener endpoint')
    const config=Object.freeze({address,port,chunkBytes,acceptTimeoutMs,writeTimeoutMs,finishTimeoutMs}),context:Context={current:{listening:false,accepted:false},session:0}
    super({chunkBytes,startupTimeoutMs:acceptTimeoutMs,writeTimeoutMs,finishTimeoutMs,open:(handlers,signal)=>{const state:State={listening:false,accepted:false};context.current=state;context.session++;return acceptPeer(config,handlers,signal,state)}})
    this.context=context
  }
  listenerStats(){
    const {session}=this.stats()
    const state=this.context.session===session?this.context.current:{listening:false,accepted:false}
    return Object.freeze({...state,session})
  }
}
/** Raw JPEG/Annex B video to one inbound TCP peer. Audio uses MuxedOutput. */
export class ListeningSocketOutput extends ElementaryOutput<ListeningSocketSink> {
  constructor(target:ListeningSocketSink|ListeningSocketSinkOptions){super(target instanceof ListeningSocketSink?target:new ListeningSocketSink(target))}
}
