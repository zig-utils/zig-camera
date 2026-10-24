import {test,expect} from 'bun:test'
import {listDrmDisplays} from '../../ts'
test('DRM discovery validates copied path options before native/platform admission',()=>{
  for(const bad of [null,1,'card',[]])expect(()=>listDrmDisplays(bad as any)).toThrow()
  for(const card of ['',null,1,'bad\0path'])expect(()=>listDrmDisplays({card:card as any})).toThrow()
  expect(()=>listDrmDisplays({card:'a'.repeat(64)})).toThrow('63 UTF-8')
  expect(()=>listDrmDisplays({card:'é'.repeat(32)})).toThrow('63 UTF-8')
  let reads=0
  if(process.platform==='linux'){
    const result=listDrmDisplays({get card(){reads++;return '/dev/null'}})
    expect(reads).toBe(1);expect(result.cardsOpened).toBe(1);expect(result.cardsTried).toBe(1)
    expect(result.displays).toEqual([]);expect(result.issues).toEqual([{card:'/dev/null',stage:'resources',reason:'system',errorNumber:25}])
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.issues)).toBe(true);expect(Object.isFrozen(result.issues[0])).toBe(true)
  }else{
    expect(()=>listDrmDisplays({get card(){reads++;return '/dev/null'}})).toThrow('(-8)');expect(reads).toBe(1)
  }
})
test('DRM exact missing paths remain explicit and repeated catalogs release native admission',()=>{
  if(process.platform!=='linux'){for(let i=0;i<10;i++)expect(()=>listDrmDisplays()).toThrow('(-8)');return}
  for(let i=0;i<20;i++){
    const value=listDrmDisplays({card:'/dev/zig-camera-kms-absent'})
    expect(value.cardsOpened).toBe(0);expect(value.displays.length).toBe(0)
    expect(value.issues).toEqual([{card:'/dev/zig-camera-kms-absent',stage:'open',reason:'system',errorNumber:2}])
  }
})
