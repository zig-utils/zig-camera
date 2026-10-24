import {native as n,ptr,storage,view,outPointer,handle,check,CameraError,type Pointer} from './ffi'
import {BunJob,snapshotJobOptions,type JobOptions} from './jobs'
import {CapturedImage,pngImageAdmission,type RasterFormat} from './image-object'
import {PngCompositor,type PngCompositeOptions} from './png-compositor'
export interface PngDecodeLimits {
  maxInputBytes?: number
  /** Aggregate default image and animation rectangle pixels; metadata is separate. */
  maxOutputBytes?: number
  maxWorkingBytes?: number
  maxMetadataBytes?: number
  maxFrames?: number
  maxChunks?: number
}
export interface PngDecodeMetadata {
  readonly icc?: Uint8Array
  readonly exif?: Uint8Array
  readonly srgbIntent?: number
  readonly gamma?: number
  readonly chromaticities?: readonly number[]
  readonly cicp?: readonly number[]
  readonly palette?: Uint8Array
}
export interface DecodedPngFrame {
  readonly image: CapturedImage
  readonly x: number
  readonly y: number
  readonly delay: Readonly<{numerator:number;denominator:number}>
  readonly dispose: 'none'|'background'|'previous'
  readonly blend: 'source'|'over'
}
/** Owned default image and raw frame rectangles. Explicit compositor available;
 * no gamma/gamut conversion or Exif orientation. close() closes every image. */
export class DecodedPng implements Disposable {
  /** @internal */
  constructor(readonly image:CapturedImage,readonly frames:readonly DecodedPngFrame[],readonly defaultIsFrame:boolean,readonly plays:number,readonly sourceDepth:number,readonly sourceColor:number,readonly interlaced:boolean,readonly metadata:Readonly<PngDecodeMetadata>){}
  /** Render one play from transparent black, ignoring an excluded poster. */
  compositor(options:PngCompositeOptions={}){
    if(this.image.closed)throw new CameraError(-5,'closed PNG image')
    return new PngCompositor(this.image.width,this.image.height,this.image.bits,this.frames,options)
  }
  close(){this.image.close();for(const frame of this.frames)frame.image.close()}
  [Symbol.dispose](){this.close()}
}
function integer(value:unknown,max:number){
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>max)throw new RangeError('invalid PNG decode limit')
  return value
}
function prepare(source:PngDecodeLimits){
  if(!source||typeof source!=='object')throw new TypeError('invalid PNG decode limits')
  const requestedInput=source.maxInputBytes,requestedOutput=source.maxOutputBytes,requestedWorking=source.maxWorkingBytes,requestedMetadata=source.maxMetadataBytes,requestedFrames=source.maxFrames,requestedChunks=source.maxChunks
  const input=requestedInput===undefined?64*1024*1024:requestedInput,output=requestedOutput===undefined?64*1024*1024:requestedOutput,working=requestedWorking===undefined?128*1024*1024:requestedWorking,metadata=requestedMetadata===undefined?16*1024*1024:requestedMetadata,frames=requestedFrames===undefined?256:requestedFrames,chunks=requestedChunks===undefined?16384:requestedChunks
  const bytes=storage(48),d=view(bytes)
  d.setUint32(0,48,true);d.setUint32(4,integer(frames,256),true);d.setUint32(8,integer(chunks,16384),true)
  for(const [at,value,max] of [[16,input,256*1024*1024],[24,output,256*1024*1024],[32,working,256*1024*1024],[40,metadata,16*1024*1024]])d.setBigUint64(at!,BigInt(integer(value,max!)),true)
  return {bytes,input:integer(input,256*1024*1024)}
}
const typed=Object.getPrototypeOf(Uint8Array.prototype),buffer=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!,offset=Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!,length=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!,ordinaryBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')!.get!
function inputView(source:Uint8Array,limit:number){
  if(!(source instanceof Uint8Array))throw new TypeError('encoded PNG must be Uint8Array')
  const backing=buffer.call(source)
  try{ordinaryBufferLength.call(backing)}catch{throw new TypeError('shared encoded PNG input is not immutable')}
  const bytes=new Uint8Array(backing,offset.call(source),length.call(source))
  if(!bytes.byteLength||bytes.byteLength>limit)throw new RangeError('encoded PNG input exceeds limit')
  return bytes
}
function copied(p:Pointer,kind:number,slot?:number){
  const size=new BigUint64Array(1)
  const copy=(data:Pointer|null,capacity:bigint)=>slot===undefined?n.zc_png_metadata_copy(p,kind,data,capacity,ptr(size)):n.zc_png_frame_copy(p,slot,data,capacity,ptr(size))
  check(copy(null,0n),'PNG copy size')
  if(size[0]>256n*1024n*1024n)throw new RangeError('PNG result exceeds limit')
  const bytes=storage(Number(size[0]));if(bytes.length)check(copy(ptr(bytes),BigInt(bytes.length)),'PNG copy')
  return bytes
}
function consume(p:Pointer){
  const owned:CapturedImage[]=[]
  try{
    const info=storage(96),d=view(info);check(n.zc_png_info_get(p,ptr(info)),'PNG info')
    const read=(slot:number)=>{
      const desc=storage(64),v=view(desc);check(n.zc_png_frame_get(p,slot,ptr(desc)),'PNG frame')
      const image=CapturedImage[pngImageAdmission](copied(p,0,slot),v.getUint32(4,true),v.getUint32(8,true),(['gray','rgb','rgba'] as const)[v.getUint32(12,true)] as RasterFormat,v.getUint32(16,true) as 8|16)
      owned.push(image)
      return {image,x:v.getUint32(20,true),y:v.getUint32(24,true),delay:Object.freeze({numerator:v.getUint32(28,true),denominator:v.getUint32(32,true)}),dispose:(['none','background','previous'] as const)[v.getUint32(36,true)]!,blend:(['source','over'] as const)[v.getUint32(40,true)]!}
    }
    const image=read(0).image,frames:DecodedPngFrame[]=[]
    for(let slot=1;slot<=d.getUint32(4,true);slot++)frames.push(Object.freeze(read(slot)))
    const flags=d.getUint32(32,true),metadata:PngDecodeMetadata={
      icc:flags&1?copied(p,1):undefined,exif:flags&2?copied(p,2):undefined,
      srgbIntent:flags&4?d.getUint32(36,true):undefined,gamma:flags&8?d.getUint32(40,true):undefined,
      chromaticities:flags&16?Object.freeze(Array.from({length:8},(_,i)=>d.getUint32(44+i*4,true))):undefined,
      cicp:flags&32?Object.freeze(Array.from({length:4},(_,i)=>d.getUint32(76+i*4,true))):undefined,
      palette:d.getUint32(28,true)?copied(p,3):undefined,
    }
    return new DecodedPng(image,Object.freeze(frames),!!d.getUint32(8,true),d.getUint32(12,true),d.getUint32(16,true),d.getUint32(20,true),!!d.getUint32(24,true),Object.freeze(metadata))
  }catch(error){for(const image of owned)image.close();throw error}
  finally{n.zc_png_close(p)}
}
/** Synchronous bounded Home PNG/APNG decoding; source bytes are never retained. */
export function decodePng(source:Uint8Array,options:PngDecodeLimits={}){
  const limits=prepare(options),bytes=inputView(source,limits.input),out=outPointer()
  check(n.zc_png_decode(ptr(bytes),BigInt(bytes.byteLength),ptr(limits.bytes),ptr(out)),'PNG decode')
  return consume(handle(out))
}
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,1))
async function run(bytes:Uint8Array,limits:ReturnType<typeof prepare>,current:BunJob<DecodedPng>,deadline:number){
  current.check()
  const out=outPointer();check(n.zc_png_decode_async(ptr(bytes),BigInt(bytes.byteLength),ptr(limits.bytes),ptr(out)),'PNG job admission')
  const p=handle(out),cancel=()=>{n.zc_png_job_cancel(p)}
  current.signal.addEventListener('abort',cancel,{once:true});if(current.cancelRequested)cancel()
  let finished=false,result:DecodedPng|undefined
  try{
    const state=storage(48),d=view(state)
    for(;;){check(n.zc_png_job_state_get(p,ptr(state)),'PNG job state');if(d.getUint32(8,true))break;await pause()}
    finished=true;if(performance.now()>=deadline&&!current.cancelRequested)current.cancel(new CameraError(-3,'PNG decode deadline'));current.check();check(d.getInt32(12,true),'PNG decoding')
    const output=outPointer();check(n.zc_png_job_take_image(p,ptr(output)),'PNG job result')
    result=consume(handle(output));current.seal();return result
  }catch(error){result?.close();throw error}
  finally{
    current.signal.removeEventListener('abort',cancel)
    if(!finished)n.zc_png_job_cancel(p)
    let code:number;while((code=n.zc_png_job_close(p))===-4)await pause()
    check(code,'PNG job close')
  }
}
/** Copies encoded input synchronously into a bounded native joined worker. */
export function decodePngAsync(source:Uint8Array,options:PngDecodeLimits&JobOptions<DecodedPng>={}){
  const limits=prepare(options),admitted=snapshotJobOptions(options,30000),bytes=inputView(source,limits.input)
  const deadline=Date.now()+(admitted.timeoutMs??Infinity)
  const job=new BunJob<DecodedPng>(current=>run(bytes,limits,current,deadline),()=>{},admitted)
  void job.start();return job
}
let fileReaders=0,fileBytes=0
/** Bounded Bun file read followed by a joined native decode. Concurrent reads
 * have a separate four-reader, 512 MiB encoded-input cap and no waiting queue. */
export function loadPngAsync(path:string,options:PngDecodeLimits&JobOptions<DecodedPng>={}){
  if(typeof path!=='string'||!path.length||path.includes('\0'))throw new TypeError('invalid PNG path')
  const limits=prepare(options),admitted=snapshotJobOptions(options,30000)
  const deadline=Date.now()+(admitted.timeoutMs??Infinity)
  const job=new BunJob<DecodedPng>(async current=>{
    current.check()
    const charge=limits.input+1
    if(fileReaders>=4||charge>512*1024*1024-fileBytes)throw new CameraError(-4,'PNG file read admission')
    fileReaders++;fileBytes+=charge
    try{
      // Bound the actual read as well as its result, including growth after stat.
      const bytes=new Uint8Array(await Bun.file(path).slice(0,charge).arrayBuffer())
      current.check();inputView(bytes,limits.input)
      return await run(bytes,limits,current,deadline)
    }finally{fileReaders--;fileBytes-=charge}
  },()=>{},admitted)
  void job.start();return job
}
