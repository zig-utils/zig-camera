import {test,expect} from 'bun:test'
import {Camera,FrameChannel,ProcessPool,type FrameExport,type RemoteFrame} from '../../ts'
import {mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
function equal(a:ArrayLike<number>,b:ArrayLike<number>){expect(Array.from(a)).toEqual(Array.from(b))}
const processed=['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616'] as const
const rawFormats=['RGGB','BGGR','GRBG','GBRG'].flatMap(p=>[
  ...[8,10,12,14,16].map(b=>`S${p}${b}`),...[10,12,14].map(b=>`S${p}${b}_CSI2P`),`${p}_PISP_COMP1`,
]).concat(['R8','R10','R12','R14','R16','R8_CSI2P','R10_CSI2P','R12_CSI2P','R14_CSI2P','MONO_PISP_COMP1'])
const module=new URL('../fixtures/process-handler.ts',import.meta.url)
function dngWords(bytes:Uint8Array){
  const b=Buffer.from(bytes),entries=b.readUInt16LE(8),tags=new Map<number,number>()
  for(let i=0;i<entries;i++)tags.set(b.readUInt16LE(10+i*12),b.readUInt32LE(18+i*12))
  const width=tags.get(256)!,height=tags.get(257)!,offset=tags.get(273)!
  return Uint16Array.from({length:width*height},(_,i)=>b.readUInt16LE(offset+i*2))
}
for(const format of processed)test(`${format} remote bundles shaped arrays and physical buffers preserve main and lores layouts`,async()=>{
  const camera=new Camera({simulate:true,fifo:true,writable:true,width:18,height:10,format,raw:true,unpackedRaw:true,lores:{width:10,height:6,format}})
  const [sender,receiver]=FrameChannel.pair()
  let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    camera.start();using frame=camera.acquire()
    const expected=frame.copyStreams(['lores','raw','main']),physical=new Map<string,Uint8Array>()
    for(const name of ['main','raw','lores'] as const){using map=frame.mapStream(name);physical.set(name,Uint8Array.from(map.planes.flatMap(p=>Array.from(p.bytes))))}
    loan=frame.exportFrame({streams:['main','raw','lores']});expect(loan.trySend(sender.fd,1n)).toBe(true);remote=receiver.tryReceive()!
    const bundle=remote.copyStreams(['lores','raw','main']);expect(bundle).toEqual(expected)
    const views=Object.values(bundle.streams).map(s=>s!.data)
    expect(views.every(v=>v.buffer===views[0].buffer)).toBe(true)
    for(const name of ['main','lores'] as const){
      const array=remote.makeArray(name),p=expected.streams[name]!,width=name==='main'?18:10,height=name==='main'?10:6
      expect(array.format).toBe(format);expect(array.rowBytes).toBe(p.rowBytes)
      expect(new Uint8Array(array.data.buffer,array.data.byteOffset,array.data.byteLength)).toEqual(p.data)
      expect(array.shape.reduce((a,b)=>a*b,1)).toBe(array.data.length)
      expect(array.shape[1]).toBe(width)
      expect(array.shape[0]).toBe(['YUV420','YVU420','NV12','NV21'].includes(format)?height*3/2:height)
      expect(array.data instanceof Uint16Array).toBe(format.endsWith('161616'))
      equal(remote.makeBuffer(name),physical.get(name)!)
    }
    expect(remote.copyStream('raw')).toEqual(expected.streams.raw!)
    frame.release();await camera.stop();remote.close();expect(receiver.tryAcknowledge(1n)).toBe(true);expect(sender.tryReceiveAcknowledgement()).toBe(1n);loan.close();await camera.close()
    expect(bundle).toEqual(expected)
    expect(()=>remote!.copyStreams()).toThrow('closed')
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await camera.close()}
})
for(const rawFormat of rawFormats)test(`${rawFormat} remote raw samples calibration and DNG survive camera retirement`,async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:17,height:5,raw:true,rawFormat}),dir=mkdtempSync(join(tmpdir(),'zc-remote-raw-'))
  const [sender,receiver]=FrameChannel.pair()
  let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    camera.start();using frame=camera.acquire()
    const packed=frame.copyStream('raw'),words=frame.copyRaw16(),expected=frame.encodeImage({format:'dng'})
    loan=frame.exportFrame({streams:['raw']});const calibration=loan.rawMetadata()
    expect(loan.trySend(sender.fd,2n)).toBe(true);remote=receiver.tryReceive()!
    expect(remote.rawMetadata()).toEqual(calibration);expect(calibration.valid).toBe(7)
    expect(Object.isFrozen(calibration.blackLevels)).toBe(true)
    expect(remote.makeArray('raw').shape).toEqual([5,packed.rowBytes])
    expect(remote.makeArray('raw').data).toEqual(packed.data)
    equal(remote.copyRaw16(),words)
    const dng=remote.encodeDng();equal(dng,expected);equal(dngWords(dng),words)
    const path=join(dir,'remote.dng');remote.saveDng(path);equal(new Uint8Array(readFileSync(path)),dng)
    if(process.env.ZC_RAW16_DECODER){
      const child=Bun.spawnSync([process.env.ZC_RAW16_DECODER,path]);if(child.exitCode!==0)throw new Error(`independent DNG decoder exit=${child.exitCode} signal=${child.signalCode}: ${Buffer.from(child.stderr)}`);expect(child.exitCode).toBe(0)
      const bytes=Buffer.from(child.stdout);expect(bytes.readUInt32LE(0)).toBe(17);expect(bytes.readUInt32LE(4)).toBe(5)
      equal(Uint16Array.from({length:words.length},(_,i)=>bytes.readUInt16LE(8+i*2)),words)
    }
    frame.release();await camera.stop();expect(remote.rawMetadata()).toEqual(calibration);remote.close();expect(receiver.tryAcknowledge(2n)).toBe(true);expect(sender.tryReceiveAcknowledgement()).toBe(2n);loan.close();await camera.close()
    equal(dngWords(dng),words)
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await camera.close();rmSync(dir,{recursive:true,force:true})}
})
test('remote write contexts exclude copies and saves while failed raw saves preserve existing files',async()=>{
  const c=new Camera({simulate:true,fifo:true,writable:true,width:4,height:2,raw:true,rawFormat:'SRGGB12'}),dir=mkdtempSync(join(tmpdir(),'zc-remote-invalid-'))
  const [sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();loan=frame.exportFrame({writable:true,streams:['main','raw']});loan.trySend(sender.fd,3n);remote=receiver.tryReceive()!
    const path=join(dir,'existing.dng');writeFileSync(path,'keep')
    remote.withWritablePlanes('raw',planes=>{
      const d=new DataView(planes[0].buffer);d.setUint16(planes[0].byteLength-2,0xffff,true)
      for(const read of [()=>remote!.copyStreams(),()=>remote!.makeBuffer(),()=>remote!.makeArray(),()=>remote!.copyRaw16(),()=>remote!.encodeDng(),()=>remote!.saveDng(path),()=>remote!.save(join(dir,'image.png'))])expect(read).toThrow('active')
      expect(remote!.rawMetadata().valid).toBe(7)
    })
    // Write the last active sample, independently of used padding.
    const info=remote.info().streams.find(s=>s.stream==='raw')!
    remote.withWritablePlanes('raw',planes=>new DataView(planes[0].buffer).setUint16(info.stride+6,0xffff,true))
    expect(()=>remote!.copyRaw16()).toThrow();expect(()=>remote!.encodeDng()).toThrow();expect(()=>remote!.saveDng(path)).toThrow()
    expect(readFileSync(path,'utf8')).toBe('keep')
    expect(()=>remote!.saveDng('bad\0path')).toThrow('NUL')
    expect(()=>remote!.saveDng({includes(){throw new Error('invoked')}} as any)).toThrow('string')
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('remote unavailable streams validation getter reentry and indexed snapshots retain no borrowed pointers',async()=>{
  const c=new Camera({simulate:true,width:4,height:2}),[sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();loan=frame.exportFrame();loan.trySend(sender.fd,4n);remote=receiver.tryReceive()!
    for(const run of [()=>remote!.copyStream('raw'),()=>remote!.copyRaw16(),()=>remote!.encodeDng(),()=>remote!.copyStreams(['main','raw']),()=>remote!.copyStreams(['main','main'])])expect(run).toThrow()
    const names:any=['main'];names[Symbol.iterator]=()=>{throw new Error('iterator invoked')}
    expect(remote.copyStreams(names).streams.main!.data.length).toBe(24)
    Object.defineProperty(names,0,{get(){remote!.close();return 'main'}})
    expect(()=>remote!.copyStreams(names)).toThrow('closed')
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close()}
})
test('remote processed save uses owned image paths and explicit Exif while leaving source unchanged',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:8,height:4}),dir=mkdtempSync(join(tmpdir(),'zc-remote-save-')),[sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();const before=frame.copyStream()
    loan=frame.exportFrame();loan.trySend(sender.fd,5n);remote=receiver.tryReceive()!
    remote.save(join(dir,'image.png'),{format:'png',exif:{software:'remote-fixture'}})
    expect(existsSync(join(dir,'image.png'))).toBe(true)
    remote.close();loan.close();expect(frame.copyStream()).toEqual(before)
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
for(const rawFormat of ['SRGGB12_CSI2P','MONO_PISP_COMP1','SBGGR16'])test(`${rawFormat} actual worker returns owned compact arrays raw samples and request-calibrated DNG`,async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10,raw:true,rawFormat,lores:{width:10,height:6,format:'NV12'}}),dir=mkdtempSync(join(tmpdir(),'zc-remote-process-'))
  const pool=await ProcessPool.open({module,maxResultBytes:4*1024*1024})
  try{
    c.start();using frame=c.acquire();const expected=frame.copyStreams(['lores','raw','main']),words=frame.copyRaw16(),dng=frame.encodeImage({format:'dng'}),path=join(dir,'worker.dng')
    const job=pool.submit<any>(frame,{action:'media',path},{streams:['main','raw','lores']});frame.release();await c.stop()
    const result=await job;await job.cleanupDone
    expect(result.pid).not.toBe(process.pid);expect(result.bundle).toEqual(expected);expect(result.words).toEqual(words);expect(result.dng).toEqual(dng)
    equal(new Uint8Array(readFileSync(path)),dng);expect(result.calibration.valid).toBe(7)
    await c.close();equal(dngWords(result.dng),words)
  }finally{await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})

test('remote internal permission checks and copies do not dispatch through an overridden public info method',async()=>{
  const c=new Camera({simulate:true,width:4,height:2}),[sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();loan=frame.exportFrame();loan.trySend(sender.fd,6n);remote=receiver.tryReceive()!
    const before=remote.info();let calls=0
    remote.info=()=>{calls++;remote!.close();return {...before,writable:true}}
    using image=remote.makeImage()
    expect(image.width).toBe(4);expect(remote.copyStreams().metadata).toEqual(before.metadata)
    expect(()=>remote!.withWritablePlanes('main',()=>{})).toThrow('read-only')
    expect(calls).toBe(0);expect(remote.closed).toBe(false)
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close()}
})
