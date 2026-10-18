"""Bounded typed control ABI and names, independent of optional NumPy."""
import ctypes as C
import math
NAMES=('AeEnable','ExposureTime','AnalogueGain','ExposureValue','AwbEnable','ColourGains','Brightness','Contrast','Saturation','Sharpness','FrameDurationLimits','LensPosition','AfMode','AfTrigger','AfRange','AfSpeed','AfMetering','AfWindows','ScalerCrop','NoiseReductionMode','AeMeteringMode','AeExposureMode','AwbMode','ExposureTimeMode','AnalogueGainMode','AfPause','AeConstraintMode','ColourTemperature','AeFlickerMode','AeFlickerPeriod')
class Control(C.Structure):
    _fields_=[(n,C.c_uint32) for n in ('id','type','count','reserved')]+[('values',C.c_double*16)]
class ControlInfo(C.Structure):
    _fields_=[(n,C.c_uint32) for n in ('id','type','min_count','max_count')]+[(n,C.c_double*4) for n in ('min','max','default')]+[('enum_mask',C.c_uint64)]
class Metadata(C.Structure):
    _fields_=[('struct_size',C.c_uint32),('valid',C.c_uint32)]+[(n,C.c_uint64) for n in ('event_id','sequence','timestamp_ns','control_revision')]+[('exposure_us',C.c_uint32),('af_state',C.c_int32),('af_pause_state',C.c_int32),('reserved',C.c_uint32)]+[(n,C.c_float) for n in ('analogue_gain','lens_position','red_gain','blue_gain')]+[('frame_duration_us',C.c_uint64),('crop',C.c_int32*4)]
def metadata(native):
    result={n:getattr(native,n) for n in ('event_id','sequence','timestamp_ns','control_revision','exposure_us','analogue_gain','red_gain','blue_gain')}
    if native.valid&1: result['af_state']=native.af_state
    if native.valid&2: result['lens_position']=native.lens_position
    if native.valid&4: result['frame_duration_us']=native.frame_duration_us
    if native.valid&8: result['crop']=tuple(native.crop)
    if native.af_pause_state>=0: result['af_pause_state']=native.af_pause_state
    return result

def capabilities(camera):
    camera._open();result={}
    for id,name in enumerate(NAMES,1):
        info=ControlInfo();status=camera._lib.zc_get_control_info(camera._handle,id,C.byref(info))
        if status==-8: continue
        camera._check(status)
        count=4 if info.type==4 else info.min_count
        def value(field):
            values=tuple(getattr(info,field)[:count])
            if any(not math.isfinite(v) for v in values): return None
            if info.type!=3: values=tuple(int(v) for v in values)
            return values[0] if count==1 else values
        result[name]={'id':id,'type':info.type,'min_count':info.min_count,'max_count':info.max_count,'min':value('min'),'max':value('max'),'default':value('default'),'enum_mask':info.enum_mask}
    return result

def set_controls(camera,values):
    camera._open()
    if not values or len(values)>32: raise ValueError('Expected 1..32 controls')
    descriptors=camera.control_info;batch=(Control*len(values))()
    for index,(name,value) in enumerate(values.items()):
        if name not in descriptors: raise NotImplementedError(f'Control not supported by this camera: {name}')
        info=descriptors[name];entry=batch[index];entry.id=info['id'];entry.type=info['type']
        if entry.type==4:
            if name=='ScalerCrop': sequence=tuple(value)
            else: sequence=tuple(n for rect in value for n in rect)
        elif isinstance(value,(tuple,list)): sequence=tuple(value)
        else: sequence=(value,)
        if not info['min_count']<=len(sequence)<=info['max_count']: raise ValueError(f'Invalid value shape for {name}')
        if entry.type==1 and any(not isinstance(v,(bool,int)) or v not in (0,1) for v in sequence): raise ValueError(f'{name} requires bool')
        if any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in sequence): raise ValueError('Control values must be finite numbers')
        if entry.type!=3 and any(int(v)!=v for v in sequence): raise ValueError('Integer/rectangle controls require integers')
        entry.count=len(sequence);entry.values[:len(sequence)]=sequence
    revision=C.c_uint64()
    camera._check(camera._lib.zc_set_controls(camera._handle,batch,len(batch),C.byref(revision)))
    return revision.value
