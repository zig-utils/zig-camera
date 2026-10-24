import{native as n,ptr,storage,view,outPointer,handle,check,CameraError,type Pointer}from'./ffi'
import{BunJob,snapshotJobOptions,type JobOptions}from'./jobs'
import{CapturedImage,decodedImageAdmission}from'./image-object'
import{encodedImageInput,imageDecodePath,withEncodedImageFile}from'./image-decode-input'
export interface JpegDecodeLimits{
 maxInputBytes?:number
 maxOutputBytes?:number
 maxWorkingBytes?:number
 maxMetadataBytes?:number
 maxWorkUnits?:number
 maxScans?:number
 maxMarkers?:number
 upsampling?:'linear'|'nearest'
}
export interface JpegDecodeMetadata{readonly icc?:Uint8Array;readonly exif?:Uint8Array}
export type JpegColorModel='gray'|'rgb'|'ycbcr'|'cmyk'|'ycck'
/** Owned gray8/RGB8 image. ICC and Exif describe the source; no implicit profile
 * transform or Exif orientation. CMYK/YCCK uses conventional ink conversion. */
export class DecodedJpeg implements Disposable{
 /** @internal */
 constructor(readonly image:CapturedImage,readonly sourceComponents:number,readonly progressive:boolean,readonly scans:number,readonly sourceColorModel:JpegColorModel,readonly upsampling:'linear'|'nearest',readonly sampling:readonly Readonly<{horizontal:number;vertical:number}>[],readonly adobeTransform:number|undefined,readonly workingPeak:bigint,readonly workUnits:bigint,readonly metadata:Readonly<JpegDecodeMetadata>){}
 close(){this.image.close()}
 [Symbol.dispose](){this.close()}
}
function integer(value:unknown,max:number){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>max)throw new RangeError('invalid JPEG decode limit');return value}
function setting(value:number|undefined,fallback:number){return value===undefined?fallback:value}
function prepare(source:JpegDecodeLimits){
 if(!source||typeof source!=='object')throw new TypeError('invalid JPEG decode limits')
 const input=source.maxInputBytes,output=source.maxOutputBytes,working=source.maxWorkingBytes,metadata=source.maxMetadataBytes,work=source.maxWorkUnits,scans=source.maxScans,markers=source.maxMarkers,sampling=source.upsampling
 if(sampling!==undefined&&sampling!=='linear'&&sampling!=='nearest')throw new RangeError('invalid JPEG upsampling')
 const bytes=storage(56),d=view(bytes);n.zc_default_jpeg_limits(ptr(bytes))
 d.setUint32(4,integer(setting(scans,256),1024),true);d.setUint32(8,integer(setting(markers,16384),65536),true);d.setUint32(12,sampling==='nearest'?1:0,true)
 for(const[at,value,max]of [[16,setting(input,64*1024*1024),256*1024*1024],[24,setting(output,64*1024*1024),256*1024*1024],[32,setting(working,128*1024*1024),448*1024*1024],[40,setting(metadata,16*1024*1024),16*1024*1024],[48,setting(work,1024*1024*1024),16*1024*1024*1024]])d.setBigUint64(at!,BigInt(integer(value,max!)),true)
 return{bytes,input:integer(setting(input,64*1024*1024),256*1024*1024)}
}
function copied(p:Pointer,kind:number){
 const size=new BigUint64Array(1),copy=(dest:Pointer|null,capacity:bigint)=>kind===0?n.zc_jpeg_pixels_copy(p,dest,capacity,ptr(size)):n.zc_jpeg_metadata_copy(p,kind,dest,capacity,ptr(size))
 check(copy(null,0n),'JPEG copy size');if(size[0]>256n*1024n*1024n)throw new RangeError('JPEG result exceeds limit')
 const bytes=storage(Number(size[0]));if(bytes.length)check(copy(ptr(bytes),BigInt(bytes.length)),'JPEG copy');return bytes
}
function consume(p:Pointer){
 let image:CapturedImage|undefined
 try{
  const info=storage(96),d=view(info);check(n.zc_jpeg_info_get(p,ptr(info)),'JPEG info')
  const components=d.getUint32(12,true),flags=d.getUint32(48,true),adobe=d.getUint32(52,true)
  image=CapturedImage[decodedImageAdmission](copied(p,0),d.getUint32(4,true),d.getUint32(8,true),components===1?'gray':'rgb',8)
  const sampling=Object.freeze(Array.from({length:components},(_,i)=>{const value=d.getUint32(32+i*4,true);return Object.freeze({horizontal:value>>4,vertical:value&15})}))
  return new DecodedJpeg(image,components,!!d.getUint32(16,true),d.getUint32(20,true),(['gray','rgb','ycbcr','cmyk','ycck']as const)[d.getUint32(24,true)]!,d.getUint32(28,true)?'nearest':'linear',sampling,adobe===0xffffffff?undefined:adobe,d.getBigUint64(80,true),d.getBigUint64(88,true),Object.freeze({icc:flags&1?copied(p,1):undefined,exif:flags&2?copied(p,2):undefined}))
 }catch(error){image?.close();throw error}finally{n.zc_jpeg_close(p)}
}
export function decodeJpeg(source:Uint8Array,options:JpegDecodeLimits={}){
 const limits=prepare(options),bytes=encodedImageInput(source,limits.input,'JPEG'),out=outPointer()
 check(n.zc_jpeg_decode(ptr(bytes),BigInt(bytes.byteLength),ptr(limits.bytes),ptr(out)),'JPEG decode');return consume(handle(out))
}
const pause=()=>Bun.sleep(1)
async function run(bytes:Uint8Array,limits:ReturnType<typeof prepare>,current:BunJob<DecodedJpeg>,deadline:number){
 current.check();const out=outPointer();check(n.zc_jpeg_decode_async(ptr(bytes),BigInt(bytes.byteLength),ptr(limits.bytes),ptr(out)),'JPEG job admission')
 const p=handle(out),cancel=()=>{n.zc_jpeg_job_cancel(p)}
 current.signal.addEventListener('abort',cancel,{once:true});if(current.cancelRequested)cancel()
 let finished=false,result:DecodedJpeg|undefined
 try{
  const state=storage(48),d=view(state)
  for(;;){check(n.zc_jpeg_job_state_get(p,ptr(state)),'JPEG job state');if(d.getUint32(8,true))break;await pause()}
  finished=true;if(performance.now()>=deadline&&!current.cancelRequested)current.cancel(new CameraError(-3,'JPEG decode deadline'));current.check();check(d.getInt32(12,true),'JPEG decoding')
  const output=outPointer();check(n.zc_jpeg_job_take_image(p,ptr(output)),'JPEG job result');result=consume(handle(output));current.seal();return result
 }catch(error){result?.close();throw error}finally{
  current.signal.removeEventListener('abort',cancel);if(!finished)n.zc_jpeg_job_cancel(p)
  let code:number;while((code=n.zc_jpeg_job_close(p))===-4)await pause();check(code,'JPEG job close')
 }
}
/** Native copied-input worker admission completes before this call returns. */
export function decodeJpegAsync(source:Uint8Array,options:JpegDecodeLimits&JobOptions<DecodedJpeg>={}){
 const limits=prepare(options),admitted=snapshotJobOptions(options,30000),bytes=encodedImageInput(source,limits.input,'JPEG'),deadline=performance.now()+(admitted.timeoutMs??Infinity)
 const job=new BunJob<DecodedJpeg>(current=>run(bytes,limits,current,deadline),()=>{},admitted);void job.start();return job
}
/** Shared bounded reader admission persists through the native worker join. */
export function loadJpegAsync(path:string,options:JpegDecodeLimits&JobOptions<DecodedJpeg>={}){
 imageDecodePath(path,'JPEG');const limits=prepare(options),admitted=snapshotJobOptions(options,30000),deadline=performance.now()+(admitted.timeoutMs??Infinity)
 const job=new BunJob<DecodedJpeg>(current=>withEncodedImageFile(path,limits.input,'JPEG',current,bytes=>run(bytes,limits,current,deadline)),()=>{},admitted);void job.start();return job
}
