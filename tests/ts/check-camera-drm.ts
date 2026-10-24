// Isolated Linux process: actual Camera pump/worker against the independent C UAPI peer.
import {strict as assert} from 'node:assert'
import {dlopen,FFIType,ptr} from 'bun:ffi'
import {Camera,Recorder,type ProcessedFormat} from '../../ts'
import {isYuv} from '../../ts/processed-format'
const path=process.env.ZC_KMS_FIXTURE
if(process.platform!=='linux'||!path)throw Error('Linux Camera DRM peer required')
const peer=dlopen(path,{
  zkms_test_scenario:{args:[FFIType.i32],returns:FFIType.void},zkms_test_fault:{args:[FFIType.i32],returns:FFIType.void},
  zkms_test_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_preview_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_properties:{args:[FFIType.ptr],returns:FFIType.void},
})
const options={simulate:true,width:8,height:6,buffers:6,fifo:true}
const settings={backend:'drm-async' as const,drm:{card:'/dev/zig-camera-kms-fixture',timeoutMs:1000},window:{x:5,y:7,width:320,height:240}}
function properties(){const out=new BigUint64Array(15);peer.symbols.zkms_test_properties(ptr(out));return out}
function counts(){const out=new Uint32Array(8);peer.symbols.zkms_test_preview_counts(ptr(out));return out}
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){if(performance.now()>end)throw Error('Camera DRM test deadline');await Bun.sleep(1)}}
function retired(){const out=new Uint32Array(5);peer.symbols.zkms_test_counts(ptr(out));assert.equal(out[0],out[1]);assert.equal(out[3],0);assert.equal(out[4],0);assert.equal(counts()[6],0);assert.equal(counts()[7],0)}
function diagnose(camera:Camera,error:unknown){console.error('Camera worker failure',error,{counts:[...counts()],properties:[...properties()].map(String),preview:camera.previewInfo(),cleanup:camera.previewCleanupPending,error:camera.previewError})}
try{
  for(const format of ['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY'] as ProcessedFormat[]){
    peer.symbols.zkms_test_scenario(10)
    const camera=new Camera({...options,format,colorSpace:isYuv(format)?'rec709':'srgb',lores:{width:4,height:2,format}})
    try{
      camera.startPreview(settings)
      await until(()=>(camera.previewInfo()?.workerFrames?.completed??0n)>0n)
      await camera.drainPreviewAsync()
      assert.equal(camera.previewInfo()?.drmState?.retainedFrames,1)
      assert.equal(camera.previewInfo()?.drmQueue?.capacity,1)
      assert.deepEqual([...properties().slice(6,10)],[5n,7n,320n,240n])
      assert.throws(()=>camera.stopPreview(),/stopPreviewAsync/)
      assert.throws(()=>camera.setPreviewView(),/asynchronous/)
      assert.throws(()=>camera.setPreviewStream('lores'),/asynchronous/)
      assert.throws(()=>camera.setOverlay({data:new Uint8Array(4),width:1,height:1}),/not implemented/)
      const offered={window:{x:9,y:11,width:320,height:240}},view=camera.setPreviewViewAsync(offered)
      offered.window.x=199;await view;assert.equal(camera.previewInfo()?.window?.x,9)
      await camera.setPreviewStreamAsync('lores');await camera.captureMetadata();await camera.drainPreviewAsync()
      assert.equal(camera.previewStreamInfo()?.width,4)
      await camera.setPreviewStreamAsync(null);await camera.drainPreviewAsync();assert.equal(camera.stats().leased,0)
      await camera.setPreviewStreamAsync('main')
      if(format==='BGR888'){
        const borrowed=await camera.captureRequest()
        try{
          await assert.rejects(camera.switchMode({width:12,height:8,format}).wait(),/unleased/)
          assert.equal(camera.previewStreamInfo()?.width,8);assert.ok(borrowed.metadata())
        }finally{borrowed.release()}
        await until(()=>(camera.previewInfo()?.workerFrames?.completed??0n)>1n)
      }
      await camera.switchMode({width:12,height:8,format,lores:{width:6,height:4,format}})
      assert.equal(camera.previewStreamInfo()?.width,12)
      await camera.switchModeAndCaptureRGB({width:10,height:8,format})
      assert.equal(camera.previewStreamInfo()?.width,12)
      await camera.stopPreviewAsync();assert.equal(camera.previewCleanupPending,0);assert.equal(camera.stats().leased,0)
    }catch(error){diagnose(camera,error);throw error}
    finally{peer.symbols.zkms_test_fault(0);await camera.close()}
    retired()
  }
  // A held real flip packet must not block Bun, capture, encoder delivery or bounded admission.
  peer.symbols.zkms_test_scenario(10)
  const camera=new Camera(options),recorder=await Recorder.open({outputframe(){}},{width:8,height:6,codec:'mjpeg',fps:25})
  try{
    camera.startPreview(settings);let recording=camera.startRecording(recorder)
    await until(()=>recording.stats().completed>=3n)
    const baseline=counts()[2]!;peer.symbols.zkms_test_fault(17)
    await until(()=>counts()[2]!>baseline&&!!camera.previewInfo()?.drmQueue?.active)
    const before=recording.stats().completed,skips=camera.previewInfo()!.workerFrames!.skipped
    let ticks=0;const timer=setInterval(()=>ticks++,1)
    try{await camera.captureMetadata();await until(()=>recording.stats().completed>before+2n)}finally{clearInterval(timer)}
    assert.ok(ticks>0);assert.ok(camera.previewInfo()!.workerFrames!.skipped>skips)
    const jobs=Array.from({length:32},()=>camera.drainPreviewAsync())
    assert.throws(()=>camera.drainPreviewAsync(),/queue full/)
    assert.throws(()=>camera.switchRecordingModeAsync(recorder,{width:12,height:8},{},{outputframe(){}}),/jobs active/)
    const reason=new Error('queued Camera view cancelled')
    for(const job of jobs)assert.equal(job.cancel(reason),true)
    const results=await Promise.allSettled(jobs.map(job=>job.wait()))
    assert.ok(results.every(result=>result.status==='rejected'&&result.reason===reason))
    const stop=camera.stopPreviewAsync();let stopped=false;void stop.wait().then(()=>stopped=true)
    await Bun.sleep(25);assert.equal(stopped,false)
    peer.symbols.zkms_test_fault(0);await stop;assert.equal(camera.stats().leased,0)
    camera.startPreview(settings)
    recording=await camera.switchRecordingModeAsync(recorder,{width:12,height:8},{},{outputframe(){}})
    await until(()=>recording.stats().completed>=2n);assert.equal(camera.previewStreamInfo()?.width,12)
    // The all-recorder transaction must retire and recreate this same owner too.
    const group=await camera.switchRecordingsModeAsync({width:10,height:8},[{recording,output:{outputframe(){}}}])
    recording=group[0]!
    await until(()=>recording.stats().completed>=2n);assert.equal(camera.previewStreamInfo()?.width,10)
    peer.symbols.zkms_test_fault(12)
    await until(()=>!!camera.previewError)
    await until(()=>camera.previewCleanupPending===1)
    assert.equal(camera.previewInfo()?.drmState?.uncertain,true)
    const healthy=recording.stats().completed;await until(()=>recording.stats().completed>healthy)
    peer.symbols.zkms_test_fault(0);await camera.stopPreviewAsync()
    assert.equal(camera.previewCleanupPending,0);assert.equal(camera.stats().leased,0)
  }catch(error){diagnose(camera,error);throw error}
  finally{peer.symbols.zkms_test_fault(0);await camera.close();await recorder.close()}
  retired()
  // Close from a completion hook joins operations, never its own hook promise.
  peer.symbols.zkms_test_scenario(10)
  const callback=new Camera(options)
  try{
    callback.startPreview(settings);await until(()=>(callback.previewInfo()?.workerFrames?.completed??0n)>0n)
    const job=callback.drainPreviewAsync({signalFunction:async()=>{await callback.close()}})
    await job;await job.cleanupDone;assert.equal(job.callbackError,undefined);assert.equal(callback.previewCleanupPending,0)
  }finally{await callback.close()}
  retired()
  // An uncertain GPU source survives failed camera close and is acknowledged on retry.
  peer.symbols.zkms_test_scenario(10)
  const failed=new Camera(options)
  try{
    failed.startPreview({...settings,drm:{...settings.drm,timeoutMs:100}})
    await until(()=>(failed.previewInfo()?.workerFrames?.completed??0n)>0n)
    peer.symbols.zkms_test_fault(12);await until(()=>!!failed.previewError)
    await assert.rejects(failed.close(),/(-3)|cleanup/)
    assert.equal(failed.previewCleanupPending,1)
    peer.symbols.zkms_test_fault(0);await failed.close();assert.equal(failed.previewCleanupPending,0)
  }finally{peer.symbols.zkms_test_fault(0);await failed.close()}
  retired()
  peer.symbols.zkms_test_scenario(10)
  const preparation=new Camera(options)
  try{
    peer.symbols.zkms_test_fault(16)
    assert.throws(()=>preparation.startPreview({...settings,overlay:{transform:{hflip:true}}}),/cleanup/)
    assert.equal(preparation.previewCleanupPending,1)
    peer.symbols.zkms_test_fault(0);await preparation.close();assert.equal(preparation.previewCleanupPending,0)
  }finally{peer.symbols.zkms_test_fault(0);await preparation.close()}
  retired()
  peer.symbols.zkms_test_scenario(10)
  const lost=new Camera(options);let fresh:Camera|undefined
  try{
    lost.startPreview(settings);await until(()=>(lost.previewInfo()?.workerFrames?.completed??0n)>0n)
    lost.simulateDisconnect();await until(()=>!!lost.deviceError)
    fresh=await lost.reconnect({initialDelayMs:0,maximumDelayMs:0,pollMs:2})
    await until(()=>(fresh!.previewInfo()?.workerFrames?.completed??0n)>0n)
    assert.equal(fresh.previewInfo()?.backend,'drm-async')
    await lost.close();assert.equal(fresh.previewInfo()?.suspended,false)
  }finally{await fresh?.close();await lost.close()}
  retired()
  console.log('Camera-owned native DRM worker: all formats, bounded skip feed, capture/recording heartbeat, async view/stream/drain/stop, lease-safe mode/group restoration, recovery and retryable cleanup passed')
}finally{peer.close()}
