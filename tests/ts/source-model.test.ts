import {test,expect} from 'bun:test'
import {Camera,FrameChannel,type FrameExport,type RemoteFrame} from '../../ts'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const limits={maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxWorkingBytes:4*1024*1024}
function modelTags(bytes:Uint8Array,model:string){
  const b=Buffer.from(bytes),count=b.readUInt16LE(8)
  for(const tag of [272,50708]){
    let found=false
    for(let i=0;i<count;i++){
      const at=10+i*12
      if(b.readUInt16LE(at)!==tag)continue
      expect(b.readUInt16LE(at+2)).toBe(2)
      const n=b.readUInt32LE(at+4),offset=n<=4?at+8:b.readUInt32LE(at+8)
      expect(n).toBe(Buffer.byteLength(model)+1)
      expect(b.toString('ascii',offset,offset+n-1)).toBe(model)
      expect(b[offset+n-1]).toBe(0);found=true
    }
    expect(found).toBe(true)
  }
}
for(const rawFormat of ['SRGGB12_CSI2P','MONO_PISP_COMP1'])test(`${rawFormat} source property model survives local and remote async codec ownership`,async()=>{
  const camera=new Camera({simulate:true,fifo:true,width:18,height:10,raw:true,rawFormat}),dir=mkdtempSync(join(tmpdir(),'zc-source-model-')),[sender,receiver]=FrameChannel.pair()
  let loan:FrameExport|undefined,remote:RemoteFrame|undefined
  const jobs:PromiseLike<Uint8Array>[]=[]
  try{
    using frame=await camera.captureRequest()
    const model=frame.properties().records.find(record=>record.name==='Model')!.values[0]!.value as string
    const expected=frame.encodeImage({format:'dng'})
    loan=frame.exportFrame({streams:['main','raw']});expect(loan.trySend(sender.fd,42n)).toBe(true);remote=receiver.tryReceive()!
    jobs.push(frame.encodeImageAsync({format:'dng',...limits}),frame.encodeImageAsync({format:'png',exif:true,...limits}),remote.encodeImageAsync({format:'dng',...limits}),remote.encodeImageAsync({format:'tiff',exif:true,...limits}))
    remote.close();remote=undefined;loan.close();loan=undefined;frame.release();await camera.close()
    const results=await Promise.all(jobs)
    for(const index of [0,2]){
      expect(Buffer.from(results[index]!)).toEqual(Buffer.from(expected));modelTags(results[index]!,model)
      const path=join(dir,`owned-${index}.dng`);writeFileSync(path,results[index]!)
      if(process.env.ZC_RAW16_DECODER){const decoded=Bun.spawnSync([process.env.ZC_RAW16_DECODER,path,model]);expect(decoded.exitCode).toBe(0)}
    }
    if(process.env.ZC_EXIF_READER)for(const [index,format] of [[1,'png'],[3,'tiff']] as const){
      const path=join(dir,`owned.${format}`);writeFileSync(path,results[index]!)
      const result=Bun.spawnSync([process.env.ZC_EXIF_READER,format,path]);expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString()).model).toBe(model)
    }
  }finally{
    await Promise.allSettled(jobs);remote?.close();loan?.close();sender.close();receiver.close();await camera.close();rmSync(dir,{recursive:true,force:true})
  }
})
