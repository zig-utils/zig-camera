import { test, expect } from 'bun:test'
import { SocketSink, SocketOutput, CameraError, type SocketTransportFactory, type SocketTransportHandlers, type SocketTransport, type OutputPacket } from '../../ts'
const failure = (p: Promise<unknown>) => p.then(() => undefined, e => e)
async function until(f: () => boolean) { const end = Date.now()+5000; while (!f()) { if(Date.now()>end) throw Error('socket test deadline'); await Bun.sleep(1) } }
function fixture(options: { protocol?: 'tcp' | 'udp'; chunkBytes?: number; writeTimeoutMs?: number; finishTimeoutMs?: number } = {}) {
  const writes: Buffer[] = []; let handlers!: SocketTransportHandlers
  let blocked = false, prefix = 0, closes = 0, closeFailure = false, finishFailure = false
  const socket: SocketTransport = {
    write(data) { if(blocked) return 0; const n=prefix || data.length; writes.push(Buffer.from(data.subarray(0,n))); return n },
    finish() { if(finishFailure) throw Error('finish failure') },
    close() { if(closeFailure) throw Error('close failure'); closes++ },
  }
  const factory: SocketTransportFactory = async (_, h) => { handlers=h; return socket }
  const sink = new SocketSink({ address:'127.0.0.1',port:5000,chunkBytes:4,...options,socketFactory:factory })
  return { sink, socket, factory, writes, get handlers(){return handlers}, get closes(){return closes},
    block(v=true){blocked=v}, prefix(n:number){prefix=n}, closeFailure(v=true){closeFailure=v}, finishFailure(v=true){finishFailure=v} }
}
async function ready(sink: SocketSink) { await sink.start(); sink.commit() }
for(const protocol of ['tcp','udp'] as const) test(`${protocol} raw chunks preserve exact bytes and short final chunk`,async()=>{
  const f=fixture({protocol}); await ready(f.sink)
  try { await f.sink.write(Buffer.from('abcdefghij')); expect(f.writes.map(x=>x.toString())).toEqual(['abcd','efgh','ij']); expect(f.sink.stats().bytes).toBe(10n) }
  finally {await f.sink.stop()}
  expect(f.closes).toBe(1)
})
test('TCP partial acceptance retains every suffix while UDP partial acceptance fails',async()=>{
  const f=fixture(); await ready(f.sink); f.prefix(1)
  await f.sink.write(Buffer.from('abcd')); await f.sink.stop(); expect(Buffer.concat(f.writes).toString()).toBe('abcd')
  const g=fixture({protocol:'udp'}); await ready(g.sink); g.prefix(1)
  await expect(g.sink.write(Buffer.from('abcd'))).rejects.toBeInstanceOf(CameraError); await g.sink.stop(); expect(g.closes).toBe(1)
})
test('blocked writes are bounded, reject overlapping producers and join a normal stop',async()=>{
  const f=fixture(); await ready(f.sink); f.block()
  const writing=f.sink.write(Buffer.from('abcdef')); await until(()=>f.sink.stats().waits>0n)
  await expect(f.sink.write(Buffer.from('another'))).rejects.toMatchObject({code:-4})
  let done=false; const stopping=f.sink.stop().then(()=>{done=true}); await Bun.sleep(5);expect(done).toBe(false);expect(f.closes).toBe(0)
  f.block(false);f.handlers.writable(); await writing;await stopping
  expect(Buffer.concat(f.writes).toString()).toBe('abcdef');expect(f.closes).toBe(1)
})
test('discard escalates an active drain and retires a blocked producer without waiting for its deadline',async()=>{
  const f=fixture({writeTimeoutMs:1000}); await ready(f.sink);f.block()
  const writing=failure(f.sink.write(Buffer.from('abc'))); await until(()=>f.sink.stats().waits>0n)
  const stopping=f.sink.stop();expect(f.sink.stop({discard:true})).toBe(stopping)
  expect(await writing).toMatchObject({code:-2});await stopping;expect(f.closes).toBe(1)
})
test('write deadlines and errors between writes surface and retain retryable close ownership',async()=>{
  const f=fixture({writeTimeoutMs:10});await ready(f.sink);f.block()
  await expect(f.sink.write(Buffer.from('abc'))).rejects.toMatchObject({code:-3});await f.sink.stop()
  const g=fixture();await ready(g.sink);g.handlers.error(Error('late network error'));g.closeFailure()
  await expect(g.sink.stop()).rejects.toThrow('close failure');expect(g.sink.stats().phase).toBe('stopping')
  g.closeFailure(false);await g.sink.stop();expect(g.closes).toBe(1)
})
test('finish errors fail normal stop and late errors cannot poison a new session',async()=>{
  const f=fixture();await ready(f.sink);const old=f.handlers;f.finishFailure()
  await expect(f.sink.stop()).rejects.toThrow('finish failure');f.finishFailure(false)
  await ready(f.sink);old.error(Error('old'));old.writable();await f.sink.write(Buffer.from('ok'));await f.sink.stop()
  expect(f.sink.stats().bytes).toBe(2n);expect(f.sink.stats().session).toBe(2)
})
test('start cancellation joins late factory cleanup before its stop fence',async()=>{
  let release!:(s:SocketTransport)=>void,signal!:AbortSignal,closed=0
  const sink=new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async(_,__,s)=>{signal=s;return new Promise(r=>{release=r})}})
  const opening=failure(sink.start());await until(()=>!!release);const stopping=sink.close();expect(signal.aborted).toBe(true)
  let done=false;void stopping.then(()=>{done=true});await Bun.sleep(5);expect(done).toBe(false)
  release({write:b=>b.length,close(){closed++}});expect(await opening).toMatchObject({code:-2});await stopping;expect(closed).toBe(1)
})
test('connect and finish deadlines abort cooperative transports and release capacity',async()=>{
  for(const stage of ['connect','finish'] as const){
    const waiting=(signal:AbortSignal)=>new Promise<never>((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason)})
    let closed=0
    const sink=new SocketSink({address:'127.0.0.1',port:5000,connectTimeoutMs:10,finishTimeoutMs:10,
      socketFactory:async(_,__,signal)=>{if(stage==='connect')await waiting(signal);return {write:b=>b.length,finish:waiting,close(){closed++}}}})
    if(stage==='connect'){await expect(sink.start()).rejects.toMatchObject({code:-3});await sink.close();expect(closed).toBe(0)}
    else{await ready(sink);await expect(sink.stop()).rejects.toMatchObject({code:-3});expect(closed).toBe(1)}
  }
})
test('transport aliases cannot be owned twice and setup close failures retain their owner',async()=>{
  const f=fixture();await ready(f.sink)
  const other=new SocketSink({address:'127.0.0.1',port:5001,socketFactory:f.factory})
  await expect(other.start()).rejects.toMatchObject({code:-4});expect(f.closes).toBe(0);await other.close();await f.sink.close()
  let fail=true,closed=0
  const third=new SocketSink({address:'127.0.0.1',port:5002,socketFactory:async(_,h)=>{h.error(Error('prepare'));return {write:b=>b.length,close(){if(fail)throw Error('cleanup');closed++}}}})
  await expect(third.start()).rejects.toBeInstanceOf(AggregateError);expect(third.stats().phase).toBe('stopping');fail=false;await third.close();expect(closed).toBe(1)
})
test('sixteen simultaneous transports are bounded and become available after joined retirement',async()=>{
  const fixtures=Array.from({length:17},()=>fixture())
  try {for(const f of fixtures.slice(0,16))await ready(f.sink);await expect(fixtures[16].sink.start()).rejects.toMatchObject({code:-4});await fixtures[0].sink.close();await ready(fixtures[16].sink)}
  finally{for(const f of fixtures)await f.sink.close()}
})
test('raw elementary output gates keyframes, rejects audio and resets on reuse',async()=>{
  const f=fixture(),output=new SocketOutput(f.sink)
  const p=(keyframe:boolean):OutputPacket=>({data:Buffer.from('jpeg'),timestampNs:0n,sourceTimestampNs:0n,codec:3,keyframe,audio:false,annexB:false})
  for(let i=0;i<2;i++){await output.start();output.streams({codec:3,width:2,height:2,fps:25,headers:new Uint8Array()});output.commit();await output.outputframe(p(false));await output.outputframe(p(true));await output.stop()}
  expect(f.writes.length).toBe(2)
  await output.start();expect(()=>output.streams({codec:3,width:2,height:2,fps:25,headers:new Uint8Array(),audio:{sampleRate:48000,channels:2}})).toThrow('video-only');await output.close()
})
test('invalid socket options and write bounds are rejected before transport writes',async()=>{
  for(const opts of [{address:'example.com'},{port:0},{protocol:'sctp'},{chunkBytes:0},{protocol:'udp',chunkBytes:65508},{writeTimeoutMs:Infinity}])
    expect(()=>new SocketSink({address:'127.0.0.1',port:5000,...opts} as any)).toThrow()
  const f=fixture();await ready(f.sink);await expect(f.sink.write(new Uint8Array(16*1024*1024+1))).rejects.toBeInstanceOf(RangeError);expect(f.writes.length).toBe(0);await f.sink.close()
})
test('synchronous writable and error callbacks cannot lose a producer wakeup',async()=>{
  let calls=0
  const sink=new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async(_,h)=>({
    write(b){if(calls++===0){h.writable();return 0}return b.length},close(){},
  })})
  await ready(sink);await sink.write(Buffer.from('data'));expect(calls).toBe(2);await sink.close()
  const marker=Error('synchronous send failure'),other=new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async(_,h)=>({write(){h.error(marker);return 0},close(){}})})
  await ready(other);await expect(other.write(Buffer.from('a'))).rejects.toBe(marker);await other.close()
})
test('discard joins a cooperative finish already in progress',async()=>{
  let finishing=false,closed=0
  const sink=new SocketSink({address:'127.0.0.1',port:5000,finishTimeoutMs:1000,socketFactory:async()=>({
    write:b=>b.length,finish:signal=>new Promise<void>((_,reject)=>{finishing=true;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})}),close(){closed++},
  })})
  await ready(sink);const stopping=sink.stop();await until(()=>finishing);expect(sink.close()).toBe(stopping);await stopping;expect(closed).toBe(1)
})
test('RTP and raw outputs share transport identity ownership without closing a healthy owner',async()=>{
  const {RtpOutput}=await import('../../ts')
  let closed=0
  const shared={write:(b:Uint8Array)=>b.length,send:()=>true,close(){closed++}}
  const raw=new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async()=>shared})
  const rtp=new RtpOutput({address:'127.0.0.1',port:5004,socketFactory:async()=>shared})
  await ready(raw);await expect(rtp.start()).rejects.toMatchObject({code:-4});expect(closed).toBe(0)
  await rtp.close();await raw.close();expect(closed).toBe(1)
  const sockets=[shared,{...shared}];let index=0
  const owner=new RtpOutput({address:'127.0.0.1',port:5004,socketFactory:async()=>sockets[index++]})
  await owner.start();await expect(raw.start()).rejects.toMatchObject({code:-4});expect(closed).toBe(1)
  await raw.close();await owner.close();expect(closed).toBe(3)
})
test('producer completion joins a transport buffered tail before drain and discard can cancel that flush',async()=>{
  for(const discard of [false,true]){
    let flushing=false,release!:()=>void,closed=0
    const sink=new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async()=>({
      write:b=>b.length,
      flush(signal:AbortSignal){flushing=true;return new Promise<void>((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})},
      close(){closed++},
    })})
    await ready(sink);const writing=failure(sink.write(Buffer.from('tail')))
    try{await Bun.sleep(5);expect(flushing).toBe(true)
      let done=false;const stopping=sink.stop().then(()=>{done=true});await Bun.sleep(5);expect(done).toBe(false)
      if(discard)await sink.close();else release()
      const error=await writing;if(discard)expect(error).toMatchObject({code:-2});else expect(error).toBeUndefined()
      await stopping;expect(closed).toBe(1)
    }finally{release?.();await writing;await sink.close()}
  }
})
test('raw and RTP sessions cannot restart inside a still-settling close fence',async()=>{
  const {RtpOutput}=await import('../../ts')
  for(const protocol of ['raw','rtp']){
    let sink:SocketSink|InstanceType<typeof RtpOutput>,attempt:Promise<unknown>|undefined,reenter=true,windowObserved=false
    const close=()=>({then(resolve:()=>void){resolve();queueMicrotask(()=>queueMicrotask(()=>{
      if(reenter && sink.stats().phase==='stopped'){windowObserved=true;reenter=false;attempt=failure(sink.start())}
    }))}} as unknown as Promise<void>)
    if(protocol==='raw')sink=new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async()=>({write:b=>b.length,close})})
    else sink=new RtpOutput({address:'127.0.0.1',port:5004,socketFactory:async()=>({send:()=>true,close})})
    try{await sink.start();await sink.stop();expect(windowObserved).toBe(true);expect(await attempt).toMatchObject({code:-4})
      await sink.start();await sink.stop()
    }finally{reenter=false;await sink.close()}
  }
})
