import {native as n,ptr,storage,view,check,outPointer,handle,CameraError,type Pointer} from './ffi'
import type {Rectangle,Size} from './catalog'
export interface Imx500Options {backend?:'libcamera'|'synthetic';index?:number;cameraId?:string}
export interface Imx500State {
  readonly backend:'libcamera'|'synthetic'
  readonly revision?:bigint
  readonly systemErrno:number
  readonly writeAttempted:boolean
  readonly writeSucceeded:boolean
  readonly changed?:boolean
  readonly control?:Readonly<{flags:number;minimum:number;maximum:number;step:number;defaultValue:number}>
  readonly previousRaw?:readonly number[]
  readonly currentRaw?:readonly number[]
  readonly savedRaw?:readonly number[]
  readonly previousRoi?:Rectangle
  readonly currentRoi?:Rectangle
  readonly savedRoi?:Rectangle
}
function decode(bytes:Uint8Array):Readonly<Imx500State>{
  const d=view(bytes),backend=d.getUint32(4,true),flags=d.getUint32(8,true)
  if(d.getUint32(0,true)!==160||backend>1||flags&~4095||!!(flags&64)!==!backend||(flags&16&&!(flags&8))||(flags&32&&(flags&3)!==3))throw Error('invalid IMX500 state')
  for(const [raw,effective]of [[1,256],[2,512],[4,1024]])if(flags&effective&&!(flags&raw))throw Error('invalid IMX500 ROI flags')
  const raw=(flag:number,at:number)=>flags&flag?Object.freeze(Array.from({length:4},(_,i)=>d.getUint32(at+i*4,true))):undefined
  const roi=(flag:number,at:number):Rectangle|undefined=>flags&flag?Object.freeze({x:d.getInt32(at,true),y:d.getInt32(at+4,true),width:d.getInt32(at+8,true),height:d.getInt32(at+12,true)}):undefined
  let control:Imx500State['control']
  if(flags&128){if(d.getUint32(24,true)!==40)throw Error('invalid IMX500 control info');const minimum=Number(d.getBigInt64(32,true)),maximum=Number(d.getBigInt64(40,true)),step=Number(d.getBigUint64(48,true)),defaultValue=Number(d.getBigInt64(56,true));if(minimum<0||maximum>0xffffffff||maximum<minimum||!Number.isSafeInteger(step)||step<1||step>0xffffffff||defaultValue<minimum||defaultValue>maximum)throw Error('invalid IMX500 control bounds');control=Object.freeze({flags:d.getUint32(28,true),minimum,maximum,step,defaultValue})}
  return Object.freeze({backend:backend?'libcamera':'synthetic',revision:flags&2048?d.getBigUint64(16,true):undefined,systemErrno:d.getInt32(12,true),writeAttempted:!!(flags&8),writeSucceeded:!!(flags&16),changed:(flags&3)===3?!!(flags&32):undefined,control,previousRaw:raw(1,64),currentRaw:raw(2,80),savedRaw:raw(4,96),previousRoi:roi(256,112),currentRoi:roi(512,128),savedRoi:roi(1024,144)})
}
export class Imx500Error extends CameraError {
  constructor(code:number,operation:string,readonly state:Readonly<Imx500State>){super(code,operation);this.name='Imx500Error'}
}
export class Imx500ConstructionError extends Error {
  constructor(cause:unknown,readonly cleanupCode:number,readonly cleanupOwner:Pick<IMX500,'close'>){super('IMX500 construction failed; descriptor cleanup requires retry',{cause});this.name='Imx500ConstructionError'}
}
function integer(value:number,min:number,max:number){if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('invalid IMX500 geometry');return value}
/** Pinned control descriptor. Cached ROI survives stream restarts through the
 * kernel's handler setup. No network, camera manager or frame owner is retained. */
export class IMX500 implements Disposable {
  private owned?:Pointer
  readonly backend:'libcamera'|'synthetic'
  readonly cameraId:string
  constructor(options:Imx500Options={}){
    if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('invalid IMX500 options')
    const backend=options.backend??'libcamera',index=options.index,id=options.cameraId
    if(backend!=='libcamera'&&backend!=='synthetic')throw new RangeError('invalid IMX500 backend')
    if(index!==undefined)integer(index,0,0xfffffffe)
    if(id!==undefined&&(typeof id!=='string'||!id.length||!id.isWellFormed()||id.includes('\0')||Buffer.byteLength(id)>4096))throw new TypeError('invalid IMX500 camera ID')
    if(id!==undefined&&index!==undefined)throw new RangeError('IMX500 camera ID and index are mutually exclusive')
    this.backend=backend
    const bytes=id===undefined?undefined:new TextEncoder().encode(id),out=outPointer()
    check(n.zc_imx500_open(backend==='synthetic'?0:1,index??0xffffffff,bytes?ptr(bytes):null,bytes?.length??0,ptr(out)),'open IMX500')
    this.owned=handle(out)
    try{
      const size=new BigUint64Array(1);check(n.zc_imx500_camera_id(this.owned,null,0n,ptr(size)),'query IMX500 camera identity')
      if(size[0]<1n||size[0]>4096n)throw Error('invalid IMX500 identity size')
      const value=storage(Number(size[0])),expected=size[0]
      check(n.zc_imx500_camera_id(this.owned,ptr(value),expected,ptr(size)),'copy IMX500 camera identity')
      if(size[0]!==expected)throw Error('changed IMX500 camera identity size')
      this.cameraId=new TextDecoder('utf-8',{fatal:true}).decode(value)
    }catch(error){const code=n.zc_imx500_close(this.owned);if(code!==0)throw new Imx500ConstructionError(error,code,this);this.owned=undefined;throw error}
  }
  private open(){if(!this.owned)throw new CameraError(-5,'closed IMX500');return this.owned}
  private outcome(code:number,bytes:Uint8Array,operation:string){const state=decode(bytes);if(code!==0)throw new Imx500Error(code,operation,state);return state}
  get closed(){return !this.owned}
  getInferenceRoi(){const out=storage(160),code=n.zc_imx500_get_roi(this.open(),ptr(out));return this.outcome(code,out,'read IMX500 cached ROI')}
  setInferenceRoiAbs(source:Rectangle){
    if(!source||typeof source!=='object')throw new TypeError('invalid IMX500 ROI')
    const x=source.x,y=source.y,width=source.width,height=source.height
    integer(x,-0x80000000,0x7fffffff);integer(y,-0x80000000,0x7fffffff);integer(width,0,0xffffffff);integer(height,0,0xffffffff)
    const out=storage(160),code=n.zc_imx500_set_roi(this.open(),x,y,width,height,ptr(out));return this.outcome(code,out,'set IMX500 inference ROI')
  }
  setInferenceAspectRatio(source:Size){
    if(!source||typeof source!=='object')throw new TypeError('invalid IMX500 aspect ratio')
    const width=source.width,height=source.height;integer(width,1,0xffffffff);integer(height,1,0xffffffff)
    const out=storage(160),code=n.zc_imx500_set_aspect(this.open(),width,height,ptr(out));return this.outcome(code,out,'set IMX500 inference aspect ratio')
  }
  /** Explicit one-write reapplication of the last saved value, never a retry. */
  restoreInferenceRoi(){const out=storage(160),code=n.zc_imx500_restore_roi(this.open(),ptr(out));return this.outcome(code,out,'restore IMX500 inference ROI')}
  getDeviceId(){const words=new Uint32Array(4);check(n.zc_imx500_device_id(this.open(),ptr(words)),'read IMX500 device ID');return Array.from(words,word=>word.toString(16).toUpperCase().padStart(8,'0')).join('')}
  close(){if(!this.owned)return;check(n.zc_imx500_close(this.owned),'close IMX500');this.owned=undefined}
  [Symbol.dispose](){this.close()}
}
