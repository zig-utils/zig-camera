import {native as n,storage,view,ptr,cstring,text,outPointer,handle,check} from './ffi'
import {processedFormatName,type ProcessedFormat} from './processed-format'
export interface DrmDiscoveryOptions { /** Omit to scan card0..card63. UTF-8 path must fit 63 bytes. */ card?:string }
export interface DrmDisplayFormat {readonly fourcc:number;readonly name:string;readonly bigEndian:boolean;readonly processedFormat?:ProcessedFormat}
export interface DrmDisplay {
  readonly card:string;readonly name:string;readonly connectorId:number;readonly connectorType:number;readonly connectorTypeId:number
  readonly status:'connected'|'disconnected'|'unknown';readonly currentCrtcId:number
  readonly activeMode?:Readonly<{width:number;height:number}>;readonly defaultMode?:Readonly<{width:number;height:number}>
  readonly physicalWidthMm:number;readonly physicalHeightMm:number;readonly atomic:boolean;readonly universalPlanes:boolean
  readonly crtcs:readonly number[];readonly formats:readonly DrmDisplayFormat[]
}
export interface DrmDiscoveryIssue {
  readonly card:string;readonly stage:'open'|'resources'|'encoder'|'crtc'|'planes'|'plane'|'connector'|'recheck'
  readonly reason:'system'|'limit'|'race'|'invalid';readonly errorNumber:number
}
export interface DrmDisplayDiscovery {
  readonly displays:readonly DrmDisplay[];readonly issues:readonly DrmDiscoveryIssue[];readonly cardsTried:number;readonly cardsOpened:number
}
/** Read-only, synchronous Linux KMS catalog. Card errors are explicit issues;
 * non-Linux hosts throw unsupported. All temporary FDs/native storage retire
 * before returning. Advertised formats do not establish scanout availability. */
export function listDrmDisplays(options:DrmDiscoveryOptions={}):Readonly<DrmDisplayDiscovery>{
  if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('invalid DRM discovery options')
  const card=options.card
  if(card!==undefined&&(typeof card!=='string'||!card.length||card.includes('\0')))throw new TypeError('invalid DRM card path')
  if(card!==undefined&&card.length>63)throw new RangeError('DRM card path exceeds 63 UTF-8 bytes')
  const path=card===undefined?undefined:cstring(card)
  if(path&&path.length>64)throw new RangeError('DRM card path exceeds 63 UTF-8 bytes')
  const out=outPointer();check(n.zc_drm_discover(path?ptr(path):null,ptr(out)),'DRM discovery')
  const p=handle(out)
  try{
    const info=storage(32),d=view(info);check(n.zc_drm_discovery_info_get(p,ptr(info)))
    const displays:DrmDisplay[]=[],issues:DrmDiscoveryIssue[]=[]
    for(let i=0;i<d.getUint32(4,true);i++){
      const data=storage(2336),v=view(data);check(n.zc_drm_discovery_display_get(p,i,ptr(data)))
      const flags=v.getUint32(48,true),crtcCount=v.getUint32(52,true),formatCount=v.getUint32(56,true)
      const geometry=(at:number)=>{const width=v.getUint32(at,true),height=v.getUint32(at+4,true);return width&&height?Object.freeze({width,height}):undefined}
      const formats=Array.from({length:formatCount},(_,slot)=>{
        const code=v.getUint32(288+slot*4,true),processed=v.getUint32(1312+slot*4,true),raw=code&0x7fffffff
        const chars=Array.from({length:4},(_,j)=>(raw>>>(j*8))&255)
        const name=chars.every(c=>c>=32&&c<=126)?String.fromCharCode(...chars):`0x${code.toString(16).padStart(8,'0')}`
        return Object.freeze({fourcc:code,name,bigEndian:!!(code&0x80000000),...(processed!==0xffffffff?{processedFormat:processedFormatName(processed)}:{})})
      })
      displays.push(Object.freeze({card:text(data,64,64),name:text(data,128,32),connectorId:v.getUint32(4,true),connectorType:v.getUint32(8,true),connectorTypeId:v.getUint32(12,true),status:(['unknown','connected','disconnected','unknown'] as const)[v.getUint32(16,true)]!,currentCrtcId:v.getUint32(20,true),activeMode:geometry(24),defaultMode:geometry(32),physicalWidthMm:v.getUint32(40,true),physicalHeightMm:v.getUint32(44,true),atomic:!!(flags&1),universalPlanes:!!(flags&2),crtcs:Object.freeze(Array.from({length:crtcCount},(_,j)=>v.getUint32(160+j*4,true))),formats:Object.freeze(formats)}))
    }
    for(let i=0;i<d.getUint32(8,true);i++){
      const data=storage(80),v=view(data);check(n.zc_drm_discovery_issue_get(p,i,ptr(data)))
      issues.push(Object.freeze({card:text(data,16,64),stage:(['open','resources','encoder','crtc','planes','plane','connector','recheck'] as const)[v.getUint32(4,true)-1]!,errorNumber:v.getInt32(8,true),reason:(['system','limit','race','invalid'] as const)[v.getUint32(12,true)-1]!}))
    }
    return Object.freeze({displays:Object.freeze(displays),issues:Object.freeze(issues),cardsTried:d.getUint32(12,true),cardsOpened:d.getUint32(16,true)})
  }finally{n.zc_drm_discovery_close(p)}
}
