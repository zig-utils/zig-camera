import {native as n, ptr, storage, view, check, handle, outPointer, CameraError, type Pointer} from './ffi'
import {BunJob} from './jobs'
export interface ImageJobLimits {
  /** Copied physical pixels and metadata; default 64 MiB, maximum 256 MiB. */
  maxInputBytes?: number
  /** Encoded result ceiling; default 64 MiB, maximum 256 MiB. */
  maxOutputBytes?: number
  /** Live codec allocations including native zlib workspace/result; default 128 MiB. */
  maxWorkingBytes?: number
}
export function prepareImageJobLimits(source: ImageJobLimits) {
  const input=source.maxInputBytes??64*1024*1024, output=source.maxOutputBytes??64*1024*1024, working=source.maxWorkingBytes??128*1024*1024
  const bytes=storage(32),d=view(bytes)
  d.setUint32(0,32,true)
  for(const [offset,value] of [[8,input],[16,output],[24,working]]) {
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>256*1024*1024)throw new RangeError('invalid image job byte limit')
    d.setBigUint64(offset!,BigInt(value),true)
  }
  return bytes
}
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,1))
/** @internal Admit synchronously before the first await; always join before returning. */
export async function runImageJob<T>(open:(out:Pointer)=>number,current:BunJob<T>,deadline:number,file?:Pointer,waitForAdmission=false,consume?:(bytes:Uint8Array)=>Promise<void>):Promise<Uint8Array|undefined>{
  current.check()
  const out=outPointer()
  let admission=open(ptr(out))
  // Only callers retaining an immutable owned snapshot and a bounded staged
  // file reservation may wait. Borrowed camera/remote adapters never opt in.
  while(admission===-4&&waitForAdmission){
    if(Date.now()>=deadline&&!current.cancelRequested)current.cancel(new CameraError(-3,'image admission deadline'))
    current.check();await pause();current.check();admission=open(ptr(out))
  }
  check(admission,'image job admission')
  const owned=handle(out),cancel=()=>{n.zc_image_job_cancel(owned)}
  current.signal.addEventListener('abort',cancel,{once:true})
  if(current.cancelRequested)cancel()
  const state=storage(48),d=view(state)
  let finished=false,failure:unknown
  try{
    for(;;){check(n.zc_image_job_state_get(owned,ptr(state)),'image job state');if(d.getUint32(8,true))break;await pause()}
    finished=true
    const code=d.getInt32(12,true)
    if(code&&code!==-10&&code!==-5)check(code,'image encoding')
    if(Date.now()>=deadline&&!current.cancelRequested)current.cancel(new CameraError(-3,'image encoding deadline'))
    current.check();check(code,'image encoding')
    if(file)return undefined
    const output=outPointer();check(n.zc_image_job_take_blob(owned,ptr(output)),'image job result')
    const blob=handle(output)
    let bytes:Uint8Array
    try{
      const size=new BigUint64Array(1);check(n.zc_image_blob_copy(blob,null,0n,ptr(size)))
      if(size[0]>256n*1024n*1024n)throw new RangeError('image result too large')
      bytes=storage(Number(size[0]));check(n.zc_image_blob_copy(blob,ptr(bytes),BigInt(bytes.length),ptr(size)))
    }finally{n.zc_image_blob_close(blob)}
    // Keep Home's native input/workspace reservation through output I/O. The
    // copied JS result replaces the transferred native allocation in that
    // reservation; an arbitrarily slow sink cannot escape the four-owner cap.
    if(consume){await consume(bytes);return undefined}
    return bytes
  }catch(error){failure=error;throw error}
  finally{
    current.signal.removeEventListener('abort',cancel)
    if(!finished)n.zc_image_job_cancel(owned)
    let code:number
    while((code=n.zc_image_job_close(owned))===-4)await pause()
    if(code){const error=new CameraError(code,'image job close');if(failure!==undefined)throw new AggregateError([failure,error],'image job cleanup failed');throw error}
  }
}
