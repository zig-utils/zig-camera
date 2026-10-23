import {test,expect} from 'bun:test'
import {Camera,RequestCallbackError,type CameraOptions,type ImageOutput,type BunJob,Control} from '../../ts'
import {native as n,view} from '../../ts/ffi'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const limits={maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxWorkingBytes:4*1024*1024}
const cam=(options:CameraOptions={})=>new Camera({simulate:true,fifo:true,width:18,height:10,raw:true,lores:{width:10,height:6},...options})
const formats=['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616'] as const
const failure=(job:PromiseLike<unknown>)=>Promise.resolve(job).then(()=>undefined,error=>error)
const equal=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
function memory(){const chunks:Uint8Array[]=[];return{output:{write(bytes:Uint8Array){chunks.push(bytes)}} as ImageOutput,bytes:()=>Buffer.concat(chunks)}}
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('wait timed out');await Bun.sleep(1)}}
async function focusMetadata(c:Camera,state:number){for(let i=0;i<64;i++){const meta=await c.captureMetadata();if(meta.afPauseState===state&&meta.controlRevision===c.controlSnapshot().revision)return meta}throw Error('focus restoration acknowledgement missing')}

for(const format of formats)test(`${format} camera outputs preserve main/lores source bytes through ordinary and temporary capture`,async()=>{
  const c=cam({format,lores:{width:10,height:6,format}})
  try{
    for(const stream of ['main','lores'] as const)for(const temporary of [false,true]){
      const options={format:(temporary?'tiff':'png') as 'png'|'tiff',stream,exif:false as const,...limits},expected=new Map<bigint,Uint8Array>(),sink=memory(),width=temporary?32:18
      c.postCallback=request=>{if(request.width===width){expect(sink.bytes().length).toBe(0);expected.set(request.sequence,request.encodeImage(options))}}
      const meta=temporary?await c.switchModeAndCaptureTo({width:32,height:24,format,lores:{width:12,height:8,format}},sink.output,options):await c.captureTo(sink.output,options)
      c.setRequestCallbacks({});equal(sink.bytes(),expected.get(meta.sequence)!);expect(c.stats().leased).toBe(0);expect(c.info().width).toBe(18)
    }
  }finally{c.setRequestCallbacks({});await c.close()}
},30000)
for(const format of ['jpeg','png','tiff','bmp','ppm','gif','dng'] as const)for(const kind of ['ordinary','focus','mode'] as const)
test(`${kind} ${format} output derives the selected request and waits for post callbacks`,async()=>{
  const c=cam(),sink=memory(),expected=new Map<bigint,Uint8Array>(),options={format,exif:false as const,...limits},width=kind==='mode'?32:18
  try{
    if(kind==='focus')c.startContinuousAutofocus()
    c.postCallback=request=>{if(request.width===width){expect(sink.bytes().length).toBe(0);expected.set(request.sequence,request.encodeImage(options))}}
    const job=kind==='mode'?c.switchModeAndCaptureTo({width:32,height:24},sink.output,options):kind==='focus'?c.captureFocusLockedToAsync(sink.output,options):c.captureToAsync(sink.output,options)
    const meta=await job;await job.cleanupDone;c.setRequestCallbacks({})
    equal(sink.bytes(),expected.get(meta.sequence)!);expect(c.stats().leased).toBe(0);expect(c.info().width).toBe(18)
    if(kind==='focus'){expect(meta.afPauseState).toBe(2);expect((await focusMetadata(c,0)).afPauseState).toBe(0)}
    if(format==='dng'&&process.env.ZC_RAW16_DECODER){const dir=mkdtempSync(join(tmpdir(),'zc-capture-output-'));try{const path=join(dir,'raw.dng');writeFileSync(path,sink.bytes());const result=Bun.spawnSync([process.env.ZC_RAW16_DECODER,path]);if(result.exitCode)throw Error(result.stderr.toString());expect(result.exitCode).toBe(0)}finally{rmSync(dir,{recursive:true,force:true})}}
  }finally{c.setRequestCallbacks({});await c.close()}
})
for(const kind of ['ordinary','focus','mode'] as const)test(`${kind} capture callback failures suppress all sink calls and release native jobs for reuse`,async()=>{
  const c=cam(),marker=Error('post capture failure'),original=n.zc_encode_stream_image_async;let writes=0,flushes=0,visited=false,admitted=false
  const output:ImageOutput={write(){writes++},flush(){flushes++}},width=kind==='mode'?32:18
  const capture=()=>kind==='mode'?c.switchModeAndCaptureTo({width:32,height:24},output,{format:'png',...limits}):kind==='focus'?c.captureFocusLockedToAsync(output,{format:'png',...limits}):c.captureToAsync(output,{format:'png',...limits})
  try{
    if(kind==='focus')c.startContinuousAutofocus()
    Object.assign(n,{zc_encode_stream_image_async:(...args:Parameters<typeof original>)=>{const code=original(...args);if(code===0)admitted=true;return code}})
    c.postCallback=request=>{if(request.width===width&&admitted){visited=true;expect([writes,flushes]).toEqual([0,0]);throw marker}}
    const job=capture(),error=await failure(job);await job.cleanupDone
    expect(error).toBeInstanceOf(RequestCallbackError);expect(error.cause).toBe(marker);expect(visited).toBe(true);expect([writes,flushes]).toEqual([0,0]);expect(c.stats().leased).toBe(0)
    c.setRequestCallbacks({});await capture();expect(writes).toBeGreaterThan(0);expect(flushes).toBe(1)
  }finally{Object.assign(n,{zc_encode_stream_image_async:original});c.setRequestCallbacks({});await c.close()}
})
for(const kind of ['ordinary','focus','mode'] as const)test(`${kind} cancellation in post processing joins restoration and prevents visible prefixes`,async()=>{
  const c=cam(),reason=Error('cancel prepared output'),sink=memory(),width=kind==='mode'?32:18
  let job:BunJob<ReturnType<Camera['captureMetadata']> extends Promise<infer T>?T:never>,visited=false
  try{
    if(kind==='focus')c.startContinuousAutofocus()
    c.postCallback=request=>{if(request.width===width&&!visited){visited=true;expect(job.cancel(reason)).toBe(true)}}
    job=kind==='mode'?c.switchModeAndCaptureTo({width:32,height:24},sink.output,{format:'png',...limits}):kind==='focus'?c.captureFocusLockedToAsync(sink.output,{format:'png',...limits}):c.captureToAsync(sink.output,{format:'png',...limits})
    expect(await failure(job)).toBe(reason);await job.cleanupDone;c.setRequestCallbacks({})
    expect(visited).toBe(true);expect(sink.bytes().length).toBe(0);expect(c.info().width).toBe(18);expect(c.stats().leased).toBe(0)
    if(kind==='focus')expect((await focusMetadata(c,0)).afPauseState).toBe(0)
  }finally{c.setRequestCallbacks({});await c.close()}
})
test('focus output waits for acknowledgement of running or paused intent before sink delivery',async()=>{
  const c=cam()
  try{
    c.startContinuousAutofocus()
    for(const paused of [false,true]){
      if(paused)await c.autofocusPauseAsync()
      const entered=gate(),release=gate(),chunks:Uint8Array[]=[]
      const job=c.captureFocusLockedToAsync({async write(bytes){chunks.push(bytes);entered.resolve();await release.promise}},{format:'png',...limits})
      try{await entered.promise;expect(c.stats().leased).toBe(0);expect((await focusMetadata(c,paused?2:0)).afPauseState).toBe(paused?2:0)}finally{release.resolve();await job}
      expect(chunks.length).toBeGreaterThan(0)
    }
  }finally{await c.close()}
})
test('focus restoration failure or cancellation leaves the output untouched and native owners reusable',async()=>{
  const c=cam(),original=n.zc_autofocus_pause_restore,reason=Error('restore cancellation');let calls=0
  try{
    c.startContinuousAutofocus()
    for(const cancel of [false,true]){
      let job:ReturnType<Camera['captureFocusLockedToAsync']>
      Object.assign(n,{zc_autofocus_pause_restore:(...args:Parameters<typeof original>)=>{expect(calls).toBe(0);if(!cancel)return -6;const rc=original(...args);job.cancel(reason);return rc}})
      job=c.captureFocusLockedToAsync({write(){calls++}},{format:'png',...limits})
      const error=await failure(job);if(cancel)expect(error).toBe(reason);else expect(error).toMatchObject({code:-6})
      await job.cleanupDone;expect(calls).toBe(0);expect(c.stats().leased).toBe(0)
      Object.assign(n,{zc_autofocus_pause_restore:original});await c.autofocusResumeAsync()
    }
    await c.captureFocusLockedTo({write(){calls++}},{format:'png',...limits});expect(calls).toBeGreaterThan(0)
  }finally{Object.assign(n,{zc_autofocus_pause_restore:original});await c.close()}
})
test('mode output restores preview runtime controls and target autofocus before its first write',async()=>{
  const c=cam(),entered=gate(),release=gate();let pre=0,post=0
  try{
    c.setControls([{id:Control.exposureTime,type:'int',values:[1200]}]);const before=c.controlSnapshot();c.startPreview({backend:'headless'})
    c.preCallback=request=>{if(request.width===32)pre++};c.postCallback=request=>{if(request.width===32)post++}
    const job=c.switchModeAndCaptureTo({width:32,height:24},{async write(){entered.resolve();await release.promise}},{format:'png',autofocus:true,dropFrames:2,...limits})
    try{
      await entered.promise;expect(c.info().width).toBe(18);expect(c.stats().leased).toBe(0)
      expect(c.controlSnapshot().controls.find(value=>value.id===Control.exposureTime)?.values).toEqual(before.controls.find(value=>value.id===Control.exposureTime)?.values)
      expect(c.previewInfo()).toBeDefined();expect(pre).toBeGreaterThanOrEqual(3);expect(post).toBe(pre)
    }finally{release.resolve();await job}
  }finally{c.setRequestCallbacks({});release.resolve();await c.close()}
})
test('temporary raw outputs enable a raw target without changing the restored source recipe',async()=>{
  const c=cam({raw:false}),sink=memory()
  try{await c.switchModeAndCaptureTo({width:17,height:5},sink.output,{format:'dng',...limits});expect(sink.bytes().subarray(0,2).toString()).toBe('II');expect(c.options.raw).toBe(false);expect(c.info().width).toBe(18)}finally{await c.close()}
})
test('mode and preview restoration failures never release the output publication barrier',async()=>{
  for(const preview of [false,true]){
    const c=cam(),Original=globalThis.Worker,owner=c as unknown as {openPreviewOwned:(options:unknown)=>void},open=owner.openPreviewOwned;let writes=0
    try{
      if(preview){c.startPreview({backend:'headless'});Object.assign(c,{openPreviewOwned:()=>{throw Error('preview restore failed')}})}
      else globalThis.Worker=function(url:string|URL,options?:WorkerOptions){const worker=new Original(url,options),post=worker.postMessage.bind(worker);Object.assign(worker,{postMessage:(request:unknown)=>{const value=request as {capture?:{kind:string};previousConfig:Uint8Array};if(value.capture?.kind==='output'){const previous=value.previousConfig.slice();view(previous).setUint32(0,0,true);post({...value,previousConfig:previous})}else post(request)}});return worker} as unknown as typeof Worker
      const error=await failure(c.switchModeAndCaptureTo({width:32,height:24},{write(){writes++}},{format:'png',...limits}))
      expect(error).toBeInstanceOf(Error);expect(writes).toBe(0)
    }finally{globalThis.Worker=Original;Object.assign(c,{openPreviewOwned:open});await c.close()}
  }
})
test('worker construction failure leaves the original camera and shared codec quota usable',async()=>{
  const c=cam(),Original=globalThis.Worker;let writes=0
  try{
    globalThis.Worker=class{constructor(){throw Error('worker unavailable')}} as unknown as typeof Worker
    expect(String(await failure(c.switchModeAndCaptureTo({width:32,height:24},{write(){writes++}},{format:'png',...limits})))).toContain('worker unavailable')
    expect(writes).toBe(0);expect(c.info().width).toBe(18);globalThis.Worker=Original
    await c.switchModeAndCaptureTo({width:32,height:24},{write(){writes++}},{format:'png',...limits});expect(writes).toBeGreaterThan(0)
  }finally{globalThis.Worker=Original;await c.close()}
})
for(const kind of ['ordinary','focus','mode'] as const)for(const stage of ['write','flush'] as const)test(`${kind} output cancellation joins accepted ${stage} and callback cleanup`,async()=>{
  const c=cam(),entered=gate(),release=gate(),callback=gate(),callbackRelease=gate(),reason=Error('cancel sink');let writes=0,flushes=0
  const output:ImageOutput={async write(){writes++;if(stage==='write'){entered.resolve();await release.promise}},async flush(){flushes++;if(stage==='flush'){entered.resolve();await release.promise}}}
  const options={format:'png' as const,...limits,signalFunction:async()=>{callback.resolve();await callbackRelease.promise}}
  let job:ReturnType<Camera['captureToAsync']>|undefined
  try{
    if(kind==='focus')c.startContinuousAutofocus()
    job=kind==='mode'?c.switchModeAndCaptureTo({width:32,height:24},output,options):kind==='focus'?c.captureFocusLockedToAsync(output,options):c.captureToAsync(output,options)
    await entered.promise;expect(c.stats().leased).toBe(0);expect(c.info().width).toBe(18);expect(job.cancel(reason)).toBe(true)
    await Bun.sleep(10);expect(job.done).toBe(false);release.resolve();expect(await failure(job)).toBe(reason);await callback.promise
    let cleaned=false;void job.cleanupDone.then(()=>{cleaned=true});await Bun.sleep(5);expect(cleaned).toBe(false);callbackRelease.resolve();await job.cleanupDone
    expect(writes).toBe(1);expect(flushes).toBe(stage==='flush'?1:0)
  }finally{release.resolve();callbackRelease.resolve();if(job)await failure(job);await c.close()}
})
test('camera stop joins a pending output write and native cleanup before settling',async()=>{
  const c=cam(),entered=gate(),release=gate()
  try{
    const job=c.captureToAsync({async write(){entered.resolve();await release.promise}},{format:'png',...limits});await entered.promise
    let stopped=false;const stop=c.stop().then(()=>{stopped=true});await Bun.sleep(10);expect(stopped).toBe(false);expect(job.done).toBe(false)
    release.resolve();expect(await failure(job)).toBeInstanceOf(Error);await stop;expect(stopped).toBe(true);expect(c.stats().leased).toBe(0)
    await c.captureTo({write(){}},{format:'png',...limits})
  }finally{release.resolve();await c.close()}
})
test('sink hooks cannot re-enter camera ownership synchronously or after awaits',async()=>{
  const c=cam();let writes=0,flushes=0
  try{
    await c.captureTo({async write(){writes++;expect(()=>c.captureToAsync({write(){}})).toThrow('output hook');await Bun.sleep(1);expect(()=>c.close()).toThrow('output hook')},async flush(){flushes++;await Bun.sleep(1);expect(()=>c.stop()).toThrow('output hook')}},{format:'png',...limits})
    expect([writes,flushes]).toEqual([1,1]);expect(c.info().width).toBe(18)
  }finally{await c.close()}
})
test('capture option and sink accessors are snapshotted once before owner revalidation',async()=>{
  const c=cam(),sink=memory();let methods=0,formatsRead=0,limitsRead=0,callbacks=0
  try{
    const output={get write(){methods++;return sink.output.write}},options={get format(){formatsRead++;return 'png' as const},get maxWorkingBytes(){limitsRead++;return limits.maxWorkingBytes},signalFunction(){callbacks++}}
    const job=c.captureToAsync(output,options);await job;await job.cleanupDone;expect([methods,formatsRead,limitsRead,callbacks]).toEqual([1,1,1,1]);expect(sink.bytes()[0]).toBe(137)
    const owned=c as unknown as {handle:number};const handle=owned.handle
    try{expect(()=>c.captureToAsync({get write(){owned.handle=0;return()=>{}}})).toThrow('unavailable')}finally{owned.handle=handle}
  }finally{await c.close()}
})
test('capture deadline after a synchronous post callback leaves no sink prefix and preserves reuse',async()=>{
  const c=cam();let writes=0,entered=false
  try{
    c.postCallback=()=>{if(!entered){entered=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100)}}
    const error=await failure(c.captureToAsync({write(){writes++}},{format:'png',...limits,timeoutMs:1000}));expect(error).toMatchObject({code:-3});expect(entered).toBe(true);expect(writes).toBe(0)
    c.setRequestCallbacks({});await c.captureTo({write(){writes++}},{format:'png',...limits});expect(writes).toBe(1)
  }finally{c.setRequestCallbacks({});await c.close()}
},10000)
test('unclaimed internal capture hooks cancel before native admission and late messages cannot read retired frames',async()=>{
  const c=cam(),Original=globalThis.Worker,original=n.zc_encode_stream_image_async,reason=Error('cancel internal hook');let late:(()=>void)|undefined,admitted=0,writes=0
  try{
    Object.assign(n,{zc_encode_stream_image_async:(...args:Parameters<typeof original>)=>{admitted++;return original(...args)}})
    globalThis.Worker=function(url:string|URL,options?:WorkerOptions){
      const inner=new Original(url,options)
      return new class{
        onmessage?: (event:MessageEvent)=>void
        onerror?: (event:ErrorEvent)=>void
        constructor(){inner.onmessage=event=>{if(event.data?.kind==='request-hook'&&event.data.phase==='capture'&&!late){late=()=>this.onmessage?.(event);return}this.onmessage?.(event)};inner.onerror=event=>this.onerror?.(event)}
        postMessage(value:unknown){inner.postMessage(value)}
        terminate(){inner.terminate()}
      }()
    } as unknown as typeof Worker
    const job=c.switchModeAndCaptureTo({width:32,height:24},{write(){writes++}},{format:'png',...limits})
    await until(()=>!!late);expect(job.cancel(reason)).toBe(true);expect(await failure(job)).toBe(reason);await job.cleanupDone
    late!();expect([admitted,writes]).toEqual([0,0]);expect(c.info().width).toBe(18);expect(c.stats().leased).toBe(0)
  }finally{globalThis.Worker=Original;Object.assign(n,{zc_encode_stream_image_async:original});await c.close()}
})
test('failed mode responses discard parent-owned prepared jobs and preserve the camera across repeated reuse',async()=>{
  const c=cam(),Original=globalThis.Worker;let writes=0
  try{
    for(let iteration=0;iteration<8;iteration++){
      globalThis.Worker=function(url:string|URL,options?:WorkerOptions){
        const inner=new Original(url,options)
        return new class{
          onmessage?: (event:MessageEvent)=>void
          onerror?: (event:ErrorEvent)=>void
          constructor(){inner.onmessage=event=>this.onmessage?.(event.data?.kind==='request-hook'?event:{data:{...event.data,code:-6}} as MessageEvent);inner.onerror=event=>this.onerror?.(event)}
          postMessage(value:unknown){inner.postMessage(value)}
          terminate(){inner.terminate()}
        }()
      } as unknown as typeof Worker
      const job=c.switchModeAndCaptureTo({width:32,height:24},{write(){writes++}},{format:'png',...limits})
      expect(await failure(job)).toMatchObject({code:-6});await job.cleanupDone;expect(writes).toBe(iteration);expect(c.info().width).toBe(18);expect(c.stats().leased).toBe(0)
      globalThis.Worker=Original;await c.captureTo({write(){writes++}},{format:'png',...limits})
    }
    expect(writes).toBe(8)
  }finally{globalThis.Worker=Original;await c.close()}
})
test('slow camera outputs retain native quota through delivery and mode rejection restores its source',async()=>{
  const cameras=Array.from({length:5},()=>cam()),entered=Array.from({length:4},gate),release=gate(),jobs=cameras.slice(0,4).map((c,i)=>c.captureToAsync({async write(){entered[i]!.resolve();await release.promise}},{format:'png',...limits}))
  try{
    await Promise.all(entered.map(value=>value.promise));cameras.forEach(c=>expect(c.stats().leased).toBe(0))
    let writes=0
    expect(await failure(cameras[4]!.captureToAsync({write(){writes++}},{format:'png',...limits}))).toMatchObject({code:-4})
    expect(await failure(cameras[4]!.switchModeAndCaptureTo({width:32,height:24},{write(){writes++}},{format:'png',...limits}))).toMatchObject({code:-4})
    expect(writes).toBe(0);expect(cameras[4]!.info().width).toBe(18);expect(cameras[4]!.stats().leased).toBe(0)
    release.resolve();await Promise.all(jobs);await cameras[4]!.captureTo({write(){writes++}},{format:'png',...limits});expect(writes).toBe(1)
  }finally{release.resolve();await Promise.all(jobs.map(failure));await Promise.all(cameras.map(c=>c.close()))}
})
test('pre-aborted and zero-timeout capture outputs create no native work or mode workers',async()=>{
  const c=cam(),Original=globalThis.Worker,original=n.zc_encode_stream_image_async;let workers=0,encodes=0,writes=0
  try{
    Object.assign(n,{zc_encode_stream_image_async:(...args:Parameters<typeof original>)=>{encodes++;return original(...args)}})
    globalThis.Worker=function(url:string|URL,options?:WorkerOptions){workers++;return new Original(url,options)} as unknown as typeof Worker
    for(const options of [{timeoutMs:0},{signal:AbortSignal.abort(Error('pre-abort'))}])for(const kind of ['ordinary','focus','mode']){
      const target={format:'png' as const,...limits,...options},output={write(){writes++}}
      const job=kind==='mode'?c.switchModeAndCaptureTo({width:32,height:24},output,target):kind==='focus'?c.captureFocusLockedToAsync(output,target):c.captureToAsync(output,target)
      expect(await failure(job)).toBeInstanceOf(Error);await job.cleanupDone
    }
    expect([workers,encodes,writes]).toEqual([0,0,0]);expect(c.stats().leased).toBe(0)
  }finally{globalThis.Worker=Original;Object.assign(n,{zc_encode_stream_image_async:original});await c.close()}
})
test('codec budget denial and sink errors release each capture owner and preserve subsequent capture',async()=>{
  const c=cam(),sinkError=Error('sink rejected');let writes=0
  try{
    c.startContinuousAutofocus()
    for(let iteration=0;iteration<36;iteration++){
      const options={format:'png' as const,...limits,...(iteration%2?{}:{maxWorkingBytes:1})},output={write(){writes++;throw sinkError}}
      const job=iteration%3===0?c.switchModeAndCaptureTo({width:32,height:24},output,options):iteration%3===1?c.captureFocusLockedToAsync(output,options):c.captureToAsync(output,options)
      const error=await failure(job);if(iteration%2)expect(error).toBe(sinkError);else expect(error).toMatchObject({code:-7})
      await job.cleanupDone;expect(c.info().width).toBe(18);expect(c.stats().leased).toBe(0)
    }
    expect(writes).toBe(18);await c.captureTo({write(){writes++}},{format:'png',...limits});expect(writes).toBe(19)
  }finally{await c.close()}
},30000)
test.skipIf(!process.env.ZC_EXIF_READER)('capture and restored-mode outputs retain source Exif defaults and copied target metadata/ICC',async()=>{
  const c=cam(),dir=mkdtempSync(join(tmpdir(),'zc-output-capture-exif-'))
  try{
    const plain=memory();await c.captureTo(plain.output,{...limits})
    const path=join(dir,'plain.jpeg');writeFileSync(path,plain.bytes())
    const inspect=(format:string,path:string)=>{const result=Bun.spawnSync([process.env.ZC_EXIF_READER!,format,path]);if(result.exitCode)throw Error(result.stderr.toString());return JSON.parse(result.stdout.toString())}
    expect(inspect('jpeg',path)).toMatchObject({width:18,height:10,model:'zig-camera synthetic',software:'zig-camera'})
    for(const format of ['jpeg','png','tiff'] as const){
      const sink=memory(),options={format,stream:'lores' as const,iccProfile:'srgb' as const,exif:{artist:'Chris',model:'Target sensor',iso:3200,dateTimeOriginal:'2003:04:05 06:07:08'},...limits}
      const job=c.switchModeAndCaptureTo({width:32,height:24,lores:{width:12,height:8}},sink.output,options);options.exif.artist='changed';await job
      const target=join(dir,`target.${format}`);writeFileSync(target,sink.bytes());expect(inspect(format,target)).toMatchObject({width:12,height:8,artist:'Chris',model:'Target sensor',iso:3200,dateTimeOriginal:'2003:04:05 06:07:08'})
      if(process.env.ZC_ICC_READER)expect(Bun.spawnSync([process.env.ZC_ICC_READER,format,target]).exitCode).toBe(0)
      expect(c.info().width).toBe(18)
    }
  }finally{await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('capture output scheduling is snapshotted once and preserves exact flush/drop selection',async()=>{
  const c=cam();let flushReads=0,dropReads=0,callbackCalls=0
  try{
    const first=await c.captureMetadata(),sink=memory(),job=c.captureToAsync(sink.output,{
      format:'png',...limits,get flush(){flushReads++;return first.timestampNs+1n},get dropFrames(){dropReads++;return 3},
      signalFunction(completed){callbackCalls++;expect(completed.error).toBeUndefined();expect(c.stats().leased).toBe(0);expect(c.info().width).toBe(18)},
    })
    const result=await job;await job.cleanupDone
    expect([flushReads,dropReads,callbackCalls]).toEqual([1,1,1]);expect(result.timestampNs).toBeGreaterThan(first.timestampNs);expect(result.sequence).toBeGreaterThanOrEqual(first.sequence+4n);expect(sink.bytes()[0]).toBe(137)
  }finally{await c.close()}
})
test('camera output admission stays bounded through completion callbacks and reuses every slot after cleanup',async()=>{
  const c=cam(),release=gate();let callbacks=0
  const options={format:'png' as const,...limits,signalFunction:async()=>{callbacks++;await release.promise}}
  const jobs=Array.from({length:32},()=>c.captureToAsync({write(){}},options))
  try{
    expect(()=>c.captureToAsync({write(){}},{format:'png',...limits})).toThrow('capture queue')
    const errors=await Promise.all(jobs.map(failure));expect(errors.every(error=>error===undefined||error.code===-4)).toBe(true)
    await until(()=>callbacks===32);expect(c.stats().leased).toBe(0);expect(()=>c.captureToAsync({write(){}})).toThrow('capture queue')
    release.resolve();await Promise.all(jobs.map(job=>job.cleanupDone));await c.captureTo({write(){}},{format:'png',...limits})
  }finally{release.resolve();await Promise.all(jobs.map(failure));await c.close()}
})
test('simultaneous request callback and native codec failures remain observable after joined cleanup',async()=>{
  const c=cam(),marker=Error('selected callback'),original=n.zc_encode_stream_image_async;let admitted=false,writes=0
  try{
    Object.assign(n,{zc_encode_stream_image_async:(...args:Parameters<typeof original>)=>{const rc=original(...args);admitted=rc===0;return rc}})
    c.postCallback=()=>{if(admitted)throw marker}
    const job=c.captureToAsync({write(){writes++}},{format:'png',...limits,maxWorkingBytes:1}),error=await failure(job)
    expect(error).toBeInstanceOf(AggregateError);expect(error.errors.some((value:unknown)=>value instanceof RequestCallbackError&&value.cause===marker)).toBe(true)
    expect(error.errors.some((value:{code?:number})=>value.code===-7)).toBe(true);await job.cleanupDone;expect(writes).toBe(0);expect(c.stats().leased).toBe(0)
    c.setRequestCallbacks({});Object.assign(n,{zc_encode_stream_image_async:original});await c.captureTo({write(){writes++}},{format:'png',...limits});expect(writes).toBe(1)
  }finally{Object.assign(n,{zc_encode_stream_image_async:original});c.setRequestCallbacks({});await c.close()}
})
