import {test,expect} from 'bun:test'
import {Camera,InferenceProjection,inferenceAspectCrop,decodeCnnKpi,type InferenceGeometry,type FrameInferenceOptions} from '../../ts'
import {native as ffi,ptr} from '../../ts/ffi'
const native:{zc_frame_cnn_kpi:(...args:Parameters<typeof ffi.zc_frame_cnn_kpi>)=>number}=ffi
const geometry=():InferenceGeometry=>({fullSensor:{width:100,height:80},sensorOutput:{width:100,height:80},output:{width:50,height:40},scalerCrop:{x:0,y:0,width:100,height:80}})
test('inference projection owns geometry and applies normalized and absolute coordinates',()=>{
  const options=geometry(),p=new InferenceProjection(options)
  ;(options.fullSensor as {width:number}).width=200;(options.output as {width:number}).width=1000;(options.scalerCrop as {width:number}).width=1
  expect(p.convert([0.25,0.25,0.75,0.75])).toEqual({x:12,y:10,width:25,height:20})
  expect(p.project({x:25,y:20,width:50,height:40})).toEqual(p.convert([0.25,0.25,0.75,0.75]))
  expect(p.roiScaled()).toEqual({x:0,y:0,width:50,height:40})
  expect(Object.isFrozen(p.fullSensor)&&Object.isFrozen(p.scalerCrop)).toBe(true)
})
test('inference ROI clipping and raw/scaler rounding agree with staged sensor math',()=>{
  const p=new InferenceProjection({fullSensor:{width:4056,height:3040},sensorOutput:{width:2028,height:1520},output:{width:640,height:480},scalerCrop:{x:100,y:200,width:2000,height:1600},roi:{x:200,y:300,width:1200,height:900}})
  expect(p.roiScaled()).toEqual({x:32,y:30,width:384,height:270})
  const tiny=new InferenceProjection({fullSensor:{width:7,height:7},sensorOutput:{width:5,height:5},output:{width:11,height:11},scalerCrop:{x:1,y:1,width:5,height:5}})
  expect(tiny.project({x:2,y:2,width:2,height:2})).toEqual({x:3,y:3,width:3,height:3})
})
test('inference clipping keeps empty anchors and clamps negative normalized origins before scaling',()=>{
  const p=new InferenceProjection(geometry())
  expect(p.convert([-1,-1,1,1])).toEqual({x:0,y:0,width:50,height:40})
  expect(p.convert([2,2,3,3])).toEqual({x:100,y:80,width:0,height:0})
  expect(p.convert([0.75,0.75,0.25,0.25])).toEqual({x:37,y:30,width:0,height:0})
  expect(new InferenceProjection({...geometry(),roi:{x:0,y:0,width:0,height:0}}).roiScaled()).toEqual(p.roiScaled())
})
test('centered aspect crops use libcamera integer centers including odd crop widths',()=>{
  expect(inferenceAspectCrop({width:4056,height:3040},{width:1,height:1})).toEqual({x:508,y:0,width:3040,height:3040})
  expect(inferenceAspectCrop({width:8,height:5},{width:1,height:1})).toEqual({x:2,y:0,width:5,height:5})
  expect(inferenceAspectCrop({width:8,height:8},{width:0xffffffff,height:0xffffffff})).toEqual({x:0,y:0,width:8,height:8})
  expect(()=>inferenceAspectCrop({width:1,height:1},{width:1,height:100})).toThrow()
})
test('inference invalid sizes crops values and coordinate spans reject explicitly',()=>{
  for(const change of [{fullSensor:{width:0,height:80}},{output:{width:NaN,height:40}},{sensorOutput:{width:0x80000000,height:1}},{scalerCrop:{x:90,y:0,width:11,height:1}},{scalerCrop:{x:-1,y:0,width:10,height:10}}])expect(()=>new InferenceProjection({...geometry(),...change})).toThrow()
  const p=new InferenceProjection(geometry())
  for(const values of [[],[0,1,2],[0,NaN,1,1],[0,Infinity,1,1],[0,1e100,1,1],[0,0,1,1,2]])expect(()=>p.convert(values)).toThrow()
  for(const r of [{x:0.5,y:0,width:1,height:1},{x:0,y:0,width:-1,height:1},{x:0x80000000,y:0,width:1,height:1}])expect(()=>p.project(r)).toThrow()
  expect(p.convert(new Float32Array([0,0,1,1]))).toEqual({x:0,y:0,width:50,height:40})
})
test('inference standalone option accessors resolve once before publishing a plan',()=>{
  const calls=new Map<string,number>(),g=geometry()
  const options=new Proxy(g,{get(target,key){calls.set(String(key),(calls.get(String(key))??0)+1);return Reflect.get(target,key)}})
  new InferenceProjection(options)
  for(const key of ['fullSensor','sensorOutput','output','scalerCrop','roi'])expect(calls.get(key)).toBe(1)
})
const camera=(raw=true,lores=true)=>new Camera({simulate:true,width:64,height:48,raw,...(lores?{lores:{width:16,height:16}}:{})})
test('request inference plans own main/lores geometry and capture metadata after source closure',async()=>{
  const c=camera();c.start();const f=c.acquire()!
  const main=f.inferenceProjection({fullSensor:{width:64,height:48}}),lores=f.inferenceProjection({fullSensor:{width:64,height:48},stream:'lores'}),timestamp=f.metadata().timestampNs
  f.release();await c.close()
  expect(main.convert([0.25,0.25,0.75,0.75])).toEqual({x:16,y:12,width:32,height:24})
  expect(lores.convert([0.25,0.25,0.75,0.75])).toEqual({x:4,y:4,width:8,height:8})
  expect(main.capture!.timestampNs).toBe(timestamp);expect(Object.isFrozen(main.capture!.crop)).toBe(true)
})
test('request inference uses exact pixel-array properties with explicit captured crop',async()=>{
  const c=camera();c.start();const f=c.acquire()!,metadata=f.metadata()
  f.metadata=()=>({...metadata,crop:{x:0,y:0,width:4056,height:3040}})
  try{const p=f.inferenceProjection();expect(p.fullSensor).toEqual({width:4056,height:3040});expect(p.roiScaled()).toEqual({x:0,y:0,width:64,height:48})}finally{f.release();await c.close()}
})
test('request inference rejects missing raw streams applied crop and selected output',async()=>{
  for(const [raw,lores]of [[false,true],[true,false]]){
    const c=camera(raw,lores);c.start();const f=c.acquire()!
    try{expect(()=>f.inferenceProjection({fullSensor:{width:64,height:48},stream:'lores'})).toThrow()}finally{f.release();await c.close()}
  }
  const c=camera();c.start();const f=c.acquire()!,old=f.metadata()
  f.metadata=()=>({...old,validMask:old.validMask&~8})
  try{expect(()=>f.inferenceProjection({fullSensor:{width:64,height:48}})).toThrow('ScalerCrop')}finally{f.release();await c.close()}
})
test('request inference admission cannot use a frame retired by options or configuration accessors',async()=>{
  for(const stage of ['option','configuration']){
    const c=camera();c.start();const f=c.acquire()!,configuration=f.configuration()
    const options:FrameInferenceOptions=stage==='option'?{get fullSensor(){f.release();return {width:64,height:48}}}:{fullSensor:{width:64,height:48}}
    if(stage==='configuration')f.configuration=()=>{f.release();return configuration}
    try{expect(()=>f.inferenceProjection(options)).toThrow()}finally{if(!f.closed)f.release();await c.close()}
  }
})
test('CNN KPI decoding preserves raw signed values and explicit Picamera conversion',()=>{
  const b=new Uint8Array(8),d=new DataView(b.buffer);d.setInt32(0,13961,true);d.setInt32(4,12360,true)
  const kpi=decodeCnnKpi(b);b.fill(0)
  expect(kpi).toEqual({dnnRaw:13961,dspRaw:12360,picameraMilliseconds:{dnn:13.961,dsp:12.36}})
  expect(Object.isFrozen(kpi)&&Object.isFrozen(kpi.picameraMilliseconds)).toBe(true)
  d.setInt32(0,-0x80000000,false);d.setInt32(4,0x7fffffff,false)
  expect(decodeCnnKpi(b,'big').dnnRaw).toBe(-0x80000000)
})
test('CNN KPI malformed shared detached proxy and byte-order inputs reject',()=>{
  for(const data of [new Uint8Array(7),new Uint8Array(9),new Uint8Array(new SharedArrayBuffer(8)),new Proxy(new Uint8Array(8),{})])expect(()=>decodeCnnKpi(data)).toThrow()
  const b=new Uint8Array(8);structuredClone(b.buffer,{transfer:[b.buffer]});expect(()=>decodeCnnKpi(b)).toThrow()
  expect(()=>decodeCnnKpi(new Uint8Array(8),'native' as 'little')).toThrow()
})
test('CNN request KPI absence and retained copied results survive source retirement',async()=>{
  const c=camera();c.start();const f=c.acquire()!,original=native.zc_frame_cnn_kpi
  expect(f.cnnKpi()).toBeNull()
  const raw=new Uint8Array([0x88,0x13,0,0,0xe8,3,0,0])
  // Native core separately tests actual selective transport. This injection
  // checks Bun adoption of an owned fixed-size native result.
  native.zc_frame_cnn_kpi=(_,__,out)=>ffi.zc_decode_cnn_kpi(ptr(raw),8n,0,out)
  try{const result=f.cnnKpi()!;f.release();await c.close();expect(result.dnnRaw).toBe(5000);expect(result.picameraMilliseconds.dsp).toBe(1);expect(()=>f.cnnKpi()).toThrow()}finally{native.zc_frame_cnn_kpi=original;if(!f.closed)f.release();await c.close()}
})
