import {native as n,ptr,storage,view,check,type Pointer} from './ffi'
export interface CnnKpiInfo {
  readonly dnnRaw:number
  readonly dspRaw:number
  /** The pinned Picamera2 /1000 view; raw counters remain authoritative. */
  readonly picameraMilliseconds:Readonly<{dnn:number;dsp:number}>
}
function decoded(bytes:Uint8Array):CnnKpiInfo|null{
  const d=view(bytes),present=d.getUint32(4,true)
  if(d.getUint32(0,true)!==32||present>1)throw Error('invalid native CNN KPI')
  if(!present)return null
  const dnnRaw=d.getInt32(8,true),dspRaw=d.getInt32(12,true),dnn=d.getFloat64(16,true),dsp=d.getFloat64(24,true)
  if(dnn!==dnnRaw/1000||dsp!==dspRaw/1000)throw Error('invalid native CNN KPI conversion')
  return Object.freeze({dnnRaw,dspRaw,picameraMilliseconds:Object.freeze({dnn,dsp})})
}
export function decodeCnnKpi(bytes:Uint8Array,endian:'little'|'big'='little'):CnnKpiInfo{
  if(endian!=='little'&&endian!=='big')throw new RangeError('invalid CNN KPI byte order')
  if(!(bytes instanceof Uint8Array))throw new TypeError('CNN KPI requires bytes')
  // Copy the fixed eight bytes before deriving native pointers. A proxy,
  // detached or shared view must not become an unchecked native span.
  const typed=Object.getPrototypeOf(Uint8Array.prototype)
  const buffer=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!.call(bytes) as ArrayBuffer
  const offset=Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!.call(bytes) as number
  const length=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!.call(bytes) as number
  if(buffer instanceof SharedArrayBuffer||length!==8)throw new TypeError('invalid CNN KPI span')
  const input=new Uint8Array(buffer,offset,length).slice(),out=storage(32)
  check(n.zc_decode_cnn_kpi(ptr(input),8n,endian==='big'?1:0,ptr(out)),'decode CNN KPI');return decoded(out)!
}
/** @internal Fixed-size native selection skips tensor payloads entirely. */
export function frameCnnKpi(camera:Pointer,token:bigint):CnnKpiInfo|null{
  const out=storage(32);check(n.zc_frame_cnn_kpi(camera,token,ptr(out)),'read request CNN KPI');return decoded(out)
}
