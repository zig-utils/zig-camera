import {native as n,storage,view,ptr,outPointer,handle,check,cstring,type Pointer} from './ffi'
import {processedFormatCode,type ProcessedFormat} from './processed-format'
export interface DrmPreviewOptions {card?:string;connectorId?:number;planeId?:number;timeoutMs?:number}
export type PreparedDrmPreview=Readonly<Required<Omit<DrmPreviewOptions,'card'>>&{card?:string}>
function integer(value:unknown,max:number,min=0){if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new RangeError('invalid DRM preview option');return value}
export function snapshotDrmPreview(source:DrmPreviewOptions={}):PreparedDrmPreview{
  if(!source||typeof source!=='object'||Array.isArray(source))throw new TypeError('invalid DRM preview options')
  const card=source.card,connector=source.connectorId,plane=source.planeId,timeout=source.timeoutMs
  if(card!==undefined){if(typeof card!=='string'||card.length===0||card.length>63||card.includes('\0')||cstring(card).length>64)throw new RangeError('invalid DRM card path')}
  return Object.freeze({card,connectorId:integer(connector??0,0xffffffff),planeId:integer(plane??0,0xffffffff),timeoutMs:integer(timeout??1000,60000,1)})
}
export function openDrmPreview(width:number,height:number,format:ProcessedFormat|undefined,options:PreparedDrmPreview){
  const data=storage(96),d=view(data);n.zc_default_drm_preview_config(ptr(data));
  d.setUint32(4,options.connectorId,true);d.setUint32(8,options.planeId,true);d.setUint32(12,processedFormatCode(format??'BGR888'),true);d.setUint32(16,width,true);d.setUint32(20,height,true);d.setUint32(24,options.timeoutMs,true)
  if(options.card)data.set(cstring(options.card),32)
  const out=outPointer();check(n.zc_preview_open_drm(ptr(data),ptr(out)),'DRM preview open');return handle(out)
}
export function readDrmPreviewState(pointer:Pointer){
  const data=storage(40),d=view(data);check(n.zc_drm_preview_state_get(pointer,ptr(data)),'DRM preview state')
  return Object.freeze({retainedFrames:d.getUint32(4,true),uncertain:!!d.getUint32(8,true),poisoned:!!d.getUint32(12,true),deviceClosed:!!d.getUint32(16,true),lastError:d.getInt32(20,true),lastErrorNumber:d.getInt32(24,true),connectorId:d.getUint32(28,true),planeId:d.getUint32(32,true),crtcId:d.getUint32(36,true)})
}
export type DrmPreviewState=ReturnType<typeof readDrmPreviewState>
