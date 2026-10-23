import {test,expect} from 'bun:test'
import {Camera,CapturedImage,FrameChannel,ProcessPool,type ImageTransformOptions,type FrameExport,type RemoteFrame} from '../../ts'
import {processedFormats} from '../../ts/processed-format'
import {mkdtempSync,readFileSync,rmSync,mkdirSync,copyFileSync,readdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
function reference(bytes:Uint8Array,w:number,h:number,bpp:number,options:ImageTransformOptions){
  const rotation=options.rotation??0,turned=rotation===90||rotation===270,rw=turned?h:w,rh=turned?w:h,
    width=options.transpose?rh:rw,height=options.transpose?rw:rh,out=new Uint8Array(width*height*bpp)
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let dx=rotation===90?h-1-y:rotation===180?w-1-x:rotation===270?y:x,
      dy=rotation===90?x:rotation===180?h-1-y:rotation===270?w-1-x:y
    if(options.hflip)dx=rw-1-dx
    if(options.vflip)dy=rh-1-dy
    if(options.transpose)[dx,dy]=[dy,dx]
    out.set(bytes.subarray((y*w+x)*bpp,(y*w+x+1)*bpp),(dy*width+dx)*bpp)
  }
  return{out,width,height}
}
function checkTransform(image:CapturedImage,options:ImageTransformOptions){
  const bpp=({gray:1,rgb:3,rgba:4})[image.format]*(image.bits/8),expected=reference(image.copyPixels(),image.width,image.height,bpp,options)
  using result=image.transform(options)
  expect([result.width,result.height,result.stride,result.format,result.bits,result.endian]).toEqual([expected.width,expected.height,expected.width*bpp,image.format,image.bits,image.endian])
  expect(Buffer.from(result.copyPixels())).toEqual(Buffer.from(expected.out))
  expect(result.colorSpace).toEqual(image.colorSpace);expect(result.sourceMetadata).toEqual(image.sourceMetadata)
}
for(const format of ['gray','rgb','rgba'] as const)for(const bits of [8,16] as const)for(const endian of ['little','big'] as const)
  test(`${format}${bits} ${endian} exact transforms retain all low bits channels alpha and singleton geometry`,()=>{
    const bpp=({gray:1,rgb:3,rgba:4})[format]*(bits/8)
    for(const [width,height] of [[5,3],[1,4],[3,1],[1,1]]){
      const row=width!*bpp,stride=row+7,data=new Uint8Array(1+(height!-1)*stride+row).fill(0xa5)
      for(let y=0;y<height!;y++)for(let x=0;x<width!;x++)for(let byte=0;byte<bpp;byte++)data[1+y*stride+x*bpp+byte]=(x*37+y*53+byte*29)%256
      using image=CapturedImage.fromRaster({data:data.subarray(1),width:width!,height:height!,stride,format,bits,endian})
      for(const rotation of [0,90,180,270] as const)for(const hflip of [false,true])for(const vflip of [false,true])for(const transpose of [false,true])checkTransform(image,{rotation,hflip,vflip,transpose})
      for(const rotation of [0,90,180,270] as const){using result=image.rotate(rotation);const expected=reference(image.copyPixels(),image.width,image.height,bpp,{rotation});expect(Buffer.from(result.copyPixels())).toEqual(Buffer.from(expected.out))}
      for(const axis of ['horizontal','vertical','both'] as const){using result=image.flip(axis);const expected=reference(image.copyPixels(),image.width,image.height,bpp,{hflip:axis!=='vertical',vflip:axis!=='horizontal'});expect(Buffer.from(result.copyPixels())).toEqual(Buffer.from(expected.out))}
      using transposed=image.transpose();expect(Buffer.from(transposed.copyPixels())).toEqual(Buffer.from(reference(image.copyPixels(),image.width,image.height,bpp,{transpose:true}).out))
      expect(data[0]).toBe(0xa5)
    }
  })
test('transformed image owners survive source closure and retain every sixteen-bit sample',()=>{
  const source=CapturedImage.fromRaster({data:new Uint8Array([0x34,0x12,0x78,0x56,0xbc,0x9a,0xdc,0xfe,0x98,0xba,0x54,0x76]),width:2,height:1,format:'rgb',bits:16})
  using rotated=source.rotate(90);source.close()
  expect(rotated.getPixel16(0,0)).toEqual([0x1234,0x5678,0x9abc,65535]);expect(rotated.getPixel16(0,1)).toEqual([0xfedc,0xba98,0x7654,65535])
  using copy=rotated.transform();const detached=copy.copyPixels();detached.fill(0)
  expect(rotated.getPixel16(0,0)[0]).toBe(0x1234);expect(copy.getPixel16(0,0)[0]).toBe(0x1234)
  expect(()=>source.rotate(90)).toThrow('closed')
})
test('transform option accessors are read once before closed-owner revalidation and malformed options never coerce',()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array([1,2,3,4,5,6]),width:2,height:1})
  const reads:string[]=[],options={} as ImageTransformOptions
  for(const [name,value] of [['rotation',90],['hflip',true],['vflip',false],['transpose',true],['strict',undefined]])Object.defineProperty(options,name as string,{get(){reads.push(name as string);return value}})
  using transformed=image.transform(options);expect(reads).toEqual(['rotation','hflip','vflip','transpose','strict'])
  for(const bad of [null,false,1,[],{rotation:45},{rotation:'90'},{rotation:NaN},{rotation:Infinity},{rotation:null},{hflip:1},{vflip:null},{transpose:{}},{strict:true}])expect(()=>image.transform(bad as any)).toThrow()
  for(const bad of [undefined,null,false,45,360,'90',NaN])expect(()=>image.rotate(bad as any)).toThrow()
  for(const bad of [null,false,1,'x'])expect(()=>image.flip(bad as any)).toThrow()
  const closed=CapturedImage.fromRaster({data:new Uint8Array([1,2,3]),width:1,height:1})
  expect(()=>closed.transform({get rotation(){closed.close();return 90 as const}})).toThrow('closed')
  expect(Buffer.from(image.copyPixels())).toEqual(Buffer.from([1,2,3,4,5,6]))
})
for(const format of processedFormats)test(`${format} transformed captured main and lores images retain provenance after camera retirement`,async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,format,lores:{width:10,height:6,format}}),owned:CapturedImage[]=[]
  try{
    using frame=await camera.captureRequest()
    for(const stream of ['main','lores'] as const)owned.push(frame.makeImage({stream}))
    frame.release();await camera.close()
    for(const image of owned){checkTransform(image,{rotation:90,hflip:true,transpose:true});using rotated=image.rotate(270);using crop=rotated.crop(0,0,2,3);expect([crop.width,crop.height]).toEqual([2,3]);using resized=rotated.resize(7,3);expect(resized.copyPixels().length).toBe(7*3*3*(image.bits/8))}
  }finally{for(const image of owned)image.close();await camera.close()}
})
test('remote and actual process captured images expose independent exact transforms after remote ownership retires',async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,format:'RGB161616',lores:{width:10,height:6,format:'BGR161616'}}),[sender,receiver]=FrameChannel.pair(),pool=await ProcessPool.open({module:new URL('../fixtures/process-handler.ts',import.meta.url)})
  let loan:FrameExport|undefined,remote:RemoteFrame|undefined,image:CapturedImage|undefined
  try{
    using frame=await camera.captureRequest();loan=frame.exportFrame({streams:['main','lores']});loan.trySend(sender.fd,42n);remote=receiver.tryReceive()!;image=remote.makeImage('lores')
    const job=pool.submit<any>(frame,{action:'image-transform',stream:'lores',transform:{rotation:90,vflip:true}},{streams:['lores']});frame.release()
    const result=await job;await job.cleanupDone
    remote.close();remote=undefined;loan.close();loan=undefined;await camera.close()
    const expected=reference(image.copyPixels(),10,6,6,{rotation:90,vflip:true});expect(result.pid).not.toBe(process.pid);expect(Buffer.from(result.pixels)).toEqual(Buffer.from(expected.out));expect([result.width,result.height]).toEqual([expected.width,expected.height]);checkTransform(image,{rotation:90,vflip:true});using processImage=CapturedImage.fromRaster({data:result.pixels,width:result.width,height:result.height,format:result.format,bits:result.bits,endian:result.endian});checkTransform(processImage,{rotation:270,hflip:true,transpose:true})
  }finally{image?.close();remote?.close();loan?.close();sender.close();receiver.close();await pool.close({drain:false});await camera.close()}
})
for(const capture of ['ordinary','focus','mode'] as const)test(`${capture} transformed RGB16 image encoding and async files outlive camera and source owners`,async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,format:'RGB161616'}),dir=mkdtempSync(join(tmpdir(),'zc-oriented-'))
  let source:CapturedImage|undefined,oriented:CapturedImage|undefined
  try{
    if(capture==='focus'){camera.startContinuousAutofocus();source=await camera.captureFocusLockedImage()}
    else if(capture==='mode')source=await camera.switchModeAndCaptureImage({width:10,height:6,format:'BGR161616'})
    else source=await camera.captureImage()
    const originalMetadata=source.sourceMetadata,expected=reference(source.copyPixels(),source.width,source.height,6,{rotation:90,hflip:true})
    oriented=source.transform({rotation:90,hflip:true});source.close();source=undefined;await camera.close()
    expect(oriented.sourceMetadata).toEqual(originalMetadata);expect(oriented.bits).toBe(16)
    const pixels=oriented.copyPixels();expect(Buffer.from(pixels)).toEqual(Buffer.from(expected.out))
    for(const format of ['png','tiff'] as const){
      const path=join(dir,`transformed.${format}`),exif={captureMetadata:false,artist:'Orthogonal still'}
      const bytes=await oriented.encodeAsync({format,exif});await oriented.saveAsync(path,{format,exif})
      expect(readFileSync(path)).toEqual(Buffer.from(bytes))
      if(process.env.ZC_RGB16_DECODER){
        const result=Bun.spawnSync([process.env.ZC_RGB16_DECODER,format,path]),decoded=Buffer.from(result.stdout)
        if(result.exitCode!==0)throw new Error(`RGB16 decoder failed (${result.exitCode}/${result.signalCode}): ${result.stderr.toString()}`)
        expect([decoded.readUInt32LE(0),decoded.readUInt32LE(4)]).toEqual([expected.width,expected.height])
        expect(decoded.subarray(8)).toEqual(Buffer.from(pixels))
      }
      if(process.env.ZC_EXIF_READER){const result=Bun.spawnSync([process.env.ZC_EXIF_READER,format,path]);expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout.toString()).artist).toBe('Orthogonal still')}
    }
  }catch(error){
    const output=join(process.env.ZC_MEDIA_FAILURE_DIR??join(import.meta.dir,'../../zig-out/media-failures'),`orthogonal-${capture}-${Date.now()}`)
    mkdirSync(output,{recursive:true})
    for(const file of readdirSync(dir))copyFileSync(join(dir,file),join(output,file))
    if(oriented&&!oriented.closed)writeFileSync(join(output,'pixels.rgb16'),oriented.copyPixels())
    writeFileSync(join(output,'context.json'),JSON.stringify({capture,width:oriented?.width,height:oriented?.height,format:oriented?.format,bits:oriented?.bits,endian:oriented?.endian,error:String(error)},null,2))
    throw error
  }finally{source?.close();oriented?.close();await camera.close();rmSync(dir,{recursive:true,force:true})}
})
