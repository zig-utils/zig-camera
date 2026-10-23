import {test,expect} from 'bun:test'
import {Camera,FrameChannel,ProcessPool,Control,type TypedCatalog,type FrameExport,type RemoteFrame} from '../../ts'
import {processedFormats} from '../../ts/processed-format'
import {readPropertiesCatalog} from '../../ts/request-properties'
import {toArrayBuffer,type Pointer} from '../../ts/ffi'
const value=(catalog:TypedCatalog,name:string)=>catalog.records.find(record=>record.name===name)!.values[0]!.value
for(const format of processedFormats)test(`${format} source properties own exact backend records across frames exports remote and source closure`,async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10,format,raw:true,lores:{width:10,height:6,format}}),[sender,receiver]=FrameChannel.pair()
  let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    const expected=c.properties(),frame=await c.captureRequest(),retained=frame.retain(),local=frame.properties()
    expect(local).toEqual(expected);expect(retained.properties()).toEqual(expected)
    expect(value(local,'PixelArraySize')).toEqual({width:4056,height:3040});expect(frame.width).toBe(18)
    const model=local.records.find(record=>record.name==='Model')!.values[0]!.bytes;model.fill(0)
    expect(c.properties()).toEqual(expected);expect(frame.properties()).toEqual(expected)
    loan=frame.exportFrame({streams:['main']});const exported=loan.properties();expect(exported).toEqual(expected)
    const nested=frame.metadataCatalog().records.find(record=>record.vendor==='zig-camera'&&record.group===0x5a440000&&record.id===1)!
    expect(nested.name).toBe('Properties.Catalog');expect(nested.kind).toBe('byte');expect(nested.values[0]!.bytes.subarray(0,4)).toEqual(new Uint8Array([72,67,65,84]))
    expect(loan.trySend(sender.fd,99n)).toBe(true);remote=receiver.tryReceive()!;const received=remote.properties();expect(received).toEqual(expected)
    retained.release();frame.release();await c.stop();expect(loan.properties()).toEqual(expected);expect(remote.properties()).toEqual(expected)
    remote.close();expect(receiver.tryAcknowledge(99n)).toBe(true);expect(sender.tryReceiveAcknowledgement()).toBe(99n);loan.close();await c.close()
    expect(received).toEqual(expected);expect(exported).toEqual(expected)
    expect(()=>frame.properties()).toThrow();expect(()=>retained.properties()).toThrow();expect(()=>loan!.properties()).toThrow();expect(()=>remote!.properties()).toThrow()
  }finally{remote?.close();loan?.close();sender.close();receiver.close();await c.close()}
})
test('property snapshots remain metadata-only inside exclusive source and remote write scopes',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10,writable:true}),[sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    using frame=await c.captureRequest();const expected=c.properties()
    using map=frame.mapStream();expect(frame.properties()).toEqual(expected);map.close()
    loan=frame.exportFrame({writable:true});expect(frame.properties()).toEqual(expected);expect(loan.properties()).toEqual(expected)
    loan.trySend(sender.fd,1n);remote=receiver.tryReceive()!;remote.withWritablePlanes('main',()=>expect(remote!.properties()).toEqual(expected))
    remote.close();expect(receiver.tryAcknowledge(1n)).toBe(true);expect(sender.tryReceiveAcknowledgement()).toBe(1n);loan.close();expect(frame.referenceCount).toBe(1)
  }finally{remote?.close();loan?.close();sender.close();receiver.close();await c.close()}
})
test('ordinary and temporary request callbacks expose source property snapshots whose values outlive their scopes',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10});const snapshots:TypedCatalog[]=[];let expired:(()=>TypedCatalog)|undefined
  try{
    const expected=c.properties();c.postCallback=request=>{snapshots.push(request.properties());expired=()=>request.properties()}
    await c.captureMetadata();expect(()=>expired!()).toThrow('expired')
    await c.switchModeAndCaptureMetadata({width:32,height:24});c.setRequestCallbacks({});await c.close()
    expect(snapshots.length).toBeGreaterThanOrEqual(2);snapshots.forEach(snapshot=>expect(snapshot).toEqual(expected));expect(()=>expired!()).toThrow('expired')
  }finally{if(c.handle)c.setRequestCallbacks({});await c.close()}
})
test('session properties remain distinct from mutable runtime control results and negotiated stream geometry',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10})
  try{const properties=c.properties();c.setControls([{id:Control.exposureTime,type:'int',values:[1200]}]);using frame=await c.captureRequest();expect(frame.properties()).toEqual(properties);expect(value(properties,'PixelArraySize')).toEqual({width:4056,height:3040});expect(frame.configuration().streams.main?.width).toBe(18)}finally{await c.close()}
})
test('reused actual workers read request properties independently of misleading initialization context and retire old wrappers',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10}),pool=await ProcessPool.open({module:new URL('../fixtures/process-handler.ts',import.meta.url),camera:c,context:{properties:{Model:'wrong initialization camera'}}})
  try{
    const expected=c.properties();let pid:number|undefined
    for(let i=0;i<36;i++){
      using frame=await c.captureRequest();const job=pool.submit<any>(frame,{action:'properties'}),result=await job;await job.cleanupDone
      expect(result.properties).toEqual(expected);expect(result.properties).toEqual(frame.properties());expect(result.priorClosed).toBe(true)
      if(i)expect(result.prior).toEqual(expected);pid??=result.pid;expect(result.pid).toBe(pid);expect(result.pid).not.toBe(process.pid)
      expect(result.initial.context.properties.Model).toBe('wrong initialization camera');expect(frame.referenceCount).toBe(1)
    }
    await pool.drain()
  }finally{await pool.close();await c.close()}
})
test('Bun properties reader validates bounded stable sizes and exact catalog kind',()=>{
  const set=(length:Pointer,value:bigint)=>new DataView(toArrayBuffer(length,0,8)).setBigUint64(0,value,true)
  for(const size of [0n,15n,4n*1024n*1024n+1n])expect(()=>readPropertiesCatalog((_data,_capacity,length)=>{set(length,size);return 0})).toThrow('size')
  expect(()=>readPropertiesCatalog((data,_capacity,length)=>{set(length,data?17n:16n);if(data)new Uint8Array(toArrayBuffer(data,0,16)).set(new Uint8Array([72,67,65,84,1,0,0,0,2,0,0,0,0,0,0,0]));return 0})).toThrow('size changed')
  expect(()=>readPropertiesCatalog((data,_capacity,length)=>{set(length,16n);if(data)new Uint8Array(toArrayBuffer(data,0,16)).set(new Uint8Array([72,67,65,84,1,0,0,0,4,0,0,0,0,0,0,0]));return 0})).toThrow('kind')
})
