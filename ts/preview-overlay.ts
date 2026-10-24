import type{PreviewOverlay}from'./index'
import{native as n,ptr,outPointer,handle,check,type Pointer}from'./ffi'
/** @internal Compact immutable native snapshot; no camera or display ownership. */
export function createPreviewOverlay(overlay:PreviewOverlay|null,allocate=true):Pointer{
 if(overlay===null)return 0 as Pointer
 if(!overlay||typeof overlay!=='object')throw new TypeError('invalid preview overlay')
 const data=overlay.data,width=overlay.width,height=overlay.height,stride=overlay.stride??width*4
 if(!(data instanceof Uint8Array)||!Number.isInteger(width)||width<1||width>4096||!Number.isInteger(height)||height<1||height>4096||!Number.isInteger(stride)||stride<width*4||stride>0xffffffff||data.byteLength<(height-1)*stride+width*4)throw new RangeError('invalid RGBA preview overlay')
 if(!allocate)return 0 as Pointer
 const out=outPointer();check(n.zc_preview_overlay_create(ptr(data),BigInt(data.byteLength),width,height,stride,ptr(out)),'preview overlay snapshot')
 return handle(out)
}
