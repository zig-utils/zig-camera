import{test,expect}from'bun:test'
import{Camera,DrmPreview}from'../../ts'
import{preparePreviewConfiguration}from'../../ts/preview-options'
test('RGB16 scanout requires an explicit copied high-byte policy and snapshots it once',async()=>{
 let reads=0
 const options={get rgb16(){reads++;return 'high-byte' as const},card:'/dev/null'}
 const prepared=preparePreviewConfiguration({backend:'drm-async',drm:options})
 expect(reads).toBe(1);expect(prepared.drm?.rgb16).toBe('high-byte')
 for(const value of [true,false,'linear','dither',1])expect(()=>preparePreviewConfiguration({backend:'drm',drm:{rgb16:value as any}})).toThrow('copy policy')
 expect(()=>new DrmPreview({width:8,height:6,rgb16:'high-byte',card:'/dev/null'})).toThrow('(-8)')
 for(const format of ['BGR161616','RGB161616'] as const){
  const camera=new Camera({simulate:true,width:8,height:6,format})
  try{
   for(const backend of ['drm','drm-async'] as const){
    expect(()=>camera.startPreview({backend,drm:{card:'/dev/null'}})).toThrow('(-8)')
    expect(()=>camera.startPreview({backend,drm:{card:'/dev/null',rgb16:'high-byte'}})).toThrow('(-8)')
   }
   expect(camera.previewCleanupPending).toBe(0);expect(camera.stats().leased).toBe(0)
   camera.startPreview({backend:'headless'});await camera.stopPreviewAsync()
  }finally{await camera.close()}
 }
})
