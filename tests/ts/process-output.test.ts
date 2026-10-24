import {test,expect} from 'bun:test'
import {ProcessSink,ProcessOutput,ProcessOutputError,Camera,Recorder,MuxedOutput} from '../../ts'
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync,cpSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,dirname,basename} from 'node:path'
import {libraryPath} from '../../ts/ffi'
import {mkvFrames} from './media'
import {simpleBlocks} from './matroska-receiver'
const fixture=new URL('../fixtures/process-output-consumer.ts',import.meta.url).pathname
const cmd=(...args:string[])=>[process.execPath,fixture,...args]
const failure=(p:Promise<unknown>)=>p.then(()=>undefined,e=>e)
async function until(f:()=>boolean,ms=5000){const deadline=Date.now()+ms;while(!f()){if(Date.now()>deadline)throw Error('process condition deadline');await Bun.sleep(1)}}
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
function preserve(dir:string,name:string){const root=process.env.ZC_MEDIA_FAILURE_DIR??new URL('../../zig-out/media-failures',import.meta.url).pathname;mkdirSync(root,{recursive:true});cpSync(dir,join(root,`process-${name}-${Date.now()}`),{recursive:true})}
test('process byte sink retains exact bounded stdout and stderr tails and restarts after joined EOF',async()=>{
  const sink=new ProcessSink({command:[process.execPath,'-e','for await(const b of Bun.stdin.stream())process.stdout.write(b);process.stderr.write("final diagnostics")'],diagnosticBytes:8})
  try{for(let i=0;i<2;i++){
    await sink.start();sink.commit();const pid=sink.stats().consumerPid!
    await sink.write(Buffer.from('hello supervised sink'));await sink.stop()
    expect(sink.stats()).toMatchObject({phase:'stopped',session:i+1,consumerExitCode:0,supervisorExitCode:0,bytes:21n})
    expect(alive(pid)).toBe(false)
    const diag=sink.diagnostics();expect(Buffer.from(diag.stdout.data).toString()).toBe('sed sink');expect(diag.stdout.total).toBe(21n);expect(diag.stdout.dropped).toBe(13n)
    expect(Buffer.from(diag.stderr.data).toString()).toBe('gnostics')
  }}finally{await sink.close()}
})
test('simultaneous stdout stderr floods cannot deadlock a child and diagnostics stay bounded',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-flood-')),ready=join(dir,'ready')
  const sink=new ProcessSink({command:cmd('flood',ready),diagnosticBytes:17})
  try{await sink.start();sink.commit();await until(()=>existsSync(ready));await sink.stop()
    for(const tail of Object.values(sink.diagnostics())){expect(tail.total).toBe(524288n);expect(tail.data).toEqual(Uint8Array.from({length:17},(_,i)=>239+i));expect(tail.dropped).toBe(524271n)}
  }finally{await sink.close();rmSync(dir,{recursive:true,force:true})}
})
test('zero-capacity diagnostics still drain every byte and reject malformed options before spawn',async()=>{
  const sink=new ProcessSink({command:cmd('flood'),diagnosticBytes:0})
  try{await sink.start();sink.commit();await sink.stop();expect(sink.diagnostics().stdout.data.length).toBe(0);expect(sink.stats().stderrBytes).toBe(524288n)}finally{await sink.close()}
  for(const options of [{command:[]},{command:['bad\0']},{command:['x'],diagnosticBytes:-1},{command:['x'],terminationGraceMs:0},{command:['x'],chunkBytes:0},{command:['x'],env:{VALUE:42}}])expect(()=>new ProcessSink(options as any)).toThrow()
})
test('blocked stdin producer deadline kills and joins an ignoring consumer and the supervisor',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-stall-')),file=join(dir,'pid'),sink=new ProcessSink({command:cmd('hang',file),writeTimeoutMs:30,terminationGraceMs:30,chunkBytes:65536})
  try{await sink.start();sink.commit();await until(()=>existsSync(file));const {consumerPid,supervisorPid}=sink.stats()
    await expect(sink.write(new Uint8Array(4*1024*1024))).rejects.toMatchObject({code:-3})
    await sink.stop();expect(sink.stats().phase).toBe('stopped');expect(alive(consumerPid!)).toBe(false);expect(alive(supervisorPid!)).toBe(false)
  }finally{await sink.close();rmSync(dir,{recursive:true,force:true})}
})
test('discard escalates a drain, terminates the owned descendant group and joins real exit',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-tree-')),file=join(dir,'pids'),grand=join(dir,'grand'),sink=new ProcessSink({command:cmd('descendant',file,grand),writeTimeoutMs:5000,terminationGraceMs:30})
  try{await sink.start();sink.commit();await until(()=>existsSync(file)&&existsSync(grand));const pids=JSON.parse(readFileSync(file,'utf8'))
    const writing=failure(sink.write(new Uint8Array(4*1024*1024)));await until(()=>sink.stats().inFlight&&sink.stats().waits>0n)
    const stopping=sink.stop();expect(sink.close()).toBe(stopping);expect(await writing).toMatchObject({code:-2});await stopping
    await until(()=>!alive(pids.pid)&&!alive(pids.descendant));expect(sink.stats().cancelled).toBe(true)
  }finally{await sink.close();rmSync(dir,{recursive:true,force:true})}
})
test('nonzero EOF exit is reported after joined cleanup with retained diagnostic bytes',async()=>{
  const sink=new ProcessSink({command:cmd('fail-at-eof')})
  try{await sink.start();sink.commit();await sink.write(Buffer.from('media'))
    await expect(sink.stop()).rejects.toBeInstanceOf(ProcessOutputError)
    expect(sink.stats().consumerExitCode).toBe(42);expect(sink.stats().phase).toBe('stopped');expect(Buffer.from(sink.diagnostics().stderr.data).toString()).toContain('failed at EOF')
  }finally{await sink.close()}
})
test('exec failure rejects preparation with errno and releases all process ownership',async()=>{
  const sink=new ProcessSink({command:['/no-such-zig-camera-consumer']})
  const error=await failure(sink.start());expect(error).toBeInstanceOf(ProcessOutputError);expect((error as ProcessOutputError).details.errno).toBeGreaterThan(0)
  await sink.close();expect(sink.stats().phase).toBe('stopped');expect(alive(sink.stats().supervisorPid!)).toBe(false)
})
test('Home Matroska recording travels through a supervised process stdin without a media subprocess',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-mkv-')),path=join(dir,'clip.mkv'),sink=new ProcessSink({command:cmd('slow-file',path)}),camera=new Camera({simulate:true,width:32,height:24,fifo:true})
  let recorder:Recorder|undefined
  try{recorder=await Recorder.open(new MuxedOutput(sink,'mkv'),{width:32,height:24,fps:25,audio:{sampleRate:48000,channels:2},asyncWrites:true,outputQueue:{maxBytes:1024*1024,maxOperations:4,waitMs:2000}})
    const pcm=Buffer.alloc(9600*4);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE((i*13)%30000,i)
    await recorder.writeAudioAsync(pcm,0n);camera.start()
    for(let i=0;i<5;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recorder.close();expect(mkvFrames(path).length).toBe(5);expect(sink.stats().consumerExitCode).toBe(0)
    const blocks=simpleBlocks(readFileSync(path)),audio=blocks.filter(b=>b.track===2)
    expect(blocks.filter(b=>b.track===1).map(b=>b.timeMs)).toEqual([0,40,80,120,160])
    expect(Buffer.concat(audio.map(b=>b.data))).toEqual(pcm)
    let frames=0;for(const block of audio){expect(block.timeMs).toBe(Math.floor(frames*1000/48000));frames+=block.data.length/4}
    expect(frames).toBe(9600)
  }catch(error){preserve(dir,'mkv');throw error}finally{await recorder?.close();await camera.close();await sink.close();rmSync(dir,{recursive:true,force:true})}
})
test('raw process output streams every JPEG byte and joins its file consumer',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-raw-')),path=join(dir,'clip.mjpg'),output=new ProcessOutput({command:cmd('copy-file',path)}),camera=new Camera({simulate:true,width:32,height:24,fifo:true}),packets:Buffer[]=[]
  let recorder:Recorder|undefined
  try{recorder=await Recorder.open(output,{width:32,height:24,fps:25,asyncWrites:true});await recorder.addOutput({outputframe:p=>{packets.push(Buffer.from(p.data))}});camera.start()
    for(let i=0;i<5;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recorder.close();expect(readFileSync(path)).toEqual(Buffer.concat(packets));expect(packets.length).toBe(5)
  }catch(error){preserve(dir,'raw');throw error}finally{await recorder?.close();await camera.close();await output.close();rmSync(dir,{recursive:true,force:true})}
})
test('parent SIGKILL is observed on the private control fd and leaves no owned process group',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-parent-')),pids=join(dir,'pids'),grand=join(dir,'grand'),ready=join(dir,'ready')
  const fixture=new URL('../fixtures/process-output-parent.ts',import.meta.url).pathname
  const parent=Bun.spawn([process.execPath,fixture,pids,grand,ready],{stdout:'ignore',stderr:'pipe',env:process.env})
  const errors=new Response(parent.stderr).text()
  try{await until(()=>existsSync(ready));const stats=JSON.parse(readFileSync(ready,'utf8')),tree=JSON.parse(readFileSync(pids,'utf8'))
    parent.kill('SIGKILL');await parent.exited
    await until(()=>!alive(stats.supervisorPid)&&!alive(tree.pid)&&!alive(tree.descendant))
    expect(alive(stats.supervisorPid)).toBe(false);expect(alive(tree.descendant)).toBe(false)
  }finally{parent.kill('SIGKILL');await parent.exited;await errors;rmSync(dir,{recursive:true,force:true})}
})
test('startup cancellation joins preparation before releasing its process slot',async()=>{
  for(let i=0;i<20;i++){
    const sink=new ProcessSink({command:cmd('hang'),terminationGraceMs:10})
    const starting=failure(sink.start());await Promise.resolve();const stopping=sink.close()
    const error=await starting;await stopping
    expect(error).toMatchObject({code:-2});expect(sink.stats().phase).toBe('stopped')
    if(sink.stats().supervisorPid)expect(alive(sink.stats().supervisorPid!)).toBe(false)
  }
})
test('a failed process output is isolated and an async replacement preserves healthy recording',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-recovery-')),path=join(dir,'recovered.mjpg'),camera=new Camera({simulate:true,width:32,height:24,fifo:true}),bad=new ProcessOutput({command:cmd('fail-first-input')}),good=new ProcessOutput({command:cmd('copy-file',path)})
  let healthy=0
  const recorder=await Recorder.open({outputframe(){healthy++}},{width:32,height:24,fps:25,isolate:true,asyncWrites:true})
  try{const id=await recorder.addOutput(bad);camera.start()
    for(let i=0;i<8;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n);await Bun.sleep(1)}
    await until(()=>recorder.outputState(id).errorCode!==0)
    const recovery=recorder.recover(good,id)
    await until(()=>good.sink.stats().phase==='prepared'||good.sink.stats().phase==='active')
    for(let i=8;i<16;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n);await Bun.sleep(1)}
    await recovery;recovery.close();await recorder.close();expect(healthy).toBe(16);expect(readFileSync(path).length).toBeGreaterThan(0)
    expect(bad.stats().consumerExitCode).toBe(42)
  }finally{await recorder.close();await bad.close();await good.close();await camera.close();rmSync(dir,{recursive:true,force:true})}
})
test('async process output splits join both consumers before reporting completion',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-split-')),a=join(dir,'a.mjpg'),b=join(dir,'b.mjpg'),first=new ProcessOutput({command:cmd('copy-file',a)}),second=new ProcessOutput({command:cmd('copy-file',b)}),camera=new Camera({simulate:true,width:32,height:24,fifo:true}),packets:Buffer[]=[]
  const recorder=await Recorder.open(first,{width:32,height:24,fps:25,asyncWrites:true})
  try{await recorder.addOutput({outputframe:p=>{packets.push(Buffer.from(p.data))}});camera.start()
    for(let i=0;i<4;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    const split=recorder.split(second)
    await until(()=>second.sink.stats().phase==='prepared'||second.sink.stats().phase==='active')
    for(let i=4;i<16;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n);await Bun.sleep(1)}
    await split;split.close();expect(first.stats().consumerExitCode).toBe(0)
    await recorder.close();expect(Buffer.concat([readFileSync(a),readFileSync(b)])).toEqual(Buffer.concat(packets));expect(second.stats().consumerExitCode).toBe(0)
  }finally{await recorder.close();await first.close();await second.close();await camera.close();rmSync(dir,{recursive:true,force:true})}
})
test('shared elementary outputs reject a second start without corrupting an active session',async()=>{
  const output=new ProcessOutput({command:cmd('copy')})
  try{await output.start();output.streams({codec:3,width:1,height:1,fps:25,headers:new Uint8Array()});output.commit()
    await expect(output.start()).rejects.toMatchObject({code:-4})
    await output.outputframe({data:Buffer.from('jpeg'),audio:false,codec:3,annexB:false,keyframe:true,timestampNs:0n,sourceTimestampNs:0n})
    await output.stop();expect(Buffer.from(output.diagnostics().stdout.data).toString()).toBe('jpeg')
  }finally{await output.close()}
})
for(const codec of ['h264','hevc'] as const)test(`${codec} process recording preserves every encoded byte including the codec flush tail`,async()=>{
  if(!process.env.ZC_TEST_CODECS)return
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-codec-')),path=join(dir,'clip.annexb'),output=new ProcessOutput({command:cmd('copy-file',path)}),camera=new Camera({simulate:true,width:64,height:48,fifo:true}),packets:Buffer[]=[]
  let recorder:Recorder|undefined
  try{recorder=await Recorder.open(output,{width:64,height:48,fps:25,codec,gop:2,asyncWrites:true});await recorder.addOutput({outputframe:p=>{packets.push(Buffer.from(p.data))}});camera.start()
    for(let i=0;i<5;i++){using frame=camera.acquire();await recorder.writeAsync(frame,BigInt(i)*40_000_000n)}
    await recorder.close();expect(packets.length).toBe(5);expect(readFileSync(path)).toEqual(Buffer.concat(packets));expect(output.stats().consumerExitCode).toBe(0)
  }catch(error){preserve(dir,codec);throw error}finally{await recorder?.close();await output.close();await camera.close();rmSync(dir,{recursive:true,force:true})}
})
test('process startup shares the sixteen-sink admission bound before creating a child',async()=>{
  const {SocketSink}=await import('../../ts'),sockets=Array.from({length:16},()=>new SocketSink({address:'127.0.0.1',port:5000,socketFactory:async()=>({write:b=>b.length,close(){}})})),sink=new ProcessSink({command:cmd('copy')})
  try{for(const socket of sockets){await socket.start();socket.commit()}
    await expect(sink.start()).rejects.toMatchObject({code:-4});expect(sink.stats().supervisorPid).toBeUndefined()
    await sockets[0].close();await sink.start();sink.commit();await sink.stop();expect(sink.stats().consumerExitCode).toBe(0)
  }finally{await sink.close();for(const socket of sockets)await socket.close()}
})
test('process command and environment snapshots ignore overridden array methods and later mutations',async()=>{
  const argv=[process.execPath,'-e','process.stdout.write(process.env.ZC_PROCESS_SNAPSHOT!);await Bun.stdin.text()']
  Object.defineProperty(argv,'map',{value(){throw Error('caller map must not run')}})
  let lengths=0;const command=new Proxy(argv,{get(target,key,receiver){if(key==='length')lengths++;return Reflect.get(target,key,receiver)}}),env={ZC_PROCESS_SNAPSHOT:'before'}
  const sink=new ProcessSink({command,env})
  argv[2]='process.exit(42)';env.ZC_PROCESS_SNAPSHOT='after'
  try{expect(lengths).toBe(1);await sink.start();sink.commit();await sink.stop();expect(Buffer.from(sink.diagnostics().stdout.data).toString()).toBe('before')}
  finally{await sink.close()}
})
test('installed supervisor discovery stays tied to a relative library loaded before cwd changes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zc-proc-install-')),lib=join(dir,'lib'),bin=join(dir,'bin'),other=join(dir,'other')
  for(const path of [lib,bin,other])mkdirSync(path)
  const absoluteLibrary=resolve(libraryPath),host=process.env.ZIG_CAMERA_OUTPUT_HOST??resolve(dirname(absoluteLibrary),'../bin/zig-camera-output-host')
  symlinkSync(absoluteLibrary,join(lib,basename(absoluteLibrary)));symlinkSync(host,join(bin,'zig-camera-output-host'))
  const script=new URL('../fixtures/process-output-installed.ts',import.meta.url).pathname
  const child=Bun.spawn([process.execPath,script,other],{cwd:dir,env:{...process.env,ZIG_CAMERA_LIBRARY:join('lib',basename(absoluteLibrary)),ZIG_CAMERA_OUTPUT_HOST:undefined},stdout:'pipe',stderr:'pipe'})
  try{const [code,errors]=await Promise.all([child.exited,new Response(child.stderr).text(),new Response(child.stdout).text()]);expect(code,errors).toBe(0)}
  finally{child.kill('SIGKILL');await child.exited;rmSync(dir,{recursive:true,force:true})}
})
test('failed-exec terminal proofs retire both private channels before preparation rejects',async()=>{
  for(let i=0;i<20;i++){
    const sink=new ProcessSink({command:['/no-such-zig-camera-terminal-proof']})
    try{
      const error=await failure(sink.start())
      expect(error).toBeInstanceOf(ProcessOutputError)
      expect((error as ProcessOutputError).details.errno).toBeGreaterThan(0)
      expect(sink.stats()).toMatchObject({phase:'stopped',supervisorExitCode:125,consumerExitCode:127,cancelled:false})
      expect(alive(sink.stats().supervisorPid!)).toBe(false)
      expect(alive(sink.stats().consumerPid!)).toBe(false)
    }finally{await sink.close()}
  }
},15000)
