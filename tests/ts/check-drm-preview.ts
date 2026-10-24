// Separate Linux process: exercises actual Zig/C/Bun APIs against the C UAPI peer.
import {strict as assert} from 'node:assert'
import {dlopen,FFIType,ptr} from 'bun:ffi'
import {Camera,Recorder,type ProcessedFormat} from '../../ts'
import {isYuv} from '../../ts/processed-format'
const path=process.env.ZC_KMS_FIXTURE
if(process.platform!=='linux'||!path)throw new Error('Linux KMS preview peer required')
const lib=dlopen(path,{
  zkms_test_scenario:{args:[FFIType.i32],returns:FFIType.void},zkms_test_fault:{args:[FFIType.i32],returns:FFIType.void},
  zkms_test_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_preview_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_properties:{args:[FFIType.ptr],returns:FFIType.void},
})
const settings={backend:'drm' as const,drm:{card:'/dev/zig-camera-kms-fixture',timeoutMs:250},window:{x:5,y:7,width:320,height:240}}
async function until(fn:()=>boolean){const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw Error('DRM test timeout');await Bun.sleep(1)}}
function properties(){const data=new BigUint64Array(15);lib.symbols.zkms_test_properties(ptr(data));return data}
function diagnose(label:string,camera:Camera,error:unknown){
  const counts=new Uint32Array(5),preview=new Uint32Array(8);lib.symbols.zkms_test_counts(ptr(counts));lib.symbols.zkms_test_preview_counts(ptr(preview))
  console.error(label,error,{counts:[...counts],preview:[...preview],properties:[...properties()].map(String),info:camera.previewInfo(),displayError:camera.previewError})
}
function retired(){
  const counts=new Uint32Array(5),preview=new Uint32Array(8);lib.symbols.zkms_test_counts(ptr(counts));lib.symbols.zkms_test_preview_counts(ptr(preview))
  assert.equal(counts[0],counts[1]);assert.equal(counts[3],0);assert.equal(counts[4],0);assert.equal(preview[6],0);assert.equal(preview[7],0)
  assert.ok(preview[0]!>0);assert.ok(preview[1]!>0);assert.ok(preview[4]!>0)
}
try{
  for(const format of ['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY'] as ProcessedFormat[]){
    lib.symbols.zkms_test_scenario(10)
    const camera=new Camera({simulate:true,width:8,height:6,buffers:4,fifo:true,format,colorSpace:isYuv(format)?'rec709':'srgb',lores:{width:4,height:2,format}})
    try{
      camera.startPreview(settings);await camera.captureMetadata();await camera.captureMetadata()
      assert.equal(camera.previewInfo()?.drmState?.retainedFrames,1);assert.ok(camera.stats().leased>=1)
      const initial=properties();assert.deepEqual([...initial.slice(6,10)],[5n,7n,320n,240n]);assert.equal(initial[14],65535n)
      if(isYuv(format)){assert.equal(initial[11],1n);assert.equal(initial[12],0n)}
      assert.throws(()=>camera.setOverlay({data:new Uint8Array([1,2,3,255]),width:1,height:1}),/(-8)/)
      camera.setPreviewView({window:settings.window,transform:{rotation:90}})
      const rotated=properties();assert.equal(rotated[10],8n);assert.deepEqual([...rotated.slice(6,10)],[75n,7n,180n,240n])
      camera.setPreviewStream('lores');await camera.captureMetadata();assert.equal(camera.previewStreamInfo()?.width,4)
      camera.setPreviewStream(null);await camera.captureMetadata();assert.equal(camera.previewInfo()?.drmState?.retainedFrames,0)
      camera.setPreviewStream('main');await camera.captureMetadata()
      if(format==='BGR888'){
        const borrowed=await camera.captureRequest()
        try{
          await assert.rejects(camera.switchMode({width:12,height:8,format}).wait(),/unleased/)
          assert.equal(camera.previewStreamInfo()?.width,8)
          assert.ok(borrowed.metadata()) // Detaching our preview must not consume the caller's lease.
        }finally{borrowed.release()}
        await camera.captureMetadata();assert.equal(camera.previewInfo()?.drmState?.retainedFrames,1)
      }
      await camera.switchMode({width:12,height:8,format,lores:{width:6,height:4,format}})
      await camera.captureMetadata();assert.equal(camera.previewStreamInfo()?.width,12);assert.equal(camera.previewInfo()?.drm?.card,settings.drm.card)
      await camera.switchModeAndCaptureRGB({width:10,height:8,format})
      assert.equal(camera.previewStreamInfo()?.width,12)
      camera.stopPreview();assert.equal(camera.stats().leased,0);assert.equal(camera.previewCleanupPending,0)
    }catch(error){diagnose(`DRM ${format} operation failed`,camera,error);throw error}
    finally{try{await camera.close()}catch(error){diagnose(`DRM ${format} close failed`,camera,error);throw error}}
    retired()
  }
  lib.symbols.zkms_test_scenario(10)
  const camera=new Camera({simulate:true,width:8,height:6,buffers:4,fifo:true})
  const recorder=await Recorder.open({outputframe(){}},{width:8,height:6,codec:'mjpeg',fps:25})
  try{
    camera.startPreview(settings);let recording=camera.startRecording(recorder)
    await until(()=>recording.stats().completed>=2n)
    recording=await camera.switchRecordingModeAsync(recorder,{width:12,height:8},{},{outputframe(){}})
    await until(()=>recording.stats().completed>=2n)
    lib.symbols.zkms_test_fault(12) // commits may apply, but no completion proof arrives
    await until(()=>camera.previewInfo()?.suspended===true)
    assert.ok(camera.previewError);assert.equal(camera.previewCleanupPending,1)
    assert.equal(camera.previewInfo()?.drmState?.retainedFrames,2)
    assert.equal(camera.previewInfo()?.drmState?.uncertain,true)
    const before=recording.stats().completed;await until(()=>recording.stats().completed>before)
    lib.symbols.zkms_test_fault(0);camera.stopPreview();assert.equal(camera.previewCleanupPending,0)
    const after=recording.stats().completed;await until(()=>recording.stats().completed>after)
  }finally{lib.symbols.zkms_test_fault(0);await camera.close();await recorder.close()}
  retired()
  for(const fault of [13,14,15]){
    lib.symbols.zkms_test_scenario(10)
    const camera=new Camera({simulate:true,width:8,height:6,buffers:4,fifo:true})
    try{
      camera.startPreview(settings);await camera.captureMetadata();lib.symbols.zkms_test_fault(fault)
      await until(()=>camera.previewError!==undefined)
      if(camera.previewCleanupPending)camera.stopPreview()
      assert.equal(camera.stats().leased,0);assert.equal(camera.previewCleanupPending,0)
    }finally{lib.symbols.zkms_test_fault(0);await camera.close()}
    retired()
  }
  lib.symbols.zkms_test_scenario(10)
  const rejected=new Camera({simulate:true,width:8,height:6})
  try{
    lib.symbols.zkms_test_fault(16)
    assert.throws(()=>rejected.startPreview({...settings,transform:{hflip:true}}),/cleanup/)
    assert.equal(rejected.previewCleanupPending,1)
    await rejected.close();assert.equal(rejected.previewCleanupPending,0)
  }finally{lib.symbols.zkms_test_fault(0);await rejected.close()}
  console.log('DRM preview format imports, GEM alias references, flip proofs, property restoration, mode/stream jobs, failure isolation and retained cleanup retries passed')
}finally{lib.close()}
