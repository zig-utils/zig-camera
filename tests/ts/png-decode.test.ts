import {test,expect} from 'bun:test'
import {CapturedImage,decodePng,decodePngAsync,loadPngAsync,encodePngAnimationAsync,Camera,type PngDecodeLimits,type DecodedPng} from '../../ts'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {runInNewContext} from 'node:vm'
import {native as n,ptr,storage,view,outPointer,handle,check,type Pointer} from '../../ts/ffi'
const same=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
for(const format of ['gray','rgb','rgba'] as const)for(const bits of [8,16] as const)for(const endian of ['little','big'] as const)test(`PNG loading retains ${format}${bits} ${endian} through filters and async source retirement`,async()=>{
  const count=({gray:1,rgb:3,rgba:4})[format],data=new Uint8Array(5*3*count*(bits/8)),v=new DataView(data.buffer)
  for(let i=0;i<5*3*count;i++){const value=(0x1234+i*1753)%65536;if(bits===8)data[i]=value>>8;else v.setUint16(i*2,value,endian==='little')}
  using image=CapturedImage.fromRaster({data,width:5,height:3,format,bits,endian})
  using expected=image.convert({endian:'little'})
  for(const pngFilter of ['adaptive','none','sub','up','average','paeth'] as const){
    const encoded=image.encode({format:'png',pngFilter})
    using decoded=decodePng(encoded)
    expect([decoded.image.width,decoded.image.height,decoded.image.format,decoded.image.bits,decoded.image.endian]).toEqual([5,3,format,bits,'little'])
    expect(decoded.frames.length).toBe(0);expect(decoded.image.sourceMetadata).toBeUndefined();expect(decoded.image.colorSpace).toBeUndefined()
    same(decoded.image.copyPixels(),expected.copyPixels())
    const job=decodePngAsync(encoded);encoded.fill(0xff)
    using asynchronous=await job;await job.cleanupDone
    same(asynchronous.image.copyPixels(),expected.copyPixels())
    using rotated=asynchronous.image.rotate(90);using resized=rotated.resize(7,4)
    expect(resized.bits).toBe(bits)
    using roundtrip=decodePng(await resized.encodeAsync({format:'png'}));same(roundtrip.image.copyPixels(),resized.copyPixels())
  }
})
for(const poster of [false,true])test(`APNG ${poster?'excluded poster':'included default'} exposes owned rectangles exact controls and shared close`,async()=>{
  const first={data:new Uint8Array([0x34,0x12,0x78,0x56,0xbc,0x9a,0xdc,0xfe,0x98,0xba,0x54,0x76]),width:2,height:1,format:'rgb' as const,bits:16 as const},patch={data:new Uint8Array([1,128,2,144,3,160]),width:1,height:1,format:'rgb' as const,bits:16 as const}
  const bytes=await encodePngAnimationAsync({width:2,height:1,plays:7,defaultImage:poster?first:undefined,frames:[{...first,delay:{numerator:3,denominator:25}},{...patch,x:1,delay:{numerator:7,denominator:0},dispose:'previous',blend:'over'}]})
  const job=decodePngAsync(bytes),result=await job
  try{
    expect(result.defaultIsFrame).toBe(!poster);expect(result.plays).toBe(7);expect(result.frames.length).toBe(2)
    same(result.image.copyPixels(),first.data);same(result.frames[0]!.image.copyPixels(),first.data);same(result.frames[1]!.image.copyPixels(),patch.data)
    expect(result.frames[1]!.delay).toEqual({numerator:7,denominator:0});expect([result.frames[1]!.x,result.frames[1]!.y,result.frames[1]!.dispose,result.frames[1]!.blend]).toEqual([1,0,'previous','over'])
    expect(Object.isFrozen(result.frames)).toBe(true)
    using clone=result.frames[1]!.image.clone();result.image.close();same(result.frames[0]!.image.copyPixels(),first.data)
    result.close();result.close();same(clone.copyPixels(),patch.data);expect(()=>result.frames[0]!.image.copyPixels()).toThrow('closed')
  }finally{result.close();await job.cleanupDone}
})
test('PNG loaded capture pixels retain explicit ICC Exif metadata without inventing source request provenance',async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10})
  try{
    using image=await camera.captureImage()
    const encoded=image.encode({format:'png',iccProfile:'srgb',exif:{captureMetadata:false,artist:'Trail photographer'}})
    using decoded=await decodePngAsync(encoded)
    expect(decoded.metadata.icc!.length).toBeGreaterThan(132);expect(decoded.metadata.exif!.length).toBeGreaterThan(14)
    expect(decoded.image.sourceMetadata).toBeUndefined();same(decoded.image.copyPixels(),image.copyPixels())
    const icc=decoded.metadata.icc!.slice(),exif=decoded.metadata.exif!.slice();encoded.fill(0)
    using cloned=decodePng(decoded.image.encode({format:'png',iccProfile:icc,exif:{raw:exif,captureMetadata:false}}))
    same(cloned.metadata.icc!,icc);same(cloned.metadata.exif!,exif)
  }finally{await camera.close()}
})
test('PNG strict complete input checks and byte frame chunk working limits never publish partial images',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array([1,2,3]),width:1,height:1})
  const bytes=image.encode({format:'png'})
  for(let size=0;size<bytes.length;size++)expect(()=>decodePng(bytes.subarray(0,size))).toThrow()
  const bad=bytes.slice();bad[29]^=1;expect(()=>decodePng(bad)).toThrow()
  const extra=new Uint8Array(bytes.length+1);extra.set(bytes);expect(()=>decodePng(extra)).toThrow()
  expect(()=>decodePngAsync(bytes,{maxInputBytes:bytes.length-1})).toThrow()
  for(const limits of [{maxOutputBytes:2},{maxWorkingBytes:1},{maxChunks:2}]){
    expect(()=>decodePng(bytes,limits)).toThrow()
    const job=decodePngAsync(bytes,limits);await expect(job.wait()).rejects.toThrow();await job.cleanupDone
  }
  for(const value of [0,-1,NaN,Infinity,'3',null,1.5,257*1024*1024])for(const name of ['maxInputBytes','maxOutputBytes','maxWorkingBytes'] as const)expect(()=>decodePng(bytes,{[name]:value} as any)).toThrow()
  for(const limits of [{maxFrames:257},{maxChunks:16385},{maxMetadataBytes:17*1024*1024}])expect(()=>decodePng(bytes,limits)).toThrow()
  using after=decodePng(bytes);same(after.image.copyPixels(),new Uint8Array([1,2,3]))
})
test('PNG options snapshot once before typed-array validation and shared/detached input is rejected',()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array([1,2,3]),width:1,height:1})
  const bytes=image.encode({format:'png'}),reads:string[]=[],options={} as PngDecodeLimits
  for(const [name,value] of [['maxInputBytes',1000],['maxOutputBytes',1000],['maxWorkingBytes',1024*1024],['maxMetadataBytes',1024],['maxFrames',2],['maxChunks',10]])Object.defineProperty(options,name as string,{get(){reads.push(name as string);return value}})
  using decoded=decodePng(bytes,options);expect(reads).toEqual(['maxInputBytes','maxOutputBytes','maxWorkingBytes','maxMetadataBytes','maxFrames','maxChunks'])
  const shared=new Uint8Array(new SharedArrayBuffer(bytes.length));shared.set(bytes);expect(()=>decodePng(shared)).toThrow('shared')
  const foreign=new Uint8Array(runInNewContext('new SharedArrayBuffer(128)'));expect(()=>decodePng(foreign)).toThrow('shared')
  const detached=bytes.slice();structuredClone(detached,{transfer:[detached.buffer]});expect(()=>decodePng(detached)).toThrow()
  const retired=bytes.slice();expect(()=>decodePng(retired,{get maxInputBytes(){structuredClone(retired,{transfer:[retired.buffer]});return 1000}})).toThrow()
  for(const invalid of [null,1,'png',{},new Uint16Array(5)])expect(()=>decodePng(invalid as any)).toThrow()
})
test('PNG active cancellation joins workers before callbacks and completed jobs release native reservations',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array(512*512*6).fill(73),width:512,height:512,bits:16})
  const bytes=image.encode({format:'png'}),reason=new Error('cancel PNG'),jobs=[]
  for(let i=0;i<4;i++){
    let callback=false
    const job=decodePngAsync(bytes,{maxWorkingBytes:8*1024*1024,signalFunction:current=>{callback=true;expect(current.done).toBe(true);expect(current.error).toBe(reason)}})
    expect(job.cancel(reason)).toBe(true);jobs.push({job,called:()=>callback})
  }
  for(const {job,called} of jobs){await expect(job.wait()).rejects.toBe(reason);await job.cleanupDone;expect(called()).toBe(true)}
  const signal=new AbortController();signal.abort(reason)
  const aborted=decodePngAsync(bytes,{signal:signal.signal});await expect(aborted.wait()).rejects.toBe(reason);await aborted.cleanupDone
  const deadline=decodePngAsync(bytes,{timeoutMs:0});await expect(deadline.wait()).rejects.toThrow('deadline');await deadline.cleanupDone
  const callbackError=new Error('callback'),job=decodePngAsync(bytes,{signalFunction(){throw callbackError}})
  using decoded=await job;await job.cleanupDone;expect(job.callbackError).toBe(callbackError);expect(job.cancel()).toBe(false)
})
test('PNG concurrent worker overflow rejects promptly and releases each native reservation after join',async()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array([1,2,3]),width:1,height:1})
  const bytes=image.encode({format:'png'}),limits=storage(48),owners:Pointer[]=[]
  n.zc_default_png_limits(ptr(limits));view(limits).setBigUint64(32,1024n*1024n,true)
  const retire=async()=>{while(owners.length){const owner=owners.at(-1)!;let code:number;while((code=n.zc_png_job_close(owner))===-4)await Bun.sleep(1);check(code,'held PNG job close');owners.pop()}}
  try{
    // Native reservations are held explicitly. Tiny decodes may otherwise
    // finish and retire before the next public job is scheduled.
    for(let i=0;i<4;i++){const out=outPointer();check(n.zc_png_decode_async(ptr(bytes),BigInt(bytes.length),ptr(limits),ptr(out)),'held PNG job');owners.push(handle(out))}
    const rejected=decodePngAsync(bytes,{maxWorkingBytes:1024*1024})
    await expect(rejected.wait()).rejects.toMatchObject({code:-4});await rejected.cleanupDone
    await retire()
    using available=await decodePngAsync(bytes,{maxWorkingBytes:1024*1024})
    same(available.image.copyPixels(),new Uint8Array([1,2,3]))
  }finally{await retire()}
})
test('PNG file loading bounds actual reads, joins cancellation and does not retain files',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-load-png-'))
  using image=CapturedImage.fromRaster({data:new Uint8Array([0x34,0x12,0x78,0x56,0xbc,0x9a]),width:1,height:1,bits:16})
  const bytes=image.encode({format:'png'}),path=join(dir,'source.png');writeFileSync(path,bytes)
  try{
    const job=loadPngAsync(path,{maxInputBytes:bytes.length});using result=await job;await job.cleanupDone;rmSync(path)
    same(result.image.copyPixels(),image.copyPixels());writeFileSync(path,bytes)
    const over=loadPngAsync(path,{maxInputBytes:bytes.length-1});await expect(over.wait()).rejects.toThrow('limit');await over.cleanupDone
    const missing=loadPngAsync(join(dir,'absent.png'));await expect(missing.wait()).rejects.toThrow();await missing.cleanupDone
    const reason=new Error('stop read'),cancel=loadPngAsync(path);cancel.cancel(reason);await expect(cancel.wait()).rejects.toBe(reason);await cancel.cleanupDone
    const jobs=Array.from({length:5},()=>loadPngAsync(path,{maxInputBytes:bytes.length,maxWorkingBytes:1024*1024})),results=await Promise.allSettled(jobs.map(j=>j.wait()))
    expect(results.filter(x=>x.status==='rejected').length).toBeGreaterThanOrEqual(1)
    for(const result of results)if(result.status==='fulfilled')result.value.close()
    await Promise.all(jobs.map(j=>j.cleanupDone))
    for(const bad of ['',123,null,'bad\0path'])expect(()=>loadPngAsync(bad as any)).toThrow()
  }finally{rmSync(dir,{recursive:true,force:true})}
})

test('PNG palette and scalar color metadata traverse the C ABI as independent copies',async()=>{
  const {deflateSync}=await import('node:zlib')
  const chunk=(name:string,data:Uint8Array)=>{
    const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);out.set(data,8)
    let crc=0xffffffff
    for(const byte of out.subarray(4,-4)){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
    out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out
  }
  const header=Buffer.from([0,0,0,2,0,0,0,1,1,3,0,0,0]),gamma=Buffer.alloc(4),chrm=Buffer.alloc(32)
  gamma.writeUInt32BE(45455);for(let i=0;i<8;i++)chrm.writeUInt32BE(10000+i*123,i*4)
  const build=(cicp=Buffer.from([9,16,0,1]))=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('sRGB',Buffer.from([2])),chunk('gAMA',gamma),chunk('cHRM',chrm),chunk('cICP',cicp),chunk('PLTE',Buffer.from([10,20,30,40,50,60])),chunk('tRNS',Buffer.from([0,91])),chunk('IDAT',deflateSync(Buffer.from([0,0x40]))),chunk('IEND',Buffer.alloc(0))])
  const input=build()
  using result=await decodePngAsync(input);input.fill(0)
  expect([result.sourceDepth,result.sourceColor,result.interlaced]).toEqual([1,3,false]);expect(result.image.format).toBe('rgba')
  same(result.image.copyPixels(),new Uint8Array([10,20,30,0,40,50,60,91]));same(result.metadata.palette!,new Uint8Array([10,20,30,0,40,50,60,91]))
  expect(result.metadata.srgbIntent).toBe(2);expect(result.metadata.gamma).toBe(45455);expect(result.metadata.chromaticities).toEqual(Array.from({length:8},(_,i)=>10000+i*123));expect(result.metadata.cicp).toEqual([9,16,0,1])
  result.metadata.palette!.fill(0);same(result.image.copyPixels(),new Uint8Array([10,20,30,0,40,50,60,91]))
  for(const values of [[9,16,1,1],[9,16,0,2]]){
    const bad=build(Buffer.from(values));expect(()=>decodePng(bad)).toThrow()
    const job=decodePngAsync(bad);await expect(job.wait()).rejects.toThrow();await job.cleanupDone
  }
})
