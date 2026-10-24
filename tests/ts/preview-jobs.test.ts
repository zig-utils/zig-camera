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
