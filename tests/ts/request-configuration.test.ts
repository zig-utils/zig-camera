import { test, expect } from 'bun:test'
import { Camera, FrameChannel, ProcessPool, Control, type FrameExport, type RemoteFrame } from '../../ts'
import { processedFormats } from '../../ts/processed-format'
import { decodeFrameConfiguration } from '../../ts/request-configuration'

for (const format of processedFormats) test(`${format} configuration describes every negotiated stream independent of selected export`, async () => {
  const camera = new Camera({simulate:true, fifo:true, writable:true, width:18, height:10, buffers:3, raw:true, unpackedRaw:true, format, lores:{width:10,height:6,format}, colorSpace:'rec709'})
  const [sender, receiver] = FrameChannel.pair()
  let loan: FrameExport | undefined, remote: RemoteFrame | undefined
  try {
    camera.start(); using frame = camera.acquire()
    const expected = frame.configuration(), catalog = frame.configurationCatalog()
    expect(expected.schemaVersion).toBe(1)
    expect(expected.cameraId).toBe(camera.cameraId)
    expect(expected.backend).toBe('synthetic')
    expect(expected.buffers).toBe(camera.info().buffers)
    expect(expected.policy).toBe('fifo')
    expect(expected.requested.format).toBe(format)
    expect(expected.requested.lores.format).toBe(format)
    expect(expected.requested.width).toBe(18)
    for (const name of ['main','raw','lores'] as const) {
      using map = frame.mapStream(name)
      const stream = expected.streams[name]!
      expect(stream.width).toBe(map.width); expect(stream.height).toBe(map.height)
      expect(stream.format).toBe(map.format)
      expect(stream.frameSize).toBe(map.planes.reduce((n,p)=>n+p.length,0n))
      expect(stream.colorSpace).toEqual(camera.colorSpace(name))
    }
    loan = frame.exportFrame({streams:['main']})
    expect(loan.info().streams.length).toBe(1)
    expect(loan.configuration()).toEqual(expected)
    expect(loan.configurationCatalog()).toEqual(catalog)
    expect(loan.trySend(sender.fd, 1n)).toBe(true)
    remote = receiver.tryReceive()!
    expect(remote.configuration()).toEqual(expected)
    expect(remote.configurationCatalog()).toEqual(catalog)
    frame.release(); await camera.stop()
    expect(remote.configuration()).toEqual(expected)
    remote.close(); expect(receiver.tryAcknowledge(1n)).toBe(true)
    expect(sender.tryReceiveAcknowledgement()).toBe(1n)
    loan.close(); await camera.close()
    expect(Object.isFrozen(expected.requested.lores)).toBe(true)
    expect(Object.isFrozen(expected.streams.main)).toBe(true)
    expect(decodeFrameConfiguration(catalog)).toEqual(expected)
    expect(()=>frame.configuration()).toThrow();expect(()=>loan!.configuration()).toThrow();expect(()=>remote!.configuration()).toThrow()
  } finally {remote?.close(); loan?.close(); sender.close(); receiver.close(); await camera.close()}
})

const transforms = [{},{hflip:true},{rotation:180},{vflip:true},{rotation:90,hflip:true},{rotation:270},{rotation:90,vflip:true},{rotation:90}] as const
for (const [index,transform] of transforms.entries()) test(`request configuration owns orientation ${index+1} and startup hints across controls`, async () => {
  const camera = new Camera({simulate:true, fifo:true, width:18, height:10, raw:true, rawFormat:'SRGGB12_CSI2P', transform})
  try {
    camera.start();using first = camera.acquire()
    const before=first.configuration()
    expect(before.orientation).toEqual({...camera.orientation(),strict:false})
    expect(Number(before.orientation.actual)).toBe(index+1)
    expect(before.requested.exposureUs).toBe(0)
    expect(before.requested.analogueGain).toBe(0)
    first.release()
    camera.setControls([{id:Control.exposureTime,type:'int',values:[5678]}])
    using second=await camera.captureRequest({dropFrames:camera.info().buffers})
    expect(second.metadata().exposureUs).toBe(5678)
    expect(second.configuration()).toEqual(before)
  } finally {await camera.close()}
})

test('configuration remains readable inside an exclusive remote pixel write scope',async()=>{
  const camera=new Camera({simulate:true,width:2,height:2,writable:true}),[sender,receiver]=FrameChannel.pair()
  try{
    camera.start();using frame=camera.acquire();const expected=frame.configuration()
    using loan=frame.exportFrame({writable:true});expect(loan.trySend(sender.fd,4n)).toBe(true)
    using remote=receiver.tryReceive()!
    remote.withWritablePlanes('main',()=>expect(remote.configuration()).toEqual(expected))
    remote.close();expect(receiver.tryAcknowledge(4n)).toBe(true);expect(sender.tryReceiveAcknowledgement()).toBe(4n)
  }finally{sender.close();receiver.close();await camera.close()}
})

test('configuration schema rejects missing duplicate wrongly typed and unsupported records',async()=>{
  const camera=new Camera({simulate:true,width:2,height:2})
  try{
    camera.start();using frame=camera.acquire();const catalog=frame.configurationCatalog(),record=catalog.records[0]!
    for(const records of [catalog.records.slice(1),[...catalog.records,record],catalog.records.map((r,i)=>i===0?{...r,kind:'string' as const}:r),catalog.records.map((r,i)=>i===0?{...r,values:[{...r.values[0]!,value:2}]}:r)])
      expect(()=>decodeFrameConfiguration({...catalog,records})).toThrow('invalid request configuration')
  }finally{await camera.close()}
})

test('reused actual child reads source configuration after mode switch instead of its initialization camera',async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,format:'RGB888'})
  const pool=await ProcessPool.open({module:new URL('../fixtures/process-handler.ts',import.meta.url),camera})
  try{
    camera.start()
    let first:any
    {using frame=camera.acquire();first=await pool.submit<any>(frame,{action:'configuration'});expect(first.configuration).toEqual(frame.configuration());await pool.drain();expect(frame.referenceCount).toBe(1)}
    await camera.switchMode({width:34,height:18,format:'RGB161616',role:'video',raw:true,unpackedRaw:true,lores:{width:10,height:6,format:'NV12'},transform:{rotation:270}})
    using frame=camera.acquire();const expected=frame.configuration(),second=await pool.submit<any>(frame,{action:'configuration'})
    expect(second.pid).toBe(first.pid);expect(second.calls).toBe(2)
    expect(second.configuration).toEqual(expected)
    expect(second.catalog).toEqual(frame.configurationCatalog())
    expect(second.configuration.streams.main.format).toBe('RGB161616')
    expect(second.initial.camera.info.width).toBe(18)
    expect(second.initial.camera.options.format).toBe('RGB888')
    await pool.drain();expect(frame.referenceCount).toBe(1)
  }finally{await pool.close();await camera.close()}
})

test('requested sensor mode survives transposition while actual raw layout and startup defaults remain explicit',async()=>{
  const sensor={width:640,height:480,bitDepth:12}
  const camera=new Camera({simulate:true,width:64,height:48,raw:true,unpackedRaw:true,sensor,transform:{rotation:90,strict:true},role:'video',colorSpace:'rec709',strictColorSpace:true})
  try{
    using frame=await camera.captureRequest();const value=frame.configuration()
    expect(value.sensor).toEqual(sensor);expect(value.requested.sensor).toEqual(sensor)
    expect(value.streams.raw).toMatchObject({width:480,height:640,format:'SGRBG12'})
    expect(value.orientation).toEqual({requested:8,actual:8,adjusted:false,strict:true})
    expect(value.requested.role).toBe('video');expect(value.requested.strictColor).toBe(true)
    expect(value.requested.noiseReduction).toBe(0xffffffff)
    expect(value.streams.lores).toBeUndefined()
  }finally{await camera.close()}
  const automatic=new Camera({simulate:true})
  try{
    using frame=await automatic.captureRequest();const value=frame.configuration()
    expect(value.requested.width).toBe(0);expect(value.requested.height).toBe(0)
    expect(value.streams.main!.width).toBeGreaterThan(0);expect(value.streams.main!.height).toBeGreaterThan(0)
    expect(value.streams.raw).toBeUndefined();expect(value.streams.lores).toBeUndefined()
  }finally{await automatic.close()}
})

test('pool initialized for one camera reads another source session configuration',async()=>{
  const first=new Camera({simulate:true,width:18,height:10}), second=new Camera({simulate:true,width:26,height:14,format:'NV21'})
  const pool=await ProcessPool.open({module:new URL('../fixtures/process-handler.ts',import.meta.url),camera:first})
  try{
    using frame=await second.captureRequest();const value=await pool.submit<any>(frame,{action:'configuration'})
    expect(value.configuration).toEqual(frame.configuration())
    expect(value.configuration.cameraId).toBe(second.cameraId)
    expect(value.configuration.streams.main.width).toBe(26)
    expect(value.initial.camera.info.width).toBe(18)
    expect(value.initial.camera.id).toBe(first.cameraId)
    await pool.drain();expect(frame.referenceCount).toBe(1)
  }finally{await pool.close();await first.close();await second.close()}
})
