import {test,expect} from 'bun:test'
import {decodePng,decodePngAsync,encodePngAnimationAsync,CapturedImage,PngCompositor,type PngAnimationFrame} from '../../ts'
const bytes=(values:readonly number[],bits:8|16)=>{
  const data=new Uint8Array(values.length*(bits/8)),v=new DataView(data.buffer)
  values.forEach((x,i)=>bits===8?data[i]=x:v.setUint16(i*2,x,true))
  return data
}
const same=(a:Uint8Array,b:Uint8Array)=>expect(Buffer.from(a)).toEqual(Buffer.from(b))
for(const bits of [8,16] as const)for(const poster of [false,true])test(`APNG rendered canvases ${bits} ${poster?'poster':'included default'} preserve alpha disposal and owned snapshots`,async()=>{
  const m=bits===8?255:65535,half=bits===8?128:32768,step=bits===8?1:257
  const base={data:bytes([m,0,0,m,0,m,0,m,0,0,m,m],bits),width:3,height:1,format:'rgba' as const,bits}
  const patch={data:bytes([0,0,m,half],bits),width:1,height:1,format:'rgba' as const,bits}
  const transparent={data:bytes([19*step,20*step,21*step,0],bits),width:1,height:1,format:'rgba' as const,bits}
  const frames:PngAnimationFrame[]=[{...base,delay:{numerator:3,denominator:25}},{...patch,x:1,blend:'over',dispose:'previous',delay:{numerator:7,denominator:0}},{...transparent,x:2,dispose:'background'},{...patch,x:0}]
  const encoded=await encodePngAnimationAsync({width:3,height:1,defaultImage:poster?{...base,data:bytes(Array(12).fill(m),bits)}:undefined,frames})
  using decoded=await decodePngAsync(encoded)
  using compositor=decoded.compositor({maxWorkingBytes:3*4*(bits/8)*2})
  const output=[]
  try{
    for(const frame of compositor)output.push(frame)
    expect(compositor.closed).toBe(true);expect(compositor.next().done).toBe(true)
    expect(output.map(x=>x.index)).toEqual([0,1,2,3]);expect(output[1]!.delay).toEqual({numerator:7,denominator:0})
    for(const frame of output)expect([frame.image.format,frame.image.bits,frame.image.width,frame.image.height]).toEqual(['rgba',bits,3,1])
    same(output[0]!.image.copyPixels(),base.data)
    same(output[1]!.image.copyPixels(),bytes([m,0,0,m,0,m-half,half,m,0,0,m,m],bits))
    same(output[2]!.image.copyPixels(),bytes([m,0,0,m,0,m,0,m,19*step,20*step,21*step,0],bits))
    same(output[3]!.image.copyPixels(),bytes([0,0,m,half,0,m,0,m,0,0,0,0],bits))
    decoded.close();same(output[0]!.image.copyPixels(),base.data)
    using reread=decodePng(output[2]!.image.encode({format:'png'}));same(reread.image.copyPixels(),output[2]!.image.copyPixels())
  }finally{for(const frame of output)frame.image.close()}
})
test('APNG excluded poster never initializes animation canvas and first previous clears before next patch',async()=>{
  const patch=(data:number[])=>({data:new Uint8Array(data),width:1,height:1,format:'rgba' as const})
  const encoded=await encodePngAnimationAsync({width:2,height:1,defaultImage:{data:new Uint8Array([255,255,255,255,255,255,255,255]),width:2,height:1,format:'rgba'},frames:[{...patch([255,0,0,255]),x:1,dispose:'previous'},{...patch([0,255,0,255]),x:0}]})
  using decoded=decodePng(encoded)
  for(let play=0;play<2;play++){
    using canvas=decoded.compositor(),a=canvas.next().value!.image,b=canvas.next().value!.image
    same(a.copyPixels(),new Uint8Array([0,0,0,0,255,0,0,255]));same(b.copyPixels(),new Uint8Array([0,255,0,255,0,0,0,0]))
  }
})
test('APNG compositor joins on break error close and exhaustion; four shared image slots remain reusable',async()=>{
  const raster={data:new Uint8Array([10,20,30]),width:1,height:1}
  const encoded=await encodePngAnimationAsync({width:1,height:1,frames:[raster,raster]})
  using decoded=decodePng(encoded)
  for(let i=0;i<20;i++){
    const compositor=decoded.compositor()
    for(const frame of compositor){frame.image.close();break}
    expect(compositor.closed).toBe(true);expect(compositor.next().done).toBe(true)
  }
  const held=Array.from({length:4},()=>decoded.compositor())
  try{
    expect(()=>decoded.compositor()).toThrow('admission')
    expect(()=>decodePng(encoded)).toThrow('(-4)')
  }finally{for(const c of held){c.close();c.close()}}
  using again=decoded.compositor();again.close();expect(()=>again.next()).toThrow('closed')
  const invalidated=decoded.compositor();decoded.frames[0]!.image.close()
  expect(()=>invalidated.next()).toThrow('closed');expect(invalidated.closed).toBe(true)
  using after=decodePng(encoded);using available=after.compositor()
  const frame=available.next().value!;frame.image.close()
})
test('APNG compositor rejects undersized limits before ownership and snapshots options once',async()=>{
  const encoded=await encodePngAnimationAsync({width:2,height:1,frames:[{data:new Uint8Array(6),width:2,height:1}]})
  using decoded=decodePng(encoded)
  let reads=0
  using exact=decoded.compositor({get maxWorkingBytes(){reads++;return 16}});expect(reads).toBe(1)
  const displayed=exact.next().value!;displayed.image.close()
  for(const invalid of [0,-1,NaN,Infinity,1.5,15,257*1024*1024,'16',null])expect(()=>decoded.compositor({maxWorkingBytes:invalid as number})).toThrow()
  for(const invalid of [null,1,'options'])expect(()=>decoded.compositor(invalid as any)).toThrow()
  using png=CapturedImage.fromRaster({data:new Uint8Array([1,2,3]),width:1,height:1})
  using still=decodePng(png.encode({format:'png'}));const empty=still.compositor();expect(empty.next().done).toBe(true);expect(empty.closed).toBe(true)
  decoded.close();expect(()=>decoded.compositor()).toThrow('closed')
})
test('APNG two-dimensional previous/background disposal preserves every outside row and corner',async()=>{
  const full=new Uint8Array(4*3*4)
  for(let i=0;i<12;i++)full.set([240,10,20,255],i*4)
  const patch=new Uint8Array(2*2*4)
  for(let i=0;i<4;i++)patch.set([10,40,240,128],i*4)
  const encoded=await encodePngAnimationAsync({width:4,height:3,frames:[
    {data:full,width:4,height:3,format:'rgba'},
    {data:patch,width:2,height:2,format:'rgba',x:1,y:1,blend:'over',dispose:'previous'},
    {data:new Uint8Array([1,2,3,0]),width:1,height:1,format:'rgba',x:3,dispose:'background'},
    {data:new Uint8Array([0,255,0,255]),width:1,height:1,format:'rgba',y:2},
  ]})
  using source=decodePng(encoded),canvas=source.compositor()
  const expected=full.slice()
  for(let i=0;i<4;i++){
    using frame=canvas.next().value!.image
    if(i===1)for(const y of [1,2])for(const x of [1,2])expected.set([125,25,130,255],(y*4+x)*4)
    if(i===2){expected.set(full);expected.set([1,2,3,0],3*4)}
    if(i===3){expected.fill(0,3*4,4*4);expected.set([0,255,0,255],2*4*4)}
    same(frame.copyPixels(),expected)
  }
  const throwing=source.compositor(),error=new Error('consumer')
  expect(()=>{for(const frame of throwing){frame.image.close();throw error}}).toThrow(error)
  expect(throwing.closed).toBe(true)
})
test('APNG RGBA16 partial-alpha composition keeps low words and independent snapshots',async()=>{
  const dest=[0x1234,0x5678,0x9abc,0x4567],src=[0xabcd,0x2345,0x6789,0x3456]
  const raster=(values:number[])=>({data:bytes(values,16),width:1,height:1,format:'rgba' as const,bits:16 as const})
  const encoded=await encodePngAnimationAsync({width:1,height:1,frames:[raster(dest),{...raster(src),blend:'over'}]})
  using decoded=decodePng(encoded),canvas=decoded.compositor()
  using first=canvas.next().value!.image,second=canvas.next().value!.image
  const m=65535n,sa=BigInt(src[3]!),da=BigInt(dest[3]!),alpha=sa*m+da*(m-sa)
  const expected=src.slice(0,3).map((s,ch)=>Number((BigInt(s)*sa*m+BigInt(dest[ch]!)*da*(m-sa)+alpha/2n)/alpha))
  expected.push(Number((alpha+m/2n)/m))
  same(second.copyPixels(),bytes(expected,16));same(first.copyPixels(),bytes(dest,16))
})
test('APNG iterator snapshots controls and rejects FFI integer truncation before opening native owners',()=>{
  using image=CapturedImage.fromRaster({data:new Uint8Array([11,22,33]),width:1,height:1})
  const delay={numerator:7,denominator:0},frame={image,x:1,y:0,delay,dispose:'none' as const,blend:'source' as const}
  const frames=[frame]
  using canvas=new PngCompositor(2,1,8,frames)
  frame.x=0;delay.numerator=9;frames.length=0
  const rendered=canvas.next().value!;using displayed=rendered.image
  same(displayed.copyPixels(),new Uint8Array([0,0,0,0,11,22,33,255]));expect(rendered.delay).toEqual({numerator:7,denominator:0})
  for(const invalid of [-1,0,1.5,NaN,Infinity,0x100000001]){
    expect(()=>new PngCompositor(invalid,1,8,[])).toThrow()
    expect(()=>new PngCompositor(1,invalid,8,[])).toThrow()
  }
  expect(()=>new PngCompositor(1,1,264 as 8,[])).toThrow()
  for(const invalid of [-1,1.5,NaN,Infinity,0x100000001])expect(()=>new PngCompositor(2,1,8,[{...frame,x:invalid}])).toThrow()
  expect(()=>new PngCompositor(2,1,8,[{...frame,dispose:'invalid' as 'none'}])).toThrow()
})
