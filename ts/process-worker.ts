/** Internal Bun process entry point. Never imported by the public facade. */
import { closeSync } from 'node:fs'
import { FrameChannel, type RemoteFrame } from './frame-channel'
import { encodeProcessValue, decodeProcessValue, processErrorSummary } from './process-values'
import type { ProcessWorkerContext, ProcessModule } from './processes'
const [moduleUrl, workerText, generationText, limitText] = process.argv.slice(2)
const worker=Number(workerText), generation=BigInt(generationText!), resultLimit=Number(limitText)
if(!Number.isInteger(worker) || worker<0 || worker>7 || generation<=0n || !Number.isInteger(resultLimit) || resultLimit<64 || resultLimit>256*1024*1024 || !moduleUrl?.startsWith('file:'))throw new Error('invalid process bootstrap')
const channel=FrameChannel.fromFd(0)
closeSync(0)
let busy=false, initialized=false, stopped=false
let module:ProcessModule, context:ProcessWorkerContext
const send=(message:unknown)=>{if(!process.send)throw new Error('process IPC unavailable');process.send(message)}
const fatal=(error:unknown)=>{
  if(stopped)return
  stopped=true
  try{send({kind:'fatal',worker,generation,error:processErrorSummary(error)})}catch{}
  try{channel.close()}catch{}
  process.exit(1)
}
process.on('disconnect',()=>{if(!stopped)process.exit(1)})
process.on('message',(message:any)=>{
  void receive(message).catch(fatal)
})
async function receive(message:any){
  if(stopped)return
  if(!message || typeof message!=='object')throw new Error('invalid process message')
  if(message.kind==='init'){
    if(initialized || busy)throw new Error('repeated process initialization')
    busy=true
    const initial=decodeProcessValue(message.context,4*1024*1024)
    const imported=await import(moduleUrl!)
    const run=typeof imported.run==='function'?imported.run:imported.default
    if(typeof run!=='function' || (imported.init!==undefined && typeof imported.init!=='function') || (imported.close!==undefined && typeof imported.close!=='function'))throw new TypeError('process module must export run/default and optional init/close functions')
    module={run,init:imported.init,close:imported.close}
    context={initial,worker,generation,state:undefined}
    context.state=await module.init?.(context)
    initialized=true;busy=false
    send({kind:'ready',worker,generation})
    return
  }
  if(!initialized)throw new Error('process request before initialization')
  if(message.kind==='stop'){
    if(busy)throw new Error('process stop overlaps a request')
    busy=true
    await module.close?.(context)
    stopped=true
    channel.close()
    process.exit(0)
  }
  if(message.kind!=='frame' || busy || typeof message.cookie!=='bigint' || message.cookie<=0n || message.cookie>0xffffffffffffffffn || !(message.args instanceof Uint8Array) || message.args.byteLength>16*1024*1024)throw new Error('invalid or overlapping process request')
  busy=true
  let remote:RemoteFrame|undefined
  try{
    // The sender commits the atomic fd record before sending this envelope.
    remote=channel.tryReceive()
    if(!remote || remote.cookie!==message.cookie)throw new Error('process frame/envelope cookie mismatch')
    let payload:Uint8Array,ok=true
    try{
      const args=decodeProcessValue(message.args,16*1024*1024)
      const result=await module.run(remote,args,context)
      // Serialize independent data while the request still owns its maps.
      payload=encodeProcessValue(result,resultLimit)
    }catch(error){
      ok=false
      payload=encodeProcessValue(processErrorSummary(error),64*1024)
    }
    remote.close();remote=undefined
    send({kind:'result',cookie:message.cookie,ok,payload})
    while(!channel.tryAcknowledge(message.cookie))await Bun.sleep(2)
  }finally{
    // Cleanup failure is fatal: no success ACK; the host must join our exit.
    remote?.close()
    busy=false
  }
}
