import {test,expect} from 'bun:test'
import {Camera,FrameChannel,ProcessPool,CameraError,type CameraOptions} from '../../ts'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const formats=['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616'] as const
const rawFormats=['RGGB','BGGR','GRBG','GBRG'].flatMap(p=>[...[8,10,12,14,16].map(b=>`S${p}${b}`),...[10,12,14].map(b=>`S${p}${b}_CSI2P`),`${p}_PISP_COMP1`]).concat(['R8','R10','R12','R14','R16','R8_CSI2P','R10_CSI2P','R12_CSI2P','R14_CSI2P','MONO_PISP_COMP1'])
const limits={maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxWorkingBytes:4*1024*1024}
async function opened(options:CameraOptions={},streams:('main'|'raw'|'lores')[]=['main']){
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,...options}),[sender,receiver]=FrameChannel.pair()
  const frame=await camera.captureRequest(),loan=frame.exportFrame({streams,writable:options.writable})
  expect(loan.trySend(sender.fd,1n)).toBe(true)
  const remote=receiver.tryReceive()!
  let acked=false
  return{camera,frame,remote,async close(){
    remote.close()
    if(!acked){expect(receiver.tryAcknowledge(1n)).toBe(true);expect(sender.tryReceiveAcknowledgement()).toBe(1n);acked=true}
    loan.close();frame.release();sender.close();receiver.close();await camera.close()
  }}
}
const bytesEqual=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
for(const format of formats)test(`${format} async remote image workers preserve both streams and survive source closure`,async()=>{
  const source=await opened({format,lores:{width:10,height:6,format}},['main','lores'])
  try{
    for(const stream of ['main','lores'] as const)for(const container of ['jpeg','png','tiff','bmp','ppm','gif'] as const){
      const expected=source.frame.encodeImage({stream,format:container,exif:false})
      const result=await source.remote.encodeImageAsync({stream,format:container,exif:false,...limits})
      bytesEqual(result,expected)
    }
    const expected=source.frame.encodeImage({format:'png',exif:false}),lores=source.frame.encodeImage({stream:'lores',format:'tiff',exif:false})
    const main=source.remote.encodeImageAsync({format:'png',exif:false,...limits}),small=source.remote.encodeImageAsync({stream:'lores',format:'tiff',exif:false,...limits})
    await source.close()
    bytesEqual(await main,expected);bytesEqual(await small,lores)
    expect(main.cancel()).toBe(false)
  }finally{await source.close()}
})
for(const rawFormat of rawFormats)test(`${rawFormat} async remote DNG owns packed rows calibration and staged save after source retirement`,async()=>{
  const source=await opened({width:17,height:5,raw:true,rawFormat},['raw']),dir=mkdtempSync(join(tmpdir(),'zc-async-raw-')),path=join(dir,'capture.dng')
  try{
    const expected=source.frame.encodeImage({format:'dng'}),bytes=source.remote.encodeImageAsync({format:'dng',...limits}),saved=source.remote.saveDngAsync(path,limits)
    await source.close();bytesEqual(await bytes,expected);await saved;bytesEqual(readFileSync(path),expected)
    expect(readdirSync(dir)).toEqual(['capture.dng'])
    if(process.env.ZC_RAW16_DECODER){const result=Bun.spawnSync([process.env.ZC_RAW16_DECODER,path]);if(result.exitCode)throw Error(result.stderr.toString());expect(result.exitCode).toBe(0)}
  }finally{await source.close();rmSync(dir,{recursive:true,force:true})}
})
const inspect=(path:string,format:string)=>{
  const result=Bun.spawnSync([process.env.ZC_EXIF_READER!,format,path]);if(result.exitCode)throw Error(result.stderr.toString());return JSON.parse(result.stdout.toString())
}
test.skipIf(!process.env.ZC_EXIF_READER)('async remote files preserve request JPEG defaults and copied Exif ICC options across immediate close',async()=>{
  const source=await opened({lores:{width:10,height:6,format:'BGR888'}},['main','lores']),dir=mkdtempSync(join(tmpdir(),'zc-async-exif-'))
  try{
    const jpeg=join(dir,'default.jpeg'),plain=join(dir,'plain.png')
    await source.remote.saveAsync(jpeg,limits)
    expect(inspect(jpeg,'jpeg')).toMatchObject({width:18,height:10,software:'zig-camera',model:'zig-camera synthetic'})
    await source.remote.saveAsync(plain,limits);expect(inspect(plain,'png').hasExif).toBe(false)
    for(const format of ['jpeg','png','tiff'] as const){
      const path=join(dir,`override.${format}`),options={format,iccProfile:'srgb' as const,exif:{iso:12800,model:'Native worker',artist:'Chris',exposureTime:[1,250] as [number,number],dateTimeOriginal:'2002:03:04 05:06:07'},...limits}
      const job=source.remote.saveAsync(path,options,'lores');options.exif.artist='mutated';await job
      expect(inspect(path,format)).toMatchObject({width:10,height:6,iso:12800,model:'Native worker',artist:'Chris',dateTimeOriginal:'2002:03:04 05:06:07',exposureTime:[1,250]})
      if(process.env.ZC_ICC_READER)expect(Bun.spawnSync([process.env.ZC_ICC_READER,format,path]).exitCode).toBe(0)
    }
    const kept=join(dir,'retained.jpeg'),job=source.remote.saveAsync(kept,{...limits,exif:{artist:'After close'}})
    await source.close();await job;expect(inspect(kept,'jpeg').artist).toBe('After close')
  }finally{await source.close();rmSync(dir,{recursive:true,force:true})}
})
test('async admission and codec limits preserve existing destinations and release every file/job owner',async()=>{
  const source=await opened(),dir=mkdtempSync(join(tmpdir(),'zc-async-limits-')),path=join(dir,'preserved.png')
  try{
    writeFileSync(path,'preserve')
    for(const [policy,code] of [[{maxInputBytes:1},-1],[{maxOutputBytes:1},-1],[{maxWorkingBytes:1024},-7]] as const){
      const job=source.remote.saveAsync(path,{format:'png',exif:false,...limits,...policy})
      try{await job;throw Error('expected limit failure')}catch(error){expect(error).toBeInstanceOf(CameraError);expect((error as CameraError).code).toBe(code)}
      await job.cleanupDone;expect(readFileSync(path,'utf8')).toBe('preserve');expect(readdirSync(dir)).toEqual(['preserved.png'])
    }
    await expect(source.remote.saveAsync(join(dir,'missing','file.png'),{format:'png',exif:false,...limits}).wait()).rejects.toThrow('(-6)')
    expect(readdirSync(dir)).toEqual(['preserved.png'])
    for(let i=0;i<40;i++)await source.remote.encodeImageAsync({format:'png',exif:false,...limits})
    await source.remote.saveAsync(path,{format:'png',exif:false,...limits});expect(readFileSync(path)[0]).toBe(137)
  }finally{await source.close();rmSync(dir,{recursive:true,force:true})}
})
test('remote encoding and file staging leave Bun responsive and cancellation joins disposal before callbacks',async()=>{
  const source=await opened({width:4096,height:2160}),dir=mkdtempSync(join(tmpdir(),'zc-async-cancel-')),path=join(dir,'preserved.png')
  let ticks=0;const interval=setInterval(()=>ticks++,1)
  try{
    writeFileSync(path,'original')
    const encoded=source.remote.encodeImageAsync({format:'png',compressLevel:9,exif:false})
    const result=await encoded;expect(result[0]).toBe(137);expect(ticks).toBeGreaterThan(0)
    const timed=source.remote.saveAsync(path,{format:'png',compressLevel:9,exif:false,timeoutMs:1})
    await expect(timed.wait()).rejects.toThrow('deadline');await timed.cleanupDone
    expect(readFileSync(path,'utf8')).toBe('original');expect(readdirSync(dir)).toEqual(['preserved.png'])
    let callback=false
    const cancelled=source.remote.saveAsync(path,{format:'png',compressLevel:9,exif:false,signalFunction:job=>{callback=true;expect(job.error).toBeDefined();expect(readFileSync(path,'utf8')).toBe('original');expect(readdirSync(dir)).toEqual(['preserved.png'])}})
    expect(cancelled.cancel(new Error('cancel native still'))).toBe(true)
    await source.close()
    await expect(cancelled.wait()).rejects.toThrow('cancel native still');await cancelled.cleanupDone
    expect(callback).toBe(true);expect(cancelled.callbackError).toBeUndefined();expect(readdirSync(dir)).toEqual(['preserved.png'])
  }finally{clearInterval(interval);await source.close();rmSync(dir,{recursive:true,force:true})}
},30000)
test('async remote deadlines pre-abort reentrant getters and exclusive scopes reject without stale owner use',async()=>{
  const source=await opened({writable:true}),dir=mkdtempSync(join(tmpdir(),'zc-async-guard-')),path=join(dir,'keep.png')
  try{
    writeFileSync(path,'keep')
    const aborted=new AbortController();aborted.abort(new Error('aborted before admission'))
    await expect(source.remote.saveAsync(path,{signal:aborted.signal}).wait()).rejects.toThrow('aborted before admission')
    await expect(source.remote.saveAsync(path,{timeoutMs:0}).wait()).rejects.toThrow('deadline')
    source.remote.withWritablePlanes('main',()=>expect(()=>source.remote.encodeImageAsync()).toThrow('write context'))
    let reads=0
    const options={get format(){reads++;return 'png' as const},get exif(){reads++;return false as const},get maxWorkingBytes(){reads++;return 1024*1024}}
    await source.remote.saveAsync(path,options);expect(reads).toBe(3)
    const before=readFileSync(path)
    expect(()=>source.remote.saveAsync(path,{get maxWorkingBytes(){source.remote.close();return 1024*1024}})).toThrow('closed')
    bytesEqual(readFileSync(path),before)
    expect(readdirSync(dir)).toEqual(['keep.png'])
  }finally{await source.close();rmSync(dir,{recursive:true,force:true})}
})
test('actual process jobs join native image encoding and staged files before returning results and ACK',async()=>{
  const camera=new Camera({simulate:true,width:18,height:10,lores:{width:10,height:6,format:'NV12'}}),dir=mkdtempSync(join(tmpdir(),'zc-async-child-')),path=join(dir,'child.jpeg')
  const pool=await ProcessPool.open({module:new URL('../fixtures/process-handler.ts',import.meta.url)})
  try{
    using frame=await camera.captureRequest();const job=pool.submit<any>(frame,{action:'async-image',path},{streams:['main','lores']})
    const value=await job;expect(value.pid).not.toBe(process.pid);expect(value.bytes[0]).toBe(137)
    expect(value.config).toEqual(frame.configuration());expect(readFileSync(path)[0]).toBe(255)
    await pool.drain();expect(frame.referenceCount).toBe(1);expect(readdirSync(dir)).toEqual(['child.jpeg'])
    if(process.env.ZC_EXIF_READER)expect(inspect(path,'jpeg')).toMatchObject({artist:'Async child',width:10,height:6})
  }finally{await pool.close();await camera.close();rmSync(dir,{recursive:true,force:true})}
})
