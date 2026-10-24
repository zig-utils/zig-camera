import { expect, test } from 'bun:test'
import { Camera, Recorder, MuxedOutput, SocketSink, ProcessSink } from '../../ts'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4, decodeAudio, decodeVideo, boxes } from './media'
const media = process.env.ZC_TEST_CODECS === '1' && process.env.ZC_TEST_AAC === '1' ? test : test.skip
function pcm(first: number, frames = 1920) {
  const bytes = Buffer.alloc(frames * 4)
  for (let i=0;i<frames;i++) {
    const value = (((first + i) % 200) - 100) * 100
    bytes.writeInt16LE(value, i*4); bytes.writeInt16LE(-value, i*4+2)
  }
  return bytes
}
function preserve(dir: string) {
  const root = process.env.ZC_MEDIA_FAILURE_DIR ?? new URL('../../zig-out/media-failures',import.meta.url).pathname
  mkdirSync(root,{recursive:true}); cpSync(dir,join(root,`fmp4-${Date.now()}`),{recursive:true})
}
for (const codec of ['h264','hevc'] as const) media(`${codec} forward MP4 streams before flush, preserves late AAC, trims tail and never patches`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-fmp4-')), path=join(dir,'stream.mp4')
  const camera=new Camera({simulate:true,width:128,height:96,fifo:true})
  let data=Buffer.alloc(0), patches=0, stops=0, recorder:Recorder|undefined
  const sink={
    async write(bytes:Uint8Array) {
      await Bun.sleep(0)
      const size=Math.min(bytes.length,257)
      data=Buffer.concat([data,Buffer.from(bytes.subarray(0,size))]); return size
    },
    patch(){patches++;throw Error('forward MP4 attempted to seek')},
    stop(){stops++},
  }
  const sequences:bigint[]=[]
  try {
    recorder=await Recorder.open(new MuxedOutput(sink,'fmp4'),{width:128,height:96,fps:25,codec,gop:4,audio:{sampleRate:48000,channels:2},outputQueue:{maxBytes:1024*1024,maxOperations:32,waitMs:1000}})
    camera.start()
    for(let i=0;i<12;i++) {
      const prefix=Buffer.from(data)
      using frame=camera.acquire(); sequences.push(frame.sequence)
      await recorder.writeAVAsync(frame,[{data:pcm(i*1920),timestampNs:20_000_000n+BigInt(i)*40_000_000n}],BigInt(i)*40_000_000n)
      expect(data.subarray(0,prefix.length)).toEqual(prefix)
    }
    await recorder.drainRecordingAsync()
    expect(data.length).toBeGreaterThan(1000)
    expect(boxes(data).some(x=>x.kind==='moof')).toBe(true)
    await recorder.flushAsync()
    const final=Buffer.from(data)
    await recorder.flushAsync(); expect(data).toEqual(final);expect(patches).toBe(0);expect(stops).toBe(0)
    writeFileSync(path,data)
    const tracks=mp4(path,{forwardOnly:true}), video=tracks.get(1)!,audio=tracks.get(2)!
    expect(video.samples.length).toBe(12);expect(audio.startUs).toBe(20000n)
    decodeVideo(path,video,sequences);decodeAudio(path,audio,0,12*1920-960)
    await recorder.close();recorder=undefined;expect(stops).toBe(1)
  }catch(error){writeFileSync(path,data);preserve(dir);throw error}
  finally{await recorder?.close().catch(()=>{});camera.close();rmSync(dir,{recursive:true,force:true})}
})
for(const transport of ['tcp','process'] as const) media(`${transport} receives Home forward AAC MP4 through a non-seekable sink`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-fmp4-transport-')), path=join(dir,'stream.mp4'),chunks:Buffer[]=[]
  let eof=false
  const server=transport==='tcp'?Bun.listen({hostname:'127.0.0.1',port:0,socket:{data(_,data){chunks.push(Buffer.from(data))},end(socket){eof=true;socket.end()},error(_,error){throw error}}}):undefined
  const sink=server?new SocketSink({address:'127.0.0.1',port:server.port,chunkBytes:97}):new ProcessSink({command:[process.execPath,new URL('../fixtures/process-output-consumer.ts',import.meta.url).pathname,'copy-file',path],chunkBytes:97})
  const codec=transport==='tcp'?'h264':'hevc',camera=new Camera({simulate:true,width:128,height:96,fifo:true})
  let recorder:Recorder|undefined
  const sequences:bigint[]=[]
  try{
    recorder=await Recorder.open(new MuxedOutput(sink,'fmp4'),{width:128,height:96,fps:25,codec,gop:4,audio:{sampleRate:48000,channels:2}})
    camera.start()
    for(let i=0;i<8;i++) {using frame=camera.acquire();sequences.push(frame.sequence);await recorder.writeAVAsync(frame,[{data:pcm(i*1920),timestampNs:BigInt(i)*40_000_000n}],BigInt(i)*40_000_000n)}
    await recorder.close();recorder=undefined
    if(server){const deadline=Date.now()+5000;while(!eof){if(Date.now()>deadline)throw Error('receiver EOF deadline');await Bun.sleep(1)}writeFileSync(path,Buffer.concat(chunks))}
    const tracks=mp4(path,{forwardOnly:true});expect(tracks.get(2)!.startUs).toBe(0n)
    decodeVideo(path,tracks.get(1)!,sequences);decodeAudio(path,tracks.get(2)!,0,8*1920)
    if(sink instanceof ProcessSink)expect(sink.stats().consumerExitCode).toBe(0)
  }catch(error){if(server)writeFileSync(path,Buffer.concat(chunks));preserve(dir);throw error}
  finally{await recorder?.close().catch(()=>{});await sink.close().catch(()=>{});camera.close();server?.stop(true);rmSync(dir,{recursive:true,force:true})}
})
media('forward AAC sessions without PCM finish with only priming and zero presented samples',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-fmp4-empty-')),path=join(dir,'empty.mp4'),chunks:Buffer[]=[]
  const camera=new Camera({simulate:true,width:128,height:96,fifo:true})
  let recorder:Recorder|undefined
  try{
    recorder=await Recorder.open({format:'fmp4',write(bytes){chunks.push(Buffer.from(bytes))}},{width:128,height:96,fps:25,codec:'h264',audio:{sampleRate:48000,channels:2}})
    camera.start()
    for(let i=0;i<4;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    expect(chunks.length).toBe(0)
    await recorder.close();recorder=undefined;writeFileSync(path,Buffer.concat(chunks))
    const audio=mp4(path,{forwardOnly:true}).get(2)!;expect(audio.presentedUs).toBe(0n);expect(audio.mediaDuration).toBe(BigInt(audio.delay!))
  }catch(error){writeFileSync(path,Buffer.concat(chunks));preserve(dir);throw error}
  finally{await recorder?.close().catch(()=>{});camera.close();rmSync(dir,{recursive:true,force:true})}
})

for (const codec of ['h264','hevc'] as const) media(`${codec} forward MP4 async splits and restarted sessions keep independent AAC clocks`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-fmp4-split-')),camera=new Camera({simulate:true,width:128,height:96,fifo:true})
  const buffers:Buffer[][]=[[],[],[]]
  const output=(i:number)=>new MuxedOutput({write(bytes){buffers[i].push(Buffer.from(bytes))}},'fmp4')
  let recorder:Recorder|undefined,split:ReturnType<Recorder['split']>|undefined
  const sequences:bigint[]=[]
  try{
    recorder=await Recorder.open(output(0),{width:128,height:96,fps:25,codec,gop:4,audio:{sampleRate:48000,channels:2}})
    camera.start()
    for(let i=0;i<20;i++){
      if(i===5)split=recorder.split(output(1))
      using frame=camera.acquire();sequences.push(frame.sequence)
      await recorder.writeAVAsync(frame,[{data:pcm(i*1920),timestampNs:BigInt(i)*40_000_000n}],BigInt(i)*40_000_000n)
    }
    await split;split?.close();split=undefined
    await recorder.flushAsync()
    let first=0
    for(let i=0;i<2;i++){
      const path=join(dir,`split-${i}.mp4`);writeFileSync(path,Buffer.concat(buffers[i]));const tracks=mp4(path,{forwardOnly:true}),video=tracks.get(1)!
      decodeVideo(path,video,sequences.slice(first,first+video.samples.length));decodeAudio(path,tracks.get(2)!,first*1920,video.samples.length*1920);first+=video.samples.length
    }
    expect(first).toBe(20)
    await recorder.restartAsync(output(2))
    const restarted:bigint[]=[]
    for(let i=0;i<5;i++){
      using frame=camera.acquire();restarted.push(frame.sequence)
      await recorder.writeAVAsync(frame,[{data:pcm(i*1920),timestampNs:BigInt(i)*40_000_000n}],BigInt(i)*40_000_000n)
    }
    await recorder.close();recorder=undefined
    const path=join(dir,'restarted.mp4');writeFileSync(path,Buffer.concat(buffers[2]));const tracks=mp4(path,{forwardOnly:true})
    decodeVideo(path,tracks.get(1)!,restarted);decodeAudio(path,tracks.get(2)!,0,5*1920)
  }catch(error){buffers.forEach((bytes,i)=>writeFileSync(join(dir,`raw-${i}.mp4`),Buffer.concat(bytes)));preserve(dir);throw error}
  finally{await recorder?.close().catch(()=>{});split?.close();camera.close();rmSync(dir,{recursive:true,force:true})}
})
for(const codec of ['h264','hevc'] as const) media(`${codec} circular snapshot streams forward MP4 with fresh AAC priming`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-fmp4-snapshot-')),path=join(dir,'snapshot.mp4'),chunks:Buffer[]=[]
  const camera=new Camera({simulate:true,width:128,height:96,fifo:true}),sequences:bigint[]=[]
  const recorder=new Recorder(null,{width:128,height:96,fps:25,codec,gop:4,circular:{maxFrames:6,maxBytes:1024*1024,durationMs:1000},audio:{sampleRate:48000,channels:2}})
  try{
    camera.start()
    for(let i=0;i<8;i++){
      using frame=camera.acquire();sequences.push(frame.sequence)
      await recorder.writeAVAsync(frame,[{data:pcm(i*1920),timestampNs:BigInt(i)*40_000_000n}],BigInt(i)*40_000_000n)
    }
    const end=Number(recorder.bufferStats().lastNs/40_000_000n)+1
    const job=recorder.snapshot(new MuxedOutput({write(bytes){chunks.push(Buffer.from(bytes))}},'fmp4'))
    await job
    writeFileSync(path,Buffer.concat(chunks));const tracks=mp4(path,{forwardOnly:true})
    expect(tracks.get(1)!.samples.length).toBe(end-4)
    decodeVideo(path,tracks.get(1)!,sequences.slice(4,end));decodeAudio(path,tracks.get(2)!,4*1920,(end-4)*1920)
  }catch(error){writeFileSync(path,Buffer.concat(chunks));preserve(dir);throw error}
  finally{await recorder.close().catch(()=>{});camera.close();rmSync(dir,{recursive:true,force:true})}
})
media('a failing forward MP4 consumer retires independently while a healthy recording finishes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-fmp4-failure-')),path=join(dir,'healthy.mp4'),chunks:Buffer[]=[]
  const camera=new Camera({simulate:true,width:128,height:96,fifo:true}),sequences:bigint[]=[]
  let recorder:Recorder|undefined
  try{
    recorder=await Recorder.open(new MuxedOutput({write(bytes){chunks.push(Buffer.from(bytes))}},'fmp4'),{width:128,height:96,fps:25,codec:'h264',gop:4,isolate:true,audio:{sampleRate:48000,channels:2}})
    const id=await recorder.addOutput({format:'fmp4',write(){throw Error('forward consumer failed')}})
    camera.start()
    for(let i=0;i<8;i++){
      using frame=camera.acquire();sequences.push(frame.sequence)
      await recorder.writeAVAsync(frame,[{data:pcm(i*1920),timestampNs:BigInt(i)*40_000_000n}],BigInt(i)*40_000_000n)
    }
    await expect(Promise.resolve(recorder.drainRecordingAsync())).rejects.toThrow('forward consumer failed');expect(recorder.outputState(id).errorCode).not.toBe(0)
    await recorder.close();recorder=undefined;writeFileSync(path,Buffer.concat(chunks));const tracks=mp4(path,{forwardOnly:true})
    decodeVideo(path,tracks.get(1)!,sequences);decodeAudio(path,tracks.get(2)!,0,8*1920)
  }catch(error){writeFileSync(path,Buffer.concat(chunks));preserve(dir);throw error}
  finally{await recorder?.close().catch(()=>{});camera.close();rmSync(dir,{recursive:true,force:true})}
})
