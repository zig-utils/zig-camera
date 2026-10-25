import {test,expect} from 'bun:test'
import {CapturedImage,Camera,decodePng,type ImageCompositeOptions,type StreamColorSpace} from '../../ts'
const image=(data:number[],width=1,height=1,format:'gray'|'rgb'|'rgba'='rgba')=>CapturedImage.fromRaster({data:Uint8Array.from(data),width,height,format})
const same=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
const srgb:StreamColorSpace={present:true,primaries:'rec709',transfer:'srgb',ycbcrEncoding:'none',range:'full'}
test('owned source-over keeps straight alpha and both sources independent after closure',()=>{
  const base=image([255,0,0,255]),overlay=image([0,0,255,128])
  using result=base.composite(overlay)
  expect(result.getPixel(0,0)).toEqual([127,0,128,255])
  expect([result.width,result.height,result.bits,result.format]).toEqual([1,1,8,'rgba'])
  expect(base.getPixel(0,0)).toEqual([255,0,0,255]);expect(overlay.getPixel(0,0)).toEqual([0,0,255,128])
  base.close();overlay.close()
  expect(result.getPixel(0,0)).toEqual([127,0,128,255])
})
test('negative overlay clipping and padded gray/word input retain native low bits and output endian',()=>{
  using base=CapturedImage.fromRaster({data:Uint8Array.from([7,9,99,11,13]),width:2,height:2,stride:3,format:'gray'})
  const bytes=new Uint8Array(32),view=new DataView(bytes.buffer)
  for(let pixel=0;pixel<4;pixel++)for(const [c,v] of [0x1234,0x8001,0xfedc,65535].entries())view.setUint16(pixel*8+c*2,v,false)
  using overlay=CapturedImage.fromRaster({data:bytes,width:2,height:2,format:'rgba',bits:16,endian:'big'})
  using result=base.composite(overlay,{x:-1,y:-1,endian:'big'})
  expect([result.bits,result.endian,result.stride]).toEqual([16,'big',16])
  expect(result.getPixel16(0,0)).toEqual([0x1234,0x8001,0xfedc,65535])
  expect(result.getPixel16(1,0)).toEqual([9*257,9*257,9*257,65535])
  expect(result.getPixel16(0,1)).toEqual([11*257,11*257,11*257,65535])
  using reduced=base.composite(overlay,{x:-1,y:-1,bits:8})
  expect(reduced.getPixel(0,0)).toEqual([0x12,0x80,0xfe,255])
})
test('source replacement changes alpha with 16-bit opacity and preserves hidden RGB',()=>{
  using base=image([1,2,3,4]),overlay=image([99,45,73,128])
  using half=base.composite(overlay,{blend:'source',opacity:0.5})
  expect(half.getPixel(0,0)).toEqual([99,45,73,64])
  using zero=base.composite(overlay,{blend:'source',opacity:0})
  expect(zero.getPixel(0,0)).toEqual([99,45,73,0])
  using unchanged=base.composite(overlay,{opacity:0})
  same(unchanged.copyPixels(),base.copyPixels())
})
for(const offset of [-0x80000000,0x7fffffff])test(`fully clipped overlay at signed boundary ${offset} copies the base canvas`,()=>{
  using base=image([17,129,255,31]),overlay=image([200,201,202,255])
  using result=base.composite(overlay,{x:offset,y:offset})
  same(result.copyPixels(),base.copyPixels())
})
test('self-composition accepts read-only input aliases while its result has independent storage',()=>{
  const base=image([17,129,255,128])
  using result=base.composite(base,{bits:16})
  base.close();expect(result.getPixel16(0,0)).toEqual([17*257,129*257,65535,49279])
})
test('color descriptions must match unless the caller explicitly assumes a common encoded space',()=>{
  using base=CapturedImage.fromRaster({data:Uint8Array.from([1,2,3]),width:1,height:1,colorSpace:srgb})
  using unknown=image([10,20,30,128])
  using different=CapturedImage.fromRaster({data:Uint8Array.from([10,20,30,128]),width:1,height:1,format:'rgba',colorSpace:{...srgb,primaries:'rec2020'}})
  for(const overlay of [unknown,different]){
    expect(()=>base.composite(overlay)).toThrow('color descriptions differ')
    using result=base.composite(overlay,{colorPolicy:'assumeSame'})
    expect(result.colorSpace).toEqual(srgb)
  }
  using matching=CapturedImage.fromRaster({data:Uint8Array.from([10,20,30]),width:1,height:1,colorSpace:srgb})
  using result=base.composite(matching);expect(result.getPixel(0,0)).toEqual([10,20,30,255])
})
test('malformed composition options reject without changing or closing either image',()=>{
  using base=image([1,2,3,4]),overlay=image([7,8,9,10])
  const invalid:unknown[]=[{x:NaN},{x:0x80000000},{x:-0x80000001},{y:1.5},{opacity:NaN},{opacity:Infinity},{opacity:-1},{opacity:1.00001},{blend:'multiply'},{bits:12},{endian:'native'},{colorPolicy:'convert'},null]
  for(const options of invalid)expect(()=>base.composite(overlay,options as ImageCompositeOptions)).toThrow()
  expect(()=>base.composite(null as any)).toThrow('owned image')
  expect(base.getPixel(0,0)).toEqual([1,2,3,4]);expect(overlay.getPixel(0,0)).toEqual([7,8,9,10])
})
test('option accessors cannot close an input and leave a stale borrowed raster during admission',()=>{
  const base=image([1,2,3,4]);using overlay=image([7,8,9,10])
  expect(()=>base.composite(overlay,{get x(){base.close();return 0}})).toThrow('closed image')
  using fresh=image([1,2,3,4])
  expect(()=>fresh.compositeAsync(overlay,{get signal(){overlay.close();return undefined}})).toThrow('closed image')
})
test('async admission snapshots each option once and owns both source rasters before returning',async()=>{
  const base=image([255,0,0,255]),overlay=image([0,0,255,128]),counts=new Map<string,number>()
  const options=new Proxy({opacity:0.5,endian:'big' as const,bits:16 as const},{get(target,key){if(typeof key==='string')counts.set(key,(counts.get(key)??0)+1);return Reflect.get(target,key)}})
  using reference=base.composite(overlay,{opacity:0.5,endian:'big',bits:16})
  const job=base.compositeAsync(overlay,options)
  base.close();overlay.close()
  using result=await job
  same(result.copyPixels(),reference.copyPixels());expect(result.endian).toBe('big')
  for(const name of ['x','y','blend','opacity','bits','endian','colorPolicy','maxInputBytes','maxOutputBytes','maxWorkingBytes','timeoutMs','signal','signalFunction'])expect(counts.get(name)).toBe(1)
})
test('composite input output and working limits share the native image admission rules',async()=>{
  using base=image([1,2,3,4,5,6,7,8,9,10,11,12],2,2,'rgb'),overlay=image([17,129,255,128])
  using result=await base.compositeAsync(overlay,{maxInputBytes:16,maxOutputBytes:16,maxWorkingBytes:16})
  expect(result.copyPixels().length).toBe(16)
  for(const options of [{maxInputBytes:15},{maxOutputBytes:15},{maxWorkingBytes:15}]){
    const job=base.compositeAsync(overlay,options)
    await expect(job.wait()).rejects.toThrow();await job.cleanupDone
  }
  using after=await base.compositeAsync(overlay)
  expect(after.getPixel(1,1)).toEqual([10,11,12,255])
})
test('pre-aborted composite jobs publish no image and completion callbacks observe joined cancellation',async()=>{
  using base=image([1,2,3,4]),overlay=image([7,8,9,10])
  const controller=new AbortController(),reason=new Error('skip composite');controller.abort(reason)
  let calls=0
  const job=base.compositeAsync(overlay,{signal:controller.signal,signalFunction(current){calls++;expect(current.error).toBe(reason)}})
  await expect(job.wait()).rejects.toBe(reason);await job.cleanupDone
  expect(calls).toBe(1);expect(job.value).toBeUndefined()
})
test('active cancellation joins copied inputs and worker reservations before fresh composites',async()=>{
  const pixels=new Uint8Array(1024*512*4).fill(127)
  using base=CapturedImage.fromRaster({data:pixels,width:1024,height:512,format:'rgba'}),overlay=image([7,8,9,10])
  for(let i=0;i<6;i++){
    const reason=new Error(`cancel ${i}`),job=base.compositeAsync(overlay,{maxWorkingBytes:4*1024*1024})
    expect(job.cancel(reason)).toBe(true)
    await expect(job.wait()).rejects.toBe(reason);await job.cleanupDone
    expect(job.value).toBeUndefined()
  }
  using after=await overlay.compositeAsync(overlay)
  expect(after.width).toBe(1)
})
test('composited capture provenance and native words survive source/camera close and PNG roundtrip',async()=>{
  const camera=new Camera({simulate:true,width:18,height:10,format:'RGB161616',fifo:true})
  let base:CapturedImage|undefined,overlay:CapturedImage|undefined
  try{
    base=await camera.captureImage({bits:16})
    overlay=CapturedImage.fromRaster({data:Uint8Array.from([0x12,0x34,0x80,0x01,0xfe,0xdc,0x80,0x01]),width:1,height:1,format:'rgba',bits:16,endian:'big',colorSpace:base.colorSpace})
    const metadata=base.sourceMetadata,job=base.compositeAsync(overlay,{endian:'little'})
    base.close();overlay.close();await camera.close()
    using result=await job
    expect(result.sourceMetadata).toEqual(metadata);expect(Object.isFrozen(result.sourceMetadata)).toBe(true)
    using decoded=decodePng(result.encode({format:'png'}))
    same(decoded.image.copyPixels(),result.copyPixels());expect(decoded.image.bits).toBe(16)
  }finally{base?.close();overlay?.close();await camera.close()}
})
