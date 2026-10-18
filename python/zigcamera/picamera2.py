"""Explicit Picamera2-style synchronous subset, backed by native frame leases.

This is not a drop-in Picamera2 module. Controls are applied at configuration;
preview() is a blocking SDL loop, and recording currently uses Home MJPEG/MKV.
"""
from dataclasses import dataclass
from . import Camera

@dataclass(frozen=True)
class MJPEGEncoder:
    quality: int = 90

def _metadata(frame):
    m=frame.metadata
    return {"SensorTimestamp":m["timestamp_ns"],"ExposureTime":m["exposure_us"],"AnalogueGain":m["analogue_gain"],
            "ColourGains":(m["red_gain"],m["blue_gain"]),"Sequence":m["sequence"]}

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
        for name,value in config["controls"].items():
            if name=="ExposureTime": options["exposure_us"]=value
            elif name=="AnalogueGain": options["analogue_gain"]=value
            elif name=="LensPosition": options["lens_position"]=value
            elif name=="NoiseReductionMode": options["noise_reduction"]=value
            elif name=="FrameDurationLimits":
                if len(value)!=2 or value[0]!=value[1]: raise NotImplementedError("Only fixed frame duration is supported")
                options["frame_duration_us"]=value[0]
            else: raise NotImplementedError(f"Configuration control not implemented: {name}")
        if self._camera is not None:
            if self._camera._started: raise RuntimeError("Stop before configuring")
            self._camera.close();self._camera=None
        self._camera=Camera(library=self.library,simulate=self.simulate,role=config["role"],**options)
        self._config=config
    def _ready(self):
        if self._camera is None: self.configure(self.create_preview_configuration())
        return self._camera
    def camera_configuration(self):
        camera=self._ready();result=dict(self._config)
        result["main"]=dict(result["main"],size=(camera.info["main"]["width"],camera.info["main"]["height"]),stride=camera.info["main"]["stride"])
        return result
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
        if not isinstance(encoder,MJPEGEncoder): raise NotImplementedError("Only the Home MJPEGEncoder is supported")
        return self._ready().start_recording(output,fps=fps,quality=encoder.quality)
    def stop_recording(self): self._ready().stop_recording()
    def preview(self,frames=300): return self._ready().preview(frames=frames)
    def __enter__(self): return self
    def __exit__(self,*exc):
        if self._camera is not None:
            try: return self._camera.__exit__(*exc)
            finally: self._camera=None
