import type {Frame,PreviewOverlay} from './index'
import {native as n,storage,view,ptr,outPointer,handle,check,cameraError,type Pointer} from './ffi'
import {BunJob,snapshotJobOptions,type JobOptions} from './jobs'
import {openDrmPreview,readDrmPreviewState,readDrmPreviewStorage,readDrmPreviewOverlay,snapshotDrmPreview,type DrmPreviewOptions} from './drm-preview'
import {preparePreviewView,validatePreviewView,type PreviewViewOptions} from './preview-view'
import {processedFormatCode,type ProcessedFormat} from './processed-format'
import {submitDrmPreviewFrame,setDrmPreviewOverlay,seedDrmPreviewOverlay} from './drm-preview-frame'
import {createPreviewOverlay} from './preview-overlay'

export interface DrmPreviewSessionOptions extends DrmPreviewOptions {
  width:number
  height:number
  format?:ProcessedFormat
  /** Native operation capacity, including the executing operation; default 4. */
  operations?:number
  view?:PreviewViewOptions
}
export class DrmPreviewCleanupError extends AggregateError {
  constructor(errors:unknown[],readonly cleanup:DrmPreview){super(errors,'DRM preparation cleanup failed; retain cleanup for close retry')}
}
function dimension(value:unknown,max:number){
  if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>max)throw new RangeError('invalid DRM session dimension/capacity')
  return value
}
/** Native preview consumer. Independent instances require explicit source
 * retirement; Camera can own one through its drm-async backend. */
export class DrmPreview implements AsyncDisposable {
  private handle=0 as Pointer
  private enabled=false
  private closing=false
  private closeJob?:Promise<void>
  private readonly jobs=new Set<BunJob<void>>()
  private readonly nativeJobs=new Set<Pointer>()
  readonly width:number
  readonly height:number
  readonly format:ProcessedFormat
  lastError:unknown
  constructor(options:DrmPreviewSessionOptions){
    const drm=snapshotDrmPreview(options),width=options.width,height=options.height,format=options.format??'BGR888',capacity=options.operations??4,offeredView=options.view
    this.width=dimension(width,16384);this.height=dimension(height,16384);this.format=format
    processedFormatCode(format);dimension(capacity,8)
    const initialView=offeredView===undefined?undefined:preparePreviewView(offeredView)
    if(initialView)validatePreviewView(initialView,this.width,this.height)
    this.handle=openDrmPreview(this.width,this.height,format,drm)
    try{
      // No source exists yet, so initial view admission cannot wait for a flip.
      if(initialView)check(n.zc_preview_set_view(this.handle,ptr(initialView.data)),'initial DRM view')
      check(n.zc_drm_preview_enable_async(this.handle,capacity),'DRM worker creation');this.enabled=true
    }
    catch(error){
      const code=n.zc_preview_close(this.handle)
      if(code===0){this.handle=0 as Pointer;throw error}
      throw new DrmPreviewCleanupError([error,cameraError(code,'DRM preparation cleanup')],this)
    }
  }
  get closed(){return !this.handle}
  get pendingJobs(){return this.nativeJobs.size}
  get state(){if(!this.handle)throw cameraError(-2,'closed DRM preview');return readDrmPreviewState(this.handle)}
  get storageState(){if(!this.handle)throw cameraError(-2,'closed DRM preview');return readDrmPreviewStorage(this.handle)}
  get overlayState(){if(!this.handle)throw cameraError(-2,'closed DRM preview');return readDrmPreviewOverlay(this.handle)}
  get queueState(){
    if(!this.handle)throw cameraError(-2,'closed DRM preview')
    const data=storage(56),d=view(data);check(n.zc_drm_preview_queue_state_get(this.handle,ptr(data)))
    return Object.freeze({capacity:d.getUint32(4,true),outstanding:d.getUint32(8,true),queued:d.getUint32(12,true),active:!!d.getUint32(16,true),liveJobs:d.getUint32(20,true),retiring:!!d.getUint32(24,true),issued:d.getBigUint64(32,true),completed:d.getBigUint64(40,true),rejected:d.getBigUint64(48,true)})
  }
  private assertOpen(){if(!this.handle||this.closing)throw cameraError(-2,'DRM preview unavailable')}
  private command(kind:number,data?:Uint8Array){
    const output=outPointer();check(n.zc_drm_preview_command_async(this.handle,kind,data?ptr(data):null,ptr(output)),'DRM command admission');return handle(output)
  }
  private async finish(native:Pointer,current?:BunJob<void>){
    const result=storage(4);let failure:unknown
    try{
      for(;;){
        const code=n.zc_drm_preview_job_finish(native,ptr(result))
        if(code===-3){await Bun.sleep(1);continue}
        check(code,'DRM completion fence');break
      }
      const code=view(result).getInt32(0,true)
      if(code===-10&&current?.cancelRequested)current.check()
      check(code,'DRM worker operation');current?.check()
    }catch(error){failure=error}
    // The native handle is about to retire. A microtask can call close/cancel
    // before BunJob seals its result; never leave a guard capturing freed memory.
    current?.setCancellationGuard(()=>false)
    const retired=n.zc_drm_preview_job_close(native)
    if(retired===0)this.nativeJobs.delete(native)
    else failure=failure===undefined?cameraError(retired,'DRM job cleanup'):new AggregateError([failure,cameraError(retired,'DRM job cleanup')],'DRM operation and cleanup failed')
    if(failure!==undefined){this.lastError=failure;throw failure}
  }
  private create(start:()=>Pointer,source:JobOptions<void>,waitCapacity=false,cleanup:()=>void=()=>{}){
    const admit=()=>{this.assertOpen();if([...this.jobs].filter(job=>!job.done).length>=32)throw cameraError(-4,'DRM job queue full')}
    admit();const options=snapshotJobOptions(source);admit()
    let job:BunJob<void>|undefined
    job=new BunJob<void>(async current=>{
      try{
        let native:Pointer
        for(;;){
          current.check();this.assertOpen()
          try{native=start();break}catch(error){
            if(!waitCapacity||!(error instanceof Error)||!('code' in error)||error.code!==-4)throw error
            await Bun.sleep(1)
          }
        }
        this.nativeJobs.add(native)
        current.setCancellationGuard(()=>n.zc_drm_preview_job_cancel(native)===0)
        await this.finish(native,current)
      }finally{cleanup()}
    },()=>{if(job)this.jobs.delete(job);cleanup()},options)
    try{admit()}catch(error){job.cancel(error);cleanup();throw error}
    if(job.done){cleanup();return job}
    this.jobs.add(job);void job.start();return job
  }
  [seedDrmPreviewOverlay](input:Pointer){this.assertOpen();check(n.zc_drm_preview_overlay_seed(this.handle,input||null),'DRM overlay bootstrap')}
  [setDrmPreviewOverlay](input:Pointer,options:JobOptions<void>={}){
    return this.create(()=>{const out=outPointer();check(n.zc_drm_preview_overlay_async(this.handle,input||null,ptr(out)),'DRM overlay admission');return handle(out)},options,true)
  }
  setOverlayAsync(overlay:PreviewOverlay|null,options:JobOptions<void>={}){
    let input=createPreviewOverlay(overlay)
    const cleanup=()=>{if(input){n.zc_preview_overlay_close(input);input=0 as Pointer}}
    try{return this.create(()=>{const out=outPointer();check(n.zc_drm_preview_overlay_async(this.handle,input||null,ptr(out)),'DRM overlay admission');return handle(out)},options,true,cleanup)}catch(error){cleanup();throw error}
  }
  showAsync(frame:Frame,options:JobOptions<void>&{stream?:'main'|'lores'}={}){
    const stream=options.stream??'main'
    if(stream!=='main'&&stream!=='lores')throw new RangeError('invalid DRM preview stream')
    if(typeof frame?.[submitDrmPreviewFrame]!=='function')throw new TypeError('live camera frame required')
    // start runs synchronously through native export admission before returning.
    // A successful admission survives immediate public Frame.release().
    return this.create(()=>frame[submitDrmPreviewFrame](this.handle,stream),options)
  }
  setViewAsync(options:PreviewViewOptions,jobOptions:JobOptions<void>={}){
    const prepared=preparePreviewView(options);validatePreviewView(prepared,this.width,this.height)
    return this.create(()=>this.command(2,prepared.data),jobOptions,true)
  }
  backgroundAsync(options:JobOptions<void>={}){return this.create(()=>this.command(1),options,true)}
  /** Joins callback cleanup; a displayed or uncertain source remains retained. */
  drainAsync(options:JobOptions<void>={}){return this.create(()=>this.command(0),options,true)}
  close():Promise<void>{
    if(!this.handle&&this.nativeJobs.size===0)return Promise.resolve()
    if(this.closeJob)return this.closeJob
    this.closing=true
    this.closeJob=Promise.resolve().then(async()=>{
      for(const job of this.jobs)job.cancel()
      await Promise.all([...this.jobs].map(job=>job.operationDone))
      let failure:unknown
      for(const native of this.nativeJobs)try{await this.finish(native)}catch(error){failure??=error}
      if(this.nativeJobs.size)throw failure??cameraError(-4,'DRM jobs still own preview')
      if(this.handle){
        if(this.enabled){
          const native=this.command(3);this.nativeJobs.add(native)
          await this.finish(native)
        }
        check(n.zc_preview_close(this.handle),'DRM worker join/close')
        this.handle=0 as Pointer
      }
      if(failure)throw failure
    }).catch(error=>{this.lastError=error;throw error}).finally(()=>{
      if(this.handle||this.nativeJobs.size){this.closing=false;this.closeJob=undefined}
    })
    return this.closeJob
  }
  async [Symbol.asyncDispose](){await this.close()}
}
