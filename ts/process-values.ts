import { serialize, deserialize } from 'bun:jsc'
/** Bounded clone input for cooperating process handlers. Plain graphs, cycles,
 * arrays, dates, maps, sets, ArrayBuffers and numeric views are supported.
 * Functions, symbols, custom instances and shared memory are rejected. */
export type ProcessValue = unknown
const typed = Object.getPrototypeOf(Uint8Array.prototype)
const get = (prototype: object, key: PropertyKey) => Object.getOwnPropertyDescriptor(prototype,key)!.get!
const arrayBytes = get(ArrayBuffer.prototype,'byteLength')
const typedBuffer = get(typed,'buffer'), typedOffset = get(typed,'byteOffset'), typedLength = get(typed,'length')
const typedName = get(typed,Symbol.toStringTag)
const dataBuffer = get(DataView.prototype,'buffer'), dataOffset = get(DataView.prototype,'byteOffset'), dataLength = get(DataView.prototype,'byteLength')
const constructors = new Map<string, any>(['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','BigInt64Array','BigUint64Array','Float16Array','Float32Array','Float64Array'].map(name=>[name,(globalThis as any)[name]]))
const bigintLimit = 1n << 4096n
export function encodeProcessValue(value: unknown, maximum: number): Uint8Array {
  if (!Number.isSafeInteger(maximum) || maximum < 64 || maximum > 256*1024*1024) throw new RangeError('invalid process value limit')
  let used=0, nodes=0
  const seen=new Map<object,any>()
  const charge=(n:number)=>{if(n>maximum-used)throw new RangeError('process value exceeds byte budget');used+=n}
  const copy=(value:unknown,depth=0):any=>{
    if(depth>64 || ++nodes>4096)throw new RangeError('process value exceeds graph bounds')
    charge(16)
    if(value===null || value===undefined || typeof value==='boolean' || typeof value==='number')return value
    if(typeof value==='string'){charge(value.length*4);return value}
    if(typeof value==='bigint'){
      if(value>=bigintLimit || value<=-bigintLimit)throw new RangeError('process bigint exceeds 4096 bits')
      charge(value.toString().length*4);return value
    }
    if(typeof value!=='object')throw new TypeError('unsupported process value')
    if(seen.has(value))return seen.get(value)
    charge(128)
    if(value instanceof ArrayBuffer){
      const size=arrayBytes.call(value);charge(size)
      const result=ArrayBuffer.prototype.slice.call(value,0)
      seen.set(value,result);return result
    }
    if(typeof SharedArrayBuffer!=='undefined' && value instanceof SharedArrayBuffer)throw new TypeError('shared process memory is unsupported')
    if(ArrayBuffer.isView(value)){
      let buffer:ArrayBuffer,offset:number,length:number,result:any
      if(value instanceof DataView){
        buffer=dataBuffer.call(value);offset=dataOffset.call(value);length=dataLength.call(value)
        result=new DataView(copy(buffer,depth+1),offset,length)
      }else{
        buffer=typedBuffer.call(value);offset=typedOffset.call(value);length=typedLength.call(value)
        const name=typedName.call(value),ctor=constructors.get(name)
        if(!ctor)throw new TypeError('unsupported numeric process view')
        const cloned=copy(buffer,depth+1)
        result=Buffer.isBuffer(value)?Buffer.from(cloned,offset,length):new ctor(cloned,offset,length)
      }
      seen.set(value,result);return result
    }
    if(value instanceof Date){const result=new Date(Date.prototype.getTime.call(value));seen.set(value,result);return result}
    if(value instanceof Map){
      if(get(Map.prototype,'size').call(value)>4096)throw new RangeError('process map exceeds graph bounds')
      const result=new Map();seen.set(value,result)
      for(const [k,v] of Map.prototype.entries.call(value))result.set(copy(k,depth+1),copy(v,depth+1))
      return result
    }
    if(value instanceof Set){
      if(get(Set.prototype,'size').call(value)>4096)throw new RangeError('process set exceeds graph bounds')
      const result=new Set();seen.set(value,result)
      for(const item of Set.prototype.values.call(value))result.add(copy(item,depth+1))
      return result
    }
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value)
    if(!array && prototype!==null && prototype!==Object.prototype)throw new TypeError('custom process instances are unsupported; return owned data')
    if(array && value.length>4096)throw new RangeError('process array exceeds graph bounds')
    const keys=Object.keys(value)
    if(keys.length>4096)throw new RangeError('process object exceeds graph bounds')
    const result=array?new Array((value as unknown[]).length):Object.create(null)
    seen.set(value,result)
    for(const key of keys){charge(key.length*4+32);Object.defineProperty(result,key,{value:copy(Reflect.get(value,key),depth+1),enumerable:true,writable:true,configurable:true})}
    return result
  }
  const bytes=serialize(copy(value),{binaryType:'nodebuffer'})
  if(bytes.byteLength>maximum)throw new RangeError('serialized process value exceeds byte budget')
  // Only these serialized bytes enter IPC, never an unrelated pooled backing
  // buffer. The additional owned copy is bounded by the accepted byte limit.
  return Uint8Array.from(bytes)
}
export function decodeProcessValue(bytes: Uint8Array, maximum: number): unknown {
  if(!(bytes instanceof Uint8Array) || bytes.byteLength>maximum)throw new RangeError('invalid process value bytes')
  return deserialize(bytes)
}
export function processErrorSummary(error:unknown) {
  let name='Error',message='remote operation failed',stack:string|undefined
  try {
    if(error instanceof Error){name=String(error.name).slice(0,128);message=String(error.message).slice(0,4096);stack=error.stack?.slice(0,8192)}
    else message=String(error).slice(0,4096)
  }catch{}
  return {name,message,stack}
}
