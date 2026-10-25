import {expect,test} from 'bun:test'
import {Camera,Frame,SynchronizedCaptureCleanupError,type SynchronizedCaptureOptions} from '../../ts'
import {native as n} from '../../ts/ffi'
const mutable=n as unknown as {zc_release:(...args:Parameters<typeof n.zc_release>)=>number}
const cam=(width=16)=>new Camera({simulate:true,width,height:12,buffers:4,fifo:true})
const failure=(job:PromiseLike<unknown>)=>Promise.resolve(job).then(()=>undefined,error=>error)
const soft={syncReady:false,flush:false,maxSkewNs:100_000_000n}
async function until(predicate:()=>boolean){const deadline=performance.now()+5000;while(!predicate()){if(performance.now()>deadline)throw Error('observation deadline');await Bun.sleep(1)}}
test('owned matched requests preserve input order, raw/lores provenance and release independently',async()=>{
  const a=cam(),b=new Camera({simulate:true,width:20,height:12,lores:{width:8,height:6},buffers:4,fifo:true})
  try{
    using group=await Camera.captureSynchronizedRequests([a,b],soft)
    expect(group.frames.map(f=>f.width)).toEqual([16,20])
    expect(group.timestampsNs).toEqual(group.frames.map(f=>f.metadata().timestampNs))
    expect(group.skewNs).toBeLessThanOrEqual(soft.maxSkewNs)
    expect(group.candidateCount).toBe(2)
    expect(Object.isFrozen(group.frames)).toBe(true)
    expect(Object.isFrozen(group.timestampsNs)).toBe(true)
    expect(group.frames[1].copyRGB('lores').length).toBe(8*6*3)
    expect(a.stats().leased).toBe(1);expect(b.stats().leased).toBe(1)
    using retained=group.frames[0].retain()
    group.frames[0].release();group.release();group.release()
    expect(group.closed).toBe(true);expect(group.frames.every(f=>f.closed)).toBe(true)
    expect(a.stats().leased).toBe(1);expect(b.stats().leased).toBe(0)
    await a.stop();expect(retained.copyRGB().length).toBe(16*12*3)
  }finally{await Promise.all([a.close(),b.close()])}
})
test('backend readiness defaults to required and freshness uses one common threshold',async()=>{
  const a=cam(),b=cam(20)
  try{
    const missing=Camera.captureSynchronizedRequestsAsync([a,b],{timeoutMs:20})
    expect(await failure(missing)).toMatchObject({code:-3});await missing.cleanupDone
    expect(a.stats().leased+b.stats().leased).toBe(0)
    a.setSynchronization('server',{frames:3});b.setSynchronization('server',{frames:5})
    using group=await Camera.captureSynchronizedRequests([a,b],{maxSkewNs:100_000_000n})
    expect(group.frames.every(f=>f.synchronization().ready===true)).toBe(true)
    expect(group.frames.every(f=>(f.metadata().validMask&16)!==0)).toBe(true)
  }finally{await Promise.all([a.close(),b.close()])}
})
test('injected shared-clock candidates advance without recycling the newer retained request',async()=>{
  const a=cam(),b=cam(20),original=Frame.prototype.metadata,seen=new Map<bigint,bigint>();let readsA=0
  try{
    Frame.prototype.metadata=function(){const m=original.call(this);if(this.width===16){readsA++;return {...m,timestampNs:100n}}let stamp=seen.get(m.eventId);if(stamp===undefined){stamp=[0n,60n,95n][Math.min(seen.size,2)];seen.set(m.eventId,stamp)}return {...m,timestampNs:stamp}}
    using group=await Camera.captureSynchronizedRequests([a,b],{...soft,maxSkewNs:10n,maxFrames:64})
    expect(group.candidateCount).toBe(4);expect(readsA).toBe(1)
    expect(group.timestampsNs).toEqual([100n,95n]);expect(group.skewNs).toBe(5n)
    expect(a.stats().leased).toBe(1);expect(b.stats().leased).toBe(1)
  }finally{Frame.prototype.metadata=original;await Promise.all([a.close(),b.close()])}
})
test('candidate budget failure joins and releases every member',async()=>{
  const a=cam(),b=cam(20)
  try{
    for(let i=0;i<8;i++){using frame=await a.captureRequest()}
    const job=Camera.captureSynchronizedRequestsAsync([a,b],{...soft,maxFrames:2,maxSkewNs:0n})
    expect(await failure(job)).toMatchObject({code:-3});await job.cleanupDone
    expect(a.stats().leased+b.stats().leased).toBe(0)
    using next=await a.captureRequest();expect(next.width).toBe(16)
  }finally{await Promise.all([a.close(),b.close()])}
})
test('active cancellation joins a pending readiness child and releases the other held request',async()=>{
  const a=cam(),b=cam(20)
  try{
    a.setSynchronization('server',{frames:1})
    const job=Camera.captureSynchronizedRequestsAsync([a,b],{flush:false,timeoutMs:5000})
    await until(()=>a.stats().leased===1)
    expect(()=>a.acquire()).toThrow();expect(()=>a.switchMode({width:24,height:12})).toThrow()
    expect(()=>b.captureRequestAsync()).toThrow()
    const reason=Error('cancel group');expect(job.cancel(reason)).toBe(true)
    expect(await failure(job)).toBe(reason);await job.cleanupDone
    expect(a.stats().leased+b.stats().leased).toBe(0)
    expect(job.cancel()).toBe(false)
    using next=await b.captureRequest();expect(next.width).toBe(20)
  }finally{await Promise.all([a.close(),b.close()])}
})
for(const method of ['stop','close'] as const) test(`${method} of either camera cancels and joins the whole unpublished group`,async()=>{
  const a=cam(),b=cam(20)
  try{
    a.setSynchronization('server',{frames:1})
    const job=Camera.captureSynchronizedRequestsAsync([a,b],{flush:false})
    await until(()=>a.stats().leased===1)
    await b[method]();expect(await failure(job)).toMatchObject({code:-2});await job.cleanupDone
    expect(a.stats().leased).toBe(0);if(method==='stop')expect(b.stats().leased).toBe(0)
    using next=await a.captureRequest();expect(next.width).toBe(16)
  }finally{await Promise.all([a.close(),b.close()])}
})
test('invalid group/options and already-cancelled admission do not consume requests',async()=>{
  const a=cam(),b=cam(20)
  try{
    expect(()=>Camera.captureSynchronizedRequestsAsync([a])).toThrow()
    expect(()=>Camera.captureSynchronizedRequestsAsync([a,a])).toThrow()
    for(const options of [{maxSkewNs:-1n},{maxSkewNs:1n<<64n},{maxFrames:1},{maxFrames:65537},{dropFrames:-1},{syncReady:3},{flush:1}])expect(()=>Camera.captureSynchronizedRequestsAsync([a,b],options as SynchronizedCaptureOptions)).toThrow()
    const controller=new AbortController(),reason=Error('already aborted');controller.abort(reason)
    const job=Camera.captureSynchronizedRequestsAsync([a,b],{...soft,signal:controller.signal})
    expect(await failure(job)).toBe(reason);await job.cleanupDone
    expect(a.stats().delivered+b.stats().delivered).toBe(0n)
    expect(a.stats().leased+b.stats().leased).toBe(0)
    const zero=Camera.captureSynchronizedRequestsAsync([a,b],{...soft,timeoutMs:0})
    expect(await failure(zero)).toMatchObject({code:-3});await zero.cleanupDone
  }finally{await Promise.all([a.close(),b.close()])}
})
test('option accessors resolve once before camera reservations and arrays do not invoke caller iterators',async()=>{
  const a=cam(),b=cam(20);let reads=0
  try{
    const members=[a,b];Object.defineProperty(members,Symbol.iterator,{value:()=>{throw Error('must not iterate source')}})
    using group=await Camera.captureSynchronizedRequests(members,{...soft,get maxSkewNs(){reads++;return 100_000_000n}})
    expect(reads).toBe(1);group.release()
    let closed:Promise<void>|undefined
    expect(()=>Camera.captureSynchronizedRequestsAsync([a,b],{get maxSkewNs(){closed=b.close();return 1n}})).toThrow()
    await closed
    using next=await a.captureRequest();expect(next.width).toBe(16)
  }finally{await Promise.all([a.close(),b.close()])}
})
test('missing timestamps fail explicitly and all child completions retire before returning',async()=>{
  const a=cam(),b=cam(20),original=Frame.prototype.metadata
  try{
    Frame.prototype.metadata=function(){const m=original.call(this);return this.width===20?{...m,validMask:m.validMask&~16}:m}
    const job=Camera.captureSynchronizedRequestsAsync([a,b],soft)
    expect(await failure(job)).toMatchObject({code:-8});await job.cleanupDone
    expect(a.stats().leased+b.stats().leased).toBe(0)
  }finally{Frame.prototype.metadata=original;await Promise.all([a.close(),b.close()])}
})
test('busy frame cleanup remains owned by an explicit retryable error',async()=>{
  const a=cam(),b=cam(20),metadata=Frame.prototype.metadata,release=mutable.zc_release
  let cleanup:SynchronizedCaptureCleanupError|undefined
  try{
    Frame.prototype.metadata=function(){const m=metadata.call(this);return this.width===20?{...m,validMask:m.validMask&~16}:m}
    mutable.zc_release=(camera,token)=>camera===a.handle?-4:release(camera,token)
    const job=Camera.captureSynchronizedRequestsAsync([a,b],soft),error=await failure(job)
    expect(error).toBeInstanceOf(SynchronizedCaptureCleanupError);cleanup=error as SynchronizedCaptureCleanupError
    await job.cleanupDone;expect(cleanup.unreleasedFrames.length).toBe(1)
    expect(a.stats().leased).toBe(1);expect(b.stats().leased).toBe(0)
    mutable.zc_release=release;cleanup.retryCleanup();expect(cleanup.unreleasedFrames.length).toBe(0)
    expect(a.stats().leased).toBe(0)
  }finally{Frame.prototype.metadata=metadata;mutable.zc_release=release;cleanup?.retryCleanup();await Promise.all([a.close(),b.close()])}
})
for(const kind of ['timestamp','identity'] as const) test(`regressing ${kind} rejects without retaining discarded candidates`,async()=>{
  const a=cam(),b=cam(20),original=Frame.prototype.metadata;let calls=0
  try{
    Frame.prototype.metadata=function(){const m=original.call(this);if(this.width!==20)return m;calls++;return {...m,timestampNs:kind==='timestamp'?(calls===1?1_000_000n:0n):BigInt(calls)*1_000_000n,eventId:kind==='identity'?1n:m.eventId}}
    const job=Camera.captureSynchronizedRequestsAsync([a,b],{...soft,maxFrames:8})
    expect(await failure(job)).toMatchObject({code:-9});await job.cleanupDone
    expect(calls).toBe(2);expect(a.stats().leased+b.stats().leased).toBe(0)
  }finally{Frame.prototype.metadata=original;await Promise.all([a.close(),b.close()])}
})
test('published maps retain their independent native owners after group release and camera stop',async()=>{
  const a=new Camera({simulate:true,writable:true,width:16,height:12,buffers:4,fifo:true}),b=cam(20)
  let group:Awaited<ReturnType<typeof Camera.captureSynchronizedRequests>>|undefined
  let mapped:ReturnType<Frame['mapStream']>|undefined
  try{
    group=await Camera.captureSynchronizedRequests([a,b],soft);mapped=group.frames[0].mapStream('main')
    mapped.row(0)[0]=217;group.release()
    expect(group.closed).toBe(true);expect(group.frames.every(f=>f.closed)).toBe(true)
    expect(a.stats().leased).toBe(1);expect(b.stats().leased).toBe(0)
    await a.stop();expect(mapped.row(0)[0]).toBe(217)
    expect(await failure(a.close())).toMatchObject({code:-4})
    mapped.close();mapped=undefined;expect(a.stats().leased).toBe(0)
    group.release()
  }finally{mapped?.close();group?.release();await Promise.all([a.close(),b.close()])}
})
test('eight-member publication owns one frame per camera and excludes a ninth before admission',async()=>{
  const cameras=Array.from({length:8},()=>cam())
  try{
    expect(()=>Camera.captureSynchronizedRequestsAsync([...cameras,cameras[0]],soft)).toThrow()
    using group=await Camera.captureSynchronizedRequests(cameras,{...soft,maxSkewNs:0xffffffffffffffffn,maxFrames:8})
    expect(group.frames.length).toBe(8);expect(group.candidateCount).toBe(8)
    expect(cameras.every(c=>c.stats().leased===1)).toBe(true)
  }finally{await Promise.all(cameras.map(c=>c.close()))}
})
test('consumed-token release errors remain reported without inventing a retryable owner',async()=>{
  const a=cam(),b=cam(20),release=mutable.zc_release
  let group:Awaited<ReturnType<typeof Camera.captureSynchronizedRequests>>|undefined
  try{
    group=await Camera.captureSynchronizedRequests([a,b],soft);let injected=false
    mutable.zc_release=(...args)=>{const code=release(...args);if(code===0&&!injected){injected=true;return -6}return code}
    let error:unknown;try{group.release()}catch(cause){error=cause}
    expect(error).toBeInstanceOf(SynchronizedCaptureCleanupError)
    expect((error as SynchronizedCaptureCleanupError).unreleasedFrames.length).toBe(0)
    expect(group.frames.every(f=>f.closed)).toBe(true)
    expect(a.stats().leased+b.stats().leased).toBe(0)
    mutable.zc_release=release;(error as SynchronizedCaptureCleanupError).retryCleanup();group.release()
    expect(group.closed).toBe(true)
  }finally{mutable.zc_release=release;group?.release();await Promise.all([a.close(),b.close()])}
})
test('callback owners stay bounded and old callback completion cannot clear an active group reservation',async()=>{
  const a=cam(),b=cam(20),jobs:ReturnType<typeof Camera.captureSynchronizedRequestsAsync>[]=[],resolve:Array<()=>void>=[]
  let active:ReturnType<typeof Camera.captureSynchronizedRequestsAsync>|undefined
  try{
    for(let i=0;i<32;i++){
      const job=Camera.captureSynchronizedRequestsAsync([a,b],{...soft,maxSkewNs:0xffffffffffffffffn,signalFunction:()=>new Promise<void>(done=>resolve.push(done))})
      jobs.push(job);const group=await job;group.release()
    }
    await until(()=>resolve.length===32)
    expect(()=>Camera.captureSynchronizedRequestsAsync([a,b],soft)).toThrow()
    resolve[0]();await jobs[0].cleanupDone
    a.setSynchronization('server',{frames:1})
    active=Camera.captureSynchronizedRequestsAsync([a,b],{flush:false})
    await until(()=>a.stats().leased===1)
    for(const done of resolve.slice(1))done()
    await Promise.all(jobs.map(job=>job.cleanupDone))
    expect(()=>a.acquire()).toThrow()
    active.cancel();await failure(active);await active.cleanupDone
    expect(a.stats().leased+b.stats().leased).toBe(0)
  }finally{
    for(const done of resolve)done()
    active?.cancel();if(active)await active.cleanupDone
    await Promise.all(jobs.map(job=>job.cleanupDone));await Promise.all([a.close(),b.close()])
  }
})
