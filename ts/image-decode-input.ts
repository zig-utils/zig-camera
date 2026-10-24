import{CameraError}from'./ffi'
const typed=Object.getPrototypeOf(Uint8Array.prototype),buffer=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!,offset=Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!,length=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!,ordinaryBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')!.get!
/** @internal Encoded input must stay immutable during synchronous native admission. */
export function encodedImageInput(source:Uint8Array,limit:number,label:string){
 if(!(source instanceof Uint8Array))throw new TypeError(`encoded ${label} must be Uint8Array`)
 const backing=buffer.call(source)
 try{ordinaryBufferLength.call(backing)}catch{throw new TypeError(`shared encoded ${label} input is not immutable`)}
 const bytes=new Uint8Array(backing,offset.call(source),length.call(source))
 if(!bytes.byteLength||bytes.byteLength>limit)throw new RangeError(`encoded ${label} input exceeds limit`)
 return bytes
}
export function imageDecodePath(path:string,label:string){if(typeof path!=='string'||!path.length||path.includes('\0'))throw new TypeError(`invalid ${label} path`)}
let readers=0,bytes=0
/** @internal One shared JPEG/PNG reader budget, held through native decode/join. */
export async function withEncodedImageFile<T>(path:string,limit:number,label:string,current:{check():void},operation:(input:Uint8Array)=>Promise<T>){
 current.check();const charge=limit+1
 if(readers>=4||charge>512*1024*1024-bytes)throw new CameraError(-4,`${label} file read admission`)
 readers++;bytes+=charge
 try{
  const input=new Uint8Array(await Bun.file(path).slice(0,charge).arrayBuffer())
  current.check();encodedImageInput(input,limit,label)
  return await operation(input)
 }finally{readers--;bytes-=charge}
}
