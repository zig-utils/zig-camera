import type { ProcessModule, ProcessWorkerContext } from '../../ts/processes'
const initial=(context:ProcessWorkerContext):any=>(context.initial as any)?.context??context.initial
export const init:ProcessModule['init']=async context=>{
  if(initial(context)?.initDelay)await Bun.sleep(initial(context).initDelay)
  if(initial(context)?.initFailure)throw new Error('fixture initialization failure')
  return {calls:0,pid:process.pid}
}
export const close:ProcessModule['close']=async context=>{
  if(initial(context)?.closeFailure)throw new Error('fixture close failure')
  if(initial(context)?.closeDelay)await Bun.sleep(initial(context).closeDelay)
  if(initial(context)?.closePath)await Bun.write(initial(context).closePath,'closed')
}
export const run:ProcessModule['run']=async (frame,data:any,context)=>{
  const state=context.state as {calls:number,pid:number};state.calls++
  if(data?.marker)await Bun.write(data.marker,'active')
  if(data?.action==='exit')process.exit(data.code??7)
  if(data?.action==='spin')while(true){}
  if(data?.waitFor)while(!(await Bun.file(data.waitFor).exists()))await Bun.sleep(2)
  if(data?.delay)await Bun.sleep(data.delay)
  if(data?.action==='fail')throw new Error(data.message??'fixture handler failure')
  if(data?.action==='oversize')return new Uint8Array(2*1024*1024)
  if(data?.action==='unsupported')return ()=>{}
  if(data?.action==='echo')return data.value
  if(data?.action==='image'){
    using image=frame.makeImage(data.stream??'main')
    return {pid:process.pid,worker:context.worker,generation:context.generation,bits:image.bits,pixels:image.copyPixels(),png:image.encode({format:'png'}),metadata:image.sourceMetadata}
  }
  const info=frame.info()
  let hash=2166136261
  for(const stream of info.streams)for(const bytes of frame.copyPlanes(stream.stream))for(const value of bytes)hash=Math.imul(hash^value,16777619)>>>0
  if(data?.action==='write')for(const stream of info.streams)frame.withWritablePlanes(stream.stream,planes=>{for(const bytes of planes)bytes[0]=data.value??91})
  return {pid:process.pid,worker:context.worker,generation:context.generation,calls:state.calls,sequence:info.metadata.sequence,metadata:frame.metadataCatalog(),hash,initial:context.initial,data}
}
