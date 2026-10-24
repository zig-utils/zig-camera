import {expect,test} from 'bun:test'
import {createConnection,createServer,type Socket} from 'node:net'
import {once} from 'node:events'
import {ListeningSocketSink,ListeningSocketOutput,SocketSink,CameraError} from '../../ts'
const failed=(promise:Promise<unknown>)=>promise.then(()=>undefined,error=>error)
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('listener condition deadline');await Bun.sleep(1)}}
async function bound(sink:ListeningSocketSink){await until(()=>sink.listenerStats().listening);return sink.listenerStats().local!}
function peer(address:string,port:number,read=true){
  const socket=createConnection({host:address,port,allowHalfOpen:true}),chunks:Buffer[]=[]
  let ended=false,closed=false
  socket.on('data',data=>chunks.push(Buffer.from(data)));socket.on('error',()=>{});socket.on('end',()=>{ended=true;socket.end()});socket.on('close',()=>{closed=true})
  if(!read)socket.pause()
  return {socket,chunks,get ended(){return ended},get closed(){return closed}}
}
for(const address of ['127.0.0.1','::1'])test(`listening TCP ${address} owns one peer, exact partial chunks, half-close and reusable sessions`,async()=>{
  const sink=new ListeningSocketSink({address,port:0,chunkBytes:127}),options=Object.freeze(sink.listenerStats())
  try{for(let session=1;session<=2;session++){
    const starting=sink.start()
    expect(sink.listenerStats()).toMatchObject({session,listening:false,accepted:false})
    expect(sink.listenerStats().local).toBeUndefined()
    const local=await bound(sink),client=peer(address,local.port)
    try{await once(client.socket,'connect');client.socket.end();await starting;sink.commit()
      expect(sink.listenerStats().peer?.port).toBe(client.socket.localPort);expect(sink.listenerStats().session).toBe(session)
      expect(Object.isFrozen(local)).toBe(true)
      await expect(sink.start()).rejects.toBeInstanceOf(CameraError)
      const bytes=Uint8Array.from({length:150001},(_,i)=>i%251),copy=Buffer.from(bytes)
      await sink.write(bytes);bytes.fill(0);await sink.stop();await until(()=>client.closed)
      expect(Buffer.concat(client.chunks)).toEqual(copy);expect(client.ended).toBe(true)
      expect(sink.listenerStats().listening).toBe(false);expect(sink.stats().bytes).toBe(150001n)
    }finally{client.socket.destroy();await sink.close()}
  }}finally{await sink.close()}
  expect(options.session).toBe(0);expect(options.accepted).toBe(false)
})
test('listener bind collision and accept deadline join retirement and release the port for reuse',async()=>{
  const first=new ListeningSocketSink({address:'127.0.0.1',port:0,acceptTimeoutMs:5000}),opening=failed(first.start()),local=await bound(first)
  const second=new ListeningSocketSink({address:'127.0.0.1',port:local.port})
  try{
    await expect(second.start()).rejects.toMatchObject({code:'EADDRINUSE'});await second.close()
    await first.close();expect(await opening).toBeInstanceOf(CameraError)
    const deadline=new ListeningSocketSink({address:'127.0.0.1',port:local.port,acceptTimeoutMs:25})
    await expect(deadline.start()).rejects.toMatchObject({code:-3});await deadline.close();expect(deadline.stats().phase).toBe('stopped')
    const reuse=new ListeningSocketSink({address:'127.0.0.1',port:local.port}),waiting=failed(reuse.start())
    await bound(reuse);await reuse.close();await waiting
  }finally{await first.close();await second.close()}
})
test('immediate cancellation joins an in-progress bind before returning and cannot leave a listening port',async()=>{
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening')
  const address=reservation.address();if(!address||typeof address==='string')throw Error('reserved address')
  await new Promise<void>(resolve=>reservation.close(()=>resolve()))
  for(let i=0;i<30;i++){
    const sink=new ListeningSocketSink({address:'127.0.0.1',port:address.port}),opening=failed(sink.start())
    if(i%2)await Promise.resolve()
    await sink.close();await opening;expect(sink.stats().phase).toBe('stopped');expect(sink.listenerStats().listening).toBe(false)
    const client=peer('127.0.0.1',address.port)
    try{expect(await failed(once(client.socket,'connect'))).toBeDefined();await until(()=>client.closed)}finally{client.socket.destroy()}
  }
})
test('only the first admitted client receives bytes and no subsequent connection joins that recording',async()=>{
  const sink=new ListeningSocketSink({address:'127.0.0.1',port:0}),starting=sink.start(),local=await bound(sink)
  const clients=Array.from({length:4},()=>peer('127.0.0.1',local.port))
  try{await starting;sink.commit();await sink.write(Buffer.from('one media consumer'));await sink.stop();await until(()=>clients.every(c=>c.closed))
    expect(clients.map(c=>Buffer.concat(c.chunks).toString()).filter(Boolean)).toEqual(['one media consumer'])
    const late=peer('127.0.0.1',local.port);try{expect(await failed(once(late.socket,'connect'))).toBeDefined();await until(()=>late.closed)}finally{late.socket.destroy()}
  }finally{for(const client of clients)client.socket.destroy();await sink.close()}
})
for(const cancel of [false,true])test(`a paused listener peer ${cancel?'cancels':'times out'} a bounded write and joins both owners`,async()=>{
  const sink=new ListeningSocketSink({address:'127.0.0.1',port:0,chunkBytes:65536,writeTimeoutMs:cancel?2000:50}),starting=sink.start(),local=await bound(sink),client=peer('127.0.0.1',local.port,false)
  try{await starting;sink.commit();const writing=failed(sink.write(new Uint8Array(16*1024*1024)))
    if(cancel){await until(()=>sink.stats().waits>0n);await sink.close()}
    const error=await writing;expect(error).toBeInstanceOf(CameraError);if(!cancel)expect(error).toMatchObject({code:-3})
    await sink.close();expect(sink.stats().phase).toBe('stopped');expect(sink.listenerStats().listening).toBe(false)
  }finally{client.socket.destroy();await sink.close()}
})
test('listening sessions share the sixteen-sink admission budget with dialing sockets',async()=>{
  const sinks=Array.from({length:16},()=>new ListeningSocketSink({address:'127.0.0.1',port:0})),opening=sinks.map(sink=>failed(sink.start()))
  const extra=new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async()=>({write:bytes=>bytes.length,close(){}})})
  try{await Promise.all(sinks.map(bound));await expect(extra.start()).rejects.toMatchObject({code:-4});await Promise.all(sinks.map(sink=>sink.close()));await Promise.all(opening)
    await extra.start();extra.commit();await extra.stop()
  }finally{await Promise.all(sinks.map(sink=>sink.close()));await extra.close()}
})
test('listener configuration snapshots numeric endpoints and rejects invalid limits before binding',async()=>{
  for(const value of [{address:'localhost',port:1},{address:'127.0.0.1',port:-1},{address:'::1%en0',port:2},{address:'127.0.0.1',port:65536},{address:'127.0.0.1',port:0,acceptTimeoutMs:Infinity},{address:'127.0.0.1',port:0,chunkBytes:0}])expect(()=>new ListeningSocketSink(value)).toThrow()
  const options={address:'127.0.0.1',port:0},sink=new ListeningSocketSink(options)
  options.address='invalid';options.port=-1
  const starting=failed(sink.start());try{expect((await bound(sink)).address).toBe('127.0.0.1')}finally{await sink.close();await starting}
  const output=new ListeningSocketOutput(sink);expect(output.resources()).toEqual([sink])
})
