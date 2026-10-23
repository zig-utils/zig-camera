import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { FrameChannel, type RemoteFrame } from './frame-channel'
import { FrameExport, transferExportToProcess, type FrameExportOptions } from './frame-export'
import { native as n, ptr, storage, view, check, outPointer, handle, cstring, CameraError, type Pointer } from './ffi'
import { BunJob, snapshotJobOptions, JobCancelledError, type JobOptions } from './jobs'
import { armDeadline } from './deadline'
import { withStagedImageFile } from './staged-image'
import { encodeProcessValue, decodeProcessValue } from './process-values'
export type { ProcessValue } from './process-values'
export interface ProcessWorkerContext {
  initial:unknown
  worker:number
  generation:bigint
  /** Persistent child-local value returned by init. */
  state:unknown
}
export interface ProcessModule {
  run(frame:RemoteFrame,data:unknown,context:ProcessWorkerContext):unknown|Promise<unknown>
  init?(context:ProcessWorkerContext):unknown|Promise<unknown>
  close?(context:ProcessWorkerContext):void|Promise<void>
}
export interface ProcessCameraSnapshot {
  readonly cameraId:string
  readonly options:unknown
  properties():unknown
  info():unknown
  orientation():unknown
}
export interface ProcessPoolOptions {
  module:string|URL
  workers?:number
  maxPending?:number
  maxArgumentBytes?:number
  maxResultBytes?:number
  maxPendingBytes?:number
  startupTimeoutMs?:number
  shutdownTimeoutMs?:number
  timeoutMs?:number|null
  context?:unknown
  /** Optional initial camera properties/options/orientation copied to children. */
  camera?:ProcessCameraSnapshot
}
export interface ProcessSubmitOptions<T=unknown> extends Omit<JobOptions<T>,'timeoutMs'>,FrameExportOptions {timeoutMs?:number|null}
type Snapshot={module:string,workers:number,items:number,bytes:number,argsLimit:number,resultLimit:number,startup:number,shutdown:number,timeout:number|null,context:Uint8Array}
const callbacks=new AsyncLocalStorage<ProcessPool>()
const signalAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
const signalReason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!
const addListener=EventTarget.prototype.addEventListener, removeListener=EventTarget.prototype.removeEventListener
const indexNames=['main','raw','lores'] as const
function integer(value:unknown,minimum:number,maximum:number,name:string){
  if(typeof value!=='number' || !Number.isSafeInteger(value) || value<minimum || value>maximum)throw new RangeError(`invalid ${name}`)
  return value
}
function duration(value:unknown,name:string){
  if(typeof value!=='number' || !Number.isFinite(value) || value<0)throw new RangeError(`invalid ${name}`)
  return value
}
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void,settled=false
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});promise.catch(()=>{})
  return {promise,get settled(){return settled},resolve(value:T){if(!settled){settled=true;resolve(value)}},reject(error:unknown){if(!settled){settled=true;reject(error)}}}
}
function relay(signal:AbortSignal|undefined){
  const controller=new AbortController()
  if(signal!==undefined){
    const aborted=signalAborted.call(signal)
    if(aborted)throw signalReason.call(signal)??new JobCancelledError()
    const abort=()=>controller.abort(signalReason.call(signal)??new JobCancelledError())
    addListener.call(signal,'abort',abort,{once:true})
    return {signal:controller.signal,close(){removeListener.call(signal,'abort',abort)}}
  }
  return {signal:controller.signal,close(){}}
}
function snapshot(options:ProcessPoolOptions):Snapshot{
  const module=options.module,workers=options.workers??1,items=options.maxPending??16,bytes=options.maxPendingBytes??128*1024*1024,argsLimit=options.maxArgumentBytes??1024*1024,resultLimit=options.maxResultBytes??4*1024*1024,startup=options.startupTimeoutMs??30000,shutdown=options.shutdownTimeoutMs??5000,suppliedTimeout=options.timeoutMs,timeout=suppliedTimeout===undefined?30000:suppliedTimeout,context=options.context,camera=options.camera
  if(typeof module!=='string' && !(module instanceof URL))throw new TypeError('process module must be a local path or file URL')
  const url=module instanceof URL?new URL(module.href):module.startsWith('file:')?new URL(module):pathToFileURL(resolve(module))
  if(url.protocol!=='file:')throw new TypeError('process module must be local')
  const selected={module:url.href,workers:integer(workers,1,8,'process workers'),items:integer(items,1,32,'process task limit'),bytes:integer(bytes,1,512*1024*1024,'process byte limit'),argsLimit:integer(argsLimit,64,16*1024*1024,'process argument limit'),resultLimit:integer(resultLimit,64,256*1024*1024,'process result limit'),startup:duration(startup,'process startup timeout'),shutdown:duration(shutdown,'process shutdown timeout'),timeout:timeout===null?null:duration(timeout,'process timeout')}
  const initial=camera?{context,camera:{id:camera.cameraId,options:camera.options,properties:camera.properties(),info:camera.info(),orientation:camera.orientation()}}:context
  return {...selected,context:encodeProcessValue(initial,4*1024*1024)}
}
export class ProcessWorkerError extends Error {
  exitCode?:number
  constructor(message:string,readonly worker:number,readonly generation:bigint,readonly detail?:unknown){super(message);this.name='ProcessWorkerError'}
}
export class ProcessRemoteError extends Error {
  readonly remoteName:string
  readonly remoteStack?:string
  constructor(detail:any){super(typeof detail?.message==='string'?detail.message:'remote process error');this.name='ProcessRemoteError';this.remoteName=typeof detail?.name==='string'?detail.name:'Error';this.remoteStack=typeof detail?.stack==='string'?detail.stack:undefined}
}
type Worker={index:number,generation:bigint,channel:FrameChannel,child?:ReturnType<typeof Bun.spawn>,ready:ReturnType<typeof deferred<void>>,accepting:boolean,joining:boolean,joined:boolean,expectedExit:boolean,active?:Entry,join?:Promise<void>,startupTimer?:()=>void,exitCode?:number,reason?:unknown}
type Entry={cookie:bigint,worker:Worker,job:BunJob<any>,done:ReturnType<typeof deferred<void>>,sent:boolean,ack:boolean,result?:{ok:boolean,payload:Uint8Array},finished:boolean,retired:boolean,deadline:number,deadlineTimer?:()=>void,relay:ReturnType<typeof relay>}
/** Actual Bun processes with native-owned camera exports/payload queues. */
export class ProcessPool implements AsyncDisposable {
  #handle:Pointer|undefined
  #workers:Worker[]=[]
  #entries=new Map<bigint,Entry>()
  #drains=new Set<BunJob<void>>()
  #restarts=new Map<number,Promise<void>>()
  #closing=false
  #close?:Promise<void>
  #timer?:ReturnType<typeof setTimeout>
  #pumpQueued=false
  #lastState:ReturnType<ProcessPool['stats']>|undefined
  lifecycleError:unknown
  private constructor(private readonly options:Snapshot){
    const out=outPointer();check(n.zc_process_open(options.workers,options.items,BigInt(options.bytes),ptr(out)));this.#handle=handle(out)
  }
  static async open(options:ProcessPoolOptions){
    const selected=snapshot(options)
    if(selected.startup===0)throw new CameraError(-3,'process startup deadline')
    const pool=new ProcessPool(selected)
    try{
      for(let i=0;i<selected.workers;i++)pool.#spawn(i,1n)
      await Promise.all(pool.#workers.map(w=>w.ready.promise))
      return pool
    }catch(error){
      try{await pool.close({drain:false})}catch(cleanup){throw new AggregateError([error,cleanup],'process startup cleanup failed')}
      throw error
    }
  }
  #open(){if(!this.#handle)throw new CameraError(-5,'closed process pool');return this.#handle}
  #admit(){this.#open();if(this.#closing)throw new CameraError(-2,'process pool closing')}
  #guardCallback(){if(callbacks.getStore()===this)throw new CameraError(-4,'process lifecycle from its completion callback')}
  get closed(){return !this.#handle}
  #observe(operation:Promise<unknown>){operation.catch(error=>{this.lifecycleError=error})}
  #spawn(index:number,generation:bigint,ends?:readonly [FrameChannel,FrameChannel]){
    const [channel,peer]=ends??FrameChannel.pair()
    const w:Worker={index,generation,channel,ready:deferred<void>(),accepting:true,joining:false,joined:false,expectedExit:false}
    this.#workers[index]=w
    try{
      const child=Bun.spawn([process.execPath,fileURLToPath(new URL('./process-worker.ts',import.meta.url)),this.options.module,String(index),String(generation),String(this.options.resultLimit)],{stdin:peer.fd,stdout:'ignore',stderr:'inherit',env:process.env,serialization:'advanced',ipc:message=>this.#message(w,message),onDisconnect:()=>{if(!w.joining && !w.expectedExit)this.#observe(this.#join(w,new ProcessWorkerError('worker IPC disconnected',index,generation),true))}})
      w.child=child
      peer.close()
      w.startupTimer=armDeadline(this.options.startup,()=>this.#observe(this.#join(w,new CameraError(-3,'process startup deadline'),true)))
      this.#observe(child.exited.then(code=>{
        w.exitCode=code
        if(!w.joining)return this.#join(w,new ProcessWorkerError(`worker exited (${code})`,index,generation),false)
      }))
      child.send({kind:'init',context:this.options.context})
    }catch(error){
      peer.close()
      this.#observe(this.#join(w,error,true))
    }
  }
  #message(w:Worker,message:any){
    if(w.joining || w.joined || this.closed)return
    try{
      if(!message || typeof message!=='object')throw new Error('invalid worker message')
      if(message.kind==='ready'){
        if(w.ready.settled || message.worker!==w.index || message.generation!==w.generation)throw new Error('invalid worker readiness')
        w.startupTimer?.();w.startupTimer=undefined;w.ready.resolve();this.#schedule();return
      }
      if(message.kind==='fatal')throw new ProcessWorkerError('worker failed',w.index,w.generation,message.error)
      if(message.kind!=='result' || typeof message.cookie!=='bigint')throw new Error('invalid worker result')
      const entry=this.#entries.get(message.cookie)
      // Cookies are never reused. Ignore results from already cancelled/retired
      // tasks; an old result cannot satisfy a replacement task.
      if(!entry){if(message.cookie>0n && message.cookie<=this.stats().issued)return;throw new Error('unknown worker cookie')}
      if(entry.worker!==w || !entry.sent)throw new Error('worker result ownership mismatch')
      if(entry.finished)return
      if(entry.result || typeof message.ok!=='boolean' || !(message.payload instanceof Uint8Array) || message.payload.byteLength>(message.ok?this.options.resultLimit:64*1024))throw new Error('invalid or excessive worker result')
      entry.result={ok:message.ok,payload:message.payload}
      this.#complete(entry)
    }catch(error){this.#observe(this.#join(w,error,true))}
  }
  #complete(entry:Entry){if(entry.ack && entry.result)entry.done.resolve()}
  #join(w:Worker,reason:unknown,kill:boolean):Promise<void>{
    if(w.join)return w.join
    if(!(reason instanceof ProcessWorkerError) && !(reason instanceof CameraError && reason.code===-3))
      reason=new ProcessWorkerError('worker transport or protocol failed',w.index,w.generation,reason)
    w.joining=true;w.accepting=false;w.reason=reason;w.startupTimer?.();w.startupTimer=undefined
    check(n.zc_process_stop_worker(this.#open(),w.index,w.generation))
    w.ready.reject(reason)
    const operation=(async()=>{
      if(w.child){
        if(kill)w.child.kill('SIGKILL')
        // A signal/IPC disconnect is not exit proof. Do not mark joined earlier.
        w.exitCode=await w.child.exited
      }
      if(reason instanceof ProcessWorkerError)reason.exitCode=w.exitCode
      check(n.zc_process_worker_joined(this.#open(),w.index,w.generation))
      w.joined=true
      let cleanup:unknown
      try{w.channel.close()}catch(error){cleanup=error}
      const failure=cleanup===undefined?reason:new ProcessWorkerError('worker endpoint cleanup failed',w.index,w.generation,new AggregateError([reason,cleanup]))
      for(const entry of this.#entries.values())if(entry.worker===w && !entry.finished)entry.done.reject(failure)
      this.#schedule()
      if(cleanup!==undefined)throw cleanup
    })()
    w.join=operation
    return operation
  }
  #schedule(){
    if(this.closed || this.#pumpQueued)return
    this.#pumpQueued=true
    queueMicrotask(()=>{this.#pumpQueued=false;this.#pump()})
  }
  #pump(){
    if(this.closed)return
    for(const w of this.#workers){
      try{
        if(!w || w.joining || w.joined || !w.ready.settled)continue
        const active=w.active
        if(active?.sent && !active.ack && !active.finished){
          const cookie=new BigUint64Array(1),rc=n.zc_process_receive_ack(this.#open(),w.index,w.generation,w.channel.fd,ptr(cookie))
          if(rc!==-3){
            check(rc)
            if(cookie[0]!==active.cookie)throw new Error('process ACK mismatch')
            active.ack=true;this.#complete(active)
          }
        }
        if(w.active || !w.accepting)continue
        const cookie=new BigUint64Array(1),next=n.zc_process_next(this.#open(),w.index,w.generation,ptr(cookie))
        if(next===-3)continue
        check(next)
        const entry=this.#entries.get(cookie[0])
        if(!entry || entry.worker!==w)throw new Error('native process queue mismatch')
        if(entry.job.cancelRequested || performance.now()>=entry.deadline){entry.job.cancel(new CameraError(-3,'process job deadline'));continue}
        const size=new BigUint64Array(1)
        check(n.zc_process_payload_copy(this.#open(),entry.cookie,null,0n,ptr(size)))
        const args=storage(Number(size[0]))
        check(n.zc_process_payload_copy(this.#open(),entry.cookie,ptr(args),BigInt(args.byteLength),ptr(size)))
        const sent=n.zc_process_send(this.#open(),entry.cookie,w.channel.fd)
        if(sent===-3)continue
        check(sent)
        entry.sent=true;w.active=entry
        try{w.child!.send({kind:'frame',cookie:entry.cookie,args})}
        catch(error){this.#observe(this.#join(w,error,true))}
      }catch(error){
        if(w && !w.joining)this.#observe(this.#join(w,error,true))
      }
    }
    if(!this.closed && [...this.#entries.values()].some(e=>!e.finished)){
      if(this.#timer===undefined)this.#timer=setTimeout(()=>{this.#timer=undefined;this.#pump()},2)
    }
  }
  /** Child must return encoded Uint8Array bytes. Only the parent owns the path. */
  submitToFile(frame:{exportFrame(options?:FrameExportOptions):FrameExport},path:string,data?:unknown,options:ProcessSubmitOptions<void>={}):BunJob<void>{
    this.#admit()
    if(typeof path!=='string')throw new TypeError('process output path must be a string')
    if(path.length===0)throw new RangeError('invalid process output path')
    const encoded=cstring(resolve(path))
    if(encoded.byteLength<2||encoded.byteLength>4097)throw new RangeError('invalid process output path')
    return this.#submit<void>(frame,data,options,encoded)
  }
  submit<T=unknown>(frame:{exportFrame(options?:FrameExportOptions):FrameExport},data?:unknown,options:ProcessSubmitOptions<T>={}):BunJob<T>{
    return this.#submit(frame,data,options)
  }
  #retireEntry(entry:Entry){
    if(entry.retired)return
    entry.finished=true
    const rc=n.zc_process_retire(this.#open(),entry.cookie)
    if(rc!==-4)entry.retired=true
    if(entry.worker.active===entry)entry.worker.active=undefined
    this.#schedule()
    check(rc,'retire process camera ownership')
  }
  #submit<T>(frame:{exportFrame(options?:FrameExportOptions):FrameExport},data:unknown,options:ProcessSubmitOptions<T>,publication?:Uint8Array):BunJob<T>{
    this.#admit()
    const suppliedTimeout=options.timeoutMs
    const settings=snapshotJobOptions({timeoutMs:suppliedTimeout===null?undefined:suppliedTimeout,signal:options.signal,signalFunction:options.signalFunction}),streams=options.streams,writable=options.writable??false
    const timeout=suppliedTimeout===null?null:settings.timeoutMs===undefined?this.options.timeout:settings.timeoutMs
    const started=performance.now(),deadline=timeout===null?Infinity:started+timeout
    const exportMethod=frame?.exportFrame
    if(typeof writable!=='boolean' || typeof exportMethod!=='function')throw new TypeError('invalid process frame/access')
    const names=streams===undefined?['main']:[...streams]
    if(names.length===0 || names.length>3 || new Set(names).size!==names.length || names.some(name=>!indexNames.includes(name as any)))throw new RangeError('invalid process streams')
    this.#admit()
    const reservation=Math.max(this.options.resultLimit,64*1024)
    check(n.zc_process_can_submit(this.#open(),0n,BigInt(reservation)))
    const input=encodeProcessValue(data,this.options.argsLimit),abort=relay(settings.signal)
    let loan:FrameExport|undefined,admitted:ReturnType<typeof transferExportToProcess>|undefined
    try{
      this.#admit()
      if(performance.now()>=deadline)throw new CameraError(-3,'process job deadline')
      check(n.zc_process_can_submit(this.#open(),BigInt(input.byteLength),BigInt(reservation)))
      loan=exportMethod.call(frame,{streams:names as any,writable})
      this.#admit()
      if(abort.signal.aborted)throw abort.signal.reason
      if(performance.now()>=deadline)throw new CameraError(-3,'process job deadline')
      admitted=transferExportToProcess(loan,this.#open(),input,reservation)
    }catch(error){
      abort.close()
      try{loan?.close()}catch(cleanup){throw new AggregateError([error,cleanup],'process admission cleanup failed')}
      throw error
    }
    const worker=this.#workers[admitted.worker]!
    let entry:Entry
    const done=deferred<void>()
    let job:BunJob<T>
    try{job=new BunJob<T>(async job=>{
      const cancel=()=>{
        if(!entry.sent || entry.ack)entry.done.reject(job.cancellationReason)
        else this.#observe(this.#join(worker,new ProcessWorkerError('worker terminated for active cancellation',worker.index,worker.generation,job.cancellationReason),true))
      }
      job.signal.addEventListener('abort',cancel,{once:true})
      try{
        job.check()
        await entry.done.promise
        if(performance.now()>=deadline)job.cancel(new CameraError(-3,'process job deadline'))
        job.check()
        if(!entry.result)throw new Error('missing process result')
        const value=decodeProcessValue(entry.result.payload,entry.result.ok?this.options.resultLimit:64*1024)
        if(!entry.result.ok)throw new ProcessRemoteError(value)
        entry.result=undefined // release the serialized copy before callbacks
        if(publication){
          if(!(value instanceof Uint8Array)||value.byteLength===0)throw new TypeError('process file result must be nonempty Uint8Array bytes')
          // Both result and ACK are proven. Return source ownership/worker now,
          // retaining the task reservation through parent publication/callbacks.
          this.#retireEntry(entry)
          await withStagedImageFile(publication,job,async file=>{
            await file!.prepareBytes(value,job)
            const wallDeadline=Number.isFinite(deadline)?Date.now()+Math.max(0,deadline-performance.now()):Infinity
            await file!.publish(job,wallDeadline)
            job.seal()
            return undefined as T
          })
          return undefined as T
        }
        return value as T
      }finally{
        job.signal.removeEventListener('abort',cancel)
        // Native refuses SENT retirement without ACK or verified peer exit.
        this.#retireEntry(entry)
        entry.deadlineTimer?.()
        if(performance.now()>=deadline)job.cancel(new CameraError(-3,'process job deadline'))
        job.check()
      }
    },()=>{
      abort.close()
      entry.deadlineTimer?.()
      // Defensive constructor/pre-start cancellation cleanup is unsent only.
      if(!entry.retired){const retired=n.zc_process_retire(this.#open(),entry.cookie);if(retired!==0)this.lifecycleError=new CameraError(retired,'process retirement');else entry.retired=true}
      const rc=n.zc_process_release(this.#open(),entry.cookie)
      if(rc===0)this.#entries.delete(entry.cookie)
      else this.lifecycleError=new CameraError(rc,'process cleanup admission')
      this.#schedule()
    },{signal:abort.signal,signalFunction:settings.signalFunction?job=>callbacks.run(this,()=>settings.signalFunction!(job)):undefined})}
    catch(error){
      abort.close()
      const retired=n.zc_process_retire(this.#open(),admitted.cookie),released=n.zc_process_release(this.#open(),admitted.cookie)
      if(retired!==0 || released!==0)throw new AggregateError([error,new CameraError(retired||released,'process admission cleanup')],'process job construction failed')
      throw error
    }
    entry={cookie:admitted.cookie,worker,job,done,sent:false,ack:false,finished:false,retired:false,deadline,relay:abort}
    this.#entries.set(entry.cookie,entry)
    // Claim operation ownership immediately; queued cancellation must still join
    // native retirement before the job's public completion is settled.
    void job.start()
    if(Number.isFinite(deadline))entry.deadlineTimer=armDeadline(Math.max(0,deadline-performance.now()),()=>job.cancel(new CameraError(-3,'process job deadline')))
    this.#schedule()
    return job
  }
  stats():{workers:number,pending:number,queued:number,active:number,retired:number,liveWorkers:number,bytes:bigint,issued:bigint,released:bigint}{
    if(!this.#handle){if(this.#lastState)return this.#lastState;throw new CameraError(-5,'closed process pool')}
    const bytes=storage(56),d=view(bytes);check(n.zc_process_get_state(this.#handle,ptr(bytes)))
    return {workers:d.getUint32(4,true),pending:d.getUint32(8,true),queued:d.getUint32(12,true),active:d.getUint32(16,true),retired:d.getUint32(20,true),liveWorkers:d.getUint32(24,true),bytes:d.getBigUint64(32,true),issued:d.getBigUint64(40,true),released:d.getBigUint64(48,true)}
  }
  workerStates(){
    this.#open()
    return this.#workers.map(w=>{
      const bytes=storage(32),d=view(bytes);check(n.zc_process_get_worker_state(this.#open(),w.index,ptr(bytes)))
      return Object.freeze({worker:w.index,generation:d.getBigUint64(16,true),pending:d.getUint32(0,true),active:d.getBigUint64(24,true),accepting:!!d.getUint32(4,true),joined:!!d.getUint32(8,true),pid:w.child?.pid,exitCode:w.exitCode,ready:w.ready.settled && !w.joining})
    })
  }
  async #prefix(target:bigint,job?:BunJob<void>){
    const pending=new Uint32Array(1)
    while(true){job?.check();check(n.zc_process_pending_through(this.#open(),target,ptr(pending)));if(!pending[0])return;await Bun.sleep(2)}
  }
  drainAsync(options:JobOptions<void>={}){
    this.#guardCallback();this.#admit()
    const selected=snapshotJobOptions(options),target=this.stats().issued
    this.#admit()
    if(this.#drains.size>=32)throw new CameraError(-4,'process drain job limit')
    const abort=relay(selected.signal)
    let job:BunJob<void>
    try{job=new BunJob<void>(async job=>this.#prefix(target,job),()=>{abort.close();this.#drains.delete(job)},{...selected,signal:abort.signal,signalFunction:selected.signalFunction?job=>callbacks.run(this,()=>selected.signalFunction!(job)):undefined})}
    catch(error){abort.close();throw error}
    this.#drains.add(job);void job.start();return job
  }
  drain(options:JobOptions<void>={}){return this.drainAsync(options).wait()}
  restart(workerIndex:number):Promise<void>{
    this.#guardCallback();this.#admit()
    const index=integer(workerIndex,0,this.options.workers-1,'process worker index')
    const existing=this.#restarts.get(index);if(existing)return existing
    const worker=this.#workers[index]!
    const operation=(async()=>{
      await this.#join(worker,new ProcessWorkerError('worker restarted',index,worker.generation),true)
      await Promise.all([...this.#entries.values()].filter(e=>e.worker===worker).map(e=>e.job.cleanupDone))
      if(this.#closing)return
      // Allocate endpoints before advancing the native worker generation; an
      // allocation failure leaves the joined generation restartable.
      const ends=FrameChannel.pair(),generation=new BigUint64Array(1)
      try{check(n.zc_process_restart_worker(this.#open(),index,worker.generation,ptr(generation)))}
      catch(error){ends[0].close();ends[1].close();throw error}
      this.#spawn(index,generation[0],ends);await this.#workers[index]!.ready.promise
    })()
    this.#restarts.set(index,operation);operation.finally(()=>this.#restarts.delete(index)).catch(()=>{})
    return operation
  }
  close(options:{drain?:boolean}={}):Promise<void>{
    this.#guardCallback()
    const drain=options.drain??true
    if(typeof drain!=='boolean')throw new TypeError('invalid process close policy')
    if(this.#close){
      if(!drain)for(const entry of this.#entries.values())entry.job.cancel(new JobCancelledError('process pool closed'))
      return this.#close
    }
    this.#closing=true
    const completion=deferred<void>()
    this.#close=completion.promise
    const operation=(async()=>{
      const errors:unknown[]=[]
      if(!drain)for(const entry of this.#entries.values())entry.job.cancel(new JobCancelledError('process pool closed'))
      await Promise.all([...this.#restarts.values()].map(p=>p.catch(()=>{})))
      await this.#prefix(this.stats().issued)
      await Promise.all([...this.#drains].map(job=>job.cleanupDone))
      for(let i=0;i<this.options.workers;i++){
        const w=this.#workers[i]
        if(!w){check(n.zc_process_worker_joined(this.#open(),i,1n));continue}
        if(w.join){try{await w.join}catch(error){errors.push(error)};continue}
        w.expectedExit=true;w.accepting=false
        let cancelTimer:(()=>void)|undefined
        try{
          try{w.child?.send({kind:'stop'})}
          catch(error){errors.push(error);await this.#join(w,error,true);continue}
          cancelTimer=armDeadline(this.options.shutdown,()=>w.child?.kill('SIGKILL'))
          await this.#join(w,new ProcessWorkerError('worker closed',w.index,w.generation),false)
          if(w.exitCode!==0)errors.push(new ProcessWorkerError(`worker close exited (${w.exitCode})`,w.index,w.generation))
        }catch(error){errors.push(error)
        }finally{cancelTimer?.()}
      }
      if(this.#timer!==undefined)clearTimeout(this.#timer)
      this.#lastState=this.stats()
      check(n.zc_process_close(this.#open()))
      this.#handle=undefined
      if(errors.length)throw new AggregateError(errors,'process pool close failed after cleanup')
    })()
    operation.then(()=>completion.resolve(),error=>{if(this.#handle)this.#close=undefined;completion.reject(error)})
    return completion.promise
  }
  async [Symbol.asyncDispose](){await this.close()}
}
