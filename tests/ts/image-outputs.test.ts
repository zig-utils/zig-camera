import {test,expect} from 'bun:test'
import {Camera,CapturedImage,FrameChannel,type ImageOutput,type CameraOptions} from '../../ts'
import {native as n} from '../../ts/ffi'
import {mkdtempSync,readFileSync,rmSync,readdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const limits={maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxWorkingBytes:4*1024*1024}
const formats=['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616'] as const
const containers=['jpeg','png','tiff','bmp','ppm','gif'] as const
const equal=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
const failure=(job:PromiseLike<unknown>)=>Promise.resolve(job).then(()=>undefined,error=>error)
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
function memory(){
  const chunks:Uint8Array[]=[]
  const output:ImageOutput={write(bytes){chunks.push(bytes)}}
  return{output,bytes:()=>Buffer.concat(chunks)}
}
async function remoteSource(options:CameraOptions={}){
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,...options}),frame=await camera.captureRequest(),[sender,receiver]=FrameChannel.pair()
  const loan=frame.exportFrame({streams:options.raw?['main','raw','lores']:['main','lores']})
  expect(loan.trySend(sender.fd,1n)).toBe(true)
  const remote=receiver.tryReceive()!
  let closed=false
  return{camera,frame,remote,async close(){if(closed)return;closed=true;remote.close();expect(receiver.tryAcknowledge(1n)).toBe(true);expect(sender.tryReceiveAcknowledgement()).toBe(1n);loan.close();frame.release();sender.close();receiver.close();await camera.close()}}
}
for(const format of formats)test(`${format} local async and local/remote sequential still outputs preserve main and lores Home encodings`,async()=>{
  const source=await remoteSource({format,lores:{width:10,height:6,format}})
  try{
    for(const stream of ['main','lores'] as const)for(const container of containers){
      const options={format:container,stream,exif:false as const,...limits},expected=source.frame.encodeImage(options)
      equal(await source.frame.encodeImageAsync(options),expected)
      for(const frame of [source.frame,source.remote]){
        const sink=memory();await frame.saveToAsync(sink.output,options);equal(sink.bytes(),expected)
      }
    }
    expect(source.frame.referenceCount).toBe(2)
  }finally{await source.close()}
},30000)
test('local and remote output jobs copy request/raw input before immediate source and camera retirement',async()=>{
  const source=await remoteSource({raw:true,lores:{width:10,height:6,format:'RGB161616'}})
  const sinks=[memory(),memory(),memory()],expected=[source.frame.encodeImage({format:'png',exif:false}),source.frame.encodeImage({format:'tiff',stream:'lores',exif:false}),source.frame.encodeImage({format:'dng'})]
  try{
    const jobs=[source.frame.saveToAsync(sinks[0]!.output,{format:'png',exif:false,...limits}),source.remote.saveToAsync(sinks[1]!.output,{format:'tiff',stream:'lores',exif:false,...limits}),source.frame.saveToAsync(sinks[2]!.output,{format:'dng',...limits})]
    await source.close();await Promise.all(jobs)
    sinks.forEach((sink,i)=>equal(sink.bytes(),expected[i]!))
    if(process.env.ZC_RAW16_DECODER){const dir=mkdtempSync(join(tmpdir(),'zc-output-dng-'));try{const path=join(dir,'image.dng');writeFileSync(path,sinks[2]!.bytes());const result=Bun.spawnSync([process.env.ZC_RAW16_DECODER,path]);if(result.exitCode)throw Error(result.stderr.toString());expect(result.exitCode).toBe(0)}finally{rmSync(dir,{recursive:true,force:true})}}
  }finally{await source.close()}
})
for(const format of ['gray','rgb','rgba'] as const)for(const bits of [8,16] as const)for(const endian of ['little','big'] as const)
test(`${format}${bits} ${endian} image objects use owned native workers and file-like outputs`,async()=>{
  for(const container of containers){
    if(format==='rgba'&&(container==='jpeg'||container==='ppm'))continue
    const channels=format==='gray'?1:format==='rgb'?3:4,row=3*channels*(bits/8),stride=row+7,data=new Uint8Array(stride+row)
    for(let i=0;i<data.length;i++)data[i]=(i*37)%256
    const image=CapturedImage.fromRaster({data,width:3,height:2,stride,format,bits,endian}),options={format:container,exif:false as const,...limits},expected=image.encode(options),sink=memory()
    const encoded=image.encodeAsync(options),saved=image.saveToAsync(sink.output,options)
    data.fill(99);image.close();equal(await encoded,expected);await saved;equal(sink.bytes(),expected)
  }
})
test('sequential outputs bound independent chunks and preserve partial progress and retained data',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(1024*100*3).map((_,i)=>i%251),width:1024,height:100})
  const expected=image.encode({format:'bmp'}),accepted:Uint8Array[]=[],retained:Uint8Array[]=[],snapshots:Uint8Array[]=[]
  let active=0,maxActive=0,flushes=0,calls=0
  const output:ImageOutput={async write(bytes){
    active++;maxActive=Math.max(maxActive,active);expect(bytes.length).toBeLessThanOrEqual(65536)
    for(let i=0;i<retained.length;i++)equal(retained[i]!,snapshots[i]!)
    const count=Math.min(bytes.length,++calls%2?37:8191)
    accepted.push(bytes.slice(0,count));retained.push(bytes);snapshots.push(bytes.slice())
    await new Promise<void>(r=>setTimeout(r,0));active--;return count
  },flush(){expect(active).toBe(0);flushes++}}
  await image.saveToAsync(output,{format:'bmp',...limits})
  equal(Buffer.concat(accepted),expected);expect(maxActive).toBe(1);expect(flushes).toBe(1)
})
test('sink mutation and buffer transfer cannot corrupt an unaccepted suffix',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(100*80*3).map((_,i)=>i%239),width:100,height:80})
  const expected=image.encode({format:'bmp'}),chunks:Uint8Array[]=[]
  await image.saveToAsync({write(bytes){const count=Math.min(127,bytes.length);chunks.push(bytes.slice(0,count));structuredClone(bytes.buffer,{transfer:[bytes.buffer as ArrayBuffer]});return count}},{format:'bmp',...limits})
  equal(Buffer.concat(chunks),expected)
})
for(const stage of ['write','flush'] as const)test(`cancellation joins active output ${stage}, suppresses subsequent calls and includes callbacks in cleanup`,async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(300*100*3),width:300,height:100})
  const entered=gate(),release=gate(),callback=gate(),callbackRelease=gate(),reason=Error(`cancel ${stage}`)
  let writes=0,flushes=0
  const job=image.saveToAsync({async write(){writes++;if(stage==='write'){entered.resolve();await release.promise}},async flush(){flushes++;if(stage==='flush'){entered.resolve();await release.promise}}},{format:'bmp',...limits,signalFunction:async()=>{callback.resolve();await callbackRelease.promise}})
  await entered.promise;expect(job.cancel(reason)).toBe(true)
  let done=false,clean=false;void job.operationDone.then(()=>{done=true});void job.cleanupDone.then(()=>{clean=true})
  await Bun.sleep(10);expect(done).toBe(false);expect(clean).toBe(false)
  release.resolve();expect(await failure(job)).toBe(reason);await callback.promise
  expect(clean).toBe(false);expect(writes).toBe(stage==='write'?1:2);expect(flushes).toBe(stage==='write'?0:1)
  callbackRelease.resolve();await job.cleanupDone;expect(job.cancel()).toBe(false)
})
test('output deadlines join a pending write and preserve sink errors delivered after cancellation',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(300*100*3),width:300,height:100})
  for(const reject of [false,true]){
    const entered=gate(),release=gate(),sinkError=Error('late sink failure');let calls=0
    const job=image.saveToAsync({async write(){calls++;entered.resolve();await release.promise;if(reject)throw sinkError}},{format:'bmp',...limits,timeoutMs:1000})
    await entered.promise;await Bun.sleep(1050);expect(job.cancelRequested).toBe(true);expect(job.done).toBe(false)
    release.resolve();const error=await failure(job)
    if(reject)expect(error).toBe(sinkError);else expect((error as {code:number}).code).toBe(-3)
    expect(calls).toBe(1);await job.cleanupDone
  }
},10000)
test('zero invalid or failed sink progress never spins or flushes and native quota remains reusable',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2})
  const bad=[0,-1,NaN,Infinity,0.5,65537,null,'1',false],sinkError=Error('write failed')
  for(let i=0;i<36;i++){
    let writes=0,flushes=0
    const job=image.saveToAsync({write(){writes++;if(i%10===9)throw sinkError;return bad[i%10] as number},flush(){flushes++}},{format:'png',...limits})
    const error=await failure(job);expect(error).toBeInstanceOf(Error);if(i%10===9)expect(error).toBe(sinkError)
    expect(writes).toBe(1);expect(flushes).toBe(0);await job.cleanupDone
  }
  expect((await image.encodeAsync({format:'png',...limits})).length).toBeGreaterThan(20)
})
test('output method accessors are snapshotted once with receiver binding and caller retains lifecycle',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2})
  let reads=0,flushReads=0,writes=0,flushed=0,closed=0
  const output={get write(){reads++;return function(this:unknown,bytes:Uint8Array){expect(this).toBe(output);writes++;return bytes.length}},get flush(){flushReads++;return function(this:unknown){expect(this).toBe(output);flushed++}},close(){closed++}}
  await image.saveToAsync(output,{format:'png',...limits});await image.saveToAsync(output,{format:'png',...limits})
  expect([reads,flushReads,writes,flushed,closed]).toEqual([2,2,2,2,0])
  expect(()=>image.saveToAsync({write:undefined} as unknown as ImageOutput)).toThrow()
  expect(()=>image.saveToAsync({write(){},flush:1} as unknown as ImageOutput)).toThrow()
})
test('option and destination accessors cannot bypass final source ownership checks',async()=>{
  const source=await remoteSource({lores:{width:10,height:6}})
  try{
    expect(()=>source.frame.saveToAsync({get write(){source.frame.release();return()=>{}}},{format:'png',...limits})).toThrow()
    expect(()=>source.remote.saveToAsync({write(){}},{format:'png',get maxInputBytes(){source.remote.close();return 1024}})).toThrow()
    const image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2})
    expect(()=>image.saveToAsync({write(){}},{format:'png',get maxWorkingBytes(){image.close();return 1024}})).toThrow()
  }finally{await source.close()}
})
test('pre-aborted and zero-timeout outputs do not admit native work or call the sink',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2})
  let opened=0,written=0;const original=n.zc_raster_encode_async
  Object.assign(n,{zc_raster_encode_async:((...args:Parameters<typeof original>)=>{opened++;return original(...args)}) as typeof original})
  try{
    for(const options of [{timeoutMs:0},{signal:AbortSignal.abort(Error('pre-abort'))}]){
      const job=image.saveToAsync({write(){written++}},{format:'png',...limits,...options});expect(await failure(job)).toBeInstanceOf(Error);await job.cleanupDone
    }
    expect([opened,written]).toEqual([0,0])
  }finally{Object.assign(n,{zc_raster_encode_async:original})}
})
test('image object staged saves now copy input at admission and keep failed/cancelled destinations intact',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-raster-async-')),path=join(dir,'image.png')
  try{
    const image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2}),expected=image.encode({format:'png'}),job=image.saveAsync(path,{format:'png',...limits})
    image.close();await job;equal(readFileSync(path),expected)
    for(const cancel of [false,true]){
      using next=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2});writeFileSync(path,'old')
      const saved=next.saveAsync(path,{format:'png',...limits,...(cancel?{}:{maxWorkingBytes:1})});if(cancel)expect(saved.cancel()).toBe(true)
      expect(await failure(saved)).toBeInstanceOf(Error);await saved.cleanupDone;expect(readFileSync(path,'utf8')).toBe('old');expect(readdirSync(dir)).toEqual(['image.png'])
    }
  }finally{rmSync(dir,{recursive:true,force:true})}
})
test('Bun FileSink is reusable and is flushed without being ended by still output jobs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-filesink-')),path=join(dir,'stream.ppm'),writer=Bun.file(path).writer()
  try{
    using image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2})
    const expected=image.encode({format:'ppm'})
    await image.saveToAsync(writer,{format:'ppm',...limits});await image.saveToAsync(writer,{format:'ppm',...limits})
    equal(readFileSync(path),Buffer.concat([expected,expected]))
  }finally{await writer.end();rmSync(dir,{recursive:true,force:true})}
})
test('a destination permits one active image writer until joined cancellation and can then be reused',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2})
  const entered=gate(),release=gate();let writes=0
  const output:ImageOutput={async write(){if(++writes===1){entered.resolve();await release.promise}}}
  const first=image.saveToAsync(output,{format:'png',...limits});await entered.promise
  for(const cancelled of [false,true]){
    if(cancelled)expect(first.cancel()).toBe(true)
    const second=image.saveToAsync(output,{format:'png',...limits});expect((await failure(second)).code).toBe(-4)
    expect(writes).toBe(1)
  }
  release.resolve();expect(await failure(first)).toBeInstanceOf(Error);await first.cleanupDone
  await image.saveToAsync(output,{format:'png',...limits});expect(writes).toBe(2)
})
test('staged image admission waits are cancellable and retain private pixels after image closure',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-image-admission-')),path=join(dir,'image.png'),original=n.zc_raster_encode_async
  const image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2});let calls=0,block=true
  Object.assign(n,{zc_raster_encode_async:((...args:Parameters<typeof original>)=>{calls++;return block?-4:original(...args)}) as typeof original})
  try{
    const expected=image.encode({format:'png'}),job=image.saveAsync(path,{format:'png',...limits});image.close()
    await Bun.sleep(10);expect(calls).toBeGreaterThan(1);expect(job.done).toBe(false)
    block=false;await job;equal(readFileSync(path),expected)
    using next=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2});block=true;writeFileSync(path,'old')
    const cancelled=next.saveAsync(path,{format:'png',...limits});await Bun.sleep(5);expect(cancelled.cancel()).toBe(true)
    expect(await failure(cancelled)).toBeInstanceOf(Error);await cancelled.cleanupDone
    expect(readFileSync(path,'utf8')).toBe('old');expect(readdirSync(dir)).toEqual(['image.png'])
  }finally{Object.assign(n,{zc_raster_encode_async:original});image.close();rmSync(dir,{recursive:true,force:true})}
})
test.skipIf(!process.env.ZC_EXIF_READER)('local output jobs preserve capture defaults and copied explicit Exif/ICC after camera closure',async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,lores:{width:10,height:6}}),dir=mkdtempSync(join(tmpdir(),'zc-output-exif-'))
  try{
    const frame=await camera.captureRequest(),sink=memory(),options={format:'png' as const,stream:'lores' as const,iccProfile:'srgb' as const,exif:{model:'Output camera',artist:'Chris',iso:640,dateTimeOriginal:'2001:02:03 04:05:06'},...limits}
    const jpeg=frame.encodeImageAsync({...limits}),saved=frame.saveToAsync(sink.output,options)
    options.exif.artist='changed';frame.release();await camera.close();const jpg=await jpeg;await saved
    for(const [format,bytes] of [['jpeg',jpg],['png',sink.bytes()]] as const){
      const path=join(dir,`image.${format}`);writeFileSync(path,bytes)
      const result=Bun.spawnSync([process.env.ZC_EXIF_READER!,format,path]);if(result.exitCode)throw Error(result.stderr.toString())
      const metadata=JSON.parse(result.stdout.toString())
      expect(metadata).toMatchObject(format==='jpeg'?{width:18,height:10,software:'zig-camera',model:'zig-camera synthetic'}:{width:10,height:6,model:'Output camera',artist:'Chris',iso:640,dateTimeOriginal:'2001:02:03 04:05:06'})
      if(format==='png'&&process.env.ZC_ICC_READER)expect(Bun.spawnSync([process.env.ZC_ICC_READER,format,path]).exitCode).toBe(0)
    }
  }finally{await camera.close();rmSync(dir,{recursive:true,force:true})}
})
test('local async admission honors an exclusive write mapping and retries safely after it closes',async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,writable:true})
  try{
    using frame=await camera.captureRequest();const map=frame.mapStream()
    try{expect((await failure(frame.encodeImageAsync({format:'png',...limits}))).code).toBe(-4)}finally{map.close()}
    expect((await frame.encodeImageAsync({format:'png',...limits}))[0]).toBe(137)
  }finally{await camera.close()}
})
test('slow outputs hold the shared native owner quota through joined writes and release it on failure',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(12),width:2,height:2})
  const entered=Array.from({length:4},gate),release=gate(),jobs=entered.map((ready,i)=>image.saveToAsync({async write(){ready.resolve();await release.promise;if(i===0)throw Error('sink failure')}},{format:'png',...limits}))
  try{
    await Promise.all(entered.map(ready=>ready.promise))
    for(const job of [image.encodeAsync({format:'png',...limits}),image.saveToAsync({write(){throw Error('must not run')}},{format:'png',...limits})])expect((await failure(job)).code).toBe(-4)
    expect(jobs[0]!.cancel()).toBe(true);await Bun.sleep(5)
    expect((await failure(image.encodeAsync({format:'png',...limits}))).code).toBe(-4)
  }finally{release.resolve();const errors=await Promise.all(jobs.map(failure));expect(errors[0]?.message).toBe('sink failure');expect(errors.slice(1)).toEqual([undefined,undefined,undefined]);await Promise.all(jobs.map(job=>job.cleanupDone))}
  expect((await image.encodeAsync({format:'png',...limits}))[0]).toBe(137)
})
