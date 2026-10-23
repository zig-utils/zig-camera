import {test,expect} from 'bun:test'
import {Camera,FrameChannel,ProcessPool,type FrameExport,type RemoteFrame} from '../../ts'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const formats=['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616'] as const
const reader=process.env.ZC_EXIF_READER
function inspect(path:string,format:string){
  const result=Bun.spawnSync([reader!,format,path])
  if(result.exitCode!==0)throw Error(`Exif reader ${result.exitCode}: ${result.stderr}`)
  return JSON.parse(result.stdout.toString())
}
function bytesEqual(a:Uint8Array,b:Uint8Array){expect(Array.from(a)).toEqual(Array.from(b))}
for(const format of formats)test(`${format} remote Home encoding preserves main lores pixels calibration and capture-derived Exif after stop`,async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10,format,raw:true,rawFormat:'SRGGB12',lores:{width:10,height:6,format}}),dir=mkdtempSync(join(tmpdir(),'zc-remote-exif-'))
  const [sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();const metadata=frame.metadata()
    const plain=new Map<string,Uint8Array>()
    for(const stream of ['main','lores'] as const)for(const container of ['jpeg','png','tiff','bmp','ppm','gif'] as const)plain.set(`${stream}.${container}`,frame.encodeImage({format:container,stream,exif:false}))
    const dng=frame.encodeImage({format:'dng'})
    loan=frame.exportFrame({streams:['main','raw','lores']});loan.trySend(sender.fd,1n);remote=receiver.tryReceive()!
    frame.release();await c.stop()
    for(const stream of ['main','lores'] as const){
      for(const container of ['jpeg','png','tiff','bmp','ppm','gif'] as const)bytesEqual(remote.encodeImage({format:container,stream,exif:false}),plain.get(`${stream}.${container}`)!)
      for(const container of ['jpeg','png','tiff'] as const){
        const path=join(dir,`${stream}.${container}`),encoded=remote.encodeImage({format:container,stream,exif:true})
        writeFileSync(path,encoded)
        if(reader){
          const found=inspect(path,container)
          expect(found).toMatchObject({hasExif:true,software:'zig-camera',orientation:1,width:stream==='main'?18:10,height:stream==='main'?10:6,iso:Math.floor(metadata.analogueGain*100),offsetTimeOriginal:'+00:00'})
          expect(found.exposureTime[0]/found.exposureTime[1]).toBeCloseTo(metadata.exposureUs/1e6,8)
          expect(found.model).toBe(remote.rawMetadata().model)
          expect(found.dateTimeOriginal).toMatch(/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/)
          expect(found.subSecTimeOriginal).toMatch(/^\d{9}$/)
        }
      }
    }
    bytesEqual(remote.encodeImage({format:'dng'}),dng)
    const retained=remote.encodeImage({format:'png',exif:false})
    remote.close();loan.close();await c.close()
    bytesEqual(retained,plain.get('main.png')!)
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test.skipIf(!reader)('remote JPEG defaults PNG opt-in ICC and explicit field precedence preserve independent Exif results',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10,lores:{width:10,height:6}}),dir=mkdtempSync(join(tmpdir(),'zc-remote-meta-')),[sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();loan=frame.exportFrame({streams:['main','lores']});loan.trySend(sender.fd,2n);remote=receiver.tryReceive()!
    const jpeg=join(dir,'default.jpeg'),png=join(dir,'default.png')
    remote.save(jpeg);expect(inspect(jpeg,'jpeg').software).toBe('zig-camera')
    remote.save(jpeg,{exif:false});expect(inspect(jpeg,'jpeg').hasExif).toBe(false)
    remote.save(png);expect(inspect(png,'png').hasExif).toBe(false)
    for(const format of ['jpeg','png','tiff'] as const){
      const path=join(dir,`override.${format}`)
      remote.save(path,{format,iccProfile:'srgb',exif:{iso:102400,model:'Remote model',artist:'Chris',exposureTime:[1,125],dateTimeOriginal:'2001:02:03 04:05:06',gps:{latitude:-45.123456,longitude:-122.987654}}},'lores')
      expect(inspect(path,format)).toMatchObject({width:10,height:6,iso:102400,model:'Remote model',artist:'Chris',exposureTime:[1,125],dateTimeOriginal:'2001:02:03 04:05:06',offsetTimeOriginal:null})
      if(process.env.ZC_ICC_READER){const found=Bun.spawnSync([process.env.ZC_ICC_READER,format,path]);expect(found.exitCode).toBe(0)}
    }
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('remote metadata option admission preserves files and rejects getter close reentry and active write access',async()=>{
  const c=new Camera({simulate:true,fifo:true,writable:true,width:4,height:2}),dir=mkdtempSync(join(tmpdir(),'zc-remote-meta-reentry-')),[sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();loan=frame.exportFrame({writable:true});loan.trySend(sender.fd,3n);remote=receiver.tryReceive()!
    const path=join(dir,'keep.jpeg');writeFileSync(path,'keep')
    for(const options of [null,4,[],{quality:0},{format:'dng'},{format:'bmp',exif:true},{iccProfile:new Uint8Array([1,2,3])}] as any[])expect(()=>remote!.save(path,options)).toThrow()
    expect(readFileSync(path,'utf8')).toBe('keep');expect(readdirSync(dir)).toEqual(['keep.jpeg'])
    remote.withWritablePlanes('main',()=>{
      expect(()=>remote!.encodeImage()).toThrow('active')
      expect(()=>remote!.save(path)).toThrow('active')
    })
    let reads=0
    const options={get format(){reads++;return 'png' as const},get exif(){reads++;return false as const}}
    remote.save(join(dir,'safe.png'),options);expect(reads).toBe(2)
    const closed={get exif(){remote!.close();return true}}
    expect(()=>remote!.encodeImage(closed)).toThrow('closed')
    expect(readFileSync(path,'utf8')).toBe('keep')
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test.skipIf(!reader)('actual process remote save and encoded result retain selected capture metadata after parent retirement',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:18,height:10,lores:{width:10,height:6,format:'NV12'}}),dir=mkdtempSync(join(tmpdir(),'zc-remote-exif-process-')),pool=await ProcessPool.open({module:new URL('../fixtures/process-handler.ts',import.meta.url)})
  try{
    c.start();using frame=c.acquire();const path=join(dir,'worker.png'),metadata=frame.metadata()
    const job=pool.submit<any>(frame,{action:'exif',path},{streams:['main','lores']});frame.release();await c.stop()
    const result=await job;await job.cleanupDone
    expect(result.pid).not.toBe(process.pid)
    const found=inspect(path,'png');expect(found).toMatchObject({width:10,height:6,iso:Math.floor(metadata.analogueGain*100),software:'zig-camera'})
    writeFileSync(join(dir,'worker.jpeg'),result.jpeg);expect(inspect(join(dir,'worker.jpeg'),'jpeg')).toMatchObject({width:18,height:10,software:'zig-camera'})
    await c.close();expect(inspect(path,'png').width).toBe(10)
  }finally{await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('remote built-in ICC rejects mismatched source transfer without replacing the output',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:8,height:4,colorSpace:'rec709'}),dir=mkdtempSync(join(tmpdir(),'zc-remote-icc-reject-')),[sender,receiver]=FrameChannel.pair();let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  try{
    c.start();using frame=c.acquire();loan=frame.exportFrame();loan.trySend(sender.fd,4n);remote=receiver.tryReceive()!
    const path=join(dir,'keep.png');writeFileSync(path,'keep')
    expect(()=>remote!.encodeImage({format:'png',iccProfile:'srgb'})).toThrow()
    expect(()=>remote!.save(path,{format:'png',iccProfile:'srgb'})).toThrow()
    expect(readFileSync(path,'utf8')).toBe('keep');expect(readdirSync(dir)).toEqual(['keep.png'])
  }finally{remote?.close();sender.close();receiver.close();loan?.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('worker native retirement survives overridden close methods and retained frames across receiver capacity',async()=>{
  const c=new Camera({simulate:true,fifo:true,width:4,height:2}),pool=await ProcessPool.open({module:new URL('../fixtures/process-handler.ts',import.meta.url),maxPending:1})
  try{
    c.start();using frame=c.acquire()
    for(let i=0;i<36;i++){
      const job=pool.submit<any>(frame,{action:'override-close'})
      const result=await job;await job.cleanupDone
      expect(result.priorClosed).toBe(true)
      expect(result.jpeg[0]).toBe(255);expect(result.jpeg[1]).toBe(216)
      expect(frame.referenceCount).toBe(1)
    }
    expect(pool.stats().pending).toBe(0)
  }finally{await pool.close({drain:false});await c.close()}
})
