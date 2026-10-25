import {test,expect} from 'bun:test'
import {Camera,CaptureAllocator,ProcessPool,ProcessRemoteError,ProcessWorkerError,type BunJob} from '../../ts'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const module=new URL('../fixtures/process-handler.ts',import.meta.url)
const camera=(writable=false)=>new Camera({simulate:true,fifo:true,writable,width:18,height:10,raw:true,unpackedRaw:true,lores:{width:10,height:6,format:'NV12'}})
async function until(predicate:()=>boolean,ms=10000){const end=performance.now()+ms;while(!predicate()){if(performance.now()>end)throw new Error('condition timeout');await Bun.sleep(2)}}
test('actual process pool initializes once routes least-pending jobs and keeps independent copied context',async()=>{
  const c=camera(),context={name:'mountain',value:new Uint8Array([1,2,3])}
  const pool=await ProcessPool.open({module,workers:2,context,camera:c})
  context.name='changed';context.value.fill(99)
  try{
    c.start();using frame=c.acquire()
    const jobs=Array.from({length:4},(_,i)=>pool.submit<any>(frame,{index:i,delay:10},{streams:['main','raw','lores']}))
    expect(frame.referenceCount).toBe(5)
    const results=await Promise.all(jobs)
    expect(results.map(r=>r.worker)).toEqual([0,1,0,1])
    expect(results.every(r=>r.pid!==process.pid)).toBe(true)
    expect(results[0].pid).not.toBe(results[1].pid)
    expect(results.map(r=>r.calls)).toEqual([1,1,2,2])
    expect(results[0].initial.context).toEqual({name:'mountain',value:new Uint8Array([1,2,3])})
    expect(results[0].initial.camera.id).toBe(c.cameraId)
    expect(results[0].metadata.kind).toBe('metadata')
    expect(results.every(r=>r.sequence===frame.sequence)).toBe(true)
    await pool.drain();expect(pool.stats().pending).toBe(0);expect(frame.referenceCount).toBe(1)
  }finally{await pool.close();await c.close()}
})
test('writable process returns only after scoped child maps and native staging writeback retire',async()=>{
  const c=camera(true),pool=await ProcessPool.open({module})
  try{
    c.start();using frame=c.acquire()
    const job=pool.submit<any>(frame,{action:'write',value:83},{writable:true,streams:['main','raw','lores']})
    expect(()=>frame.copyRGB()).toThrow()
    const result=await job
    expect(result.pid).not.toBe(process.pid);expect(frame.referenceCount).toBe(1)
    for(const name of ['main','raw','lores'] as const){using map=frame.mapStream(name);expect(map.planes[0].bytes[0]).toBe(83)}
  }finally{await pool.close();await c.close()}
})
test('queued cancellation retires before job completion without terminating its busy peer',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-process-')),marker=join(dir,'active'),released=join(dir,'released')
  const c=camera(),pool=await ProcessPool.open({module})
  try{
    c.start();using frame=c.acquire()
    const first=pool.submit<any>(frame,{marker,waitFor:released}),queued=pool.submit(frame,{delay:1})
    await until(()=>existsSync(marker))
    expect(queued.cancel()).toBe(true)
    await expect(queued.wait()).rejects.toThrow('cancelled')
    await queued.cleanupDone
    expect(frame.referenceCount).toBe(2)
    await Bun.write(released,'release')
    const result=await first;expect(result.calls).toBe(1)
    const next=await pool.submit<any>(frame,{})
    expect(next.pid).toBe(result.pid);expect(next.calls).toBe(2)
  }finally{await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('CPU-bound active cancellation kills and verifies exit before release, then restart uses a fresh generation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-process-')),marker=join(dir,'active')
  const c=camera(true),pool=await ProcessPool.open({module})
  try{
    c.start();using frame=c.acquire()
    const pid=pool.workerStates()[0].pid!,job=pool.submit(frame,{action:'spin',marker},{writable:true})
    await until(()=>existsSync(marker))
    expect(job.cancel()).toBe(true)
    await expect(job.wait()).rejects.toThrow('cancelled')
    await job.cleanupDone
    expect(()=>process.kill(pid,0)).toThrow()
    expect(frame.referenceCount).toBe(1);expect(pool.workerStates()[0].joined).toBe(true)
    await pool.restart(0)
    const result=await pool.submit<any>(frame,{})
    expect(result.generation).toBe(2n);expect(result.pid).not.toBe(pid);expect(result.calls).toBe(1)
  }finally{await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('worker failure and deadline preserve healthy workers and reject their own pending jobs',async()=>{
  const c=camera(),pool=await ProcessPool.open({module,workers:2})
  try{
    c.start();using frame=c.acquire()
    const bad=pool.submit(frame,{action:'exit',code:9}),good=pool.submit<any>(frame,{delay:20}),behind=pool.submit(frame,{})
    await expect(bad.wait()).rejects.toBeInstanceOf(ProcessWorkerError)
    expect((bad.error as ProcessWorkerError).exitCode).toBe(9)
    await expect(behind.wait()).rejects.toBeInstanceOf(ProcessWorkerError)
    const result=await good
    expect(result.worker).toBe(1)
    const later=await pool.submit<any>(frame,{})
    expect(later.pid).toBe(result.pid)
    await pool.restart(0)
    let timed:BunJob<unknown>|undefined
    await expect((async()=>{timed=pool.submit(frame,{delay:500},{timeoutMs:15});await timed})()).rejects.toThrow('deadline')
    await timed?.cleanupDone
    await pool.drain();expect(frame.referenceCount).toBe(1)
  }finally{await pool.close({drain:false});await c.close()}
})
test('remote handler and serialization errors are isolated jobs and leave their process reusable',async()=>{
  const c=camera(),pool=await ProcessPool.open({module,maxResultBytes:1024*1024})
  try{
    c.start();using frame=c.acquire()
    const pid=pool.workerStates()[0].pid
    for(const action of ['fail','oversize','unsupported']){
      const job=pool.submit(frame,{action})
      await expect(job.wait()).rejects.toBeInstanceOf(ProcessRemoteError)
      await job.cleanupDone
      expect(frame.referenceCount).toBe(1)
    }
    expect((await pool.submit<any>(frame,{})).pid).toBe(pid)
  }finally{await pool.close();await c.close()}
})
test('native task admission includes slow callbacks and drain observes a fixed cleanup prefix',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-process-')),released=join(dir,'released')
  const c=camera(),pool=await ProcessPool.open({module,maxPending:2})
  let release!:()=>void,entered=false
  const callback=new Promise<void>(r=>{release=r})
  try{
    c.start();using frame=c.acquire()
    const first=pool.submit(frame,{}, {signalFunction:async()=>{entered=true;await callback}})
    await first;await until(()=>entered)
    expect(frame.referenceCount).toBe(1)
    expect(pool.stats().retired).toBe(1)
    const drain=pool.drainAsync(),later=pool.submit(frame,{waitFor:released})
    expect(()=>pool.submit(frame,{})).toThrow()
    expect(drain.done).toBe(false)
    release();await drain
    expect(later.done).toBe(false)
    await Bun.write(released,'release');await later;await pool.drain()
    expect(pool.stats().pending).toBe(0)
  }finally{release();await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('completion callback lifecycle reentry rejects promptly while outside close waits cleanup',async()=>{
  const c=camera(),pool=await ProcessPool.open({module})
  try{
    c.start();using frame=c.acquire()
    const job=pool.submit(frame,{}, {signalFunction:async()=>{
      expect(()=>pool.drainAsync()).toThrow('completion callback')
      expect(()=>pool.close()).toThrow('completion callback')
      expect(()=>pool.restart(0)).toThrow('completion callback')
    }})
    await job;await job.cleanupDone;expect(job.callbackError).toBeUndefined()
  }finally{await pool.close();await c.close()}
})
test('aborting close joins active and queued jobs, source release/stop cannot destroy pending exports',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-process-')),marker=join(dir,'active')
  const c=camera(),pool=await ProcessPool.open({module})
  try{
    c.start();const frame=c.acquire(),first=pool.submit(frame,{action:'spin',marker}),second=pool.submit(frame,{})
    frame.release();await c.stop();await until(()=>existsSync(marker))
    await expect(c.close()).rejects.toThrow()
    const closed=pool.close({drain:false})
    expect(pool.close()).toBe(closed)
    await expect(first.wait()).rejects.toThrow();await expect(second.wait()).rejects.toThrow()
    await closed;expect(pool.closed).toBe(true);await c.close()
  }finally{await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('graceful process close invokes module close, init failures and startup deadlines unwind session admission',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-process-')),path=join(dir,'closed')
  try{
    for(let i=0;i<10;i++)await expect(ProcessPool.open({module,context:{initFailure:true}})).rejects.toThrow()
    await expect(ProcessPool.open({module,context:{initDelay:1000},startupTimeoutMs:15})).rejects.toThrow()
    const pool=await ProcessPool.open({module,context:{closePath:path}})
    await pool.close();expect(await Bun.file(path).text()).toBe('closed')
  }finally{rmSync(dir,{recursive:true,force:true})}
})
test('snapshot getters run once and invalid/aborted inputs never retain source ownership',async()=>{
  const c=camera(),pool=await ProcessPool.open({module,maxArgumentBytes:1024})
  try{
    c.start();using frame=c.acquire()
    let reads=0
    const data={get value(){reads++;return 123n}}
    const result=await pool.submit<any>(frame,{action:'echo',value:data})
    expect(reads).toBe(1);expect(result.value).toBe(123n)
    for(const options of [{streams:[]},{streams:['invalid']},{writable:1},{timeoutMs:0},{timeoutMs:NaN}])expect(()=>pool.submit(frame,{},options as any)).toThrow()
    const controller=new AbortController();controller.abort(new Error('already aborted'))
    expect(()=>pool.submit(frame,{}, {signal:controller.signal})).toThrow('already aborted')
    expect(()=>pool.submit(frame,new Uint8Array(2048))).toThrow()
    expect(()=>pool.submit(frame,()=>{})).toThrow()
    expect(frame.referenceCount).toBe(1)
    expect(pool.stats().pending).toBe(0)
    const lost=c.acquire()
    expect(()=>pool.submit(lost,{get release(){lost.release();return 1}})).toThrow('released')
    expect(pool.stats().pending).toBe(0)
  }finally{await pool.close();await c.close()}
})
test('result reservations and slow callback cleanup bound aggregate returned bytes',async()=>{
  const c=camera(),pool=await ProcessPool.open({module,workers:2,maxPending:32,maxResultBytes:1024*1024,maxPendingBytes:2*1024*1024+4096})
  let release!:()=>void
  const held=new Promise<void>(r=>release=r)
  try{
    c.start();using frame=c.acquire()
    const a=pool.submit(frame,{}, {signalFunction:()=>held}),b=pool.submit(frame,{}, {signalFunction:()=>held})
    expect(pool.stats().bytes).toBeGreaterThanOrEqual(2n*1024n*1024n)
    expect(()=>pool.submit(frame,{})).toThrow()
    await Promise.all([a,b])
    expect(frame.referenceCount).toBe(1);expect(pool.stats().pending).toBe(2)
    expect(()=>pool.submit(frame,{})).toThrow()
    release();await pool.drain();expect(pool.stats().bytes).toBe(0n)
  }finally{release();await pool.close();await c.close()}
})
test('observer drain cancellation leaves processing alive and handles callback failure cleanup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-process-')),released=join(dir,'released')
  const c=camera(),pool=await ProcessPool.open({module})
  try{
    c.start();using frame=c.acquire()
    const job=pool.submit<any>(frame,{waitFor:released},{signalFunction:()=>{throw new Error('completion failure')}})
    const drain=pool.drainAsync({timeoutMs:5})
    await expect(drain.wait()).rejects.toThrow('deadline')
    expect(pool.workerStates()[0].joined).toBe(false)
    await Bun.write(released,'release');expect((await job).pid).toBe(pool.workerStates()[0].pid)
    await job.cleanupDone;expect((job.callbackError as Error).message).toBe('completion failure')
    await pool.drain();expect(frame.referenceCount).toBe(1)
  }finally{await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
test('close hook errors and bounded shutdown timeouts surface after all native session resources close',async()=>{
  for(const context of [{closeFailure:true},{closeDelay:1000}]){
    const pool=await ProcessPool.open({module,context,shutdownTimeoutMs:15})
    await expect(pool.close()).rejects.toThrow('close failed')
    expect(pool.closed).toBe(true)
    expect(pool.stats().pending).toBe(0)
  }
  const next=await ProcessPool.open({module});await next.close()
})
test('abort and close reentry cannot create two close owners or transfer an invalid source',async()=>{
  const c=camera(),pool=await ProcessPool.open({module})
  try{
    c.start();using frame=c.acquire()
    let reads=0
    const wrapper={get exportFrame(){reads++;return frame.exportFrame.bind(frame)}}
    await pool.submit(wrapper,{})
    expect(reads).toBe(1)
    const controller=new AbortController(),job=pool.submit(frame,{delay:80},{signal:controller.signal})
    let nested:Promise<void>|undefined
    job.signal.addEventListener('abort',()=>{nested=pool.close({drain:false})})
    const close=pool.close({get drain(){return false}})
    await expect(job.wait()).rejects.toThrow('closed')
    await close;expect(nested).toBe(close);expect(frame.referenceCount).toBe(1)
  }finally{if(!pool.closed)await pool.close({drain:false});await c.close()}
})
test('large owned image results use configurable native reservations rather than a fixed small IPC cap',async()=>{
  const c=new Camera({simulate:true,width:1280,height:720}),pool=await ProcessPool.open({module,maxResultBytes:8*1024*1024,maxPendingBytes:32*1024*1024})
  try{
    c.start();using frame=c.acquire();using original=frame.makeImage()
    const result=await pool.submit<any>(frame,{action:'image'})
    expect(result.pixels.byteLength).toBe(1280*720*3)
    expect(result.pixels).toEqual(original.copyPixels())
    await pool.drain();expect(pool.stats().bytes).toBe(0n)
  }finally{await pool.close();await c.close()}
})
test('explicit infinite job deadlines and escalation from graceful close still join active processes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-process-')),marker=join(dir,'active'),overrideMarker=join(dir,'override-active'),released=join(dir,'released')
  const c=camera(),pool=await ProcessPool.open({module,timeoutMs:10})
  try{
    c.start();using frame=c.acquire()
    const finiteOverride=pool.submit<any>(frame,{marker:overrideMarker,waitFor:released},{timeoutMs:null})
    await until(()=>existsSync(overrideMarker));await Bun.sleep(20);expect(finiteOverride.done).toBe(false)
    await Bun.write(released,'release');await finiteOverride
    const job=pool.submit(frame,{action:'spin',marker},{timeoutMs:null})
    await until(()=>existsSync(marker))
    const close=pool.close()
    expect(pool.close({drain:false})).toBe(close)
    await expect(job.wait()).rejects.toThrow('closed')
    await close;expect(frame.referenceCount).toBe(1)
  }finally{if(!pool.closed)await pool.close({drain:false});await c.close();rmSync(dir,{recursive:true,force:true})}
})
for(const format of ['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616'] as const)
  test(`${format} actual process returns owned Home RGB image pixels and PNG metadata`,async()=>{
    const c=new Camera({simulate:true,width:18,height:10,format,lores:{width:10,height:6,format}}),pool=await ProcessPool.open({module})
    try{
      c.start();using frame=c.acquire()
      for(const stream of ['main','lores'] as const){
        using original=frame.makeImage({stream})
        const result=await pool.submit<any>(frame,{action:'image',stream},{streams:[stream]})
        expect(result.pid).not.toBe(process.pid);expect(result.bits).toBe(original.bits)
        expect(result.pixels).toEqual(original.copyPixels());expect(result.metadata.sequence).toBe(frame.sequence)
        expect([...result.png.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10])
      }
    }finally{await pool.close();await c.close()}
  })

test('initial camera configuration omits native allocation ownership while exported frames retain it',async()=>{
  const allocator=new CaptureAllocator({simulate:true,maxEntries:1,maxBytes:65536})
  const c=new Camera({simulate:true,fifo:true,width:18,height:10,buffers:2,allocator})
  let pool:ProcessPool|undefined
  try{
    pool=await ProcessPool.open({module,camera:c})
    c.start();using frame=c.acquire()
    const result=await pool.submit<any>(frame,{})
    expect(result.initial.camera.options.allocator).toBeUndefined()
    expect(Object.hasOwn(result.initial.camera.options,'allocator')).toBe(false)
    expect(result.initial.camera.options.width).toBe(18)
    expect(result.initial.camera.id).toBe(c.cameraId)
    expect(result.sequence).toBe(frame.sequence)
    expect(c.options.allocator).toBe(allocator)
    expect(allocator.state.borrowed).toBe(1)
    await pool.close();pool=undefined
    expect(allocator.state.borrowed).toBe(1)
    frame.release();await c.close()
    expect(allocator.state.borrowed).toBe(0)
  }finally{await pool?.close();await c.close();allocator.close()}
})
