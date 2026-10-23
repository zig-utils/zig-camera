import{test,expect}from'bun:test'
import{Camera,ProcessPool,ProcessWorkerError,type BunJob}from'../../ts'
import{native}from'../../ts/ffi'
import{mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync}from'node:fs'
import{tmpdir}from'node:os'
import{join}from'node:path'
const module=new URL('../fixtures/process-handler.ts',import.meta.url)
const cam=()=>new Camera({simulate:true,fifo:true,width:18,height:10,raw:true,rawFormat:'SRGGB12',lores:{width:10,height:6,format:'NV12'}})
const equal=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
async function until(predicate:()=>boolean){const end=performance.now()+10000;while(!predicate()){if(performance.now()>end)throw Error('test condition timeout');await Bun.sleep(2)}}
const formats=['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616']as const
for(const format of formats)test(`${format} parent-only process publication preserves encoded bytes and returns source before callbacks`,async()=>{
 const c=new Camera({simulate:true,fifo:true,width:18,height:10,format,lores:{width:10,height:6,format}}),pool=await ProcessPool.open({module}),dir=mkdtempSync(join(tmpdir(),'zc-parent-file-'))
 try{
  using frame=await c.captureRequest()
  for(const stream of ['main','lores']as const)for(const codec of ['jpeg','png','tiff','bmp','ppm','gif']as const){
   const path=join(dir,`${stream}.${codec}`),expected=frame.encodeImage({format:codec,stream,exif:false})
   let callback=false
   const job=pool.submitToFile(frame,path,{action:'parent-image',format:codec,stream},{streams:[stream],signalFunction:()=>{callback=true;equal(readFileSync(path),expected);expect(frame.referenceCount).toBe(1)}})
   expect(await job).toBeUndefined();await job.cleanupDone;expect(callback).toBe(true);expect(job.callbackError).toBeUndefined();equal(readFileSync(path),expected)
  }
  await pool.drain();expect(pool.stats().pending).toBe(0);expect(readdirSync(dir).length).toBe(12)
 }finally{await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('parent DNG and captured Exif publish from child bytes without transferring destination path',async()=>{
 const c=cam(),pool=await ProcessPool.open({module}),dir=mkdtempSync(join(tmpdir(),'zc-parent-dng-'))
 try{
  using frame=await c.captureRequest();const path=join(dir,'raw.dng'),expected=frame.encodeImage({format:'dng'})
  await pool.submitToFile(frame,path,{action:'parent-image',format:'dng',stream:'raw'},{streams:['raw']});equal(readFileSync(path),expected)
  if(process.env.ZC_RAW16_DECODER)expect(Bun.spawnSync([process.env.ZC_RAW16_DECODER,path]).exitCode).toBe(0)
  const jpeg=join(dir,'photo.jpeg');await pool.submitToFile(frame,jpeg,{action:'parent-image',format:'jpeg',exif:{artist:'Parent published'}},{streams:['main']})
  if(process.env.ZC_EXIF_READER){const r=Bun.spawnSync([process.env.ZC_EXIF_READER,'jpeg',jpeg]);expect(r.exitCode).toBe(0);expect(JSON.parse(r.stdout.toString())).toMatchObject({artist:'Parent published',software:'zig-camera'})}
 }finally{await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('active cancellation joins killed worker without creating a parent temporary or changing destination',async()=>{
 const c=cam(),pool=await ProcessPool.open({module}),dir=mkdtempSync(join(tmpdir(),'zc-parent-cancel-')),path=join(dir,'keep.png'),marker=join(dir,'active')
 try{
  writeFileSync(path,'keep');using frame=await c.captureRequest();const pid=pool.workerStates()[0].pid!
  const job=pool.submitToFile(frame,path,{action:'spin',marker});await until(()=>existsSync(marker));expect(job.cancel()).toBe(true)
  await expect(job.wait()).rejects.toThrow('cancelled');await job.cleanupDone
  expect(()=>process.kill(pid,0)).toThrow();expect(pool.workerStates()[0].joined).toBe(true);expect(frame.referenceCount).toBe(1)
  expect(readFileSync(path,'utf8')).toBe('keep');expect(readdirSync(dir).sort()).toEqual(['active','keep.png'])
  await pool.restart(0);await pool.submitToFile(frame,path,{action:'parent-image'});expect(readFileSync(path)[0]).toBe(137)
 }finally{await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('a serialized result without matching ACK cannot publish',async()=>{
 const c=cam(),pool=await ProcessPool.open({module}),dir=mkdtempSync(join(tmpdir(),'zc-parent-ack-')),path=join(dir,'keep.png')
 try{writeFileSync(path,'keep');using frame=await c.captureRequest();const job=pool.submitToFile(frame,path,{action:'image-no-ack'});await expect(job.wait()).rejects.toBeInstanceOf(ProcessWorkerError);await job.cleanupDone;expect(frame.referenceCount).toBe(1);expect(readFileSync(path,'utf8')).toBe('keep');expect(readdirSync(dir)).toEqual(['keep.png'])}
 finally{await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('cancellation during parent staging preserves next task on the already reused worker',async()=>{
 const c=cam(),pool=await ProcessPool.open({module}),dir=mkdtempSync(join(tmpdir(),'zc-parent-stage-')),path=join(dir,'keep.png'),prepare=native.zc_image_file_prepare_bytes
 let first:BunJob<void>,next:BunJob<any>|undefined,seen=false
 try{
  writeFileSync(path,'keep');using frame=await c.captureRequest();const pid=pool.workerStates()[0].pid
  Object.assign(native,{zc_image_file_prepare_bytes:(...args:Parameters<typeof prepare>)=>{
   const rc=prepare(...args)
   if(rc===0&&!seen){seen=true;expect(frame.referenceCount).toBe(1);next=pool.submit<any>(frame,{action:'echo',value:43});expect(first.cancel(new Error('cancel parent stage'))).toBe(true)}
   return rc
  }})
  first=pool.submitToFile(frame,path,{action:'parent-image'});await expect(first.wait()).rejects.toThrow('cancel parent stage');await first.cleanupDone
  expect(seen).toBe(true);expect(await next).toBe(43);expect(pool.workerStates()[0].pid).toBe(pid);expect(pool.workerStates()[0].joined).toBe(false)
  expect(readFileSync(path,'utf8')).toBe('keep');expect(readdirSync(dir)).toEqual(['keep.png'])
 }finally{Object.assign(native,{zc_image_file_prepare_bytes:prepare});await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('parent publication guards late cancellation and drain includes completion callback cleanup',async()=>{
 const c=cam(),pool=await ProcessPool.open({module}),dir=mkdtempSync(join(tmpdir(),'zc-parent-drain-')),path=join(dir,'photo.png'),finish=native.zc_image_file_finish
 let first:BunJob<void>,entered=false,release!:()=>void,claimed=false
 const gate=new Promise<void>(resolve=>release=resolve)
 try{
  using frame=await c.captureRequest()
  Object.assign(native,{zc_image_file_finish:(...args:Parameters<typeof finish>)=>{const rc=finish(...args);if(args[1]===1&&rc===0){claimed=true;expect(first.cancel()).toBe(false)}return rc}})
  first=pool.submitToFile(frame,path,{action:'parent-image'},{signalFunction:async()=>{entered=true;expect(frame.referenceCount).toBe(1);expect(readFileSync(path)[0]).toBe(137);await gate}})
  await first;await until(()=>entered);const drain=pool.drainAsync();expect(drain.done).toBe(false);expect(pool.stats().pending).toBe(1);release();await first.cleanupDone;await drain;expect(pool.stats().pending).toBe(0);expect(claimed).toBe(true)
 }finally{release();Object.assign(native,{zc_image_file_finish:finish});await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('invalid results and I/O failures preserve files and release all parent reservations',async()=>{
 const c=cam(),pool=await ProcessPool.open({module,maxResultBytes:1024*1024}),dir=mkdtempSync(join(tmpdir(),'zc-parent-fail-')),path=join(dir,'keep.png')
 try{
  using frame=await c.captureRequest();writeFileSync(path,'keep')
  for(const value of [undefined,'text',new Uint8Array(0),{bytes:new Uint8Array([1])}])await expect(pool.submitToFile(frame,path,{action:'echo',value}).wait()).rejects.toThrow('nonempty Uint8Array')
  await expect(pool.submitToFile(frame,path,{action:'oversize'}).wait()).rejects.toThrow()
  await expect(pool.submitToFile(frame,join(dir,'missing','x.png'),{action:'parent-image'}).wait()).rejects.toThrow('(-6)')
  await pool.drain();expect(frame.referenceCount).toBe(1);expect(pool.stats().bytes).toBe(0n);expect(readdirSync(dir)).toEqual(['keep.png']);expect(readFileSync(path,'utf8')).toBe('keep')
  for(let i=0;i<36;i++)await pool.submitToFile(frame,path,{action:'parent-image'});await pool.drain();expect(pool.stats().pending).toBe(0)
 }finally{await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('deadline stays active after ACK and source retirement until parent staging joins',async()=>{
 const c=cam(),pool=await ProcessPool.open({module}),dir=mkdtempSync(join(tmpdir(),'zc-parent-deadline-')),path=join(dir,'keep.png'),query=native.zc_image_file_preparation_result
 let seen=false
 try{
  using frame=await c.captureRequest();writeFileSync(path,'keep');const pid=pool.workerStates()[0].pid
  Object.assign(native,{zc_image_file_preparation_result:(...args:Parameters<typeof query>)=>{const rc=query(...args);if(rc===0){seen=true;expect(frame.referenceCount).toBe(1);return -3}return rc}})
  const job=pool.submitToFile(frame,path,{action:'parent-image'},{timeoutMs:1000});await expect(job.wait()).rejects.toThrow('deadline');await job.cleanupDone
  expect(seen).toBe(true);expect(pool.workerStates()[0].pid).toBe(pid);expect(pool.workerStates()[0].joined).toBe(false)
  expect(readFileSync(path,'utf8')).toBe('keep');expect(readdirSync(dir)).toEqual(['keep.png']);expect(pool.stats().pending).toBe(0)
 }finally{Object.assign(native,{zc_image_file_preparation_result:query});await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
},15000)

test('relative parent destinations resolve before option accessors and child completion',async()=>{
 const original=process.cwd(),dir=mkdtempSync(join(tmpdir(),'zc-parent-cwd-')),a=join(dir,'a'),b=join(dir,'b'),c=cam(),pool=await ProcessPool.open({module})
 mkdirSync(a);mkdirSync(b)
 try{
  using frame=await c.captureRequest();process.chdir(a)
  const job=pool.submitToFile(frame,'photo.png',{action:'parent-image'},{get timeoutMs(){process.chdir(b);return 10000}})
  await job;expect(readFileSync(join(a,'photo.png'))[0]).toBe(137);expect(readdirSync(b)).toEqual([])
 }finally{process.chdir(original);await pool.close();await c.close();rmSync(dir,{recursive:true,force:true})}
})
