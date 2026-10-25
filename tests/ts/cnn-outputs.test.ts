import {test,expect} from 'bun:test'
import {Camera,CnnTensor,CnnOutputs,decodeCnnOutputs,type CnnOutputOptions} from '../../ts'
import {native as ffi,ptr} from '../../ts/ffi'
const native: {zc_cnn_catalog_outputs:(...args:Parameters<typeof ffi.zc_cnn_catalog_outputs>)=>number,zc_catalog_close:(...args:Parameters<typeof ffi.zc_catalog_close>)=>void}=ffi
function fixture(shapes:number[][]=[[2,3]],profile=16){
  const info=new Uint8Array(profile===16?712:264),d=new DataView(info.buffer)
  info.set(new TextEncoder().encode('trail-cnn'));d.setUint32(64,shapes.length,true)
  let count=0
  for(const [i,shape] of shapes.entries()){
    const at=68+i*(8+profile*2),elements=shape.reduce((a,b)=>a*b,1)
    d.setUint32(at,elements,true);d.setUint32(at+4,shape.length,true)
    shape.forEach((extent,axis)=>d.setUint16(at+8+axis*2,extent,true));count+=elements
  }
  info[68+profile*(8+profile*2)]=255
  return {info,values:Float32Array.from({length:count},(_,i)=>i)}
}
for(const profile of [8,16])test(`CNN ${profile} profile owns column-major values and converts explicitly`,()=>{
  const {info,values}=fixture([[2,3]],profile),output=decodeCnnOutputs(info,values)
  info.fill(0);values.fill(99)
  expect(output.networkName).toBe('trail-cnn');expect(output.frameCount).toBe(255)
  const t=output.tensors[0]
  expect(t.shape).toEqual([2,3]);expect(t.strides).toEqual([1,2])
  expect(t.get(1,2)).toBe(5);expect(Array.from(t.data)).toEqual([0,1,2,3,4,5])
  expect(Array.from(t.toRowMajor())).toEqual([0,2,4,1,3,5])
  for(const coords of [[1],[2,0],[0,3],[0,-1],[0,NaN],[0,0.5]])expect(()=>t.get(...coords)).toThrow()
})
test('CNN row order and logical batch views share values with explicit matching strides',()=>{
  const {info,values}=fixture(),output=decodeCnnOutputs(info,values,{order:'row-major',addBatch:true}),t=output.tensors[0]
  expect(t.shape).toEqual([1,2,3]);expect(t.strides).toEqual([0,3,1]);expect(t.get(0,1,2)).toBe(5)
  expect(Array.from(t.data)).toEqual([0,2,4,1,3,5]);expect(t.toRowMajor()).toEqual(t.data)
  expect(Object.isFrozen(t.shape)&&Object.isFrozen(t.strides)&&Object.isFrozen(output.tensors)).toBe(true)
})
test('CNN scalar empty rank16 and full16 tensor prefixes are distinct valid cases',()=>{
  const {info,values}=fixture([[],[0,3],Array(16).fill(1),...Array.from({length:13},()=>[1])])
  const output=decodeCnnOutputs(info,values,{addBatch:true})
  expect(output.tensors.length).toBe(16);expect(output.tensors[0].get(0)).toBe(0)
  expect(output.tensors[1].data.length).toBe(0);expect(()=>output.tensors[1].get(0,0,0)).toThrow()
  expect(output.tensors[1].toRowMajor().length).toBe(0)
  expect(output.tensors[2].shape.length).toBe(17);expect(output.tensors[2].get(...Array(17).fill(0))).toBe(1)
  const empty=fixture([]);expect(decodeCnnOutputs(empty.info,empty.values).tensors.length).toBe(0)
})
test('CNN reordering preserves NaN payloads signed zero and infinity bits',()=>{
  const {info,values}=fixture(),words=new Uint32Array(values.buffer),bits=[0x7fc01234,0x80000000,0x3f800000,0xff800000,0x7f800000,0]
  words.set(bits)
  const output=decodeCnnOutputs(info,values),row=output.tensors[0].toRowMajor()
  expect(Array.from(new Uint32Array(output.tensors[0].data.buffer))).toEqual(bits)
  expect(Array.from(new Uint32Array(row.buffer))).toEqual([bits[0],bits[2],bits[4],bits[1],bits[3],bits[5]])
})
test('CNN malformed geometry counts names and unknown ABI lengths reject',()=>{
  const {info,values}=fixture(),bad=(offset:number,value:number,width=4)=>{
    const b=info.slice(),d=new DataView(b.buffer)
    if(width===4)d.setUint32(offset,value,true);else d.setUint16(offset,value,true)
    expect(()=>decodeCnnOutputs(b,values)).toThrow()
  }
  bad(64,17);bad(68,5);bad(72,17);bad(76,65535,2)
  const name=info.slice();name[0]=255;expect(()=>decodeCnnOutputs(name,values)).toThrow()
  for(const length of [0,263,265,711,713])expect(()=>decodeCnnOutputs(new Uint8Array(length),values)).toThrow()
  for(const data of [values.subarray(0,5),new Float32Array(7)])expect(()=>decodeCnnOutputs(info,data)).toThrow()
})
test('CNN inputs reject shared detached proxy and incorrect typed views',()=>{
  const {info,values}=fixture()
  for(const input of [new Uint8Array(new SharedArrayBuffer(712)),new Proxy(info,{}),new Uint16Array(356)])expect(()=>decodeCnnOutputs(input as Uint8Array,values)).toThrow()
  for(const data of [new Float32Array(new SharedArrayBuffer(24)),new Proxy(values,{}),new Uint32Array(6)])expect(()=>decodeCnnOutputs(info,data as Float32Array)).toThrow()
  const detached=values.slice();structuredClone(detached.buffer,{transfer:[detached.buffer]})
  expect(()=>decodeCnnOutputs(info,detached)).toThrow()
})
test('CNN copied views detect detachment before element reads or native row copies',()=>{
  const {info,values}=fixture(),tensor=decodeCnnOutputs(info,values).tensors[0]
  structuredClone(tensor.data.buffer,{transfer:[tensor.data.buffer]})
  expect(()=>tensor.get(0,0)).toThrow();expect(()=>tensor.toRowMajor()).toThrow()
})
test('CNN options are bounded read once and resolved before source pointers',()=>{
  const {info,values}=fixture(),counts=new Map<string,number>()
  const options=new Proxy({},{get(_,key){counts.set(String(key),(counts.get(String(key))??0)+1);return undefined}})
  decodeCnnOutputs(info,values,options);expect([...counts.values()]).toEqual([1,1,1])
  for(const options of [null,[],{order:'bad'},{addBatch:1},{maxOutputBytes:0},{maxOutputBytes:5},{maxOutputBytes:68*1024*1024},{maxOutputBytes:NaN},{maxOutputBytes:20}])expect(()=>decodeCnnOutputs(info,values,options as CnnOutputOptions)).toThrow()
  expect(()=>decodeCnnOutputs(info,values,{get order(){structuredClone(values.buffer,{transfer:[values.buffer]});return 'row-major' as const}})).toThrow()
  expect(()=>new CnnTensor(Symbol(),info,values,'row-major',false)).toThrow()
  expect(()=>new CnnOutputs(Symbol(),info,values,{} as any)).toThrow()
})
test('CNN direct float copy exceeds ordinary 4MiB metadata ceiling without number lists',()=>{
  const {info,values}=fixture([[1024,1281]]);values[values.length-1]=123.5
  expect(values.byteLength).toBeGreaterThan(4*1024*1024)
  const tensor=decodeCnnOutputs(info,values,{maxOutputBytes:values.byteLength}).tensors[0]
  expect(tensor.data.length).toBe(values.length);expect(tensor.get(1023,1280)).toBe(123.5)
  expect(()=>decodeCnnOutputs(info,values,{maxOutputBytes:4*1024*1024})).toThrow()
})
const camera=()=>new Camera({simulate:true,width:16,height:16,buffers:3})
test('CNN frame snapshots distinguish absent metadata and respect retained leases',async()=>{
  const c=camera();c.start();const frame=c.acquire()!
  expect(frame.cnnOutputs()).toBeNull();await c.stop();expect(frame.cnnOutputs()).toBeNull()
  frame.release();expect(()=>frame.cnnOutputs()).toThrow();await c.close()
})
test('CNN frame option accessors cannot retire a lease before native admission',async()=>{
  const c=camera();c.start();const frame=c.acquire()!
  expect(()=>frame.cnnOutputs({get order(){frame.release();return 'column-major' as const}})).toThrow()
  await c.stop();await c.close()
})
test('CNN frame metadata overrides cannot retire a lease before native admission',async()=>{
  const c=camera();c.start();const frame=c.acquire()!,metadata=frame.metadata()
  frame.metadata=()=>{frame.release();return metadata}
  try{expect(()=>frame.cnnOutputs()).toThrow()}finally{await c.stop();await c.close()}
})
test('CNN frame wrapper owns capture context and always retires its catalog on decode errors',async()=>{
  const c=camera();c.start();const frame=c.acquire()!,{info,values}=fixture()
  const decode=native.zc_cnn_catalog_outputs,close=native.zc_catalog_close
  let closed=0
  native.zc_catalog_close=(catalog)=>{closed++;close(catalog)}
  // Deliberate decoder injection: the actual snapshot/lease acquisition remains
  // native. Positive selective metadata transport is tested in native core/SDK.
  native.zc_cnn_catalog_outputs=(_,order,max,header,data,capacity)=>ffi.zc_decode_cnn_outputs(ptr(info),BigInt(info.length),ptr(values),BigInt(values.byteLength),0,order,max,header,data,capacity)
  try{
    const output=frame.cnnOutputs()!;expect(closed).toBe(1)
    const timestamp=frame.metadata().timestampNs;frame.release();await c.stop()
    expect(output.capture!.timestampNs).toBe(timestamp);expect(output.tensors[0].get(1,2)).toBe(5)
    c.start();const next=c.acquire()!
    native.zc_cnn_catalog_outputs=()=>-1
    try{expect(()=>next.cnnOutputs()).toThrow();expect(closed).toBe(2)}finally{next.release();await c.stop()}
  }finally{native.zc_cnn_catalog_outputs=decode;native.zc_catalog_close=close;if(!frame.closed)frame.release();await c.close()}
})
