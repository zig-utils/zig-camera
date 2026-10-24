import {test,expect} from 'bun:test'
import {Camera} from '../../ts'
import {preparePreviewConfiguration} from '../../ts/preview-options'
test('DRM options snapshot scalars once and reject truncation before display preparation',()=>{
  let reads=0
  const options={get card(){reads++;return '/dev/null'},get connectorId(){reads++;return 20},get planeId(){reads++;return 40},get timeoutMs(){reads++;return 30}}
  const prepared=preparePreviewConfiguration({backend:'drm',drm:options});expect(reads).toBe(4)
  expect(prepared.drm).toEqual({card:'/dev/null',connectorId:20,planeId:40,timeoutMs:30});expect(Object.isFrozen(prepared.drm)).toBe(true)
  for(const backend of ['sdl','headless'] as const)expect(()=>preparePreviewConfiguration({backend,drm:{}})).toThrow('require DRM')
  for(const value of [-1,1.5,NaN,Infinity,0x100000000])expect(()=>preparePreviewConfiguration({backend:'drm',drm:{connectorId:value}})).toThrow()
  for(const value of [0,60001,-1,NaN])expect(()=>preparePreviewConfiguration({backend:'drm',drm:{timeoutMs:value}})).toThrow()
  for(const card of ['', 'bad\0path','a'.repeat(64),'é'.repeat(32)])expect(()=>preparePreviewConfiguration({backend:'drm',drm:{card}})).toThrow()
})
test('DRM non-device preparation preserves camera ownership and permits a fresh headless preview',async()=>{
  const camera=new Camera({simulate:true,width:8,height:6})
  try{
    for(let i=0;i<8;i++)expect(()=>camera.startPreview({backend:'drm',drm:{card:'/dev/null'}})).toThrow('(-8)')
    expect(camera.previewCleanupPending).toBe(0);expect(camera.stats().leased).toBe(0);expect(camera.previewInfo()).toBeUndefined()
    camera.startPreview({backend:'headless'});await camera.captureMetadata();camera.stopPreview()
    expect(camera.stats().leased).toBe(0)
  }finally{await camera.close()}
})
