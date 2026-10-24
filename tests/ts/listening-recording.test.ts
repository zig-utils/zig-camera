import {expect,test} from 'bun:test'
import {createConnection} from 'node:net'
import {Camera,Recorder,ListeningSocketSink,ListeningSocketOutput,MuxedOutput,PtsOutput,PtsStream} from '../../ts'
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,cpSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mp4,decodeVideo,decodeAudio} from './media'
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('listening recording deadline');await Bun.sleep(1)}}
async function receiver(sink:ListeningSocketSink){
  await until(()=>sink.listenerStats().listening)
  const local=sink.listenerStats().local!,socket=createConnection({host:local.address,port:local.port,allowHalfOpen:true}),chunks:Buffer[]=[]
  let closed=false
  socket.on('data',bytes=>chunks.push(Buffer.from(bytes)));socket.on('error',()=>{});socket.on('end',()=>socket.end());socket.on('close',()=>{closed=true})
  return {socket,chunks,get closed(){return closed}}
}
function preserve(dir:string){const root=process.env.ZC_MEDIA_FAILURE_DIR??new URL('../../zig-out/media-failures',import.meta.url).pathname;mkdirSync(root,{recursive:true});cpSync(dir,join(root,`listening-${Date.now()}`),{recursive:true})}
for(const codec of ['mjpeg','h264','hevc'] as const)test(`inbound ${codec} recording receives exact Home packets and shared source PTS`,async()=>{
  if(codec!=='mjpeg'&&!process.env.ZC_TEST_CODECS)return
  const sink=new ListeningSocketSink({address:'127.0.0.1',port:0,chunkBytes:127}),clockBytes:Buffer[]=[],clock=await PtsStream.open({write(bytes){clockBytes.push(Buffer.from(bytes))}})
  const output=new PtsOutput(new ListeningSocketOutput(sink),clock),camera=new Camera({simulate:true,width:64,height:48,fifo:true}),packets:Buffer[]=[]
  const opening=Recorder.open(output,{width:64,height:48,fps:25,codec,...(codec==='mjpeg'?{}:{gop:2})});opening.catch(()=>{})
  let recorder:Recorder|undefined,client:Awaited<ReturnType<typeof receiver>>|undefined
  try{client=await receiver(sink);recorder=await opening;await recorder.addOutput({outputframe(packet){if(!packet.audio)packets.push(Buffer.from(packet.data))}})
    camera.start();for(let i=0;i<6;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recorder.close();recorder=undefined;await clock.close();await until(()=>client!.closed)
    expect(packets.length).toBe(6);expect(Buffer.concat(client.chunks)).toEqual(Buffer.concat(packets));expect(Buffer.concat(clockBytes).toString()).toBe('0.000\n40.000\n80.000\n120.000\n160.000\n200.000\n')
  }finally{await sink.close();await recorder?.close();await opening.catch(()=>{});await clock.close();camera.close();client?.socket.destroy()}
})
for(const codec of ['h264','hevc'] as const)test.skipIf(!process.env.ZC_TEST_CODECS||!process.env.ZC_TEST_AAC)(`inbound ${codec}/AAC forward MP4 independently decodes before the listener session retires`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-listener-mp4-')),path=join(dir,'clip.mp4'),sink=new ListeningSocketSink({address:'127.0.0.1',port:0,chunkBytes:97})
  const camera=new Camera({simulate:true,width:128,height:96,fifo:true}),sequences:bigint[]=[]
  const opening=Recorder.open(new MuxedOutput(sink,'fmp4'),{width:128,height:96,fps:25,codec,gop:4,audio:{sampleRate:48000,channels:2}});opening.catch(()=>{})
  let recorder:Recorder|undefined,client:Awaited<ReturnType<typeof receiver>>|undefined
  try{client=await receiver(sink);recorder=await opening;camera.start()
    for(let i=0;i<8;i++){
      const pcm=Buffer.alloc(1920*4);for(let n=0;n<1920;n++){const value=(((i*1920+n)%200)-100)*100;pcm.writeInt16LE(value,n*4);pcm.writeInt16LE(-value,n*4+2)}
      using frame=camera.acquire();sequences.push(frame.sequence)
      await recorder.writeAVAsync(frame,[{data:pcm,timestampNs:BigInt(i)*40_000_000n}],BigInt(i)*40_000_000n)
    }
    await recorder.flushAsync();await until(()=>Buffer.concat(client!.chunks).length===Number(sink.stats().bytes))
    expect(client.closed).toBe(false)
    writeFileSync(path,Buffer.concat(client.chunks));const tracks=mp4(path,{forwardOnly:true});decodeVideo(path,tracks.get(1)!,sequences);decodeAudio(path,tracks.get(2)!,0,8*1920)
    await recorder.close();recorder=undefined;await until(()=>client!.closed)
  }catch(error){if(client)writeFileSync(path,Buffer.concat(client.chunks));preserve(dir);throw error}
  finally{await sink.close();await recorder?.close().catch(()=>{});await opening.catch(()=>{});camera.close();client?.socket.destroy();rmSync(dir,{recursive:true,force:true})}
})
test('async listening-output splits accept fresh consumers and join both complete byte streams',async()=>{
  const first=new ListeningSocketSink({address:'127.0.0.1',port:0}),second=new ListeningSocketSink({address:'127.0.0.1',port:0}),camera=new Camera({simulate:true,width:32,height:24,fifo:true}),packets:Buffer[]=[]
  const opening=Recorder.open(new ListeningSocketOutput(first),{width:32,height:24,fps:25});opening.catch(()=>{})
  let recorder:Recorder|undefined,a:Awaited<ReturnType<typeof receiver>>|undefined,b:Awaited<ReturnType<typeof receiver>>|undefined,job:ReturnType<Recorder['split']>|undefined
  try{a=await receiver(first);recorder=await opening;await recorder.addOutput({outputframe(packet){packets.push(Buffer.from(packet.data))}});camera.start()
    for(let i=0;i<4;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    job=recorder.split(new ListeningSocketOutput(second));b=await receiver(second)
    for(let i=4;i<14;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n);await Bun.sleep(1)}
    await job;job.close();job=undefined;await recorder.close();recorder=undefined;await until(()=>a!.closed&&b!.closed)
    expect(Buffer.concat([...a.chunks,...b.chunks])).toEqual(Buffer.concat(packets));expect(packets.length).toBe(14)
    expect(a.chunks.length).toBeGreaterThan(0);expect(b.chunks.length).toBeGreaterThan(0)
  }finally{await first.close();await second.close();await recorder?.close();await opening.catch(()=>{});job?.close();camera.close();a?.socket.destroy();b?.socket.destroy()}
})
test('a reset inbound peer is isolated and async recovery accepts a replacement without losing healthy frames',async()=>{
  const first=new ListeningSocketSink({address:'127.0.0.1',port:0}),next=new ListeningSocketSink({address:'127.0.0.1',port:0}),camera=new Camera({simulate:true,width:32,height:24,fifo:true})
  let healthy=0,client:Awaited<ReturnType<typeof receiver>>|undefined,replacement:Awaited<ReturnType<typeof receiver>>|undefined,job:ReturnType<Recorder['recover']>|undefined
  const recorder=await Recorder.open({outputframe(){healthy++}},{width:32,height:24,fps:25,isolate:true})
  try{const adding=recorder.addOutput(new ListeningSocketOutput(first));client=await receiver(first);const id=await adding;camera.start()
    for(let i=0;i<4;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    client.socket.resetAndDestroy()
    for(let i=4;i<8;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n);await Bun.sleep(1)}
    await until(()=>recorder.outputState(id).errorCode!==0)
    job=recorder.recover(new ListeningSocketOutput(next),id);replacement=await receiver(next)
    for(let i=8;i<18;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n);await Bun.sleep(1)}
    await job;job.close();job=undefined;await recorder.close();await until(()=>replacement!.closed)
    expect(healthy).toBe(18);expect(replacement.chunks.length).toBeGreaterThan(0)
  }finally{await first.close();await next.close();await recorder.close();job?.close();camera.close();client?.socket.destroy();replacement?.socket.destroy()}
})
test('inbound Home Matroska carries exact timestamped PCM and video',async()=>{
  const {simpleBlocks}=await import('./matroska-receiver'),sink=new ListeningSocketSink({address:'127.0.0.1',port:0}),camera=new Camera({simulate:true,width:32,height:24,fifo:true})
  const opening=Recorder.open(new MuxedOutput(sink,'mkv'),{width:32,height:24,fps:25,audio:{sampleRate:48000,channels:2}});opening.catch(()=>{})
  let recorder:Recorder|undefined,client:Awaited<ReturnType<typeof receiver>>|undefined
  try{client=await receiver(sink);recorder=await opening;camera.start();const pcm=Buffer.alloc(9600*4);for(let n=0;n<pcm.length;n+=2)pcm.writeInt16LE((n%20000)-10000,n)
    await recorder.writeAudioAsync(pcm,0n)
    for(let i=0;i<5;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recorder.close();recorder=undefined;await until(()=>client!.closed)
    const blocks=simpleBlocks(Buffer.concat(client.chunks));expect(blocks.filter(b=>b.track===1).length).toBe(5)
    const audio=blocks.filter(b=>b.track===2);expect(Buffer.concat(audio.map(b=>b.data))).toEqual(pcm);expect(audio[0].timeNs).toBe(0n)
  }finally{await sink.close();await recorder?.close();await opening.catch(()=>{});camera.close();client?.socket.destroy()}
})
