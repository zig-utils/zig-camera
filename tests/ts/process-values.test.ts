import {test,expect} from 'bun:test'
import {encodeProcessValue,encodeProcessCameraValue,decodeProcessValue} from '../../ts/process-values'
test('bounded process snapshots preserve cycles numeric aliases maps dates and one getter scan',()=>{
  const buffer=new ArrayBuffer(32),words=new Uint16Array(buffer,4,3),bytes=new Uint8Array(buffer,6,2)
  words[1]=54321
  let reads=0
  const source:any={buffer,words,bytes,date:new Date(1730000000000),map:new Map(),set:new Set(),get value(){reads++;return 9007199254740993n}}
  source.self=source;source.map.set(source,words);source.set.add(source)
  const encoded=encodeProcessValue(source,1024*1024)
  expect(reads).toBe(1)
  words.fill(0)
  const copy=decodeProcessValue(encoded,1024*1024) as any
  expect(copy.self).toBe(copy);expect(copy.value).toBe(9007199254740993n)
  expect(copy.words.buffer).toBe(copy.buffer);expect(copy.bytes.buffer).toBe(copy.buffer)
  expect(copy.words.byteOffset).toBe(4);expect(copy.words[1]).toBe(54321)
  expect(copy.map.get(copy)).toBe(copy.words);expect(copy.set.has(copy)).toBe(true)
  expect(copy.date.getTime()).toBe(1730000000000)
})
test('process graph and byte limits reject before serialization accepts unbounded input',()=>{
  for(const value of [()=>{},Symbol('x'),new SharedArrayBuffer(8),new Uint8Array(new SharedArrayBuffer(8)),new class X{}(),new Array(4097),new Uint8Array(2*1024*1024),1n<<4096n])expect(()=>encodeProcessValue(value,1024*1024)).toThrow()
  let nested:any=null;for(let i=0;i<70;i++)nested={nested};expect(()=>encodeProcessValue(nested,1024*1024)).toThrow('graph')
  expect(()=>encodeProcessValue('x'.repeat(3000),1024)).toThrow('budget')
  expect(()=>decodeProcessValue(new Uint8Array(65),64)).toThrow()
  const detached=new ArrayBuffer(8);detached.transfer();expect(()=>encodeProcessValue(detached,1024)).toThrow()
})

test('camera configuration projection preserves bounded graph aliases and never reads native allocator getters',()=>{
  class Owner {}
  const owner=new Owner(),options:any={width:32,get allocator(){throw Error('native owner getter read')}}
  options.self=options
  const initial={camera:{options},context:{recipe:options}}
  const copy=decodeProcessValue(encodeProcessCameraValue(initial,4096,options),4096) as any
  expect(copy.camera.options.width).toBe(32)
  expect(Object.hasOwn(copy.camera.options,'allocator')).toBe(false)
  expect(copy.camera.options.self).toBe(copy.camera.options)
  expect(copy.context.recipe).toBe(copy.camera.options)
  expect(()=>encodeProcessCameraValue({camera:{options},context:owner},4096,options)).toThrow('custom process instances')
  expect(()=>encodeProcessValue({allocator:owner},4096)).toThrow('custom process instances')
  const large={allocator:owner,width:'x'.repeat(2048)}
  expect(()=>encodeProcessCameraValue({camera:{options:large}},128,large)).toThrow('byte budget')
})
