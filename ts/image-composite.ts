import {storage,view} from './ffi'
import type {RasterEndian} from './image-object'
export interface ImageCompositeOptions {
  x?:number
  y?:number
  blend?:'over'|'source'
  /** 0..1, rounded to an exact 16-bit coverage multiplier. Default 1. */
  opacity?:number
  /** Defaults to the greater input precision; 16->8 explicitly keeps high bytes. */
  bits?:8|16
  endian?:RasterEndian
  /** No color conversion. Unknown vs known descriptions differ by default. */
  colorPolicy?:'requireSame'|'assumeSame'
}
export function snapshotCompositeOptions(options:ImageCompositeOptions) {
  const x=options.x??0,y=options.y??0,blend=options.blend??'over',opacity=options.opacity??1,bits=options.bits,endian=options.endian,policy=options.colorPolicy??'requireSame'
  for(const value of [x,y])if(typeof value!=='number'||!Number.isInteger(value)||value< -0x80000000||value>0x7fffffff)throw new RangeError('invalid image composite offset')
  if(blend!=='over'&&blend!=='source')throw new RangeError('invalid image composite blend')
  if(typeof opacity!=='number'||!Number.isFinite(opacity)||opacity<0||opacity>1)throw new RangeError('invalid image composite opacity')
  if(bits!==undefined&&bits!==8&&bits!==16)throw new RangeError('invalid image composite precision')
  if(endian!==undefined&&endian!=='little'&&endian!=='big')throw new RangeError('invalid image composite endian')
  if(policy!=='requireSame'&&policy!=='assumeSame')throw new RangeError('invalid image composite color policy')
  return {x,y,blend,opacity:Math.round(opacity*65535),bits,endian,policy}
}
export function compositeDescriptor(options:ReturnType<typeof snapshotCompositeOptions>,bits:8|16,endian:RasterEndian){
  const bytes=storage(32),d=view(bytes)
  d.setUint32(0,32,true);d.setUint32(4,options.blend==='over'?0:1,true)
  d.setInt32(8,options.x,true);d.setInt32(12,options.y,true)
  d.setUint32(16,bits,true);d.setUint32(20,endian==='big'?1:0,true)
  d.setUint32(24,options.opacity,true)
  return bytes
}
