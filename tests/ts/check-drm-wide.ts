// Independent Linux peer: real shared mmap bytes and source/display lifetimes.
import{strict as assert}from'node:assert'
import{dlopen,FFIType,ptr}from'bun:ffi'
import{Camera,DrmPreview,Recorder,type Frame}from'../../ts'
const path=process.env.ZC_KMS_FIXTURE
if(process.platform!=='linux'||!path)throw Error('Linux RGB16 DRM peer required')
const peer=dlopen(path,{
 zkms_test_scenario:{args:[FFIType.i32],returns:FFIType.void},zkms_test_fault:{args:[FFIType.i32],returns:FFIType.void},
 zkms_test_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_preview_counts:{args:[FFIType.ptr],returns:FFIType.void},
 zkms_test_cpu_counts:{args:[FFIType.ptr],returns:FFIType.void},zkms_test_cpu_snapshot:{args:[FFIType.ptr,FFIType.u32,FFIType.ptr],returns:FFIType.i32},
})
const settings={width:8,height:6,card:'/dev/zig-camera-kms-fixture',timeoutMs:500,rgb16:'high-byte' as const}
const options={simulate:true,width:8,height:6,buffers:6,fifo:true,writable:true}
async function until(check:()=>boolean){const end=performance.now()+5000;while(!check()){if(performance.now()>end)throw Error('RGB16 DRM deadline');await Bun.sleep(1)}}
function counts(){const out=new Uint32Array(8);peer.symbols.zkms_test_cpu_counts(ptr(out));return out}
function display(){const out=new Uint32Array(8);peer.symbols.zkms_test_preview_counts(ptr(out));return out}
function retired(){
 const io=new Uint32Array(5);peer.symbols.zkms_test_counts(ptr(io));assert.equal(io[0],io[1]);assert.equal(io[3],0);assert.equal(io[4],0)
 const cpu=counts();assert.equal(cpu[0],cpu[1]);assert.equal(cpu[2],cpu[3]);assert.equal(cpu[4],cpu[5]);assert.equal(cpu[6],0);assert.equal(cpu[7],0)
 assert.equal(display()[6],0);assert.equal(display()[7],0)
}
function words(x:number,y:number,seed:number){return [((x+seed)*919+0x1234)&65535,((y+seed)*2311+0x5678)&65535,((x+y+seed)*1367+0x9abc)&65535]}
function paint(frame:Frame,format:'BGR161616'|'RGB161616',seed:number,stream:'main'|'lores'='main'){
 frame.withMappedStream(map=>{
  map.planes[0]!.bytes.fill(0xa7)
  for(let y=0;y<map.height;y++){
   const row=map.row(y),data=new DataView(row.buffer,row.byteOffset,row.byteLength)
   for(let x=0;x<map.width;x++)for(let ch=0;ch<3;ch++)data.setUint16(x*6+ch*2,words(x,y,seed)[format==='RGB161616'?2-ch:ch]!,true)
  }
 },stream)
}
function pixels(seed:number,width=8,height=6){
 const bytes=new Uint8Array(4096),info=new Uint32Array(4)
 assert.equal(peer.symbols.zkms_test_cpu_snapshot(ptr(bytes),bytes.length,ptr(info)),0)
 assert.equal(info[0],width);assert.equal(info[1],height);const pitch=info[2]!
 for(let y=0;y<height;y++){
  for(let x=0;x<width;x++){
   const value=words(x,y,seed),at=y*pitch+x*4
   assert.deepEqual([...bytes.slice(at,at+4)],[value[2]!>>>8,value[1]!>>>8,value[0]!>>>8,255])
  }
  assert.ok(bytes.slice(y*pitch+width*4,(y+1)*pitch).every(value=>value===0))
 }
}
async function admitted(camera:Camera,preview:DrmPreview,format:'BGR161616'|'RGB161616',seed:number){
 const frame=await camera.captureRequest()
 try{paint(frame,format,seed);return {job:preview.showAsync(frame)}}finally{frame.release()}
}
try{
 for(const format of ['BGR161616','RGB161616'] as const){
  peer.symbols.zkms_test_scenario(10)
  const camera=new Camera({...options,format}),preview=new DrmPreview({...settings,format,operations:2})
  try{
   for(let seed=0;seed<12;seed++){
    await (await admitted(camera,preview,format,seed)).job;pixels(seed)
    assert.equal(camera.stats().leased,0);assert.equal(preview.state.retainedFrames,0)
    assert.equal(preview.storageState.copyPolicy,'rgb16-high-byte');assert.equal(preview.storageState.inputFormat,format)
    assert.equal(preview.storageState.scanoutFormat,'XRGB8888');assert.equal(preview.storageState.copiedFrames,BigInt(seed+1))
    assert.equal(preview.storageState.cpuActive,0)
   }
   assert.equal(counts()[0],2);assert.equal(counts()[1],0);assert.equal(counts()[2],2)
   assert.equal(preview.storageState.buffers,2);assert.equal(preview.storageState.storageBytes,768n)
   assert.equal(display()[0],0) // Converted words never import an ordinary staged memfd.
   await preview.backgroundAsync();assert.equal(preview.storageState.buffers,2)
   const baseline=display()[2]!;peer.symbols.zkms_test_fault(17)
   const active=(await admitted(camera,preview,format,19)).job
   await until(()=>display()[2]!>baseline&&preview.queueState.active)
   assert.equal(camera.stats().leased,0);pixels(19);assert.equal(active.cancel(),false)
   const queued=(await admitted(camera,preview,format,20)).job,reason=new Error('queued RGB16 cancellation')
   assert.equal(queued.cancel(reason),true);assert.equal(camera.stats().leased,1)
   let ticks=0;const clock=setInterval(()=>ticks++,1);await Bun.sleep(20);clearInterval(clock)
   assert.ok(ticks>0);assert.equal(queued.done,false)
   peer.symbols.zkms_test_fault(0);await active;await assert.rejects(queued.wait(),error=>error===reason)
   assert.equal(camera.stats().leased,0);pixels(19)
   // The displayed copy is independent of the source camera lifetime.
   const before=display()[2]!;peer.symbols.zkms_test_fault(17)
   const last=(await admitted(camera,preview,format,21)).job
   await until(()=>display()[2]!>before)
   await camera.close();assert.equal(last.done,false);pixels(21)
   peer.symbols.zkms_test_fault(0);await last;await preview.close()
  }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
  retired()
 }
 console.log('RGB16/BGR16 exact high-byte pixels, opaque BGRX, zero padding, two reusable driver buffers, input retirement before flip, queue cancellation and camera-independent scanout passed')
 for(const fault of [20,21,22,23,24,25,28,29,31,32]){
  peer.symbols.zkms_test_scenario(10)
  const camera=new Camera({...options,format:'BGR161616'}),preview=new DrmPreview({...settings,format:'BGR161616'})
  try{
   peer.symbols.zkms_test_fault(fault)
   const job=(await admitted(camera,preview,'BGR161616',1)).job
   await assert.rejects(job.wait());assert.equal(camera.stats().leased,0);assert.equal(display()[2],0)
   peer.symbols.zkms_test_fault(0);await preview.close()
  }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
  retired()
 }
 peer.symbols.zkms_test_scenario(10)
 const reuseCamera=new Camera({...options,format:'BGR161616'}),reuse=new DrmPreview({...settings,format:'BGR161616'})
 try{
  for(let seed=0;seed<2;seed++)await (await admitted(reuseCamera,reuse,'BGR161616',seed)).job
  const before=display()[2]!;peer.symbols.zkms_test_fault(24)
  await assert.rejects((await admitted(reuseCamera,reuse,'BGR161616',3)).job.wait(),/(-6)/)
  assert.equal(reuse.state.poisoned,true);assert.equal(reuse.storageState.buffers,1);assert.equal(reuse.storageState.copiedFrames,2n)
  assert.equal(display()[2],before);assert.equal(reuseCamera.stats().leased,0)
  await reuse.close()
 }finally{peer.symbols.zkms_test_fault(0);await reuse.close();await reuseCamera.close()}
 retired()
 for(const fault of [26,27]){
  peer.symbols.zkms_test_scenario(10)
  const camera=new Camera({...options,format:'RGB161616'}),preview=new DrmPreview({...settings,format:'RGB161616'})
  try{
   await (await admitted(camera,preview,'RGB161616',2)).job
   peer.symbols.zkms_test_fault(fault);await assert.rejects(preview.close(),/(-6)/)
   assert.equal(preview.closed,false);assert.equal(preview.state.deviceClosed,true)
   await preview.close();assert.equal(preview.closed,true)
  }finally{peer.symbols.zkms_test_fault(0);await preview.close();await camera.close()}
  retired()
 }
 peer.symbols.zkms_test_scenario(10)
 const stalledCamera=new Camera({...options,format:'BGR161616'}),stalled=new DrmPreview({...settings,format:'BGR161616'})
 try{
  peer.symbols.zkms_test_fault(30)
  await assert.rejects((await admitted(stalledCamera,stalled,'BGR161616',3)).job.wait(),/(-6)/)
  assert.equal(stalledCamera.stats().leased,0);assert.equal(stalled.storageState.cpuActive,1)
  await assert.rejects(stalled.close(),/(-6)/)
  assert.equal(stalled.state.deviceClosed,true);assert.equal(stalled.storageState.buffers,1);assert.equal(stalled.storageState.cpuActive,1)
  peer.symbols.zkms_test_fault(0);await stalled.close();assert.equal(stalled.closed,true)
 }finally{peer.symbols.zkms_test_fault(0);await stalled.close();await stalledCamera.close()}
 retired()
 // Camera-owned sync and worker integration, source selection and mode restoration.
 for(const backend of ['drm','drm-async'] as const){
  peer.symbols.zkms_test_scenario(10)
  const camera=new Camera({...options,format:'RGB161616',lores:{width:4,height:2,format:'BGR161616'}})
  try{
   camera.startPreview({backend,drm:settings})
   await camera.captureMetadata()
   if(backend==='drm-async')await camera.drainPreviewAsync()
   assert.equal(camera.previewInfo()?.drmStorage?.copyPolicy,'rgb16-high-byte');assert.equal(camera.stats().leased,0)
   await camera.setPreviewStreamAsync('lores');await camera.captureMetadata();await camera.drainPreviewAsync()
   assert.equal(camera.previewStreamInfo()?.width,4);assert.equal(camera.previewInfo()?.drmStorage?.inputFormat,'BGR161616')
   await camera.setPreviewStreamAsync(null);await camera.captureMetadata();await camera.drainPreviewAsync()
   assert.equal(camera.stats().leased,0);assert.equal(camera.previewInfo()?.drmStorage?.buffers,0)
   await camera.setPreviewStreamAsync('main');await camera.captureMetadata();await camera.drainPreviewAsync()
   await camera.switchMode({width:12,height:8,format:'BGR161616'})
   await camera.captureMetadata();await camera.drainPreviewAsync();assert.equal(camera.previewStreamInfo()?.width,12)
   await camera.switchModeAndCaptureRGB({width:10,height:8,format:'RGB161616'})
   assert.equal(camera.previewStreamInfo()?.width,12)
   await camera.switchMode({width:12,height:8,format:'BGR888'})
   await camera.captureMetadata();await camera.drainPreviewAsync();assert.equal(camera.previewInfo()?.drmStorage?.copyPolicy,'direct')
   await camera.switchMode({width:12,height:8,format:'RGB161616'})
   await camera.captureMetadata();await camera.drainPreviewAsync();assert.equal(camera.previewInfo()?.drmStorage?.copyPolicy,'rgb16-high-byte')
   await camera.stopPreviewAsync();assert.equal(camera.stats().leased,0);assert.equal(camera.previewCleanupPending,0)
  }finally{peer.symbols.zkms_test_fault(0);await camera.close()}
  retired()
 }
 peer.symbols.zkms_test_scenario(10)
 const lostCamera=new Camera({...options,format:'BGR161616'}),lost=new DrmPreview({...settings,format:'BGR161616'})
 try{
  for(let seed=0;seed<2;seed++)await (await admitted(lostCamera,lost,'BGR161616',seed)).job
  peer.symbols.zkms_test_fault(12)
  await assert.rejects((await admitted(lostCamera,lost,'BGR161616',3)).job.wait(),/(-3)/)
  assert.equal(lostCamera.stats().leased,0);assert.equal(lost.state.retainedFrames,0)
  assert.equal(lost.state.uncertain,true);assert.equal(lost.storageState.buffers,2)
  await assert.rejects(lost.close(),/(-3)/);assert.equal(counts()[6],2);assert.equal(display()[6],2)
  await lostCamera.close()
  peer.symbols.zkms_test_fault(0);await lost.close()
 }finally{peer.symbols.zkms_test_fault(0);await lost.close();await lostCamera.close()}
 retired()
 // A separate async producer keeps recording while the copied display is held.
 peer.symbols.zkms_test_scenario(10)
 const recordingCamera=new Camera({...options,format:'RGB161616'})
 const recorder=await Recorder.open({outputframe(){}},{width:8,height:6,codec:'mjpeg',fps:25,asyncWrites:true,producerQueue:{maxBytes:262144,maxOperations:2}})
 try{
  recordingCamera.startPreview({backend:'drm-async',drm:settings})
  let recording=recordingCamera.startRecording(recorder)
  await until(()=>recording.stats().completed>=3n&&(recordingCamera.previewInfo()?.drmStorage?.copiedFrames??0n)>0n)
  const before=display()[2]!;peer.symbols.zkms_test_fault(17)
  await until(()=>display()[2]!>before&&!!recordingCamera.previewInfo()?.drmQueue?.active)
  const encoded=recording.stats().completed,skips=recordingCamera.previewInfo()!.workerFrames!.skipped
  await recordingCamera.captureMetadata();await until(()=>recording.stats().completed>encoded+2n)
  assert.ok(recordingCamera.previewInfo()!.workerFrames!.skipped>skips)
  const stopping=recordingCamera.stopPreviewAsync();await Bun.sleep(20);assert.equal(stopping.done,false)
  peer.symbols.zkms_test_fault(0);await stopping
  const healthy=recording.stats().completed;await until(()=>recording.stats().completed>healthy)
  recordingCamera.startPreview({backend:'drm-async',drm:settings})
  recording=await recordingCamera.switchRecordingModeAsync(recorder,{width:12,height:8,format:'RGB161616'},{},{outputframe(){}})
  await until(()=>recording.stats().completed>=2n)
  const group=await recordingCamera.switchRecordingsModeAsync({width:10,height:8,format:'BGR161616'},[{recording,output:{outputframe(){}}}])
  recording=group[0]!;await until(()=>recording.stats().completed>=2n)
  assert.equal(recordingCamera.previewStreamInfo()?.width,10)
 }finally{peer.symbols.zkms_test_fault(0);await recordingCamera.close();await recorder.close()}
 retired()
 console.log('Converted-output uncertainty retains both GPU buffers without camera leases; async producer progress and joined recorder/group modes passed')
 console.log('CPU scanout driver capabilities, malformed layouts, export/sync/create/framebuffer faults, consumed-FD cleanup, post-card-close coherency retry and Camera source/mode lifetimes passed')
}finally{peer.close()}
