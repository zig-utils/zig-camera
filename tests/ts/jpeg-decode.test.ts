import{test,expect}from'bun:test'
import{CapturedImage,Camera,decodeJpeg,decodeJpegAsync,loadJpegAsync,loadPngAsync,decodePngAsync,type JpegDecodeLimits}from'../../ts'
import{native as n,ptr,storage,view,outPointer,handle,check,type Pointer}from'../../ts/ffi'
import{mkdtempSync,readFileSync,writeFileSync,rmSync}from'node:fs'
import{tmpdir}from'node:os'
import{join}from'node:path'
const same=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
function image(){return CapturedImage.fromRaster({data:new Uint8Array([213,74,31,15,200,110,255,150,80,30,60,90]),width:2,height:2})}
const fixture=process.env.ZC_JPEG_FIXTURE,independent=fixture?test:test.skip
independent('JPEG owned objects decode independent progressive, sampling and color models before source retirement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'zc-jpeg-fixture-'))
 try{
  for(let mode=0;mode<=10;mode++)for(const progressive of [0,1,2])for(const nearest of mode===4||mode===5?[true]:[false,true]){
   const jpeg=join(dir,'source.jpg'),raw=join(dir,'reference.raw'),result=Bun.spawnSync([fixture!,jpeg,raw,String(mode),String(progressive),nearest?'1':'0'])
   expect(result.exitCode).toBe(0);const bytes=new Uint8Array(readFileSync(jpeg)),expected=new Uint8Array(readFileSync(raw))
   const job=decodeJpegAsync(bytes,{upsampling:nearest?'nearest':'linear'});bytes.fill(0)
   using decoded=await job;await job.cleanupDone
   expect([decoded.image.width,decoded.image.height,decoded.image.bits]).toEqual([35,23,8]);expect(decoded.progressive).toBe(progressive!==0)
   expect(decoded.sourceComponents).toBe(mode===6?1:mode>=8?4:3);expect(decoded.sourceColorModel).toBe(mode===6?'gray':mode===7?'rgb':mode===10?'ycck':mode>=8?'cmyk':'ycbcr')
   expect(decoded.scans).toBeGreaterThan(progressive?1:0);expect(decoded.sampling.length).toBe(decoded.sourceComponents);expect(decoded.workingPeak).toBeGreaterThan(BigInt(expected.length));expect(decoded.workUnits).toBeGreaterThan(0n)
   const pixels=decoded.image.copyPixels();expect(pixels.length).toBe(expected.length);let difference=0;for(let i=0;i<pixels.length;i++)difference=Math.max(difference,Math.abs(pixels[i]!-expected[i]!));expect(difference).toBeLessThanOrEqual(3)
   same(decoded.metadata.icc!,new Uint8Array([9,8,7,6,5,4,3,2,1]));same(decoded.metadata.exif!,new Uint8Array([73,73,42,0,8,0,0,0,0,0]))
   expect(decoded.image.sourceMetadata).toBeUndefined();expect(decoded.image.colorSpace).toBeUndefined()
   using cloned=decoded.image.clone();decoded.close();same(cloned.copyPixels(),pixels)
   using rotated=cloned.rotate(90);using resized=rotated.resize(9,7);using png=await decodePngAsync(resized.encode({format:'png'}));same(png.image.copyPixels(),resized.copyPixels())
  }
 }finally{rmSync(dir,{recursive:true})}
})
test('JPEG camera images preserve owned source metadata with no invented capture provenance',async()=>{
 const camera=new Camera({simulate:true,width:18,height:10,fifo:true})
 try{
  const encoded=await camera.captureEncodedImage({format:'jpeg',iccProfile:'srgb',exif:{captureMetadata:false,artist:'Mountain trails'}})
  await camera.close();using decoded=decodeJpeg(encoded);expect([decoded.image.width,decoded.image.height]).toEqual([18,10]);expect(decoded.metadata.icc!.length).toBeGreaterThan(132);expect(decoded.metadata.exif!.length).toBeGreaterThan(14)
  expect(decoded.image.sourceMetadata).toBeUndefined();const icc=decoded.metadata.icc!.slice(),exif=decoded.metadata.exif!.slice();encoded.fill(0)
  using other=decodeJpeg(decoded.image.encode({format:'jpeg',iccProfile:icc,exif:{raw:exif,captureMetadata:false}}));same(other.metadata.icc!,icc);same(other.metadata.exif!,exif)
 }finally{await camera.close()}
})
test('JPEG strict parse and all decode budgets reject before publishing partial images',async()=>{
 using source=image();const bytes=source.encode({format:'jpeg'})
 for(let end=1;end<bytes.length;end++)expect(()=>decodeJpeg(bytes.subarray(0,end))).toThrow()
 for(const limit of [{maxInputBytes:bytes.length-1},{maxOutputBytes:1},{maxWorkingBytes:1},{maxWorkUnits:1},{maxMarkers:1}]){
  expect(()=>decodeJpeg(bytes,limit)).toThrow();try{const job=decodeJpegAsync(bytes,limit);await expect(job.wait()).rejects.toThrow();await job.cleanupDone}catch(error){expect(limit.maxInputBytes).toBeDefined()}
 }
 for(const key of ['maxInputBytes','maxOutputBytes','maxWorkingBytes','maxMetadataBytes','maxWorkUnits','maxScans','maxMarkers']as const)for(const value of [0,-1,NaN,Infinity,1.5,null,'1'])expect(()=>decodeJpeg(bytes,{[key]:value}as any)).toThrow()
 expect(()=>decodeJpeg(bytes,{upsampling:'fancy'as any})).toThrow();expect(()=>decodeJpeg(bytes,{maxScans:1025})).toThrow();expect(()=>decodeJpeg(bytes,{maxWorkUnits:17*1024**3})).toThrow()
 const trailing=new Uint8Array(bytes.length+1);trailing.set(bytes);expect(()=>decodeJpeg(trailing)).toThrow()
 const unsupported=bytes.slice();for(let i=0;i<unsupported.length-1;i++)if(unsupported[i]===255&&unsupported[i+1]===192){unsupported[i+1]=195;break}expect(()=>decodeJpeg(unsupported)).toThrow('(-8)')
 using after=decodeJpeg(bytes);expect(after.image.width).toBe(2)
})
test('JPEG input and option accessors snapshot once and shared/detached buffers reject',()=>{
 using source=image();const bytes=source.encode({format:'jpeg'}),reads:string[]=[],options={}as JpegDecodeLimits
 for(const[name,value]of [['maxInputBytes',65536],['maxOutputBytes',65536],['maxWorkingBytes',1024*1024],['maxMetadataBytes',1024],['maxWorkUnits',1024*1024],['maxScans',10],['maxMarkers',100],['upsampling','linear']])Object.defineProperty(options,name!,{get(){reads.push(name as string);return value}})
 using decoded=decodeJpeg(bytes,options);expect(reads).toEqual(['maxInputBytes','maxOutputBytes','maxWorkingBytes','maxMetadataBytes','maxWorkUnits','maxScans','maxMarkers','upsampling'])
 const shared=new Uint8Array(new SharedArrayBuffer(bytes.length));shared.set(bytes);expect(()=>decodeJpeg(shared)).toThrow('shared')
 const detached=bytes.slice();structuredClone(detached,{transfer:[detached.buffer]});expect(()=>decodeJpegAsync(detached)).toThrow()
 for(const invalid of [null,1,'jpeg',{},new Uint16Array(10)])expect(()=>decodeJpeg(invalid as any)).toThrow()
})
test('JPEG cancellation joins workers and callbacks before releasing copied inputs',async()=>{
 using source=CapturedImage.fromRaster({data:new Uint8Array(512*512*3).fill(73),width:512,height:512});const encoded=source.encode({format:'jpeg'}),reason=Error('cancel JPEG'),jobs=[]
 for(let i=0;i<4;i++){let called=false;const job=decodeJpegAsync(encoded,{maxWorkingBytes:8*1024*1024,signalFunction:current=>{called=true;expect(current.done).toBe(true);expect(current.error).toBe(reason)}});expect(job.cancel(reason)).toBe(true);jobs.push({job,called:()=>called})}
 for(const{job,called}of jobs){await expect(job.wait()).rejects.toBe(reason);await job.cleanupDone;expect(called()).toBe(true)}
 const signal=new AbortController();signal.abort(reason);const aborted=decodeJpegAsync(encoded,{signal:signal.signal});await expect(aborted.wait()).rejects.toBe(reason);await aborted.cleanupDone
 using healthy=await decodeJpegAsync(encoded);expect(healthy.image.width).toBe(512)
})
test('JPEG file jobs bound actual reads, preserve callback lifetime and permit healthy retries',async()=>{
 using source=image();const bytes=source.encode({format:'jpeg'}),dir=mkdtempSync(join(tmpdir(),'zc-jpeg-file-')),path=join(dir,'image.jpg')
 try{
  writeFileSync(path,bytes);let completed=false;const job=loadJpegAsync(path,{signalFunction:current=>{completed=true;expect(current.value?.image.width).toBe(2)}});using decoded=await job;await job.cleanupDone;expect(completed).toBe(true)
  const rejected=loadJpegAsync(path,{maxInputBytes:bytes.length-1});await expect(rejected.wait()).rejects.toThrow('limit');await rejected.cleanupDone
  const missing=loadJpegAsync(join(dir,'absent'));await expect(missing.wait()).rejects.toThrow();await missing.cleanupDone
  for(const value of ['', 'a\0b', 1])expect(()=>loadJpegAsync(value as any)).toThrow('path')
 }finally{rmSync(dir,{recursive:true})}
})
for(const format of ['png','jpeg']as const)test(`${format} decode uses a monotonic deadline when native admission starves JS timers`,async()=>{
 using source=image();const bytes=source.encode({format}),key=format==='png'?'zc_png_decode_async':'zc_jpeg_decode_async',original=n[key]
 Object.assign(n,{[key]:(...args:Parameters<typeof original>)=>{const code=original(...args),start=performance.now();while(performance.now()-start<25){}return code}})
 try{const job=format==='png'?decodePngAsync(bytes,{timeoutMs:5}):decodeJpegAsync(bytes,{timeoutMs:5});await expect(job.wait()).rejects.toMatchObject({code:-3});await job.cleanupDone;expect(job.value).toBeUndefined()}finally{Object.assign(n,{[key]:original})}
})
test('JPEG and PNG file jobs share one bounded read budget through cancellation joins',async()=>{
 using source=image();const jpeg=source.encode({format:'jpeg'}),png=source.encode({format:'png'}),dir=mkdtempSync(join(tmpdir(),'zc-decode-shared-')),jpegPath=join(dir,'image.jpg'),pngPath=join(dir,'image.png')
 writeFileSync(jpegPath,jpeg);writeFileSync(pngPath,png)
 const original=Bun.file,release:(()=>void)[]=[],jobs:ReturnType<typeof loadJpegAsync|typeof loadPngAsync>[]=[];let reads=0
 Object.assign(Bun,{file:()=>({slice:(_:number,end:number)=>{expect(end).toBe(65537);return{arrayBuffer:()=>{reads++;return new Promise<ArrayBuffer>(resolve=>release.push(()=>resolve(new ArrayBuffer(0))))}}}})})
 try{
  for(let i=0;i<4;i++)jobs.push(i%2?loadPngAsync(pngPath,{maxInputBytes:65536}):loadJpegAsync(jpegPath,{maxInputBytes:65536}))
  const excessJpeg=loadJpegAsync(jpegPath,{maxInputBytes:65536}),excessPng=loadPngAsync(pngPath,{maxInputBytes:65536})
  await expect(excessJpeg.wait()).rejects.toMatchObject({code:-4});await expect(excessPng.wait()).rejects.toMatchObject({code:-4});expect(reads).toBe(4)
  const reason=Error('cancel shared read');for(const job of jobs)expect(job.cancel(reason)).toBe(true);expect(jobs.every(job=>!job.done)).toBe(true)
  for(const finish of release)finish();for(const job of jobs){await expect(job.wait()).rejects.toBe(reason);await job.cleanupDone}
 }finally{Object.assign(Bun,{file:original});for(const finish of release)finish();await Promise.allSettled(jobs.map(job=>job.wait()));await Promise.all(jobs.map(job=>job.cleanupDone));rmSync(dir,{recursive:true})}
})
