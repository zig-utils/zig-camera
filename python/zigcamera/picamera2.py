"""Explicit Picamera2-style subset, backed by native frame leases.

Includes typed runtime controls, focus jobs and async preview. This is not a
drop-in Picamera2 module. Recording uses Home MJPEG/MKV or optional AVC/HEVC/MP4.
"""
from dataclasses import dataclass
from . import Camera
from .modes import serialized as _serialized

@dataclass(frozen=True)
class MJPEGEncoder:
    quality: int = 90

@dataclass(frozen=True)
class H264Encoder:
    bitrate: int = 0
    iperiod: int = 60
    quality: int = 90

@dataclass(frozen=True)
class HEVCEncoder:
    bitrate: int = 0
    iperiod: int = 60
    quality: int = 90

def _metadata(frame):
    m=frame.metadata
    result={"SensorTimestamp":m["timestamp_ns"],"ExposureTime":m["exposure_us"],"AnalogueGain":m["analogue_gain"],"ColourGains":(m["red_gain"],m["blue_gain"]),"Sequence":m["sequence"],"ControlRevision":m['control_revision'],"EventId":m['event_id']}
    for a,b in (('af_state','AfState'),('af_pause_state','AfPauseState'),('lens_position','LensPosition'),('frame_duration_us','FrameDuration'),('crop','ScalerCrop')):
        if a in m: result[b]=m[a]
    return result

class CompletedRequest:
    def __init__(self,frame): self._frame=frame
    def make_array(self,name="main"):
        return self._frame.numpy(name)
    def make_buffer(self,name="main"):
        return self._frame.copy_buffer(name)
    def get_metadata(self): return _metadata(self._frame)
    def save(self,name,file_output):
        if name=="raw": self._frame.save_dng(file_output)
        elif name=="main": self._frame.save(file_output)
        else: raise ValueError("Unknown stream")
    def release(self): self._frame.release()
    def __enter__(self): return self
    def __exit__(self,*exc): self.release()

class Picamera2:
    def __init__(self,camera_num=0,*,simulate=False,library=None):
        import threading
        self._operation_lock=threading.RLock();self._mode_guard=threading.Lock();self._mode_job=None;self._operation_slots=threading.BoundedSemaphore(32);self._preview_options=None
        self.camera_num=camera_num;self.simulate=simulate;self.library=library;self._camera=None;self._config=None
    def _configuration(self,role,main,raw,buffer_count,controls,default_size,lores=None,sensor=None):
        main=dict(main or {})
        if set(main)-{"size","format"}: raise NotImplementedError("Main configuration supports size and format")
        if main.get("format","BGR888")!="BGR888": raise NotImplementedError("Only BGR888 (RGB byte order) is supported")
        size=tuple(main.get("size",default_size))
        if len(size)!=2: raise ValueError("size must be (width,height)")
        return {"role":role,"main":{"size":size,"format":"BGR888"},"raw":None if raw is None else dict(raw),
                "buffer_count":buffer_count,"controls":dict(controls or {}),"lores":None if lores is None else dict(lores),"sensor":None if sensor is None else dict(sensor)}
    def create_preview_configuration(self,main=None,*,raw=None,buffer_count=4,controls=None,lores=None,sensor=None):
        return self._configuration("preview",main,raw,buffer_count,controls,(640,480),lores,sensor)
    def create_video_configuration(self,main=None,*,raw=None,buffer_count=6,controls=None,lores=None,sensor=None):
        return self._configuration("video",main,raw,buffer_count,controls,(1920,1080),lores,sensor)
    def create_still_configuration(self,main=None,*,raw={},buffer_count=4,controls=None,lores=None,sensor=None):
        return self._configuration("still",main,raw,buffer_count,controls,(0,0),lores,sensor)
    @_serialized
    def configure(self,config):
        if isinstance(config,str):
            if config not in ("preview","video","still"): raise ValueError("Unknown configuration")
            config=getattr(self,f"create_{config}_configuration")()
        size=config["main"]["size"];options={"width":size[0],"height":size[1],"buffer_count":config["buffer_count"],"camera_index":self.camera_num}
        raw=config["raw"]
        if raw is not None:
            if set(raw)-{"format"}: raise NotImplementedError("Raw configuration supports format; size is negotiated")
            options.update(raw=True,unpacked_raw=True)
            if "format" in raw: options["raw_format"]=raw["format"]
        if self._camera is not None:
            if self._camera._started: raise RuntimeError("Stop before configuring")
            self._camera.close();self._camera=None
        self._camera=Camera(library=self.library,simulate=self.simulate,role=config["role"],lores=config.get("lores"),sensor=config.get("sensor"),**options)
        if config["controls"]: self._camera.set_controls(config["controls"])
        self._config=config
    def _ready(self):
        if self._camera is None: self.configure(self.create_preview_configuration())
        return self._camera
    @_serialized
    def camera_configuration(self):
        camera=self._ready();result=dict(self._config)
        result["main"]=dict(result["main"],size=(camera.info["main"]["width"],camera.info["main"]["height"]),stride=camera.info["main"]["stride"])
        result['sensor']=dict(camera.info['sensor'])
        if camera.info['lores']['width']:
            l=camera.info['lores'];result['lores']={'size':(l['width'],l['height']),'format':l['format'],'stride':l['stride']}
        return result
    @property
    @_serialized
    def sensor_modes(self): return self._ready().sensor_modes
    @property
    @_serialized
    def camera_controls(self):
        return {name:(info['min'],info['max'],info['default']) for name,info in self._ready().control_info.items()}
    @_serialized
    def set_controls(self,controls): return self._ready().set_controls(controls)
    @_serialized
    def autofocus_cycle(self,wait=None,signal_function=None,*,timeout=5): return self._ready().autofocus_cycle(wait,signal_function,timeout=timeout)
    def wait(self,job,timeout=None): return job.result(timeout)
    @_serialized
    def start_preview(self,*,title='zig-camera',startup_timeout=5):
        preview=self._ready().start_preview(title=title,startup_timeout=startup_timeout)
        self._preview_options={'title':title,'startup_timeout':startup_timeout};return preview
    @_serialized
    def stop_preview(self):
        self._preview_options=None
        if self._camera is not None: self._camera.stop_preview()
    @_serialized
    def start(self): self._ready().start()
    @_serialized
    def stop(self):
        self._preview_options=None
        if self._camera is not None: self._camera.stop()
    @_serialized
    def close(self):
        self._preview_options=None
        if self._camera is not None: self._camera.close();self._camera=None
    @_serialized
    def capture_request(self,*,timeout_ms=5000,wait=None,signal_function=None):
        return self._ready()._capture(lambda frame:CompletedRequest(frame),wait,signal_function,timeout_ms,retain=True)
    @_serialized
    def captured_request(self,*,timeout_ms=5000): return self.capture_request(timeout_ms=timeout_ms)
    @_serialized
    def capture_array(self,name="main",*,wait=None,signal_function=None,timeout_ms=5000):
        return self._ready().capture_array(timeout_ms,name=name,wait=wait,signal_function=signal_function)
    @_serialized
    def capture_buffer(self,name="main",*,wait=None,signal_function=None,timeout_ms=5000):
        return self._ready().capture_buffer(timeout_ms,name=name,wait=wait,signal_function=signal_function)
    @_serialized
    def capture_metadata(self,*,wait=None,signal_function=None,timeout_ms=5000):
        return self._ready()._capture(_metadata,wait,signal_function,timeout_ms)
    @_serialized
    def capture_file(self,file_output,name="main",*,wait=None,signal_function=None,timeout_ms=5000):
        if name not in ('main','raw'): raise ValueError('Still saving supports main and raw')
        def save(frame):
            if name=='raw': frame.save_dng(file_output)
            else: frame.save(file_output)
        return self._ready()._capture(save,wait,signal_function,timeout_ms)
    @_serialized
    def start_recording(self,encoder,output,*,fps=30,audio=None):
        if isinstance(encoder,MJPEGEncoder): options={"codec":"mjpeg","quality":encoder.quality}
        elif isinstance(encoder,(H264Encoder,HEVCEncoder)):
            options={"codec":"h264" if isinstance(encoder,H264Encoder) else "hevc","quality":encoder.quality,"bitrate":encoder.bitrate,"gop":encoder.iperiod}
        else: raise NotImplementedError("Use a Home MJPEGEncoder, H264Encoder or HEVCEncoder")
        from .outputs import CircularOutput
        if isinstance(output,CircularOutput):
            if output._recording is not None and not output._recording.closed: raise RuntimeError('Circular output is already bound')
            recording=self._ready().start_recording(None,fps=fps,circular=output.config,audio=audio,**options)
            output._bind(recording);return recording
        return self._ready().start_recording(output,fps=fps,audio=audio,**options)
    @_serialized
    def split_recording(self,output,*,wait=None,signal_function=None):
        return self._ready().split_recording(output,wait=wait,signal_function=signal_function)
    @_serialized
    def add_recording_output(self,output): return self._ready().add_recording_output(output)
    @_serialized
    def remove_recording_output(self,output): return self._ready().remove_recording_output(output)
    def _switch(self,config,operation,wait,signal_function,num_frames,timeout_ms):
        from .modes import submit
        return submit(self,config,operation,wait,signal_function,num_frames,timeout_ms)
    def switch_mode(self,config,wait=None,signal_function=None,*,timeout_ms=5000):
        return self._switch(config,None,wait,signal_function,0,timeout_ms)
    def switch_mode_and_drop_frames(self,config,num_frames,wait=None,signal_function=None,*,timeout_ms=5000):
        return self._switch(config,None,wait,signal_function,num_frames,timeout_ms)
    def switch_mode_and_capture_array(self,config,name='main',wait=None,signal_function=None,*,num_frames=0,timeout_ms=5000):
        return self._switch(config,lambda frame:frame.numpy(name),wait,signal_function,num_frames,timeout_ms)
    def switch_mode_and_capture_buffer(self,config,name='main',wait=None,signal_function=None,*,num_frames=0,timeout_ms=5000):
        return self._switch(config,lambda frame:frame.copy_buffer(name),wait,signal_function,num_frames,timeout_ms)
    def switch_mode_and_capture_metadata(self,config,wait=None,signal_function=None,*,num_frames=0,timeout_ms=5000):
        return self._switch(config,_metadata,wait,signal_function,num_frames,timeout_ms)
    def switch_mode_and_capture_file(self,config,file_output,name='main',wait=None,signal_function=None,*,num_frames=0,timeout_ms=5000):
        if name not in ('main','raw'): raise ValueError('Still saving supports main and raw')
        def save(frame):
            if name=='raw': frame.save_dng(file_output)
            else: frame.save(file_output)
            return _metadata(frame)
        return self._switch(config,save,wait,signal_function,num_frames,timeout_ms)
    @_serialized
    def stop_recording(self): self._ready().stop_recording()
    @_serialized
    def preview(self,frames=300): return self._ready().preview(frames=frames)
    def __enter__(self): return self
    @_serialized
    def __exit__(self,*exc):
        if self._camera is not None:
            try: return self._camera.__exit__(*exc)
            finally: self._camera=None
