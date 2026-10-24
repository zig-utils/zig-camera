import {test,expect} from 'bun:test'
import {DrmPreview} from '../../ts'
test('native DRM sessions validate copied dimensions and capacity before device preparation',()=>{
  for(const value of [0,-1,1.5,NaN,Infinity,16385])expect(()=>new DrmPreview({width:value,height:6,card:'/dev/null'})).toThrow('dimension')
  for(const operations of [0,9,-1,NaN,1.5])expect(()=>new DrmPreview({width:8,height:6,operations,card:'/dev/null'})).toThrow('capacity')
  expect(()=>new DrmPreview({width:8,height:6,format:'not-a-format' as any,card:'/dev/null'})).toThrow('format')
  for(let i=0;i<8;i++)expect(()=>new DrmPreview({width:8,height:6,card:'/dev/null'})).toThrow('(-8)')
})
