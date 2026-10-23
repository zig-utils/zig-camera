import { test, expect } from 'bun:test'
import { Camera, FrameChannel, RemoteFrame, type FrameExport } from '../../ts'
import { fstatSync } from 'node:fs'
const formats = ['BGR888','RGB888','XBGR8888','XRGB8888','YUV420','YVU420','NV12','NV21','YUYV','YVYU','UYVY','VYUY','BGR161616','RGB161616'] as const
for (const format of formats)
  test(`${format} remote frame owns physical planes full metadata and native precision images`, async () => {
    const camera = new Camera({ simulate:true, fifo:true, writable:true, width:18, height:10, raw:true, unpackedRaw:true, format, lores:{width:10,height:6,format}, colorSpace:'rec709' })
    const [sender, receiver] = FrameChannel.pair()
    let loan: FrameExport | undefined, remote: RemoteFrame | undefined
    try {
      camera.start()
      using frame = camera.acquire()
      const physical = new Map<string,Uint8Array[]>()
      for (const name of ['main','raw','lores'] as const) {
        using mapped = frame.mapStream(name)
        physical.set(name, mapped.planes.map(p => p.bytes.slice()))
      }
      using original = frame.makeImage()
      using originalLores = frame.makeImage({stream:'lores'})
      const metadata = frame.metadata(), catalog = frame.metadataCatalog()
      loan = frame.exportFrame({streams:['main','raw','lores']})
      expect(receiver.tryReceive()).toBeUndefined()
      expect(loan.trySend(sender.fd, 9007199254740993n)).toBe(true)
      remote = receiver.tryReceive()!
      expect(remote).toBeInstanceOf(RemoteFrame)
      expect(remote.cookie).toBe(9007199254740993n)
      expect(remote.info().metadata).toEqual(metadata)
      expect(remote.metadataCatalog()).toEqual(catalog)
      expect(remote.info().planes[0].fd).not.toBe(loan.info().planes[0].fd)
      for (const name of ['main','raw','lores'] as const) {
        const copied = remote.copyPlanes(name)
        expect(copied).toEqual(physical.get(name)!)
        copied[0][0] ^= 0xff
        expect(remote.copyPlanes(name)).toEqual(physical.get(name)!)
      }
      expect(() => remote!.withWritablePlanes('main', () => {})).toThrow('read-only')
      using image = remote.makeImage(), lores = remote.makeImage('lores')
      expect(image.bits).toBe(format.endsWith('161616') ? 16 : 8)
      expect(image.copyPixels()).toEqual(original.copyPixels())
      expect(lores.copyPixels()).toEqual(originalLores.copyPixels())
      frame.release()
      await camera.stop()
      const ownerFds = remote.info().planes.map(p => p.fd)
      remote.close()
      for (const fd of ownerFds) expect(() => fstatSync(fd)).toThrow()
      expect(receiver.tryAcknowledge(9007199254740993n)).toBe(true)
      expect(sender.tryReceiveAcknowledgement()).toBe(9007199254740993n)
      loan.close()
      await camera.close()
      expect(image.copyPixels()).toEqual(original.copyPixels())
      expect(catalog.kind).toBe('metadata')
      expect(image.encode({format:'png'}).subarray(0,8)).toEqual(new Uint8Array([137,80,78,71,13,10,26,10]))
      expect(() => remote!.copyPlanes()).toThrow('closed')
    } finally {
      remote?.close(); sender.close(); receiver.close(); loan?.close(); await camera.close()
    }
  })

test('remote write contexts detach escaped aliases on returns throws thenables and close reentry', async () => {
  const camera = new Camera({simulate:true,writable:true,width:4,height:2})
  const [sender,receiver] = FrameChannel.pair()
  let loan: FrameExport | undefined, remote: RemoteFrame | undefined
  try {
    camera.start()
    using frame = camera.acquire()
    loan = frame.exportFrame({writable:true})
    expect(loan.trySend(sender.fd, 1n)).toBe(true)
    remote = receiver.tryReceive()!
    let escaped: Uint8Array | undefined, alias: Uint8Array | undefined
    remote.withWritablePlanes('main', planes => {
      escaped = planes[0]; alias = planes[0].subarray(0,2); planes[0][0] = 91
      expect(() => remote!.close()).toThrow('active')
      expect(() => remote!.copyPlanes()).toThrow('active')
      expect(() => remote!.makeImage()).toThrow('active')
      expect(() => remote!.withWritablePlanes('main',()=>{})).toThrow('active')
    })
    expect(escaped!.byteLength).toBe(0); expect(alias!.byteLength).toBe(0)
    expect(remote.copyPlanes()[0][0]).toBe(91)
    expect(() => remote!.withWritablePlanes('main', planes => {escaped=planes[0];throw new Error('callback failure')})).toThrow('callback failure')
    expect(escaped!.byteLength).toBe(0)
    expect(() => remote!.withWritablePlanes('main', planes => {escaped=planes[0];return {then(){}}})).toThrow('synchronous')
    expect(escaped!.byteLength).toBe(0)
    remote.close()
    expect(receiver.tryAcknowledge(1n)).toBe(true)
    expect(sender.tryReceiveAcknowledgement()).toBe(1n)
    loan.close()
    using mapped = frame.mapStream()
    expect(mapped.planes[0].bytes[0]).toBe(91)
  } finally {remote?.close();sender.close();receiver.close();loan?.close();await camera.close()}
})

test('remote admission preserves queued records and returns capacity after close', async () => {
  const camera = new Camera({simulate:true,width:2,height:2})
  const [sender,receiver] = FrameChannel.pair(), remotes: RemoteFrame[] = []
  let loan: FrameExport | undefined
  try {
    camera.start(); using frame = camera.acquire(); loan=frame.exportFrame()
    for (let i=1;i<=32;i++) {
      expect(loan.trySend(sender.fd,BigInt(i))).toBe(true)
      remotes.push(receiver.tryReceive()!)
    }
    expect(loan.trySend(sender.fd,33n)).toBe(true)
    expect(() => receiver.tryReceive()).toThrow()
    remotes.pop()!.close()
    using next = receiver.tryReceive()!
    expect(next.cookie).toBe(33n)
    next.close()
    for (const remote of remotes) remote.close()
    remotes.length=0
    expect(receiver.tryReceive()).toBeUndefined()
    // All same-process consumer maps are now joined before source retirement.
    loan.close()
  } finally {for(const remote of remotes)remote.close();sender.close();receiver.close();loan?.close();await camera.close()}
})

test('atomic channel backpressure retries without partial records or extra export references', async () => {
  const camera = new Camera({simulate:true,width:2,height:2})
  const [sender,receiver] = FrameChannel.pair()
  let loan: FrameExport | undefined
  try {
    camera.start();using frame=camera.acquire();loan=frame.exportFrame()
    let sent=0
    while(sent<10000 && loan.trySend(sender.fd,BigInt(sent+1)))sent++
    expect(sent).toBeGreaterThan(0);expect(sent).toBeLessThan(10000)
    expect(frame.referenceCount).toBe(2)
    for(let i=1;i<=sent;i++){
      using remote=receiver.tryReceive()!
      expect(remote.cookie).toBe(BigInt(i))
    }
    expect(receiver.tryReceive()).toBeUndefined()
    expect(loan.trySend(sender.fd,99999n)).toBe(true)
    using again=receiver.tryReceive()!;expect(again.cookie).toBe(99999n);again.close()
    loan.close()
  } finally {sender.close();receiver.close();loan?.close();await camera.close()}
})

test('channel endpoint duplicates own their fd and validate cookies and packet roles', () => {
  const [sender,receiver] = FrameChannel.pair()
  using duplicate = FrameChannel.fromFd(receiver.fd)
  sender.close();sender.close()
  expect(() => sender.fd).toThrow('closed')
  expect(() => FrameChannel.fromFd(-1)).toThrow()
  expect(() => FrameChannel.fromFd(0.5)).toThrow()
  for (const value of [0n,-1n,0x10000000000000000n,1])expect(() => duplicate.tryAcknowledge(value as bigint)).toThrow()
  receiver.close()
  expect(fstatSync(duplicate.fd).isSocket()).toBe(true)
  const [a,b]=FrameChannel.pair()
  try{
    expect(b.tryAcknowledge(1n)).toBe(true)
    expect(() => a.tryReceive()).toThrow() // Wrong message role is consumed.
    expect(a.tryReceive()).toBeUndefined()
    expect(b.tryAcknowledge(2n)).toBe(true)
    expect(a.tryReceiveAcknowledgement()).toBe(2n)
  }finally{a.close();b.close()}
})

for(const writable of [false,true])for(const abrupt of [false,true])
  test(`Bun exec receives actual descriptors and joins ${abrupt?'exit':'ACK'} before ${writable?'writable':'read'} source retirement`, async()=>{
    const camera=new Camera({simulate:true,fifo:true,writable,width:18,height:10,raw:true,unpackedRaw:true,lores:{width:10,height:6,format:'NV12'}})
    const [sender,receiver]=FrameChannel.pair()
    let loan:FrameExport|undefined, child:ReturnType<typeof Bun.spawn>|undefined
    try{
      camera.start();using frame=camera.acquire()
      let hash=2166136261
      const originals=new Map<string,Uint8Array>()
      // make compact comparison through pre-export copies; independent physical
      // hashes include the real per-plane used padding, recorded from the export
      // receiver in another local owner before child handoff.
      loan=frame.exportFrame({streams:['main','raw','lores'],writable})
      expect(loan.trySend(sender.fd,1n)).toBe(true)
      using local=receiver.tryReceive()!
      for(const stream of local.info().streams){
        const planes=local.copyPlanes(stream.stream)
        originals.set(stream.stream,planes[0].slice())
        for(const bytes of planes)for(const value of bytes)hash=Math.imul(hash^value,16777619)>>>0
      }
      local.close()
      const spawned=Bun.spawn([process.execPath,new URL('../fixtures/frame-channel-child.ts',import.meta.url).pathname,abrupt?'abrupt':'ack'],{stdin:receiver.fd,stdout:'pipe',stderr:'pipe',env:process.env})
      child=spawned
      receiver.close()
      expect(loan.trySend(sender.fd,9007199254740993n)).toBe(true)
      const output=await new Response(spawned.stdout).text(),error=await new Response(spawned.stderr).text()
      expect(await child.exited,error).toBe(0)
      const result=JSON.parse(output)
      expect(result.hash).toBe(hash);expect(result.sequence).toBe(frame.metadata().sequence.toString());expect(result.kind).toBe('metadata')
      expect([...Buffer.from(result.png,'base64').subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10])
      if(!abrupt)expect(sender.tryReceiveAcknowledgement()).toBe(9007199254740993n)
      // The peer has exited even if it skipped explicit remote.close/ACK.
      loan.close()
      if(writable)for(const name of ['main','raw','lores'] as const){using mapped=frame.mapStream(name);expect(mapped.planes[0].bytes[0]).toBe(originals.get(name)![0]^0x5a)}
    }finally{
      if(child){child.kill();await child.exited}
      sender.close();receiver.close();loan?.close();await camera.close()
    }
  })
