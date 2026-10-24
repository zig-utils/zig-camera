import {native as n,storage,view,ptr,outPointer,handle,check,cstring,type Pointer} from './ffi'
import {processedFormatCode,processedFormatName,type ProcessedFormat} from './processed-format'
export interface DrmPreviewOptions {card?:string;connectorId?:number;planeId?:number;timeoutMs?:number;rgb16?:'high-byte'}
export type PreparedDrmPreview=Readonly<Required<Omit<DrmPreviewOptions,'card'|'rgb16'>>&Pick<DrmPreviewOptions,'card'|'rgb16'>>
function integer(value:unknown,max:number,min=0){if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new RangeError('invalid DRM preview option');return value}
export function snapshotDrmPreview(source:DrmPreviewOptions={}):PreparedDrmPreview{
  if(!source||typeof source!=='object'||Array.isArray(source))throw new TypeError('invalid DRM preview options')
  const card=source.card,connector=source.connectorId,plane=source.planeId,timeout=source.timeoutMs,rgb16=source.rgb16
  if(card!==undefined){if(typeof card!=='string'||card.length===0||card.length>63||card.includes('\0')||cstring(card).length>64)throw new RangeError('invalid DRM card path')}
  if(rgb16!==undefined&&rgb16!=='high-byte')throw new RangeError('invalid RGB16 display copy policy')
  return Object.freeze({card,...(rgb16?{rgb16}:{}),connectorId:integer(connector??0,0xffffffff),planeId:integer(plane??0,0xffffffff),timeoutMs:integer(timeout??1000,60000,1)})
}
export function openDrmPreview(width:number,height:number,format:ProcessedFormat|undefined,options:PreparedDrmPreview){
  const copyWords=options.rgb16&&(format==='RGB161616'||format==='BGR161616')
  const data=storage(96),d=view(data);n.zc_default_drm_preview_config(ptr(data));
  d.setUint32(4,options.connectorId,true);d.setUint32(8,options.planeId,true);d.setUint32(12,processedFormatCode(format??'BGR888'),true);d.setUint32(16,width,true);d.setUint32(20,height,true);d.setUint32(24,options.timeoutMs,true)
  if(options.card)data.set(cstring(options.card),32)
  const out=outPointer();check((copyWords?n.zc_preview_open_drm_rgb16:n.zc_preview_open_drm)(ptr(data),ptr(out)),'DRM preview open');return handle(out)
}
export function readDrmPreviewState(pointer:Pointer){
  const data=storage(40),d=view(data);check(n.zc_drm_preview_state_get(pointer,ptr(data)),'DRM preview state')
  return Object.freeze({retainedFrames:d.getUint32(4,true),uncertain:!!d.getUint32(8,true),poisoned:!!d.getUint32(12,true),deviceClosed:!!d.getUint32(16,true),lastError:d.getInt32(20,true),lastErrorNumber:d.getInt32(24,true),connectorId:d.getUint32(28,true),planeId:d.getUint32(32,true),crtcId:d.getUint32(36,true)})
}
export type DrmPreviewState=ReturnType<typeof readDrmPreviewState>

export function readDrmPreviewStorage(pointer:Pointer){
 const data=storage(48),d=view(data);check(n.zc_drm_preview_storage_state_get(pointer,ptr(data)),'DRM storage state')
 return Object.freeze({inputFormat:processedFormatName(d.getUint32(4,true)),scanoutFormat:processedFormatName(d.getUint32(8,true)),copyPolicy:d.getUint32(12,true)?'rgb16-high-byte' as const:'direct' as const,buffers:d.getUint32(16,true),cpuActive:d.getUint32(20,true),copiedFrames:d.getBigUint64(32,true),storageBytes:d.getBigUint64(40,true)})
}
export type DrmPreviewStorageState=ReturnType<typeof readDrmPreviewStorage>

export function readDrmPreviewOverlay(pointer:Pointer){
 const data=storage(56),d=view(data);check(n.zc_drm_preview_overlay_state_get(pointer,ptr(data)),'DRM overlay state')
 return Object.freeze({planeId:d.getUint32(4,true),configured:!!d.getUint32(8,true),visible:!!d.getUint32(12,true),blendMode:(['none','coverage','premultiplied'] as const)[d.getUint32(16,true)]!,buffers:d.getUint32(20,true),uncertain:!!d.getUint32(24,true),cpuActive:d.getUint32(28,true),poisoned:!!d.getUint32(32,true),storageBytes:d.getBigUint64(40,true),updates:d.getBigUint64(48,true)})
}
export type DrmPreviewOverlayState=ReturnType<typeof readDrmPreviewOverlay>
