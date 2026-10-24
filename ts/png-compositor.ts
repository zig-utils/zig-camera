import {native as n,ptr,storage,outPointer,handle,check,CameraError,type Pointer} from './ffi'
import {CapturedImage,decodedImageAdmission,apngCompositeInto} from './image-object'
import type {DecodedPngFrame} from './png-decode'
export interface PngCompositeOptions {
  /** Two native RGBA canvases, independent of decoded input and yielded copies.
   * Defaults to 128 MiB. Hard maximum 256 MiB; no allocation while pushing. */
  maxWorkingBytes?:number
}
export interface CompositedPngFrame {
  readonly image:CapturedImage
  readonly index:number
  /** PNG's raw denominator is retained; zero means 100 for scheduling. */
  readonly delay:Readonly<{numerator:number;denominator:number}>
}
type InputFrame={readonly image:CapturedImage;readonly x:number;readonly y:number;readonly dispose:number;readonly blend:number;readonly delay:Readonly<{numerator:number;denominator:number}>}
function integer(value:unknown,min:number,max:number){
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('invalid APNG frame geometry or control')
  return value
}
/** Sequential, synchronous Home compositor. Keep decoded rectangle images open
 * while iterating. Each yielded canvas is independently owned by the caller.
 * Exhaustion, iterator.return()/for-of break, errors and close retire native
 * ownership. Use `using` if calling next manually or abandoning iteration. */
export class PngCompositor implements IterableIterator<CompositedPngFrame>,Disposable {
  private pointer?:Pointer
  private index=0
  private ended=false
  private readonly frames:readonly InputFrame[]
  /** @internal Use DecodedPng.compositor(). An excluded poster is never fed. */
  constructor(private readonly width:number,private readonly height:number,private readonly bits:8|16,frames:readonly DecodedPngFrame[],options:PngCompositeOptions={}) {
    integer(width,1,0x7fffffff);integer(height,1,0x7fffffff)
    if(bits!==8&&bits!==16)throw new RangeError('invalid APNG canvas depth')
    if(!options||typeof options!=='object')throw new TypeError('invalid APNG compositor options')
    const requested=options.maxWorkingBytes,maximum=requested===undefined?128*1024*1024:requested
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>256*1024*1024)throw new RangeError('invalid APNG compositor working limit')
    if(!Array.isArray(frames)||frames.length>256)throw new RangeError('invalid APNG frame list')
    this.frames=frames.map(frame=>{
      const image=frame.image,x=frame.x,y=frame.y,dispose=frame.dispose,blend=frame.blend,delay=frame.delay
      if(!(image instanceof CapturedImage))throw new TypeError('invalid APNG frame image')
      const disposeCode=(['none','background','previous'] as const).indexOf(dispose),blendCode=(['source','over'] as const).indexOf(blend)
      integer(disposeCode,0,2);integer(blendCode,0,1)
      return Object.freeze({image,x:integer(x,0,0xffffffff),y:integer(y,0,0xffffffff),dispose:disposeCode,blend:blendCode,delay:Object.freeze({numerator:integer(delay.numerator,0,65535),denominator:integer(delay.denominator,0,65535)})})
    })
    const out=outPointer()
    check(n.zc_apng_compositor_open(width,height,bits,BigInt(maximum),ptr(out)),'APNG compositor admission')
    this.pointer=handle(out)
  }
  next():IteratorResult<CompositedPngFrame> {
    if(this.ended)return {done:true,value:undefined}
    if(!this.pointer)throw new CameraError(-5,'closed APNG compositor')
    try{
      const frame=this.frames[this.index]
      if(!frame){this.ended=true;this.close();return {done:true,value:undefined}}
      const bytes=storage(this.width*this.height*4*(this.bits/8)),length=new BigUint64Array(1)
      frame.image[apngCompositeInto](this.pointer,frame.x,frame.y,frame.dispose,frame.blend)
      check(n.zc_apng_compositor_copy(this.pointer,ptr(bytes),BigInt(bytes.length),ptr(length)),'APNG display copy')
      const image=CapturedImage[decodedImageAdmission](bytes,this.width,this.height,'rgba',this.bits)
      const value=Object.freeze({image,index:this.index++,delay:frame.delay})
      return {done:false,value}
    }catch(error){this.close();throw error}
  }
  return():IteratorResult<CompositedPngFrame>{this.ended=true;this.close();return {done:true,value:undefined}}
  [Symbol.iterator](){return this}
  get closed(){return !this.pointer}
  close(){if(this.pointer){n.zc_apng_compositor_close(this.pointer);this.pointer=undefined}}
  [Symbol.dispose](){this.close()}
}
