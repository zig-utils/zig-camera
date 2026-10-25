import {native as n,ptr,storage,view,check} from './ffi'
import type {Rectangle,Size,TypedCatalog} from './catalog'
import type {FrameConfiguration} from './request-configuration'
import type {decodeMetadata} from './metadata'
export interface InferenceGeometry {
  fullSensor:Size
  sensorOutput:Size
  output:Size
  scalerCrop:Rectangle
  roi?:Rectangle
}
export interface FrameInferenceOptions {
  stream?:'main'|'lores'
  /** Full pixel-array size; otherwise read the request's camera properties. */
  fullSensor?:Size
  /** Previously applied inference ROI in full-sensor pixels; does not set it. */
  roi?:Rectangle
}
type Capture=ReturnType<typeof decodeMetadata>
function object(value:unknown):asserts value is object{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('invalid inference geometry')
}
function integer(value:number,min:number,max:number){
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('invalid inference geometry value')
  return value
}
function size(value:Size,max=0x7fffffff):Size{
  object(value);const width=value.width,height=value.height
  return Object.freeze({width:integer(width,1,max),height:integer(height,1,max)})
}
function rectangle(value:Rectangle):Rectangle{
  object(value);const x=value.x,y=value.y,width=value.width,height=value.height
  return Object.freeze({x:integer(x,-0x80000000,0x7fffffff),y:integer(y,-0x80000000,0x7fffffff),width:integer(width,0,0xffffffff),height:integer(height,0,0xffffffff)})
}
function putRect(bytes:Uint8Array,at:number,r:Rectangle){const d=view(bytes);d.setInt32(at,r.x,true);d.setInt32(at+4,r.y,true);d.setUint32(at+8,r.width,true);d.setUint32(at+12,r.height,true)}
function rectBytes(r:Rectangle){const bytes=storage(16);putRect(bytes,0,r);return bytes}
function readRect(bytes:Uint8Array):Rectangle{const d=view(bytes);return Object.freeze({x:d.getInt32(0,true),y:d.getInt32(4,true),width:d.getUint32(8,true),height:d.getUint32(12,true)})}
export function inferenceAspectCrop(fullSensor:Size,aspect:Size):Rectangle{
  const f=size(fullSensor),a=size(aspect,0xffffffff),full=new Uint32Array([f.width,f.height]),ratio=new Uint32Array([a.width,a.height]),out=storage(16)
  check(n.zc_inference_aspect(ptr(full),ptr(ratio),ptr(out)),'center inference aspect crop')
  return readRect(out)
}
/** Owned coordinate plan; no request, camera or native handle is retained. */
export class InferenceProjection {
  readonly fullSensor:Size
  readonly sensorOutput:Size
  readonly output:Size
  readonly scalerCrop:Rectangle
  readonly roi?:Rectangle
  readonly capture?:Readonly<Omit<Capture,'crop'>>&{readonly crop:Readonly<Capture['crop']>}
  private readonly geometry:Uint8Array
  constructor(options:InferenceGeometry,capture?:Capture){
    object(options)
    // Resolve every caller accessor before deriving native pointers.
    const full=options.fullSensor,raw=options.sensorOutput,output=options.output,crop=options.scalerCrop,roi=options.roi
    this.fullSensor=size(full);this.sensorOutput=size(raw);this.output=size(output);this.scalerCrop=rectangle(crop);this.roi=roi===undefined?undefined:rectangle(roi)
    if(capture)this.capture=Object.freeze({...capture,crop:Object.freeze({...capture.crop})})
    const bytes=storage(64),d=view(bytes);d.setUint32(0,64,true);d.setUint32(4,this.roi?1:0,true)
    for(const [i,s] of [this.fullSensor,this.sensorOutput,this.output].entries()){d.setUint32(8+i*8,s.width,true);d.setUint32(12+i*8,s.height,true)}
    putRect(bytes,32,this.scalerCrop);if(this.roi)putRect(bytes,48,this.roi)
    const out=storage(16);check(n.zc_inference_roi(ptr(bytes),ptr(out)),'validate inference projection');this.geometry=bytes
  }
  project(object:Rectangle):Rectangle{
    const r=rectBytes(rectangle(object)),out=storage(16)
    check(n.zc_inference_project(ptr(this.geometry),ptr(r),ptr(out)),'project inference rectangle');return readRect(out)
  }
  convert(coords:readonly number[]|Float32Array|Float64Array):Rectangle{
    if(!Array.isArray(coords)&&!(coords instanceof Float32Array)&&!(coords instanceof Float64Array))throw new TypeError('inference coordinates require four numbers')
    const count=coords.length,values=[coords[0],coords[1],coords[2],coords[3]]
    if(count!==4||values.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new RangeError('invalid inference coordinates')
    const input=new Float64Array(values),out=storage(16)
    check(n.zc_inference_convert(ptr(this.geometry),ptr(input),ptr(out)),'convert inference coordinates');return readRect(out)
  }
  roiScaled():Rectangle{const out=storage(16);check(n.zc_inference_roi(ptr(this.geometry),ptr(out)),'project inference ROI');return readRect(out)}
}
/** @internal Snapshot user options before consulting the retained request. */
export function prepareFrameInference(options:FrameInferenceOptions){
  object(options);const stream=options.stream??'main',full=options.fullSensor,roi=options.roi
  if(stream!=='main'&&stream!=='lores')throw new RangeError('invalid inference output stream')
  return {stream,fullSensor:full===undefined?undefined:size(full),roi:roi===undefined?undefined:rectangle(roi)}
}
function pixelArray(properties:TypedCatalog):Size{
  if(properties.kind!=='properties')throw Error('invalid inference properties')
  const records=properties.records.filter(r=>r.group===0&&r.name==='PixelArraySize'&&['libcamera','synthetic','',undefined].includes(r.vendor))
  if(records.length!==1)throw Error('missing or ambiguous pixel array size')
  const record=records[0],values=record.values.filter(v=>v.role==='current')
  if(record.input===true||record.kind!=='size'||record.isArray===true||values.length!==1)throw Error('invalid pixel array size')
  const value=values[0]
  if(value.kind!=='size'||value.isArray||value.count!==1||value.bytes.length!==8)throw Error('invalid pixel array size')
  const d=new DataView(value.bytes.buffer,value.bytes.byteOffset,value.bytes.byteLength)
  return size({width:d.getUint32(0,value.littleEndian),height:d.getUint32(4,value.littleEndian)})
}
/** @internal Uses only copied request configuration/properties and metadata. */
export function frameInference(configuration:FrameConfiguration,capture:Capture,properties:TypedCatalog|undefined,settings:ReturnType<typeof prepareFrameInference>){
  if(!(capture.validMask&8))throw Error('request has no applied ScalerCrop metadata')
  const raw=configuration.streams.raw,out=configuration.streams[settings.stream]
  if(!raw||!out)throw Error('inference projection requires raw and selected output streams')
  const full=settings.fullSensor??pixelArray(properties!)
  return new InferenceProjection({fullSensor:full,sensorOutput:raw,output:out,scalerCrop:capture.crop,roi:settings.roi},capture)
}
