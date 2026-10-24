// Isolated Linux process with tests/drm_kms_preload.c as its protocol peer.
import {strict as assert} from 'node:assert'
import {dlopen,FFIType,ptr} from 'bun:ffi'
import {listDrmDisplays} from '../../ts'
const fixture=process.env.ZC_KMS_FIXTURE
if(process.platform!=='linux'||!fixture)throw new Error('Linux KMS UAPI fixture required')
const lib=dlopen(fixture,{zkms_test_scenario:{args:[FFIType.i32],returns:FFIType.void},zkms_test_counts:{args:[FFIType.ptr],returns:FFIType.void}})
try{
  for(let scenario=0;scenario<=5;scenario++){
    lib.symbols.zkms_test_scenario(scenario)
    const result=listDrmDisplays({card:'/dev/zig-camera-kms-fixture'})
    const counters=new Uint32Array(5);lib.symbols.zkms_test_counts(ptr(counters))
    assert.deepEqual([counters[0],counters[1],counters[3],counters[4]],[1,1,0,0]);assert.ok(counters[2]!>4)
    if(scenario===0||scenario===2){
      assert.equal(result.displays.length,2);assert.deepEqual(result.issues,[])
      const [a,b]=result.displays
      assert.deepEqual([a!.card,a!.name,a!.connectorId,a!.currentCrtcId,a!.status],['/dev/zig-camera-kms-fixture','HDMI-A-1',20,10,'connected'])
      assert.deepEqual(a!.activeMode,{width:1920,height:1080});assert.deepEqual(a!.defaultMode,{width:1280,height:720})
      assert.deepEqual(a!.crtcs,[10]);assert.deepEqual(b!.crtcs,[11]);assert.equal(a!.atomic,scenario===0);assert.equal(a!.universalPlanes,true)
      assert.deepEqual(a!.formats.map(f=>[f.fourcc,f.processedFormat]),[[0x34325258,'XRGB8888'],[0x3231564e,'NV12'],[0xdeadbeef,undefined]])
      assert.deepEqual(b!.formats.map(f=>f.processedFormat),['RGB888','NV12',undefined]);assert.equal(b!.status,'disconnected');assert.equal(b!.activeMode,undefined);assert.equal(b!.defaultMode,undefined)
      assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a!.formats));assert.ok(Object.isFrozen(a!.formats[0]));assert.ok(Object.isFrozen(a!.activeMode))
    }else{
      assert.equal(result.displays.length,0);assert.equal(result.issues.length,1)
      const issue=result.issues[0]!
      assert.equal(issue.reason,scenario===3?'limit':scenario===4?'system':'race')
      assert.equal(issue.stage,scenario===1?'recheck':scenario===4?'plane':'connector')
      assert.equal(issue.errorNumber,scenario===4?5:0)
    }
  }
  console.log('Linux KMS UAPI catalog, capability rejection, unknown formats, topology rollback and FD retirement passed')
}finally{lib.close()}
