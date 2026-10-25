import {expect,test} from 'bun:test'
import {Camera,CameraError,IMX500,Imx500Error,Imx500ConstructionError,getTuningState} from '../../ts'
import {native as n} from '../../ts/ffi'
const open=()=>new IMX500({backend:'synthetic'})
const reset={x:0,y:0,width:0,height:0}
const full={x:0,y:0,width:4056,height:3040}
test('IMX500 owns exact selectors without retaining a manager and preserves cached ROI after close',()=>{
 let reads=0
 const sensor=new IMX500({get backend(){reads++;return 'synthetic' as const},get index(){reads++;return 0},get cameraId(){reads++;return undefined}})
 try{
  expect(reads).toBe(3);expect(sensor.cameraId).toBe('synthetic')
  expect(getTuningState({simulate:true}).managerUsers).toBe(0)
  sensor.setInferenceRoiAbs(reset)
  const state=sensor.setInferenceRoiAbs({x:100,y:200,width:300,height:400})
  expect(state).toMatchObject({backend:'synthetic',writeAttempted:true,writeSucceeded:true,changed:true,currentRaw:[100,200,300,400],currentRoi:{x:100,y:200,width:300,height:400}})
  expect(Object.isFrozen(state)).toBe(true);expect(Object.isFrozen(state.currentRaw)).toBe(true)
  expect(Object.isFrozen(state.currentRoi)).toBe(true)
  expect(()=>open()).toThrow(CameraError)
  sensor.close();sensor.close();expect(sensor.closed).toBe(true)
  expect(()=>sensor.getInferenceRoi()).toThrow(CameraError)
  using next=new IMX500({backend:'synthetic',cameraId:'synthetic'})
  expect(next.getInferenceRoi().currentRaw).toEqual([100,200,300,400])
  expect(state.currentRaw).toEqual([100,200,300,400])
  next.setInferenceRoiAbs(reset)
 }finally{sensor.close();using cleanup=open();cleanup.setInferenceRoiAbs(reset)}
})
test('IMX500 clips crops, encodes full/reset sentinels and forces only explicit restoration',()=>{
 using sensor=open();sensor.setInferenceRoiAbs(reset)
 expect(sensor.getInferenceRoi()).toMatchObject({currentRoi:full,currentRaw:[0,0,0,0],control:{minimum:0,maximum:4032,step:1}})
 const square=sensor.setInferenceAspectRatio({width:1,height:1})
 expect(square.currentRoi).toEqual({x:508,y:0,width:3040,height:3040})
 const same=sensor.setInferenceAspectRatio({width:1,height:1})
 expect(same).toMatchObject({revision:square.revision,writeAttempted:false,writeSucceeded:false,changed:false})
 const restored=sensor.restoreInferenceRoi()
 expect(restored).toMatchObject({revision:square.revision!+1n,writeAttempted:true,writeSucceeded:true,changed:false})
 expect(sensor.setInferenceRoiAbs({x:-100,y:-100,width:200,height:200}).currentRaw).toEqual([0,0,100,100])
 const before=sensor.getInferenceRoi()
 for(const request of [{x:0,y:0,width:4056,height:100},{x:5000,y:0,width:2,height:2},{x:1,y:0,width:0,height:0}]){
  try{sensor.setInferenceRoiAbs(request);throw Error('accepted unsupported crop')}
  catch(error){expect(error).toBeInstanceOf(Imx500Error);const e=error as Imx500Error;expect(e.state.writeAttempted).toBe(false);expect(e.state.revision).toBe(before.revision);expect(e.state.currentRaw).toEqual(before.currentRaw);expect(e.state.savedRaw).toEqual(before.savedRaw)}
 }
 expect(sensor.setInferenceRoiAbs(full).currentRaw).toEqual([0,0,0,0])
 expect(sensor.setInferenceRoiAbs(reset).writeAttempted).toBe(false)
 expect(sensor.getDeviceId()).toBe('53594E544845544943494D5835303000')
})
test('IMX500 rejects malformed options and geometry without consuming admission',()=>{
 for(const value of [null,[],{backend:'wrong'},{backend:'synthetic',index:-1},{backend:'synthetic',index:0xffffffff},{backend:'synthetic',cameraId:''},{backend:'synthetic',cameraId:'x\0y'},{backend:'synthetic',cameraId:'\ud800'},{backend:'synthetic',index:0,cameraId:'synthetic'},{backend:'synthetic',index:1},{backend:'synthetic',cameraId:'absent'}])expect(()=>new IMX500(value as never)).toThrow()
 using sensor=open()
 for(const value of [NaN,Infinity,-1,1.5,0x100000000])expect(()=>sensor.setInferenceRoiAbs({x:0,y:0,width:value,height:1})).toThrow(RangeError)
 expect(()=>sensor.setInferenceAspectRatio({width:0,height:1})).toThrow(RangeError)
 expect(()=>sensor.setInferenceRoiAbs({get x(){sensor.close();return 0},y:0,width:1,height:1})).toThrow(CameraError)
 expect(sensor.closed).toBe(true)
 using next=open();next.setInferenceRoiAbs(reset)
})
test('IMX500 descriptor persists across asynchronous camera mode changes',async()=>{
 using sensor=open();sensor.setInferenceRoiAbs(reset)
 await using camera=new Camera({simulate:true,width:32,height:24,fifo:true})
 try{
  sensor.setInferenceAspectRatio({width:1,height:1})
  const state=sensor.getInferenceRoi()
  await camera.switchMode({width:48,height:32,fifo:true})
  expect(sensor.getInferenceRoi().currentRaw).toEqual(state.currentRaw)
  expect(sensor.getInferenceRoi().revision).toBe(state.revision)
  sensor.setInferenceRoiAbs({x:0,y:0,width:100,height:200})
  await camera.switchModeAndCaptureMetadata({width:64,height:48,fifo:true})
  expect(sensor.getInferenceRoi().currentRaw).toEqual([0,0,100,200])
 }finally{sensor.setInferenceRoiAbs(reset)}
})
test('IMX500 failed identity adoption retains an explicit retry owner when close is busy',()=>{
 const query=n.zc_imx500_camera_id,close=n.zc_imx500_close
 let failure:Imx500ConstructionError|undefined
 try{
  Object.assign(n,{zc_imx500_camera_id:()=>-3})
  Object.assign(n,{zc_imx500_close:()=>-4})
  try{open();throw Error('adopted invalid identity')}catch(error){expect(error).toBeInstanceOf(Imx500ConstructionError);failure=error as Imx500ConstructionError;expect(failure.cleanupCode).toBe(-4)}
 }finally{Object.assign(n,{zc_imx500_camera_id:query,zc_imx500_close:close})}
 expect(()=>open()).toThrow(CameraError)
 failure!.cleanupOwner.close();failure!.cleanupOwner.close()
 using next=open();next.setInferenceRoiAbs(reset)
})
test('IMX500 failed close retains the handle for explicit retry',()=>{
 const sensor=open(),close=n.zc_imx500_close
 try{
  Object.assign(n,{zc_imx500_close:()=>-4})
  expect(()=>sensor.close()).toThrow(CameraError);expect(sensor.closed).toBe(false)
 }finally{Object.assign(n,{zc_imx500_close:close});sensor.close()}
 using next=open();next.setInferenceRoiAbs(reset)
})
