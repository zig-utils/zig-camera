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
  if(data?.action==='override-close'){
    let priorClosed=true
    if((state as any).retained){
      priorClosed=false
      try{(state as any).retained.makeBuffer()}catch(error){if((error as any).code===-5)priorClosed=true;else throw error}
    }
    ;(state as any).retained=frame
    frame.close=()=>{}
    return {priorClosed,jpeg:frame.encodeImage()}
  }
  if(data?.action==='parent-image'){
    const bytes=await frame.encodeImageAsync({format:data.format??'png',stream:data.stream??'main',exif:data.exif??false})
    if(data.encoded)await Bun.write(data.encoded,'encoded')
    if(data.release)while(!(await Bun.file(data.release).exists()))await Bun.sleep(2)
    return bytes
  }
  if(data?.action==='image-no-ack'){
    const bytes=await frame.encodeImageAsync({format:'png',exif:false})
    const {FrameChannel}=await import('../../ts')
    FrameChannel.prototype.tryAcknowledge=()=>{process.exit(19)}
    return bytes
  }
  if(data?.action==='async-image'){
    const bytes=await frame.encodeImageAsync({format:'png',exif:true,stream:'lores'})
    await frame.saveAsync(data.path,{format:'jpeg',exif:{artist:'Async child'}},'lores')
    return {pid:process.pid,bytes,config:frame.configuration()}
  }
  if(data?.action==='exif'){
    frame.save(data.path,{format:'png',exif:true},'lores')
    return {pid:process.pid,jpeg:frame.encodeImage()}
  }
  if(data?.action==='configuration')return {pid:process.pid,configuration:frame.configuration(),catalog:frame.configurationCatalog(),initial:context.initial,calls:state.calls}
  if(data?.action==='media'){
    if(data.path)frame.saveDng(data.path)
    return {pid:process.pid,bundle:frame.copyStreams(['lores','raw','main']),array:frame.makeArray('main'),buffer:frame.makeBuffer('raw'),words:frame.copyRaw16(),dng:frame.encodeDng(),calibration:frame.rawMetadata()}
  }
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
