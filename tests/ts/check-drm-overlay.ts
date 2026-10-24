// Independent Linux UAPI peer; real shared mmap bytes and real flip-event FDs.
import{strict as assert}from'node:assert'
import{dlopen,FFIType,ptr}from'bun:ffi'
import{Camera,DrmPreview,Recorder,type PreviewTransform,type PreviewOverlay}from'../../ts'
import{native as n}from'../../ts/ffi'
const path=process.env.ZC_KMS_FIXTURE
if(process.platform!=='linux'||!path)throw Error('Linux two-plane DRM peer required')
const peer=dlopen(path,{
 zkms_test_scenario:{args:[FFIType.i32],returns:FFIType.void},zkms_test_fault:{args:[FFIType.i32],returns:FFIType.void},
 zkms_test_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_preview_counts:{args:[FFIType.ptr],returns:FFIType.void},
 zkms_test_properties:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_overlay_properties:{args:[FFIType.ptr],returns:FFIType.void},
 zkms_test_pair_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_cpu_counts:{args:[FFIType.ptr],returns:FFIType.void},
 zkms_test_overlay_snapshot:{args:[FFIType.ptr,FFIType.u32,FFIType.ptr],returns:FFIType.i32},
})
const settings={width:8,height:6,card:'/dev/zig-camera-kms-fixture',timeoutMs:300}
const options={simulate:true,width:8,height:6,buffers:6,fifo:true}
const alphas=[0,1,127,128,254,255]
function rgba(seed=0,width=3,height=2):PreviewOverlay{
 const stride=width*4+8,data=new Uint8Array(stride*height).fill(0xa7)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*stride+x*4;data.set([213+seed,74+seed,31+seed,alphas[(y*width+x)%6]!],at)}
 return{data,width,height,stride}
}
function cpu(){const out=new Uint32Array(8);peer.symbols.zkms_test_cpu_counts(ptr(out));return out}
function io(){const out=new Uint32Array(5);peer.symbols.zkms_test_counts(ptr(out));return out}
function display(){const out=new Uint32Array(8);peer.symbols.zkms_test_preview_counts(ptr(out));return out}
function pair(){const out=new Uint32Array(2);peer.symbols.zkms_test_pair_counts(ptr(out));return out}
function props(overlay=true){const out=new BigUint64Array(overlay?17:15);if(overlay)peer.symbols.zkms_test_overlay_properties(ptr(out));else peer.symbols.zkms_test_properties(ptr(out));return out}
function pixels(input:PreviewOverlay,premult=false){
 const bytes=new Uint8Array(4096),info=new Uint32Array(4)
 assert.equal(peer.symbols.zkms_test_overlay_snapshot(ptr(bytes),bytes.length,ptr(info)),0)
 assert.equal(info[0],input.width);assert.equal(info[1],input.height)
 for(let y=0;y<input.height;y++){
  for(let x=0;x<input.width;x++){
   const source=y*(input.stride??input.width*4)+x*4,target=y*info[2]!+x*4,alpha=input.data[source+3]!
   const expected=[2,1,0].map(ch=>premult?Math.floor((input.data[source+ch]!*alpha+127)/255):input.data[source+ch]!)
   assert.deepEqual([...bytes.slice(target,target+4)],[...expected,alpha])
  }
  for(let pad=input.width*4;pad<info[2]!;pad++)assert.equal(bytes[y*info[2]!+pad],0)
 }
}
async function until(check:()=>boolean){const end=performance.now()+6000;while(!check()){if(performance.now()>end)throw Error('two-plane DRM deadline');await Bun.sleep(1)}}
async function offer(camera:Camera,preview:DrmPreview){const frame=await camera.captureRequest();try{await preview.showAsync(frame)}finally{frame.release()}}
function retired(){const c=cpu(),d=display(),fds=io();assert.equal(fds[0],fds[1]);assert.equal(fds[3],0);assert.equal(fds[4],0);assert.equal(c[0],c[1]);assert.equal(c[2],c[3]);assert.equal(c[4],c[5]);assert.equal(c[6],0);assert.equal(c[7],0);assert.equal(d[6],0);assert.equal(d[7],0);assert.equal(pair()[1],0)}
try{
 for(const scenario of [40,41]){
  peer.symbols.zkms_test_scenario(scenario)
  const camera=new Camera(options),preview=new DrmPreview(settings)
  try{
   await offer(camera,preview);const original=rgba(),expected=structuredClone(original),job=preview.setOverlayAsync(original);original.data.fill(0);await job
   assert.equal(io()[0],1);assert.equal(preview.overlayState.planeId,41);assert.equal(preview.overlayState.blendMode,scenario===40?'coverage':'premultiplied');pixels(expected,scenario===41)
   assert.equal(props()[15],2n);assert.equal(props()[16],scenario===40?7n:3n);assert.equal(camera.stats().leased,1)
   for(let i=0;i<5;i++)await preview.setOverlayAsync(rgba(i))
   assert.equal(cpu()[0],2);assert.equal(preview.overlayState.buffers,2)
   const uploads=cpu()[4],pairs=pair()[0]!
   for(let i=0;i<3;i++)await offer(camera,preview)
   assert.equal(cpu()[4],uploads);assert.ok(pair()[0]!>=pairs+3);assert.equal(preview.storageState.copyPolicy,'direct')
   const transforms:PreviewTransform[]=[{}, {hflip:true},{rotation:180},{vflip:true},{transpose:true},{rotation:90},{rotation:90,vflip:true},{rotation:270}]
   const rotations=[1n,17n,4n,33n,18n,8n,34n,2n]
   for(let i=0;i<transforms.length;i++){
    await preview.setViewAsync({window:{x:9,y:11,width:80,height:60},keepAspect:false,transform:transforms[i],overlay:{rectangle:{x:1,y:2,width:3,height:2},transform:transforms[7-i]}})
    assert.deepEqual([...props().slice(6,10)],i<4?[19n,31n,30n,20n]:[22n,26n,40n,15n]);assert.equal(props(false)[10],rotations[i]);assert.equal(props()[10],rotations[7-i])
   }
   await preview.backgroundAsync();assert.equal(camera.stats().leased,0);assert.equal(preview.overlayState.visible,true)
   await preview.setViewAsync({window:{width:1,height:1},keepAspect:false,overlay:{rectangle:{x:0,y:0,width:1,height:1}}});assert.equal(preview.overlayState.visible,false);assert.equal(preview.overlayState.configured,true)
   await preview.setViewAsync({keepAspect:false});assert.equal(preview.overlayState.visible,true);pixels(rgba(4),scenario===41)
   const before=props();peer.symbols.zkms_test_fault(13);await assert.rejects(preview.setOverlayAsync(rgba(9)).wait(),/(-6)/)
   assert.deepEqual(props(),before);assert.equal(preview.overlayState.poisoned,false);pixels(rgba(4),scenario===41)
   await preview.setOverlayAsync(rgba(7,2,3));pixels(rgba(7,2,3),scenario===41);assert.equal(preview.overlayState.buffers,2)
   await preview.setOverlayAsync(null);assert.equal(preview.overlayState.configured,false);assert.equal(cpu()[6],0);assert.equal(io()[1],0)
   await offer(camera,preview);assert.equal(camera.stats().leased,1)
  }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
  retired()
 }
 console.log('DRM alpha bytes, named blend/stacking, two-slot reuse, atomic geometry/background and rejected TEST preservation passed')
 for(const scenario of [42,43,44,45,46]){
  peer.symbols.zkms_test_scenario(scenario);const preview=new DrmPreview(settings)
  try{await assert.rejects(preview.setOverlayAsync(rgba()).wait(),/(-8)/);assert.equal(preview.overlayState.configured,false);assert.equal(io()[0],1)}finally{await preview.close()}
  retired()
 }
 console.log('Unsuitable alpha-plane topologies reject without a second master FD')
 // A held pair flip owns both GPU buffers but leaves Bun and cancellation live.
 peer.symbols.zkms_test_scenario(40)
 const camera=new Camera(options),preview=new DrmPreview({...settings,timeoutMs:1500,operations:3})
 try{
  await offer(camera,preview);await preview.setOverlayAsync(rgba());const before=display()[2]!
  peer.symbols.zkms_test_fault(17);const active=preview.setOverlayAsync(rgba(1));await until(()=>display()[2]!>before)
  assert.equal(active.cancel(),false);const cancelled=preview.setOverlayAsync(rgba(2)),reason=Error('cancel queued overlay');assert.equal(cancelled.cancel(reason),true)
  const pending=rgba(3),expected=structuredClone(pending),next=preview.setOverlayAsync(pending);pending.data.fill(0)
  let ticks=0;const timer=setInterval(()=>ticks++,1);await Bun.sleep(25);clearInterval(timer);assert.ok(ticks>0);assert.equal(next.done,false)
  peer.symbols.zkms_test_fault(0);await active;await assert.rejects(cancelled.wait(),error=>error===reason);await next;pixels(expected)
  assert.equal(preview.overlayState.updates,3n);await preview.drainAsync()
  const last=preview.setOverlayAsync(null,{signalFunction:async()=>{await preview.close()}});await last;await last.cleanupDone;assert.equal(last.callbackError,undefined)
 }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
 retired()
 console.log('Held pair flip, immutable queued snapshots, queued cancellation and callback close passed')
 // Unknown pair submit must quarantine video AND overlay until joined detach.
 for(const fault of [12,14]){
  peer.symbols.zkms_test_scenario(40);const camera=new Camera(options),preview=new DrmPreview({...settings,timeoutMs:50})
  try{
   await offer(camera,preview);await preview.setOverlayAsync(rgba());peer.symbols.zkms_test_fault(fault)
   await assert.rejects(preview.setOverlayAsync(rgba(1)).wait(),fault===12?/(-3)/:/(-6)/)
   assert.equal(preview.state.uncertain,true);assert.equal(preview.overlayState.uncertain,true);assert.equal(preview.overlayState.buffers,2);assert.equal(camera.stats().leased,1)
   if(fault===12){await assert.rejects(preview.close(),/(-3)/);assert.equal(io()[1],0);assert.ok(cpu()[6]!>0)}
   peer.symbols.zkms_test_fault(0);await preview.close();assert.equal(camera.stats().leased,0)
  }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
  retired()
 }
 console.log('Unknown pair submission quarantines both owners and retries restoration while primary remains live')
 // Failed CPU END keeps child mapping/fd and shared master until retry succeeds.
 peer.symbols.zkms_test_scenario(40)
 const poisoned=new DrmPreview(settings)
 try{
  peer.symbols.zkms_test_fault(30);await assert.rejects(poisoned.setOverlayAsync(rgba()).wait(),/(-6)/);assert.equal(poisoned.overlayState.cpuActive,1)
  await assert.rejects(poisoned.close(),/(-6)/);assert.equal(io()[1],0);assert.equal(cpu()[6],1)
  peer.symbols.zkms_test_fault(0);await poisoned.close()
 }finally{peer.symbols.zkms_test_fault(0);await poisoned.close()}
 retired()
 // A bootstrap snapshot must not expose the new overlay before scene publication.
 const seed=n.zc_drm_preview_overlay_seed;let seeded=0
 Object.assign(n,{zc_drm_preview_overlay_seed(...args:Parameters<typeof seed>){
  const before=pair()[0],code=seed(...args)
  if(!code){assert.equal(props()[0],0n);assert.equal(pair()[0],before);seeded++}return code
 }})
 for(const backend of ['drm','drm-async'] as const){
  peer.symbols.zkms_test_scenario(40);const camera=new Camera({...options,lores:{width:4,height:2,rgb:true}})
  try{
   camera.startPreview({backend,drm:settings,window:{width:80,height:60},keepAspect:false})
   await camera.captureMetadata();await camera.drainPreviewAsync();const input=rgba(),expected=structuredClone(input)
   if(backend==='drm')camera.setOverlay(input);else await camera.setOverlayAsync(input)
   input.data.fill(0);pixels(expected)
   await camera.setPreviewStreamAsync('lores');await camera.captureMetadata();await camera.drainPreviewAsync();pixels(expected)
   await camera.switchMode({width:12,height:8,lores:{width:6,height:4,rgb:true}});await camera.captureMetadata();await camera.drainPreviewAsync();pixels(expected)
   await camera.switchModeAndCaptureRGB({width:10,height:8});await camera.captureMetadata();await camera.drainPreviewAsync();pixels(expected)
   assert.equal(camera.previewInfo()?.drmOverlay?.configured,true)
   await camera.setOverlayAsync(null);assert.equal(camera.previewInfo()?.drmOverlay?.configured,false)
   const job=camera.setOverlayAsync(rgba(),{signalFunction:async()=>{await camera.close()}});await job;await job.cleanupDone;assert.equal(job.callbackError,undefined)
  }finally{peer.symbols.zkms_test_fault(0);await camera.close()}
  retired()
 }
 assert.ok(seeded>=4);Object.assign(n,{zc_drm_preview_overlay_seed:seed})
 // Fresh-owner recovery restores the retained immutable overlay independently.
 for(const backend of ['drm','drm-async'] as const){
  peer.symbols.zkms_test_scenario(40);const old=new Camera(options);let fresh:Camera|undefined
  try{
   old.startPreview({backend,drm:settings,stream:null});const input=rgba(5),expected=structuredClone(input)
   if(backend==='drm')old.setOverlay(input);else await old.setOverlayAsync(input)
   old.simulateDisconnect();input.data.fill(0)
   fresh=await old.reconnect({initialDelayMs:0,maximumDelayMs:0,pollMs:2})
   await fresh.captureMetadata();await fresh.drainPreviewAsync();assert.equal(fresh.previewInfo()?.drmOverlay?.configured,true)
   assert.equal(fresh.previewInfo()?.drmOverlay?.visible,true)
   await fresh.setPreviewStreamAsync('main');await fresh.captureMetadata();await fresh.drainPreviewAsync();pixels(expected)
   await old.close();pixels(expected)
  }finally{await fresh?.close();await old.close()}
  retired()
 }
 // Shared root and overlay are rebuilt during single/group recording modes.
 peer.symbols.zkms_test_scenario(40)
 const recordingCamera=new Camera(options),recorder=await Recorder.open({outputframe(){}},{width:8,height:6,codec:'mjpeg',fps:25})
 try{
  recordingCamera.startPreview({backend:'drm-async',drm:settings});let recording=recordingCamera.startRecording(recorder)
  await recordingCamera.setOverlayAsync(rgba());await until(()=>recording.stats().completed>=2n)
  const before=display()[2]!;peer.symbols.zkms_test_fault(17)
  await until(()=>display()[2]!>before&&!!recordingCamera.previewInfo()?.drmQueue?.active)
  const completed=recording.stats().completed,skips=recordingCamera.previewInfo()!.workerFrames!.skipped
  await recordingCamera.captureMetadata();await until(()=>recording.stats().completed>completed+2n)
  assert.ok(recordingCamera.previewInfo()!.workerFrames!.skipped>skips)
  const cancelled=recordingCamera.setOverlayAsync(rgba(7)),reason=Error('cancel Camera overlay behind active frame')
  assert.equal(cancelled.cancel(reason),true);await assert.rejects(cancelled.wait(),error=>error===reason)
  const change=recordingCamera.setOverlayAsync(rgba());await Bun.sleep(10);assert.equal(change.done,false)
  peer.symbols.zkms_test_fault(0);await change
  recording=await recordingCamera.switchRecordingModeAsync(recorder,{width:12,height:8},{},{outputframe(){}});await until(()=>recording.stats().completed>=2n)
  pixels(rgba());const group=await recordingCamera.switchRecordingsModeAsync({width:10,height:8},[{recording,output:{outputframe(){}}}]);recording=group[0]!
  await until(()=>recording.stats().completed>=2n);await recordingCamera.drainPreviewAsync();pixels(rgba())
 }finally{peer.symbols.zkms_test_fault(0);await recordingCamera.close();await recorder.close()}
 retired()
 console.log('Named two-plane blending, padded RGBA bytes, DMA fences, strict stacking, shared master, atomic geometry, bounded reuse, cancellation, unknown submission quarantine and camera/recorder mode restoration passed')
}finally{peer.close()}
