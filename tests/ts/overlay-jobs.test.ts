import{test,expect}from'bun:test'
import{Camera}from'../../ts'
import{native}from'../../ts/ffi'
const options={simulate:true,width:8,height:6,buffers:4}
const rgba=()=>({data:new Uint8Array([213,74,31,128]),width:1,height:1})
test('headless overlay jobs validate without allocating, serialize and join completion close',async()=>{
 const camera=new Camera(options),original=native.zc_preview_overlay_create
 Object.assign(native,{zc_preview_overlay_create(){throw Error('headless allocation')}})
 try{
  camera.startPreview({backend:'headless'})
  camera.setOverlay(rgba());await camera.setOverlayAsync(rgba())
  expect(()=>camera.setOverlayAsync({...rgba(),data:new Uint8Array(3)})).toThrow('RGBA')
  const first=camera.setOverlayAsync(rgba()),second=camera.setOverlayAsync(null)
  expect(()=>camera.setOverlay(null)).toThrow('pending')
  await first;await second
  const closing=camera.setOverlayAsync(null,{signalFunction:async()=>{await camera.close()}})
  await closing;await closing.cleanupDone;expect(closing.callbackError).toBeUndefined()
 }finally{await camera.close();Object.assign(native,{zc_preview_overlay_create:original})}
})
test('overlay jobs retire snapshots after preabort, queued cancellation, queue rejection and signal reentry',async()=>{
 const camera=new Camera(options),create=native.zc_preview_overlay_create,close=native.zc_preview_overlay_close
 let made=0,retired=0
 Object.assign(native,{zc_preview_overlay_create(...args:Parameters<typeof create>){const code=create(...args);if(!code)made++;return code},zc_preview_overlay_close(...args:Parameters<typeof close>){if(args[0])retired++;return close(...args)}})
 try{
  // Inactive jobs still release copied native admission inputs on operation failure.
  for(let i=0;i<40;i++)await expect(camera.setOverlayAsync(rgba()).wait()).rejects.toThrow('not active')
  camera.startPreview({backend:'headless'})
  const controller=new AbortController(),reason=Error('overlay preabort');controller.abort(reason)
  await expect(camera.setOverlayAsync(rgba(),{signal:controller.signal}).wait()).rejects.toBe(reason)
  const cancelled=camera.setOverlayAsync(rgba());expect(cancelled.cancel(reason)).toBe(true);await expect(cancelled.wait()).rejects.toBe(reason)
  const jobs=Array.from({length:32},()=>camera.setOverlayAsync(rgba()));expect(()=>camera.setOverlayAsync(rgba())).toThrow('full');await Promise.all(jobs.map(job=>job.wait()))
  expect(made).toBe(40);expect(retired).toBe(made)
  const signal=new AbortController().signal,add=signal.addEventListener.bind(signal);let stopped:Promise<void>|undefined
  Object.defineProperty(signal,'addEventListener',{value:(...args:Parameters<AbortSignal['addEventListener']>)=>{stopped=camera.stop();return add(...args)}})
  expect(()=>camera.setOverlayAsync(rgba(),{signal})).toThrow('unavailable');await stopped
 }finally{await camera.close();Object.assign(native,{zc_preview_overlay_create:create,zc_preview_overlay_close:close})}
})
const preview=process.env.ZC_TEST_PREVIEW==='1'?test:test.skip
preview('SDL overlay jobs snapshot before return, release cancelled inputs and preserve recipe across modes',async()=>{
 const camera=new Camera(options),create=native.zc_preview_overlay_create,close=native.zc_preview_overlay_close
 let made=0,retired=0
 Object.assign(native,{zc_preview_overlay_create(...args:Parameters<typeof create>){const code=create(...args);if(!code)made++;return code},zc_preview_overlay_close(...args:Parameters<typeof close>){if(args[0])retired++;return close(...args)}})
 try{
  camera.startPreview('');const input=rgba(),first=camera.setOverlayAsync(input);input.data.fill(0);await first
  expect(made).toBe(1);expect(retired).toBe(0)
  const cancelled=camera.setOverlayAsync(rgba()),reason=Error('cancel image');expect(cancelled.cancel(reason)).toBe(true);await expect(cancelled.wait()).rejects.toBe(reason)
  const controller=new AbortController();controller.abort(reason);await expect(camera.setOverlayAsync(rgba(),{signal:controller.signal}).wait()).rejects.toBe(reason)
  expect(made).toBe(3);expect(retired).toBe(2)
  await camera.switchMode({width:12,height:8});await camera.switchModeAndCaptureRGB({width:10,height:8});expect(retired).toBe(2)
  await camera.setOverlayAsync(null);expect(retired).toBe(3);await camera.stopPreviewAsync()
 }finally{await camera.close();Object.assign(native,{zc_preview_overlay_create:create,zc_preview_overlay_close:close})}
})
