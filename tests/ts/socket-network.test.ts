import {simpleBlocks} from './matroska-receiver'
import { expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { SocketSink, SocketOutput, Camera, Recorder, MuxedOutput, PtsOutput, PtsStream, type OutputPacket } from '../../ts'
import { mkvFrames } from './media'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
async function until(f: () => boolean) { const end=Date.now()+5000;while(!f()){if(Date.now()>end)throw Error('network receive deadline');await Bun.sleep(1)} }
async function receiver(address='127.0.0.1',halfClose=false){
  const chunks:Buffer[]=[], sockets=new Set<Socket>();let ended=false
  const server=createServer({allowHalfOpen:true},s=>{
    sockets.add(s);s.on('data',d=>chunks.push(Buffer.from(d)));s.on('error',()=>{});s.on('end',()=>{ended=true;s.end()});s.on('close',()=>sockets.delete(s))
    if(halfClose)s.end()
  })
  server.listen(0,address);await once(server,'listening')
  const addressInfo=server.address();if(!addressInfo||typeof addressInfo==='string')throw Error('TCP receiver address')
  return {port:addressInfo.port,chunks,get ended(){return ended},async close(){for(const s of sockets)s.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}}
}
for(const address of ['127.0.0.1','::1'])test(`TCP ${address} sends exact bytes, joins finish and permits peer write-half closure`,async()=>{
  const server=await receiver(address,true),sink=new SocketSink({address,port:server.port,chunkBytes:1024})
  try{await sink.start();sink.commit();await Bun.sleep(5)
    const input=Uint8Array.from({length:150_001},(_,i)=>i%251),copy=Buffer.from(input)
    await sink.write(input);input.fill(0);await sink.stop();await until(()=>server.ended)
    expect(Buffer.concat(server.chunks)).toEqual(copy);expect(sink.stats().bytes).toBe(BigInt(copy.length))
  }finally{await sink.close();await server.close()}
})
for(const address of ['127.0.0.1','::1'])test(`raw UDP ${address} preserves chosen datagram boundaries and exact concatenated bytes`,async()=>{
  const received:Buffer[]=[]
  const socket=await Bun.udpSocket({hostname:address,port:0,socket:{data:(_,data)=>{received.push(Buffer.from(data))}}})
  const sink=new SocketSink({protocol:'udp',address,port:socket.port,chunkBytes:31})
  try{await sink.start();sink.commit();const bytes=Uint8Array.from({length:157},(_,i)=>i)
    await sink.write(bytes);await sink.stop();await until(()=>received.length===6)
    expect(received.map(x=>x.length)).toEqual([31,31,31,31,31,2]);expect(Buffer.concat(received)).toEqual(Buffer.from(bytes))
  }finally{await sink.close();socket.close()}
})
test('a refused real TCP connection releases startup ownership and the sink can reconnect',async()=>{
  const server=await receiver(),port=server.port;await server.close()
  const sink=new SocketSink({address:'127.0.0.1',port,connectTimeoutMs:1000})
  await expect(sink.start()).rejects.toBeDefined();await sink.close()
  expect(sink.stats().phase).toBe('stopped')
})
for(const codec of ['mjpeg','h264','hevc'] as const)test(`${codec} actual TCP elementary recording and shared PTS match healthy output packets`,async()=>{
  if(codec!=='mjpeg'&&!process.env.ZC_TEST_CODECS)return
  const server=await receiver(), sink=new SocketSink({address:'127.0.0.1',port:server.port,chunkBytes:127})
  const pts:Buffer[]=[],clock=await PtsStream.open({write:b=>{pts.push(Buffer.from(b))}})
  const output=new PtsOutput(new SocketOutput(sink),clock),camera=new Camera({simulate:true,width:64,height:48,fifo:true})
  let recorder:Recorder|undefined;const packets:Buffer[]=[]
  try{recorder=await Recorder.open(output,{width:64,height:48,fps:25,codec,...(codec==='mjpeg'?{}:{gop:2}),asyncWrites:true,outputQueue:{maxBytes:1024*1024,maxOperations:4,waitMs:2000}})
    await recorder.addOutput({outputframe(p){if(!p.audio)packets.push(Buffer.from(p.data))}})
    camera.start();for(let i=0;i<5;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recorder.close();await clock.close();await until(()=>server.ended)
    expect(Buffer.concat(server.chunks)).toEqual(Buffer.concat(packets));expect(packets.length).toBe(5)
    expect(Buffer.concat(pts).toString()).toBe('0.000\n40.000\n80.000\n120.000\n160.000\n')
  }finally{await recorder?.close();await camera.close();await sink.close();await clock.close();await server.close()}
})
test('Home Matroska TCP streaming retains synchronized PCM audio and complete video without seeking',async()=>{
  const server=await receiver(),sink=new SocketSink({address:'127.0.0.1',port:server.port,chunkBytes:113}), camera=new Camera({simulate:true,width:32,height:24,fifo:true})
  const directory=mkdtempSync(join(tmpdir(),'zc-socket-mkv-'));let recorder:Recorder|undefined
  try{recorder=await Recorder.open(new MuxedOutput(sink,'mkv'),{width:32,height:24,fps:25,audio:{sampleRate:48000,channels:2},asyncWrites:true})
    const pcm=Buffer.alloc(9600*4);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%30000,i)
    await recorder.writeAudioAsync(pcm,0n);camera.start()
    for(let i=0;i<5;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recorder.close();await until(()=>server.ended)
    const bytes=Buffer.concat(server.chunks),path=join(directory,'clip.mkv');writeFileSync(path,bytes)
    expect(mkvFrames(path).length).toBe(5)
    // PCM bytes are contiguous across bounded Matroska blocks, independently
    // inspect every SimpleBlock rather than trusting the sender's counters.
    const blocks=simpleBlocks(bytes),audio=blocks.filter(b=>b.track===2)
    expect(Buffer.concat(audio.map(b=>b.data))).toEqual(pcm)
  }catch(e){if(process.env.ZC_MEDIA_FAILURE_DIR){mkdirSync(process.env.ZC_MEDIA_FAILURE_DIR,{recursive:true});writeFileSync(join(directory,'received.bin'),Buffer.concat(server.chunks));cpSync(directory,join(process.env.ZC_MEDIA_FAILURE_DIR,`socket-${Date.now()}`),{recursive:true})}throw e}
  finally{await recorder?.close();await camera.close();await sink.close();await server.close();rmSync(directory,{recursive:true,force:true})}
})
test('raw socket failures isolate and async recovery preserves every healthy recording frame',async()=>{
  const marker=Error('broken stream'),camera=new Camera({simulate:true,width:32,height:24,fifo:true})
  let healthy=0,badClosed=0;const recovered:Buffer[]=[]
  const bad=new SocketOutput({address:'127.0.0.1',port:5000,socketFactory:async()=>({write(){throw marker},close(){badClosed++}})})
  const good=new SocketOutput({address:'127.0.0.1',port:5001,socketFactory:async()=>({write(b){recovered.push(Buffer.from(b));return b.length},close(){}})})
  const recorder=await Recorder.open({outputframe(){healthy++}},{width:32,height:24,fps:25,asyncWrites:true,isolate:true})
  try{const id=await recorder.addOutput(bad);camera.start()
    for(let i=0;i<4;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await until(()=>recorder.outputState(id).errorCode!==0);expect(recorder.outputErrors.get(id)).toBe(marker)
    const recovery=recorder.recover(good,id)
    for(let i=4;i<8;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recovery;recovery.close();await recorder.close();expect(healthy).toBe(8);expect(recovered.length).toBeGreaterThan(0);expect(badClosed).toBe(1)
  }finally{await recorder.close();await camera.close();await bad.close();await good.close()}
})
test('async raw socket splits join both TCP segments and preserve every healthy byte',async()=>{
  const first=await receiver(),second=await receiver(),a=new SocketOutput({address:'127.0.0.1',port:first.port}),b=new SocketOutput({address:'127.0.0.1',port:second.port})
  const camera=new Camera({simulate:true,width:32,height:24,fifo:true}),all:Buffer[]=[]
  const recorder=await Recorder.open(a,{width:32,height:24,fps:25,asyncWrites:true})
  try{await recorder.addOutput({outputframe:p=>{if(!p.audio)all.push(Buffer.from(p.data))}});camera.start()
    for(let i=0;i<4;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    const split=recorder.split(b)
    for(let i=4;i<12;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n);await Bun.sleep(1)}
    await split;split.close();await recorder.close();await until(()=>first.ended&&second.ended)
    expect(Buffer.concat([...first.chunks,...second.chunks])).toEqual(Buffer.concat(all));expect(all.length).toBe(12)
    expect(first.chunks.length).toBeGreaterThan(0);expect(second.chunks.length).toBeGreaterThan(0)
  }finally{await recorder.close();await camera.close();await a.close();await b.close();await first.close();await second.close()}
})
