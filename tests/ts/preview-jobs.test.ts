import {test,expect} from 'bun:test'
import {Camera,BunJob} from '../../ts'
import {preparePreviewConfiguration} from '../../ts/preview-options'
const options={simulate:true,width:8,height:6,buffers:4,lores:{width:4,height:2,rgb:true}}
test('Camera preview jobs copy views, serialize source selection and allow completion callback close',async()=>{
  const camera=new Camera(options)
  try{
    camera.startPreview({backend:'headless'})
    const view={window:{x:5,y:7,width:320,height:240}}
    const first=camera.setPreviewViewAsync(view);view.window.x=99
    const second=camera.setPreviewStreamAsync('lores')
    expect(()=>camera.switchMode({width:12,height:8})).toThrow('preview jobs')
    expect(()=>camera.stopPreview()).toThrow('change active')
    expect(()=>camera.setPreviewView({keepAspect:false})).toThrow('preview jobs pending')
    expect(()=>camera.setPreviewStream(null)).toThrow('preview jobs pending')
    await first;await second
    expect(camera.previewInfo()?.window?.x).toBe(5)
    expect(camera.previewStreamInfo()).toMatchObject({stream:'lores',width:4,height:2})
    const reason=new Error('queued preview cancelled'),cancelled=camera.setPreviewStreamAsync(null)
    expect(cancelled.cancel(reason)).toBe(true)
    await expect(cancelled.wait()).rejects.toBe(reason)
    await camera.drainPreviewAsync()
    expect(camera.previewStreamInfo()?.stream).toBe('lores')
    const last=camera.stopPreviewAsync({signalFunction:async()=>{await camera.close()}})
    await last;await last.cleanupDone
    expect(last.callbackError).toBeUndefined();expect(camera.previewInfo()).toBeUndefined()
    await camera.close()
  }finally{await camera.close()}
})
test('preview queue bounds, abort snapshots and camera stop retire all admitted operations',async()=>{
  const camera=new Camera(options)
  try{
    camera.startPreview({backend:'headless'})
    const jobs=Array.from({length:32},()=>camera.drainPreviewAsync())
    expect(()=>camera.drainPreviewAsync()).toThrow('queue full')
    await camera.stop()
    await Promise.allSettled(jobs.map(job=>job.wait()))
    expect(jobs.every(job=>job.done)).toBe(true)
    expect(camera.stats().leased).toBe(0);expect(camera.previewInfo()).toBeUndefined()
    camera.startPreview({backend:'headless'})
    const controller=new AbortController(),reason=new Error('already aborted')
    controller.abort(reason)
    const job=camera.stopPreviewAsync({signal:controller.signal})
    await expect(job.wait()).rejects.toBe(reason)
    expect(camera.previewInfo()?.backend).toBe('headless')
    await camera.stopPreviewAsync()
  }finally{await camera.close()}
})
test('asynchronous DRM configuration snapshots and non-device failures retain no camera leases',async()=>{
  let reads=0
  const config=preparePreviewConfiguration({backend:'drm-async',drm:{get card(){reads++;return '/dev/null'}},stream:'lores'})
  expect(reads).toBe(1);expect(config.backend).toBe('drm-async');expect(config.drm?.card).toBe('/dev/null')
  const camera=new Camera(options)
  try{
    for(let i=0;i<8;i++)expect(()=>camera.startPreview({backend:'drm-async',drm:{card:'/dev/null'}})).toThrow('(-8)')
    expect(camera.previewCleanupPending).toBe(0);expect(camera.stats().leased).toBe(0)
    camera.startPreview({backend:'headless'});await camera.stopPreviewAsync()
  }finally{await camera.close()}
})
test('BunJob forwards cancellation identity through a child guard and refuses post-claim cancellation',async()=>{
  let finish!:()=>void
  const waiting=new Promise<void>(resolve=>finish=resolve),reason=new Error('parent reason')
  const child=new BunJob<void>(async current=>{await waiting;current.check()},()=>{})
  const parent=new BunJob<void>(async current=>{
    current.setCancellationGuard(reason=>child.cancel(reason))
    void child.start()
    try{await child}finally{current.setCancellationGuard(()=>false)}
  },()=>{})
  void parent.start();expect(parent.cancel(reason)).toBe(true)
  expect(child.cancellationReason).toBe(reason);finish()
  await expect(parent.wait()).rejects.toBe(reason)
  expect(parent.cancel(new Error('late'))).toBe(false)
})
test('preview admission rechecks camera stop and queue capacity after signal listener reentry',async()=>{
  const camera=new Camera(options)
  let stopped:Promise<void>|undefined
  try{
    camera.startPreview({backend:'headless'})
    const controller=new AbortController(),signal=controller.signal,add=signal.addEventListener.bind(signal)
    Object.defineProperty(signal,'addEventListener',{value:(...args:Parameters<AbortSignal['addEventListener']>)=>{
      stopped=camera.stop();return add(...args)
    }})
    expect(()=>camera.drainPreviewAsync({signal})).toThrow('unavailable')
    await stopped
    expect(camera.previewInfo()).toBeUndefined()
    camera.startPreview({backend:'headless'})
    const full=new AbortController().signal,normal=full.addEventListener.bind(full),jobs:BunJob<void>[]=[]
    Object.defineProperty(full,'addEventListener',{value:(...args:Parameters<AbortSignal['addEventListener']>)=>{
      for(let i=0;i<32;i++)jobs.push(camera.drainPreviewAsync())
      return normal(...args)
    }})
    expect(()=>camera.stopPreviewAsync({signal:full})).toThrow('queue full')
    await Promise.all(jobs.map(job=>job.wait()))
    expect(camera.previewInfo()?.suspended).toBe(false)
    await camera.stopPreviewAsync();expect(camera.previewCleanupPending).toBe(0)
  }finally{await stopped;await camera.close()}
})
test('synchronous abort during signal registration retires an unpublished preview job',async()=>{
  const camera=new Camera(options),controller=new AbortController(),signal=controller.signal,reason=new Error('registration abort')
  try{
    camera.startPreview({backend:'headless'})
    const add=signal.addEventListener.bind(signal)
    Object.defineProperty(signal,'addEventListener',{value:(...args:Parameters<AbortSignal['addEventListener']>)=>{
      add(...args);controller.abort(reason)
    }})
    const job=camera.stopPreviewAsync({signal})
    await expect(job.wait()).rejects.toBe(reason);await job.cleanupDone
    expect(camera.previewInfo()?.suspended).toBe(false)
    await camera.switchMode({width:12,height:8})
    await camera.stopPreviewAsync()
  }finally{await camera.close()}
})
for(const kind of ['plain','single','group'] as const)test(`${kind} mode admission cannot cross a signal-reentrant preview job`,async()=>{
  const camera=new Camera(options)
  const {Recorder}=await import('../../ts')
  const recorder=kind==='plain'?undefined:await Recorder.open({outputframe(){}},{width:8,height:6,codec:'mjpeg',fps:25})
  let pending:BunJob<void>|undefined
  try{
    camera.startPreview({backend:'headless'})
    const recording=kind==='group'?camera.startRecording(recorder!):undefined
    const controller=new AbortController(),signal=controller.signal,add=signal.addEventListener.bind(signal)
    Object.defineProperty(signal,'addEventListener',{value:(...args:Parameters<AbortSignal['addEventListener']>)=>{
      pending=camera.drainPreviewAsync();return add(...args)
    }})
    const invoke=()=>kind==='plain'?camera.switchMode({width:12,height:8},{signal})
      :kind==='single'?camera.switchRecordingModeAsync(recorder!,{width:12,height:8},{},{outputframe(){}},{signal})
      :camera.switchRecordingsModeAsync({width:12,height:8},[{recording:recording!,output:{outputframe(){}}}],{signal})
    expect(invoke).toThrow('preview jobs pending')
    await pending
    expect(camera.info().width).toBe(8);expect(camera.previewInfo()?.suspended).toBe(false)
    await camera.stopPreviewAsync()
  }finally{await camera.close();await recorder?.close()}
})
test('synchronous view and stream validation cannot cross a reentrant preview admission',async()=>{
  const camera=new Camera(options)
  try{
    camera.startPreview({backend:'headless'})
    for(const kind of ['view','stream'] as const){
      let pending:BunJob<void>|undefined
      const view={get keepAspect(){pending=camera.drainPreviewAsync();return false}}
      expect(()=>kind==='view'?camera.setPreviewView(view):camera.setPreviewStream(null,view)).toThrow('preview changed')
      await pending
      expect(camera.previewInfo()?.keepAspect).toBeUndefined()
      expect(camera.previewStreamInfo()?.stream).toBe('main')
    }
    await camera.stopPreviewAsync()
  }finally{await camera.close()}
})
