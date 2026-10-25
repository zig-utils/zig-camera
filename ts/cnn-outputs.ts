import {native as n,ptr,storage,view,check,outPointer,handle,type Pointer} from './ffi'
import type {decodeMetadata} from './metadata'
export type CnnStorageOrder = 'column-major' | 'row-major'
export interface CnnOutputOptions {
  /** Physical storage order of each owned tensor; defaults to column-major. */
  order?: CnnStorageOrder
  /** Add a logical leading singleton batch axis, without copying values. */
  addBatch?: boolean
  /** Float payload ceiling, 4..64 MiB and a multiple of four; default 16 MiB. */
  maxOutputBytes?: number
}
type Capture = ReturnType<typeof decodeMetadata>
const admission = Symbol('native CNN outputs')
const descriptorSize = 3424, tensorSize = 208, tensorOffset = 96
const typed = Object.getPrototypeOf(Uint8Array.prototype)
const bufferGet = Object.getOwnPropertyDescriptor(typed,'buffer')!.get!
const offsetGet = Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!
const bytesGet = Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!
const nativeBigEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 0
const decoder = new TextDecoder('utf-8',{fatal:true})
function bytes(data: Uint8Array | Float32Array) {
  const buffer = bufferGet.call(data) as ArrayBuffer
  if (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer)
    throw new TypeError('CNN inputs must not use shared memory')
  return new Uint8Array(buffer,offsetGet.call(data),bytesGet.call(data))
}
/** @internal Resolve options before deriving any native pointer or owner. */
export function prepareCnnOptions(options: CnnOutputOptions) {
  if (!options || typeof options!=='object' || Array.isArray(options)) throw new TypeError('invalid CNN options')
  const order=options.order??'column-major',addBatch=options.addBatch??false,maxOutputBytes=options.maxOutputBytes??16*1024*1024
  if(order!=='column-major'&&order!=='row-major')throw new RangeError('invalid CNN storage order')
  if(typeof addBatch!=='boolean')throw new TypeError('invalid CNN batch option')
  if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<4||maxOutputBytes>64*1024*1024||maxOutputBytes%4!==0)throw new RangeError('invalid CNN output ceiling')
  return {order,code:order==='column-major'?0:1,addBatch,maxOutputBytes}
}
export class CnnTensor {
  readonly shape: readonly number[]
  /** Strides in float elements; an added singleton batch axis has stride zero. */
  readonly strides: readonly number[]
  private readonly owned: Float32Array
  private readonly descriptor: Uint8Array
  constructor(token:symbol,descriptor:Uint8Array,values:Float32Array,readonly order:CnnStorageOrder,addBatch:boolean){
    if(token!==admission)throw new TypeError('use CNN decoding or Frame.cnnOutputs')
    this.descriptor=descriptor
    const d=view(descriptor),count=d.getUint32(0,true),rank=d.getUint32(4,true),offset=Number(d.getBigUint64(8,true))
    if(rank>16||!Number.isSafeInteger(offset)||offset>values.length||count>values.length-offset)throw Error('invalid native CNN tensor')
    const shape=Array.from({length:rank},(_,i)=>d.getUint32(16+i*4,true)),strides=Array.from({length:rank},(_,i)=>Number(d.getBigUint64(80+i*8,true)))
    if(strides.some(s=>!Number.isSafeInteger(s)||s<0||s>count))throw Error('invalid native CNN strides')
    this.shape=Object.freeze(addBatch?[1,...shape]:shape)
    this.strides=Object.freeze(addBatch?[0,...strides]:strides)
    this.owned=values.subarray(offset,offset+count)
  }
  get data(){return this.owned}
  /** Row/column meaning follows shape and strides, independent of batch views. */
  get(...coordinates:number[]){
    if(coordinates.length!==this.shape.length)throw new RangeError('CNN coordinate rank')
    if(bytes(this.owned).byteLength!==view(this.descriptor).getUint32(0,true)*4)throw new TypeError('CNN data was detached')
    let offset=0
    for(let i=0;i<coordinates.length;i++){
      const value=coordinates[i]
      if(!Number.isSafeInteger(value)||value<0||value>=this.shape[i])throw new RangeError('CNN coordinate bounds')
      offset+=value*this.strides[i]
    }
    return this.owned[offset]
  }
  toRowMajor():Float32Array{
    const source=bytes(this.owned),count=view(this.descriptor).getUint32(0,true)
    if(source.byteLength!==count*4)throw new TypeError('CNN data was detached')
    const result=new Float32Array(count)
    check(n.zc_cnn_tensor_row_major(ptr(this.descriptor),this.order==='column-major'?0:1,count?ptr(source):null,BigInt(count),count?ptr(result):null,BigInt(count)),'copy row-major CNN tensor')
    return result
  }
}
export class CnnOutputs {
  readonly networkName: string
  readonly frameCount: number
  readonly tensors: readonly CnnTensor[]
  readonly capture?: Readonly<Omit<Capture,'crop'>> & {readonly crop:Readonly<Capture['crop']>}
  constructor(token:symbol,header:Uint8Array,values:Float32Array,settings:ReturnType<typeof prepareCnnOptions>,capture?:Capture){
    if(token!==admission)throw new TypeError('use CNN decoding or Frame.cnnOutputs')
    const d=view(header),count=d.getUint32(8,true),nameLength=d.getUint32(16,true)
    if(d.getUint32(0,true)!==descriptorSize||d.getUint32(4,true)!==1||count>16||nameLength>64||d.getUint32(20,true)!==settings.code||d.getBigUint64(24,true)!==BigInt(values.length))throw Error('invalid native CNN outputs')
    this.networkName=decoder.decode(header.subarray(32,32+nameLength))
    this.frameCount=d.getUint32(12,true)
    this.tensors=Object.freeze(Array.from({length:count},(_,i)=>new CnnTensor(admission,header.slice(tensorOffset+i*tensorSize,tensorOffset+(i+1)*tensorSize),values,settings.order,settings.addBatch)))
    if(capture)this.capture=Object.freeze({...capture,crop:Object.freeze({...capture.crop})})
  }
}
function copied(call:(header:Uint8Array,output?:Float32Array)=>number,settings:ReturnType<typeof prepareCnnOptions>,capture?:Capture):CnnOutputs|null{
  const header=storage(descriptorSize)
  check(call(header),'query CNN outputs')
  const d=view(header),present=d.getUint32(4,true),count=d.getBigUint64(24,true)
  if(d.getUint32(0,true)!==descriptorSize||present>1||count>BigInt(settings.maxOutputBytes/4))throw Error('invalid native CNN output size')
  if(!present)return null
  const values=new Float32Array(Number(count))
  if(count)check(call(header,values),'copy CNN outputs')
  return new CnnOutputs(admission,header,values,settings,capture)
}
/** Decode exported little-endian tensor info and native float32 storage without
 * JavaScript number-list conversion. The returned compact allocation is owned. */
export function decodeCnnOutputs(info:Uint8Array,values:Float32Array,options:CnnOutputOptions={}):CnnOutputs{
  const settings=prepareCnnOptions(options)
  if(!(info instanceof Uint8Array)||!(values instanceof Float32Array))throw new TypeError('CNN info and values require Uint8Array and Float32Array')
  const descriptor=bytes(info),data=bytes(values)
  if(data.byteLength>settings.maxOutputBytes)throw new RangeError('CNN values exceed output ceiling')
  return copied((header,output)=>n.zc_decode_cnn_outputs(descriptor.byteLength?ptr(descriptor):null,BigInt(descriptor.byteLength),data.byteLength?ptr(data):null,BigInt(data.byteLength),nativeBigEndian?1:0,settings.code,BigInt(settings.maxOutputBytes),ptr(header),output?.length?ptr(output):null,BigInt(output?.length??0)),settings)!
}
/** @internal Native selection skips unrelated payloads and never decodes an
 * entire catalog into JS number arrays. Snapshot retirement always joins copy. */
export function copyFrameCnnOutputs(camera:Pointer,token:bigint,settings:ReturnType<typeof prepareCnnOptions>,capture:Capture):CnnOutputs|null{
  const out=outPointer()
  check(n.zc_frame_cnn_catalog(camera,token,BigInt(settings.maxOutputBytes),ptr(out)),'snapshot CNN metadata')
  const catalog=handle(out)
  try{return copied((header,output)=>n.zc_cnn_catalog_outputs(catalog,settings.code,BigInt(settings.maxOutputBytes),ptr(header),output?.length?ptr(output):null,BigInt(output?.length??0)),settings,capture)}
  finally{n.zc_catalog_close(catalog)}
}
