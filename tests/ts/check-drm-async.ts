// Isolated Linux process, independent system-header C peer and actual poll/read FDs.
import {strict as assert} from 'node:assert'
import {dlopen,FFIType,ptr} from 'bun:ffi'
import {Camera,DrmPreview,type ProcessedFormat} from '../../ts'
import {isYuv} from '../../ts/processed-format'
const path=process.env.ZC_KMS_FIXTURE
if(process.platform!=='linux'||!path)throw Error('Linux DRM async peer required')
const peer=dlopen(path,{
  zkms_test_scenario:{args:[FFIType.i32],returns:FFIType.void},zkms_test_fault:{args:[FFIType.i32],returns:FFIType.void},
  zkms_test_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_preview_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_properties:{args:[FFIType.ptr],returns:FFIType.void},
})
const settings={width:8,height:6,card:'/dev/zig-camera-kms-fixture',timeoutMs:1000}
function values(){const out=new BigUint64Array(15);peer.symbols.zkms_test_properties(ptr(out));return out}
function counts(){const out=new Uint32Array(8);peer.symbols.zkms_test_preview_counts(ptr(out));return out}
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){if(performance.now()>end)throw Error('DRM async deadline');await Bun.sleep(1)}}
async function offer(camera:Camera,preview:DrmPreview){const frame=await camera.captureRequest();try{return preview.showAsync(frame)}finally{frame.release()}}
// Do not return a thenable from an async admission helper: it would await it.
async function admitted(camera:Camera,preview:DrmPreview){const frame=await camera.captureRequest();try{return {job:preview.showAsync(frame)}}finally{frame.release()}}
function retired(){
  const out=new Uint32Array(5);peer.symbols.zkms_test_counts(ptr(out));assert.equal(out[0],out[1]);assert.equal(out[3],0);assert.equal(out[4],0)
  const p=counts();assert.equal(p[6],0);assert.equal(p[7],0)
}
try{
  for(const format of ['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY'] as ProcessedFormat[]){
    peer.symbols.zkms_test_scenario(10)
    const camera=new Camera({simulate:true,width:8,height:6,buffers:6,fifo:true,format,colorSpace:isYuv(format)?'rec709':'srgb'})
    const preview=new DrmPreview({...settings,format})
    try{
      await offer(camera,preview);assert.equal(preview.state.retainedFrames,1);assert.equal(preview.pendingJobs,0)
      await offer(camera,preview);await preview.drainAsync();assert.equal(preview.state.retainedFrames,1)
      assert.equal(camera.stats().leased,1) // A cleanup fence cannot release scanout.
      const offered={window:{x:5,y:7,width:320,height:240}}
      const view=preview.setViewAsync(offered);offered.window.x=99;await view
      assert.deepEqual([...values().slice(6,10)],[5n,7n,320n,240n])
      if(isYuv(format)){assert.equal(values()[11],1n);assert.equal(values()[12],0n)}
      await preview.backgroundAsync();assert.equal(camera.stats().leased,0)
      await preview.close();assert.equal(preview.closed,true);assert.equal(preview.pendingJobs,0)
    }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
    retired()
  }
  // Native matrix admission supports Rec2020 without the SDL CPU converter.
  peer.symbols.zkms_test_scenario(10)
  const wide=new Camera({simulate:true,width:8,height:6,buffers:4,format:'NV12',colorSpace:'rec2020'}),widePreview=new DrmPreview({...settings,format:'NV12'})
  try{await offer(wide,widePreview);assert.equal(values()[11],2n)}finally{await widePreview.close();await wide.close()}
  retired()

  peer.symbols.zkms_test_scenario(10)
  const camera=new Camera({simulate:true,width:8,height:6,buffers:6,fifo:true}),preview=new DrmPreview({...settings,operations:2})
  try{
    await offer(camera,preview)
    const baseline=counts()[2]!
    peer.symbols.zkms_test_fault(17) // Hold a real completion packet until released.
    const active=(await admitted(camera,preview)).job
    await until(()=>preview.queueState.active&&counts()[2]!>baseline)
    assert.equal(active.cancel(),false)
    const queued=(await admitted(camera,preview)).job
    const reason=new Error('cancel queued preview')
    assert.equal(queued.cancel(reason),true)
    const rejected=(await admitted(camera,preview)).job
    await assert.rejects(rejected.wait(),/(-4)/)
    assert.ok(preview.queueState.rejected>0n)
    const offered={window:{x:5,y:7,width:320,height:240}},view=preview.setViewAsync(offered)
    offered.window.x=199
    let ticks=0;const heartbeat=setInterval(()=>ticks++,1)
    await Bun.sleep(25);clearInterval(heartbeat)
    assert.ok(ticks>0);assert.equal(active.done,false);assert.equal(queued.done,false)
    assert.equal(preview.queueState.queued,1)
    peer.symbols.zkms_test_fault(0)
    await active;await assert.rejects(queued.wait(),error=>error===reason);await view
    assert.deepEqual([...values().slice(6,10)],[5n,7n,320n,240n])
    await preview.drainAsync();assert.equal(camera.stats().leased,1)
    const before=counts()[2]!
    peer.symbols.zkms_test_fault(17)
    const last=(await admitted(camera,preview)).job
    await until(()=>counts()[2]!>before)
    const closing=preview.close();let closed=false;void closing.then(()=>closed=true)
    await Bun.sleep(25);assert.equal(closed,false);assert.equal(last.done,false)
    peer.symbols.zkms_test_fault(0);await last;await closing
    assert.equal(preview.pendingJobs,0);assert.equal(camera.stats().leased,0)
  }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
  retired()

  peer.symbols.zkms_test_scenario(10)
  const lostCamera=new Camera({simulate:true,width:8,height:6,buffers:4}),lost=new DrmPreview({...settings,timeoutMs:100})
  try{
    await offer(lostCamera,lost);peer.symbols.zkms_test_fault(12)
    await assert.rejects(offer(lostCamera,lost),/(-3)/)
    assert.equal(lost.state.uncertain,true);assert.equal(lost.state.retainedFrames,2)
    await assert.rejects(lost.close(),/(-3)/);assert.equal(lost.closed,false);assert.equal(lost.state.retainedFrames,2)
    peer.symbols.zkms_test_fault(0);await lost.close();assert.equal(lostCamera.stats().leased,0)
  }finally{peer.symbols.zkms_test_fault(0);await lost.close();await lostCamera.close()}
  retired()

  peer.symbols.zkms_test_scenario(10)
  const closeError=new DrmPreview(settings)
  peer.symbols.zkms_test_fault(16)
  await assert.rejects(closeError.close(),/(-6)/)
  assert.equal(closeError.closed,false);assert.equal(closeError.state.deviceClosed,true);assert.equal(closeError.pendingJobs,0)
  await closeError.close();assert.equal(closeError.closed,true);retired()
  // A close microtask may run between native job retirement and BunJob sealing.
  // This used to be a dangerous place to retain a cancellation guard pointer.
  for(let i=0;i<16;i++){
    peer.symbols.zkms_test_scenario(10)
    const camera=new Camera({simulate:true,width:8,height:6,buffers:4}),preview=new DrmPreview(settings)
    try{
      const frame=await camera.captureRequest()
      let closing:Promise<void>|undefined
      queueMicrotask(()=>{closing=preview.close()})
      const job=preview.showAsync(frame);frame.release()
      const [result]=await Promise.allSettled([job.wait()])
      await closing
      if(result.status==='rejected')assert.equal((result.reason as Error).name,'JobCancelledError')
      assert.equal(preview.closed,true);assert.equal(camera.stats().leased,0)
    }finally{await preview.close();await camera.close()}
    retired()
  }
  peer.symbols.zkms_test_scenario(10)
  const callbackCamera=new Camera({simulate:true,width:8,height:6,buffers:4}),callbackPreview=new DrmPreview(settings)
  try{
    const frame=await callbackCamera.captureRequest();let closed=false
    const job=callbackPreview.showAsync(frame,{signalFunction:async()=>{await callbackPreview.close();closed=true}})
    frame.release();await job;await job.cleanupDone
    assert.equal(job.callbackError,undefined);assert.equal(closed,true);assert.equal(callbackPreview.closed,true)
  }finally{await callbackPreview.close();await callbackCamera.close()}
  retired()
  console.log('Native DRM serial worker, owned async inputs, real-FD flip waits, bounded queue, queued cancellation, heartbeat progress, copied views, joined close and retryable faults passed')
}finally{peer.close()}
