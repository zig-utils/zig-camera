"""Explicit Picamera2-style subset, backed by native frame leases.

Includes typed runtime controls, focus jobs and async preview. This is not a
drop-in Picamera2 module. Recording uses Home MJPEG/MKV or optional AVC/HEVC/MP4.
"""
from dataclasses import dataclass
from . import Camera

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
        if name!="main": raise NotImplementedError("Use save_dng for the raw stream")
        return self._frame.numpy()
    def make_buffer(self,name="main"):
        if name!="main": raise NotImplementedError("Raw byte access uses the native Frame API")
        return self._frame.copy_rgb()
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
        self.camera_num=camera_num;self.simulate=simulate;self.library=library;self._camera=None;self._config=None
    def _configuration(self,role,main,raw,buffer_count,controls,default_size):
        main=dict(main or {})
        if set(main)-{"size","format"}: raise NotImplementedError("Main configuration supports size and format")
        if main.get("format","BGR888")!="BGR888": raise NotImplementedError("Only BGR888 (RGB byte order) is supported")
        size=tuple(main.get("size",default_size))
        if len(size)!=2: raise ValueError("size must be (width,height)")
        return {"role":role,"main":{"size":size,"format":"BGR888"},"raw":None if raw is None else dict(raw),
                "buffer_count":buffer_count,"controls":dict(controls or {})}
    def create_preview_configuration(self,main=None,*,raw=None,buffer_count=4,controls=None):
        return self._configuration("preview",main,raw,buffer_count,controls,(640,480))
    def create_video_configuration(self,main=None,*,raw=None,buffer_count=6,controls=None):
        return self._configuration("video",main,raw,buffer_count,controls,(1920,1080))
    def create_still_configuration(self,main=None,*,raw={},buffer_count=4,controls=None):
        return self._configuration("still",main,raw,buffer_count,controls,(0,0))
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
        self._camera=Camera(library=self.library,simulate=self.simulate,role=config["role"],**options)
        if config["controls"]: self._camera.set_controls(config["controls"])
        self._config=config
    def _ready(self):
        if self._camera is None: self.configure(self.create_preview_configuration())
        return self._camera
    def camera_configuration(self):
        camera=self._ready();result=dict(self._config)
        result["main"]=dict(result["main"],size=(camera.info["main"]["width"],camera.info["main"]["height"]),stride=camera.info["main"]["stride"])
        return result
    @property
    def camera_controls(self):
        return {name:(info['min'],info['max'],info['default']) for name,info in self._ready().control_info.items()}
    def set_controls(self,controls): return self._ready().set_controls(controls)
    def autofocus_cycle(self,wait=None,signal_function=None,*,timeout=5): return self._ready().autofocus_cycle(wait,signal_function,timeout=timeout)
    def wait(self,job,timeout=None): return job.result(timeout)
    def start_preview(self,*,title='zig-camera',startup_timeout=5): return self._ready().start_preview(title=title,startup_timeout=startup_timeout)
    def stop_preview(self):
        if self._camera is not None: self._camera.stop_preview()
    def start(self): self._ready().start()
    def stop(self):
        if self._camera is not None: self._camera.stop()
    def close(self):
        if self._camera is not None: self._camera.close();self._camera=None
    def capture_request(self,*,timeout_ms=5000): return CompletedRequest(self._ready().acquire(timeout_ms))
    def captured_request(self,*,timeout_ms=5000): return self.capture_request(timeout_ms=timeout_ms)
    def capture_array(self,name="main"):
        with self.captured_request() as request: return request.make_array(name)
    def capture_buffer(self,name="main"):
        with self.captured_request() as request: return request.make_buffer(name)
    def capture_metadata(self):
        with self.captured_request() as request: return request.get_metadata()
    def capture_file(self,file_output,name="main"):
        with self.captured_request() as request: request.save(name,file_output)
    def start_recording(self,encoder,output,*,fps=30):
        if isinstance(encoder,MJPEGEncoder): options={"codec":"mjpeg","quality":encoder.quality}
        elif isinstance(encoder,(H264Encoder,HEVCEncoder)):
            options={"codec":"h264" if isinstance(encoder,H264Encoder) else "hevc","quality":encoder.quality,"bitrate":encoder.bitrate,"gop":encoder.iperiod}
        else: raise NotImplementedError("Use a Home MJPEGEncoder, H264Encoder or HEVCEncoder")
        return self._ready().start_recording(output,fps=fps,**options)
    def stop_recording(self): self._ready().stop_recording()
    def preview(self,frames=300): return self._ready().preview(frames=frames)
    def __enter__(self): return self
    def __exit__(self,*exc):
        if self._camera is not None:
            try: return self._camera.__exit__(*exc)
            finally: self._camera=None
