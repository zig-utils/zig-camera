"""Small ctypes interface to zig-camera ABI v1; no NumPy dependency.

Borrowed views must stay inside their context and frame lease. Use copy_rgb()
for owned bytes or numpy() for an owned ndarray. Never close borrowed DMA fds.
"""
from __future__ import annotations
import ctypes as C
import ctypes.util
import os
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from .controls import Control as _Control, ControlInfo as _ControlInfo, Metadata as _Metadata

__all__ = ["Camera", "Frame", "CameraError", "Preview", "Recorder"]

class _Config(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in ("width", "height", "buffer_count", "camera_index", "policy", "exposure_us", "frame_duration_us")] + [
        ("analogue_gain", C.c_float), ("lens_position", C.c_float), ("raw", C.c_uint32), ("raw_format", C.c_char * 32)]
class _CaptureOptions(C.Structure):
    _fields_ = [(n,C.c_uint32) for n in ("struct_size","role","unpacked_raw","noise_reduction")]
class _PipelineOptions(C.Structure):
    _fields_ = [("struct_size",C.c_uint32),("capture",_CaptureOptions)] + [(n,C.c_uint32) for n in ("sensor_width","sensor_height","sensor_bit_depth","lores_width","lores_height","lores_format")]
class _SensorMode(C.Structure):
    _fields_ = [(n,C.c_uint32) for n in ("width","height","bit_depth")] + [("format",C.c_char*32)]
class _RawMetadata(C.Structure):
    _fields_ = [("valid",C.c_uint32),("black_levels",C.c_float*4),("camera_to_srgb",C.c_float*9),("model",C.c_char*128)]
class _VideoConfig(C.Structure):
    _fields_ = [(n,C.c_uint32) for n in ("width","height","fps_num","fps_den","codec","bitrate","quality","gop")]
class _AudioConfig(C.Structure):
    _fields_=[(n,C.c_uint32) for n in ('struct_size','backend','sample_rate','channels','block_frames','reserved')]+[('start_ns',C.c_uint64)]
class _AudioBlock(C.Structure):
    _fields_=[('timestamp_ns',C.c_uint64),('clock_error_ns',C.c_int64),('frames',C.c_uint32),('reserved',C.c_uint32)]
class _RecordingOptions(C.Structure):
    _fields_=[(n,C.c_uint32) for n in ('struct_size','sample_rate','channels','buffer_frames','max_blocks','exclusive')]
class _RecordingStats(C.Structure):
    _fields_=[(n,C.c_uint64) for n in ('segments','output_bytes','output_frames','output_duration_ns','audio_frames','audio_written_frames','audio_queued_frames','audio_trimmed_frames')]+[(n,C.c_uint32) for n in ('rotation_due','audio_enabled')]
class _OutputStats(C.Structure):
    _fields_=[(n,C.c_uint64) for n in ('id','frames','bytes','first_ns','audio_frames')]+[(n,C.c_uint32) for n in ('waiting_key','reserved')]
class _OutputPacket(C.Structure):
    _fields_=[('data',C.c_void_p),('length',C.c_uint64),('timestamp_ns',C.c_uint64),('codec',C.c_uint32),('flags',C.c_uint32)]
_PacketCallback=C.CFUNCTYPE(C.c_int,C.c_void_p,C.POINTER(_OutputPacket))
_WriteCallback=C.CFUNCTYPE(C.c_int,C.c_void_p,C.c_void_p,C.c_uint64)
_PatchCallback=C.CFUNCTYPE(C.c_int,C.c_void_p,C.c_uint64,C.c_void_p,C.c_uint64)
class _OutputCallbacks(C.Structure):
    _fields_=[('struct_size',C.c_uint32),('format',C.c_uint32),('context',C.c_void_p),('packet',_PacketCallback),('write',_WriteCallback),('patch',_PatchCallback),('file_fd',C.c_int32),('pts_fd',C.c_int32),('secondary_pts_fd',C.c_int32),('reserved',C.c_uint32)]
class _BufferConfig(C.Structure):
    _fields_=[('struct_size',C.c_uint32),('max_frames',C.c_uint32),('max_bytes',C.c_uint64),('duration_us',C.c_uint64)]
class _AudioBufferStats(C.Structure):
    _fields_=[(n,C.c_uint64) for n in ('frames','bytes','evicted_frames','first_ns','last_ns')]
class _BufferStats(C.Structure):
    _fields_=[(n,C.c_uint64) for n in ('frames','bytes','evicted','skipped','first_ns','last_ns','segments')]+[(n,C.c_uint32) for n in ('split_pending','output_open')]
class _Plane(C.Structure):
    _fields_ = [("data", C.POINTER(C.c_uint8)), ("length", C.c_uint64), ("bytes_used", C.c_uint64),
                ("offset", C.c_uint64), ("fd", C.c_int32), ("reserved", C.c_uint32)]
class _Stream(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in ("width", "height", "stride", "plane_count")] + [("format", C.c_char * 32), ("planes", _Plane * 4)]
class _Frame(C.Structure):
    _fields_ = [(n, C.c_uint64) for n in ("token", "sequence", "timestamp_ns")] + [
        ("exposure_us", C.c_uint32), ("analogue_gain", C.c_float), ("red_gain", C.c_float), ("blue_gain", C.c_float),
        ("main", _Stream), ("raw", _Stream)]
class _Info(C.Structure):
    _fields_ = [("backend", C.c_uint32), ("buffer_count", C.c_uint32), ("main", _Stream), ("raw", _Stream), ("camera_id", C.c_char * 256)]
class _PipelineInfo(C.Structure):
    _fields_ = [(n,C.c_uint32) for n in ("struct_size","sensor_width","sensor_height","sensor_bit_depth")] + [("lores",_Stream)]
class _Stats(C.Structure):
    _fields_ = [(n, C.c_uint64) for n in ("completed", "delivered", "dropped", "errors")] + [("ready", C.c_uint32), ("leased", C.c_uint32)]

class CameraError(RuntimeError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)

def _load(path=None):
    name = "libzigcamera.dylib" if sys.platform == "darwin" else "libzigcamera.so"
    candidate = path or os.environ.get("ZIG_CAMERA_LIBRARY")
    if not candidate:
        local = Path(__file__).resolve().parents[2] / "zig-out" / "lib" / name
        candidate = str(local) if local.exists() else ctypes.util.find_library("zigcamera")
    if not candidate:
        raise FileNotFoundError("Build zig-camera or set ZIG_CAMERA_LIBRARY to its shared library")
    lib = C.CDLL(str(candidate))
    signatures = {
        'zc_default_audio_config':([C.POINTER(_AudioConfig)],None),
        'zc_audio_open':([C.POINTER(_AudioConfig),C.c_char_p,C.POINTER(C.c_void_p)],C.c_int),
        'zc_audio_read':([C.c_void_p,C.POINTER(C.c_uint8),C.c_uint64,C.c_uint32,C.POINTER(_AudioBlock)],C.c_int),
        'zc_audio_close':([C.c_void_p],C.c_int),
        'zc_default_recording_options':([C.POINTER(_RecordingOptions)],None),
        'zc_video_open_ex':([C.c_char_p,C.POINTER(_VideoConfig),C.POINTER(_RecordingOptions),C.POINTER(C.c_void_p)],C.c_int),
        'zc_video_open_aac':([C.c_char_p,C.POINTER(_VideoConfig),C.POINTER(_RecordingOptions),C.c_uint32,C.POINTER(C.c_void_p)],C.c_int),
        'zc_video_write_audio':([C.c_void_p,C.POINTER(C.c_uint8),C.c_uint64,C.c_uint64],C.c_int),
        'zc_video_set_rotation':([C.c_void_p,C.c_uint64,C.c_uint64],C.c_int),
        'zc_video_recording_stats':([C.c_void_p,C.POINTER(_RecordingStats)],C.c_int),
        'zc_default_buffer_config':([C.POINTER(_BufferConfig)],None),
        'zc_video_open_circular':([C.POINTER(_VideoConfig),C.POINTER(_BufferConfig),C.POINTER(C.c_void_p)],C.c_int),
        'zc_video_open_circular_av':([C.POINTER(_VideoConfig),C.POINTER(_BufferConfig),C.POINTER(_RecordingOptions),C.c_uint32,C.POINTER(C.c_void_p)],C.c_int),
        'zc_video_audio_buffer_stats':([C.c_void_p,C.POINTER(_AudioBufferStats)],C.c_int),
        'zc_video_freeze_buffer':([C.c_void_p,C.c_char_p,C.POINTER(C.c_void_p)],C.c_int),
        'zc_snapshot_write':([C.c_void_p],C.c_int),
        'zc_snapshot_close':([C.c_void_p],None),
        'zc_video_set_delay':([C.c_void_p,C.c_uint64],C.c_int),
        'zc_video_add_callbacks':([C.c_void_p,C.POINTER(_OutputCallbacks),C.POINTER(C.c_uint64)],C.c_int),
        'zc_video_add_output':([C.c_void_p,C.c_char_p,C.POINTER(C.c_uint64)],C.c_int),
        'zc_video_remove_output':([C.c_void_p,C.c_uint64],C.c_int),
        'zc_video_output_stats':([C.c_void_p,C.c_uint64,C.POINTER(_OutputStats)],C.c_int),
        'zc_video_create':([C.POINTER(_VideoConfig),C.POINTER(_RecordingOptions),C.c_uint32,C.POINTER(C.c_void_p)],C.c_int),
        'zc_video_split_callbacks':([C.c_void_p,C.POINTER(_OutputCallbacks)],C.c_int),
        'zc_video_open_callbacks':([C.c_void_p,C.POINTER(_OutputCallbacks)],C.c_int),
        'zc_video_get_headers':([C.c_void_p,C.c_void_p,C.c_uint64,C.POINTER(C.c_uint64)],C.c_int),
        'zc_format_pts':([C.c_uint64,C.c_void_p,C.c_uint32,C.POINTER(C.c_uint32)],C.c_int),
        'zc_video_buffer_stats':([C.c_void_p,C.POINTER(_BufferStats)],C.c_int),
        **{name:([C.c_void_p,C.c_char_p],C.c_int) for name in ('zc_video_save_buffer','zc_video_open_output','zc_video_split')},
        **{name:([C.c_void_p],C.c_int) for name in ('zc_video_close_output','zc_video_cancel_split')},
        "zc_default_pipeline_options":([C.POINTER(_PipelineOptions)],None),
        "zc_open_pipeline":([C.POINTER(_Config),C.POINTER(_PipelineOptions),C.POINTER(C.c_void_p)],C.c_int),
        "zc_get_pipeline_info":([C.c_void_p,C.POINTER(_PipelineInfo)],C.c_int),
        "zc_get_sensor_modes":([C.c_void_p,C.POINTER(_SensorMode),C.c_uint32,C.POINTER(C.c_uint32)],C.c_int),
        "zc_get_stream":([C.c_void_p,C.c_uint64,C.c_uint32,C.POINTER(_Stream)],C.c_int),
        "zc_copy_stream":([C.POINTER(_Stream),C.POINTER(C.c_uint8),C.c_uint64],C.c_int),
        "zc_get_control_info":([C.c_void_p,C.c_uint32,C.POINTER(_ControlInfo)],C.c_int),
        "zc_set_controls":([C.c_void_p,C.POINTER(_Control),C.c_uint32,C.POINTER(C.c_uint64)],C.c_int),
        "zc_get_frame_metadata":([C.c_void_p,C.c_uint64,C.POINTER(_Metadata)],C.c_int),
        "zc_wait_metadata":([C.c_void_p,C.c_uint64,C.c_uint32,C.POINTER(_Metadata)],C.c_int),
        "zc_autofocus_start":([C.c_void_p,C.POINTER(C.c_uint64)],C.c_int),
        "zc_autofocus_cancel":([C.c_void_p,C.c_uint64],C.c_int),
        "zc_autofocus_wait":([C.c_void_p,C.c_uint64,C.c_uint32,C.POINTER(C.c_uint32)],C.c_int),
        "zc_abi_version": ([], C.c_uint32),
        "zc_default_config": ([C.POINTER(_Config)], None),
        "zc_open": ([C.POINTER(_Config), C.POINTER(C.c_void_p)], C.c_int),
        "zc_default_capture_options": ([C.POINTER(_CaptureOptions)],None),
        "zc_open_ex": ([C.POINTER(_Config),C.POINTER(_CaptureOptions),C.POINTER(C.c_void_p)],C.c_int),
        "zc_save_dng": ([C.c_void_p,C.c_uint64,C.c_char_p],C.c_int),
        "zc_get_raw_metadata": ([C.c_void_p,C.c_uint64,C.POINTER(_RawMetadata)],C.c_int),
        "zc_copy_rgb":([C.POINTER(_Frame),C.POINTER(C.c_uint8),C.c_uint64],C.c_int),
        "zc_preview_open": ([C.c_char_p,C.c_uint32,C.c_uint32,C.POINTER(C.c_void_p)],C.c_int),
        "zc_preview_show": ([C.c_void_p,C.POINTER(_Frame)],C.c_int),
        "zc_preview_close": ([C.c_void_p],C.c_int),
        "zc_default_video_config": ([C.POINTER(_VideoConfig)],None),
        "zc_video_open": ([C.c_char_p,C.POINTER(_VideoConfig),C.POINTER(C.c_void_p)],C.c_int),
        "zc_video_write": ([C.c_void_p,C.POINTER(_Frame),C.c_uint64],C.c_int),
        "zc_video_close": ([C.c_void_p],C.c_int),
        "zc_get_info": ([C.c_void_p, C.POINTER(_Info)], C.c_int),
        "zc_start": ([C.c_void_p], C.c_int), "zc_stop": ([C.c_void_p], C.c_int), "zc_close": ([C.c_void_p], C.c_int),
        "zc_acquire": ([C.c_void_p, C.c_uint32, C.POINTER(_Frame)], C.c_int),
        "zc_release": ([C.c_void_p, C.c_uint64], C.c_int),
        "zc_get_stats": ([C.c_void_p, C.POINTER(_Stats)], C.c_int),
        "zc_save_jpeg": ([C.c_void_p, C.c_uint64, C.c_char_p, C.c_uint32], C.c_int),
        "zc_status_string": ([C.c_int], C.c_char_p),
    }
    for symbol, (args, result) in signatures.items():
        fn = getattr(lib, symbol); fn.argtypes = args; fn.restype = result
    if lib.zc_abi_version() != 1:
        raise RuntimeError("Unsupported zig-camera ABI version")
    return lib

def _geometry(s):
    return {"width": s.width, "height": s.height, "stride": s.stride, "format": s.format.decode("ascii"), "plane_count": s.plane_count}

def _u32(value):
    if not isinstance(value, int) or not 0 <= value <= 0xffffffff:
        raise ValueError("Expected an unsigned 32-bit integer")
    return value

class Camera:
    def __init__(self, *, library=None, simulate=False, policy="latest", role="still", unpacked_raw=False, noise_reduction=None, sensor=None, lores=None, **options):
        self._lib = _load(library)
        self._handle = C.c_void_p()
        self._recording = None
        self._preview=None;self._pump=None;self._af_job=None;self._async_lock=threading.RLock();self._control_info=None
        from collections import deque
        self._active_capture_job=None;self._capture_jobs=deque();self._job_slots=threading.BoundedSemaphore(32);self._stopping=False
        self._started = False
        self._leases = {}  # Keep leases alive until explicitly released; deterministic cleanup.
        config = _Config(); self._lib.zc_default_config(C.byref(config))
        integer = {"width", "height", "buffer_count", "camera_index", "exposure_us", "frame_duration_us"}
        floating = {"analogue_gain", "lens_position"}
        for key, value in options.items():
            if key in integer: setattr(config, key, _u32(value))
            elif key in floating: setattr(config, key, float(value))
            elif key == "raw": config.raw = bool(value)
            elif key == "raw_format":
                encoded = value.encode("ascii")
                if len(encoded) > 31 or b"\0" in encoded: raise ValueError("Invalid raw format")
                config.raw_format = encoded
            else: raise TypeError(f"Unknown camera option: {key}")
        if policy not in ("fifo", "latest"): raise ValueError("policy must be fifo or latest")
        config.policy = 0 if policy == "fifo" else 1
        roles={"still":0,"preview":1,"video":2}
        if role not in roles: raise ValueError("role must be still, preview or video")
        capture = _CaptureOptions(); self._lib.zc_default_capture_options(C.byref(capture))
        capture.role=roles[role]; capture.unpacked_raw=bool(unpacked_raw)
        if noise_reduction is not None: capture.noise_reduction=_u32(noise_reduction)
        pipeline=_PipelineOptions();self._lib.zc_default_pipeline_options(C.byref(pipeline));pipeline.capture=capture
        if sensor is not None:
            if set(sensor)-{'output_size','bit_depth'} or set(sensor)!={'output_size','bit_depth'}: raise ValueError('sensor requires output_size and bit_depth')
            width,height=sensor['output_size'];pipeline.sensor_width=_u32(width);pipeline.sensor_height=_u32(height);pipeline.sensor_bit_depth=_u32(sensor['bit_depth'])
            if not width or not height or not sensor['bit_depth']: raise ValueError('Explicit sensor values must be positive')
        if lores is not None:
            if set(lores)-{'size','format'}: raise ValueError('lores supports size and format')
            width,height=lores.get('size',(320,240));pipeline.lores_width=_u32(width);pipeline.lores_height=_u32(height)
            if not width or not height: raise ValueError('Lores dimensions must be positive')
            formats={'YUV420':0,'BGR888':1}
            if lores.get('format','YUV420') not in formats: raise ValueError('Lores format must be YUV420 or BGR888')
            pipeline.lores_format=formats[lores.get('format','YUV420')]
        self._check(self._lib.zc_open_pipeline(C.byref(config),C.byref(pipeline),C.byref(self._handle)))
        native = _Info()
        self._check(self._lib.zc_get_info(self._handle, C.byref(native)))
        self.info = {"backend": "synthetic" if native.backend == 0 else "libcamera", "camera_id": native.camera_id.decode(),
                     "buffer_count": native.buffer_count, "main": _geometry(native.main), "raw": _geometry(native.raw)}
        extra=_PipelineInfo();self._check(self._lib.zc_get_pipeline_info(self._handle,C.byref(extra)))
        self.info['lores']=_geometry(extra.lores)
        self.info['sensor']={'output_size':(extra.sensor_width,extra.sensor_height),'bit_depth':extra.sensor_bit_depth}
        if (native.backend == 0) != bool(simulate):
            self.close()
            raise ValueError("Synthetic builds require simulate=True; real builds require simulate=False")
    def _check(self, status):
        if status: raise CameraError(status, self._lib.zc_status_string(status).decode())
    def _open(self):
        from .output_objects import guard_callback
        guard_callback()
        if not self._handle.value: raise RuntimeError("Camera is closed")
    def start(self):
        self._open(); self._check(self._lib.zc_start(self._handle)); self._started=True;self._stopping=False
        if self._preview is not None: self._ensure_pump()
        return self
    def stop(self):
        from .output_objects import guard_callback
        guard_callback()
        self._open();failure=None
        with self._async_lock:
            self._stopping=True
            pending=list(self._capture_jobs)
        for job in pending: job.cancel()

        for close in (self.stop_recording,self.stop_preview):
            try: close()
            except Exception as error:
                if failure is None: failure=error
        with self._async_lock: pump=self._pump;self._pump=None
        if pump is not None: pump.close()
        self._check(self._lib.zc_stop(self._handle));self._started=False
        if self._af_job is not None: self._af_job.join()
        if failure is not None: raise failure
    @property
    def control_info(self):
        self._open()
        if self._control_info is None:
            from .controls import capabilities
            self._control_info=capabilities(self)
        return self._control_info
    def set_controls(self,values):
        from .controls import set_controls
        return set_controls(self,values)
    def wait_metadata(self,after_event=0,timeout_ms=5000):
        from .controls import metadata
        self._open();out=_Metadata()
        self._check(self._lib.zc_wait_metadata(self._handle,after_event,_u32(timeout_ms),C.byref(out)))
        return metadata(out)
    def _ensure_pump(self):
        from .pipeline import CapturePump
        with self._async_lock:
            if self._pump is not None and (self._pump.stop_event.is_set() or not self._pump.thread.is_alive()):
                self._pump.close();self._pump=None
            if self._pump is None: self._pump=CapturePump(self)
            return self._pump
    def _maybe_stop_pump(self):
        with self._async_lock:
            if self._capture_jobs or self._recording is not None or (self._preview is not None and self._preview.running) or (self._af_job is not None and not self._af_job.done()): return
            pump=self._pump
            if pump is not None: pump.stop_event.set()
            if pump is not None and threading.current_thread() is pump.thread: return
        if pump is not None:
            pump.close()
            with self._async_lock:
                if self._pump is pump: self._pump=None
    def autofocus_cycle(self,wait=None,signal_function=None,*,timeout=5):
        from .jobs import AutofocusJob
        if not isinstance(timeout,(int,float)) or not 0<timeout<=4294967: raise ValueError('Invalid autofocus timeout')
        self._open()
        if not self._started: raise RuntimeError('Start capture before autofocus')
        with self._async_lock:
            if self._af_job is not None and not self._af_job.done(): raise RuntimeError('Autofocus job already active')
            job_id=C.c_uint64();self._check(self._lib.zc_autofocus_start(self._handle,C.byref(job_id)))
            job=AutofocusJob(self,job_id.value,timeout,signal_function);self._af_job=job
            self._ensure_pump();job.start()
        return job.result() if (wait is True or (wait is None and signal_function is None)) else job
    def wait(self,job,timeout=None): return job.result(timeout)
    def acquire(self, timeout_ms=5000, *, _internal=False):
        self._open(); native = _Frame()
        self._check(self._lib.zc_acquire(self._handle, _u32(timeout_ms), C.byref(native)))
        frame = Frame(self, native);frame._internal=_internal
        self._leases[native.token] = frame
        return frame
    @property
    def sensor_modes(self):
        self._open();count=C.c_uint32()
        self._check(self._lib.zc_get_sensor_modes(self._handle,None,0,C.byref(count)))
        modes=(_SensorMode*count.value)()
        self._check(self._lib.zc_get_sensor_modes(self._handle,modes,len(modes),C.byref(count)))
        return [{'size':(m.width,m.height),'bit_depth':m.bit_depth,'format':m.format.decode()} for m in modes]
    def _capture(self,operation,wait=None,signal_function=None,timeout_ms=5000,*,retain=False):
        from .jobs import CaptureJob
        self._open();_u32(timeout_ms)
        with self._async_lock:
            if not self._started or self._stopping: raise RuntimeError('Start capture before submitting jobs')
            if not self._job_slots.acquire(False): raise RuntimeError('Capture job capacity (32) exhausted')
            job=CaptureJob(self,operation,timeout_ms,signal_function,retain)
            self._capture_jobs.append(job)
            try: self._ensure_pump()
            except Exception:
                self._capture_jobs.remove(job);self._job_slots.release();raise
        return job.result() if (wait is True or (wait is None and signal_function is None)) else job
    def capture_request(self,timeout_ms=5000,*,wait=None,signal_function=None):
        return self._capture(lambda frame:frame,wait,signal_function,timeout_ms,retain=True)
    def capture_array(self,timeout_ms=5000,*,name='main',wait=None,signal_function=None):
        return self._capture(lambda frame:frame.numpy(name),wait,signal_function,timeout_ms)
    def capture_buffer(self,timeout_ms=5000,*,name='main',wait=None,signal_function=None):
        return self._capture(lambda frame:frame.copy_buffer(name),wait,signal_function,timeout_ms)
    def capture_metadata(self,timeout_ms=5000,*,wait=None,signal_function=None):
        return self._capture(lambda frame:frame.metadata,wait,signal_function,timeout_ms)
    def capture_file(self,path,timeout_ms=5000,*,wait=None,signal_function=None):
        return self._capture(lambda frame:frame.save(path),wait,signal_function,timeout_ms)
    def start_recording(self,path,*,fps=30,quality=90,codec="mjpeg",bitrate=0,gop=0,circular=None,audio=None):
        from .pipeline import Recording
        self._open()
        with self._async_lock:
            if self._recording is not None: raise RuntimeError('Recording already active')
            if not self._started: self.start()
            from .outputs import RotatingOutput
            rotation=path if isinstance(path,RotatingOutput) else None
            if rotation is not None:
                if circular is not None: raise ValueError('Rotation requires a file output')
                rotation._available()
                path=rotation.path(0)
            source=None;recorder=None;recording=None;encoding={}
            try:
                if audio is not None and audio is not False:
                    options={} if audio is True else dict(audio)
                    encoding={name:options.pop(name) for name in ('codec','bitrate') if name in options}
                    options.setdefault('backend','alsa')
                    synthetic=self.info['backend']=='synthetic'
                    if synthetic != (options['backend']=='synthetic'): raise ValueError('Audio and camera must use the same clock source')
                    source=AudioCapture(library=self._lib._name,**options)
                recorder=Recorder(path,width=self.info['main']['width'],height=self.info['main']['height'],fps=fps,quality=quality,codec=codec,bitrate=bitrate,gop=gop,library=self._lib._name,circular=circular,audio=None if source is None else {'sample_rate':source.sample_rate,'channels':source.channels,**encoding},exclusive=rotation is not None)
                recording=Recording(self,recorder,fps,audio=source,rotation=rotation)
                self._recording=recording
                if rotation is not None: rotation._bind(recording)
                recording._thread=self._ensure_pump().thread
                return recording
            except Exception:
                self._recording=None
                if recording is not None: recording.close()
                else:
                    if recorder is not None: recorder.close()
                    if source is not None: source.close()
                raise
    def split_recording(self,path,*,wait=None,signal_function=None):
        with self._async_lock:
            if self._recording is None: raise RuntimeError('Recording is not active')
            job=self._recording.split(path,signal_function)
        return job.result() if (wait is True or (wait is None and signal_function is None)) else job
    def add_recording_output(self,output):
        self._open()
        with self._async_lock:
            if self._recording is None: raise RuntimeError('Recording is not active')
            return self._recording.add_output(output)
    def remove_recording_output(self,output):
        self._open()
        with self._async_lock:
            if self._recording is None: raise RuntimeError('Recording is not active')
            return self._recording.remove_output(output)
    def stop_recording(self):
        from .output_objects import guard_callback
        guard_callback()
        with self._async_lock:
            recording=self._recording;self._recording=None;pump=self._pump
        self._maybe_stop_pump()
        if recording is not None:
            if pump is not None and pump.error is not None and recording.error is None: recording.error=pump.error
            recording.close()
    def start_preview(self,*,title='zig-camera',startup_timeout=5):
        from .async_preview import AsyncPreview
        self._open()
        with self._async_lock:
            if self._preview is not None: raise RuntimeError('Preview already active')
        window=AsyncPreview(self,title,startup_timeout)
        with self._async_lock:
            self._preview=window
            if self._started: self._ensure_pump()
        return window
    def stop_preview(self):
        from .output_objects import guard_callback
        guard_callback()
        with self._async_lock:
            preview=self._preview;self._preview=None
        self._maybe_stop_pump()
        if preview is not None: preview.close()
    def preview(self,frames=300,timeout_ms=5000):
        if not self._started: self.start()
        with Preview(self.info["main"]["width"],self.info["main"]["height"],library=self._lib._name) as window:
            n=0
            while frames==0 or n<frames:
                with self.acquire(timeout_ms) as frame:
                    if not window.show(frame): break
                n+=1
            return n
    @property
    def stats(self):
        self._open(); s = _Stats(); self._check(self._lib.zc_get_stats(self._handle, C.byref(s)))
        return {name: getattr(s, name) for name, _ in s._fields_}
    def close(self):
        from .output_objects import guard_callback
        guard_callback()
        if self._handle.value: self.stop()
        if self._handle.value:
            self._check(self._lib.zc_close(self._handle))
            self._handle = C.c_void_p()
    def __enter__(self): return self
    def __exit__(self, *exc):
        failure=None
        try: self.stop()
        except Exception as error: failure=error
        for lease in list(self._leases.values()):
            try: lease.release()
            except Exception as error:
                if failure is None: failure=error
        try: self.close()
        except Exception as error:
            if failure is None: failure=error
        if failure is not None and exc[0] is None: raise failure

class Frame:
    def __init__(self, camera, native):
        self._camera = camera; self._native = native; self._views = 0
    def _live(self):
        if not self._native.token: raise RuntimeError("Frame was released")
    @property
    def metadata(self):
        self._live()
        from .controls import metadata
        native=_Metadata();self._camera._check(self._camera._lib.zc_get_frame_metadata(self._camera._handle,self._native.token,C.byref(native)))
        return metadata(native)
    @contextmanager
    def plane(self, index=0, *, raw=False, name="main"):
        """Borrow a read-only memoryview. Do not keep it or derived views after exit."""
        self._live()
        stream = self.stream("raw" if raw else name)
        if not 0 <= index < stream.plane_count: raise IndexError("No such plane")
        plane = stream.planes[index]
        array = (C.c_uint8 * plane.bytes_used).from_address(C.addressof(plane.data.contents))
        view = memoryview(array).cast("B").toreadonly()
        self._views += 1
        try: yield view
        finally:
            view.release(); self._views -= 1
    def stream(self,name='main'):
        self._live()
        ids={'main':0,'raw':1,'lores':2}
        if name not in ids: raise ValueError('Unknown stream')
        stream=_Stream();self._camera._check(self._camera._lib.zc_get_stream(self._camera._handle,self._native.token,ids[name],C.byref(stream)))
        return stream
    def copy_buffer(self,name='main'):
        """Owned tight RGB or I420 bytes, omitting all row padding."""
        s=self.stream(name)
        size=s.width*s.height*(3 if s.format==b'BGR888' else 3)//(1 if s.format==b'BGR888' else 2)
        if s.format not in (b'BGR888',b'YUV420'): raise NotImplementedError('Use plane(raw=True) for Bayer bytes')
        out=(C.c_uint8*size)()
        self._camera._check(self._camera._lib.zc_copy_stream(C.byref(s),out,size))
        return bytes(out)
    def copy_rgb(self,name='main'):
        if self.stream(name).format!=b'BGR888': raise ValueError('Stream is not RGB')
        return self.copy_buffer(name)
    def numpy(self,name='main'):
        """Owned HxWx3 RGB or (H*3/2)xW I420 ndarray."""
        import numpy as np
        s=self.stream(name);data=self.copy_buffer(name)
        shape=(s.height,s.width,3) if s.format==b'BGR888' else (s.height*3//2,s.width)
        return np.frombuffer(data,dtype=np.uint8).reshape(shape).copy()
    @contextmanager
    def mapped_array(self):
        """Borrowed read-only ndarray; must not escape this context or its lease."""
        import numpy as np
        s = self._native.main
        with self.plane() as view:
            array = np.ndarray((s.height, s.width, 3), dtype=np.uint8, buffer=view, strides=(s.stride, 3, 1))
            array.setflags(write=False)
            yield array
    def save_dng(self,path):
        self._live()
        self._camera._check(self._camera._lib.zc_save_dng(self._camera._handle,self._native.token,_path(path)))
    @property
    def raw_metadata(self):
        self._live(); meta=_RawMetadata()
        self._camera._check(self._camera._lib.zc_get_raw_metadata(self._camera._handle,self._native.token,C.byref(meta)))
        return {"valid":meta.valid,"black_levels":list(meta.black_levels),"camera_to_srgb":list(meta.camera_to_srgb),"model":meta.model.decode()}
    def save(self,path):
        suffix=Path(path).suffix.lower()
        if suffix in (".jpg",".jpeg"): self.save_jpeg(path)
        elif suffix==".dng": self.save_dng(path)
        elif suffix==".ppm":
            self._live(); s=self._native.main
            with open(path,"wb") as file:
                file.write(f"P6\n{s.width} {s.height}\n255\n".encode())
                with self.plane() as data:
                    for y in range(s.height): file.write(data[y*s.stride:y*s.stride+s.width*3])
        else: raise ValueError("Supported still formats: JPEG, PPM, DNG")
    def save_jpeg(self, path, quality=98):
        self._live()
        self._camera._check(self._camera._lib.zc_save_jpeg(self._camera._handle, self._native.token, _path(path), _u32(quality)))
    def release(self):
        self._live()
        if self._views: raise RuntimeError("Exit borrowed view contexts before releasing the frame")
        token = self._native.token
        status = self._camera._lib.zc_release(self._camera._handle, token)
        # A synchronization/device error consumes the lease and poisons capture.
        if status != -5:
            self._native.token = 0
            self._camera._leases.pop(token, None)
        self._camera._check(status)
    def __enter__(self): self._live(); return self
    def __exit__(self, *exc): self.release()


def _path(path):
    value=os.fsencode(path)
    if b"\0" in value: raise ValueError("Paths cannot contain NUL")
    return value

def _check(lib,status):
    if status: raise CameraError(status,lib.zc_status_string(status).decode())

class Preview:
    """SDL window. All operations must run on the creating main/UI thread."""
    def __init__(self,width,height,*,title="zig-camera",library=None):
        self._lib=_load(library); self._handle=C.c_void_p()
        _check(self._lib,self._lib.zc_preview_open(title.encode(),_u32(width),_u32(height),C.byref(self._handle)))
    def show(self,frame):
        if not self._handle.value: raise RuntimeError("Preview is closed")
        frame._live()
        status=self._lib.zc_preview_show(self._handle,C.byref(frame._native))
        if status==1: return False
        _check(self._lib,status); return True
    def close(self):
        if self._handle.value:
            _check(self._lib,self._lib.zc_preview_close(self._handle)); self._handle=C.c_void_p()
    def __enter__(self): return self
    def __exit__(self,*exc): self.close()

class Recorder:
    """Home MJPEG/MKV or optional AVC/HEVC/MP4. Serialize calls per instance."""
    def __init__(self,path=None,*,width,height,fps=30,quality=90,codec="mjpeg",bitrate=0,gop=0,library=None,circular=None,audio=None,exclusive=False):
        from .output_objects import guard_callback,_path as is_path,MuxedOutput
        guard_callback()
        initial_outputs=list(path) if isinstance(path,(list,tuple)) else None
        if initial_outputs is not None and len(initial_outputs)>8: raise ValueError('At most 8 simultaneous outputs')
        direct_object=initial_outputs is not None or (path is not None and not is_path(path))
        self._lib=_load(library); self._handle=C.c_void_p();self._lock=threading.RLock();self._snapshot_slots=threading.BoundedSemaphore(2);self._bridge=None;self._next_bridge=None;self._split_staged=False;self._callback_error=None;self._primary_output=None;self._next_output=None;self._extra_bridges={};self._extra_targets={}; config=_VideoConfig()
        self._lib.zc_default_video_config(C.byref(config))
        codecs={"mjpeg":3,"h264":1,"hevc":2}
        if codec not in codecs: raise ValueError("codec must be mjpeg, h264 or hevc")
        config.codec=codecs[codec];config.bitrate=_u32(bitrate);config.gop=_u32(gop)
        config.width=_u32(width); config.height=_u32(height); config.fps_num=_u32(fps); config.quality=_u32(quality)
        self._video_spec={'codec':codec,'width':config.width,'height':config.height,'fps_num':config.fps_num,'fps_den':config.fps_den}
        self._audio_spec=None
        if circular is not None:
            if path is not None: raise ValueError('Circular recording starts without a file; use open_output')
            if set(circular)-{'max_frames','max_bytes','duration_ms','delay_ms'}: raise ValueError('Unknown circular buffer option')
            buffer=_BufferConfig();self._lib.zc_default_buffer_config(C.byref(buffer))
            buffer.max_frames=_u32(circular.get('max_frames',300))
            duration_ms=circular.get('duration_ms',5000)
            if not isinstance(duration_ms,int) or duration_ms<0 or (duration_ms==0 and 'delay_ms' not in circular): raise ValueError('Invalid circular duration')
            for name,value in (('max_bytes',circular.get('max_bytes',64*1024*1024)),('duration_us',max(1,duration_ms)*1000)):
                if not isinstance(value,int) or not 0<value<2**64: raise ValueError('Invalid circular buffer limit')
                setattr(buffer,name,value)
            if audio is None:
                _check(self._lib,self._lib.zc_video_open_circular(C.byref(config),C.byref(buffer),C.byref(self._handle)))
            else:
                audio=dict(audio);audio_codec=audio.pop('codec','pcm' if codec=='mjpeg' else 'aac')
                audio_bitrate=_u32(audio.pop('bitrate',0))
                if audio_codec not in ('pcm','aac') or (codec=='mjpeg' and audio_codec=='aac'): raise ValueError('AAC requires H.264/HEVC; PCM supports all video codecs')
                self._audio_container='.mp4' if audio_codec=='aac' else '.mkv'
                if audio_bitrate and audio_codec!='aac': raise ValueError('PCM does not use a bitrate')
                if set(audio)-{'sample_rate','channels','buffer_frames','max_blocks'}: raise ValueError('Unknown audio recording option')
                opts=_RecordingOptions();self._lib.zc_default_recording_options(C.byref(opts));opts.exclusive=bool(exclusive);opts.max_blocks=4096
                for name,value in audio.items(): setattr(opts,name,_u32(value))
                if not opts.sample_rate: raise ValueError('Audio sample rate is required')
                if 'buffer_frames' not in audio:
                    opts.buffer_frames=_u32(opts.sample_rate*min(10,(buffer.duration_us+999999)//1000000+1))
                _check(self._lib,self._lib.zc_video_open_circular_av(C.byref(config),C.byref(buffer),C.byref(opts),audio_bitrate,C.byref(self._handle)))
        else:
            if path is None: raise ValueError('A file or circular buffer configuration is required')
            opts=_RecordingOptions();self._lib.zc_default_recording_options(C.byref(opts));opts.exclusive=bool(exclusive)
            audio_bitrate=0
            if audio is not None:
                audio=dict(audio)
                audio_target=initial_outputs[0] if initial_outputs else path
                target_format=audio_target.format if isinstance(audio_target,MuxedOutput) else Path(audio_target).suffix.lstrip('.') if is_path(audio_target) else None
                audio_codec=audio.pop('codec', 'aac' if target_format=='mp4' else 'pcm')
                audio_bitrate=_u32(audio.pop('bitrate',0))
                if audio_codec not in ('pcm','aac'): raise ValueError('Audio codec must be pcm or aac')
                if target_format is not None and (audio_codec=='aac') != (target_format=='mp4'): raise ValueError('AAC requires MP4; PCM requires MKV')
                if audio_bitrate and audio_codec!='aac': raise ValueError('PCM does not use a bitrate')
                if set(audio)-{'sample_rate','channels','buffer_frames','max_blocks'}: raise ValueError('Unknown audio recording option')
                for name,value in audio.items(): setattr(opts,name,_u32(value))
                if not opts.sample_rate: raise ValueError('Audio sample rate is required')
                if 'buffer_frames' not in audio: opts.buffer_frames=opts.sample_rate*2
            if direct_object:
                _check(self._lib,self._lib.zc_video_create(C.byref(config),C.byref(opts),audio_bitrate,C.byref(self._handle)))
            elif audio_bitrate:
                _check(self._lib,self._lib.zc_video_open_aac(_path(path),C.byref(config),C.byref(opts),audio_bitrate,C.byref(self._handle)))
            else: _check(self._lib,self._lib.zc_video_open_ex(_path(path),C.byref(config),C.byref(opts),C.byref(self._handle)))
        if not direct_object and circular is None: self._primary_output=path
        if audio is not None: self._audio_spec={'sample_rate':opts.sample_rate,'channels':opts.channels}
        if direct_object:
            try:
                if initial_outputs is None: self.open_output(path)
                elif initial_outputs:
                    self.open_output(initial_outputs[0])
                    for output in initial_outputs[1:]: self.add_output(output)
            except BaseException:
                try: self.close()
                except Exception: pass
                raise
        if circular is not None and 'delay_ms' in circular:
            try: self.set_delay(circular['delay_ms'])
            except Exception: self.close();raise
    def _open(self):
        from .output_objects import guard_callback
        guard_callback()
        if not self._handle.value: raise RuntimeError('Recorder is closed')
    def _checked(self,status):
        if status and self._callback_error is not None:
            error=self._callback_error;self._callback_error=None;raise error
        _check(self._lib,status)
    def _streams(self):
        from .output_objects import StreamInfo
        length=C.c_uint64();_check(self._lib,self._lib.zc_video_get_headers(self._handle,None,0,C.byref(length)))
        data=(C.c_uint8*length.value)()
        if length.value: _check(self._lib,self._lib.zc_video_get_headers(self._handle,data,length.value,C.byref(length)))
        spec=self._video_spec
        info=StreamInfo(0,spec['codec'],width=spec['width'],height=spec['height'],extradata=bytes(data))
        result=[(info,dict(width=info.width,height=info.height,fps_num=spec['fps_num'],fps_den=spec['fps_den'],extradata=info.extradata))]
        if self._audio_spec is not None:
            info=StreamInfo(1,'pcm_s16le',**self._audio_spec);result.append((info,dict(self._audio_spec)))
        return result
    def write(self,frame,*,timestamp_ns=None):
        with self._lock:
            self._open();frame._live()
            ts=frame._native.timestamp_ns if timestamp_ns is None else timestamp_ns
            if not isinstance(ts,int) or not 0<=ts<2**64: raise ValueError('Invalid timestamp')
            self._after_native(self._lib.zc_video_write(self._handle,C.byref(frame._native),ts))
    def write_audio(self,data,*,timestamp_ns):
        if not isinstance(timestamp_ns,int) or not 0<=timestamp_ns<2**64: raise ValueError('Invalid audio timestamp')
        data=bytes(data);buf=(C.c_uint8*len(data)).from_buffer_copy(data)
        with self._lock:
            self._open();self._checked(self._lib.zc_video_write_audio(self._handle,buf,len(data),timestamp_ns))
    def set_rotation(self,*,duration_ns=0,max_bytes=0):
        if any(not isinstance(v,int) or not 0<=v<2**64 for v in (duration_ns,max_bytes)): raise ValueError('Invalid rotation limit')
        with self._lock:
            self._open();_check(self._lib,self._lib.zc_video_set_rotation(self._handle,duration_ns,max_bytes))
    @property
    def stats(self):
        with self._lock:
            self._open();out=_RecordingStats();_check(self._lib,self._lib.zc_video_recording_stats(self._handle,C.byref(out)))
            return {name:getattr(out,name) for name,_ in out._fields_}
    @property
    def buffer_stats(self):
        with self._lock:
            self._open();out=_BufferStats();_check(self._lib,self._lib.zc_video_buffer_stats(self._handle,C.byref(out)))
            return {name:getattr(out,name) for name,_ in out._fields_}
    @property
    def audio_buffer_stats(self):
        with self._lock:
            self._open();out=_AudioBufferStats();_check(self._lib,self._lib.zc_video_audio_buffer_stats(self._handle,C.byref(out)))
            return {name:getattr(out,name) for name,_ in out._fields_}
    def _path_call(self,name,path):
        if hasattr(self,'_audio_container') and Path(path).suffix!=self._audio_container: raise ValueError(f'Circular audio requires {self._audio_container}')
        with self._lock:
            self._open();_check(self._lib,getattr(self._lib,name)(self._handle,_path(path)))
    def set_delay(self,delay_ms):
        if not isinstance(delay_ms,int) or not 0<=delay_ms<2**64//1_000_000: raise ValueError('Invalid output delay')
        with self._lock:
            self._open();self._after_native(self._lib.zc_video_set_delay(self._handle,delay_ms*1_000_000))
    def save_buffer(self,path,*,wait=None,signal_function=None):
        from .jobs import SnapshotJob
        if hasattr(self,'_audio_container') and Path(path).suffix!=self._audio_container: raise ValueError(f'Circular audio requires {self._audio_container}')
        if not self._snapshot_slots.acquire(False): raise RuntimeError('Snapshot capacity exhausted')
        frozen=C.c_void_p();lib=self._lib
        try:
            with self._lock:
                self._open();_check(lib,lib.zc_video_freeze_buffer(self._handle,_path(path),C.byref(frozen)))
        except Exception: self._snapshot_slots.release();raise
        def release():
            lib.zc_snapshot_close(frozen)
        def write():
            _check(lib,lib.zc_snapshot_write(frozen));return path
        job=SnapshotJob(write,release,signal_function,self._snapshot_slots.release).start()
        if wait is True or (wait is None and signal_function is None): job.result();return None
        return job
    def _check_bridge_distinct(self,bridge):
        for other in (self._bridge,self._next_bridge,*self._extra_bridges.values()):
            if other is not None: bridge.check_distinct(other)
    @property
    def outputs(self):
        with self._lock:
            self._open()
            return (() if self._primary_output is None else (self._primary_output,))+tuple(self._extra_targets.values())
    def _output_id(self,target):
        if isinstance(target,int):
            if not 0<=target<2**64: raise ValueError('Invalid output ID')
            return target
        from .output_objects import _path as is_path
        targets={**self._extra_targets}
        if self._primary_output is not None: targets[0]=self._primary_output
        for identity,output in targets.items():
            if output is target or (is_path(output) and is_path(target) and os.fsdecode(output)==os.fsdecode(target)): return identity
        raise ValueError('Output is not attached')
    def output_stats(self,output=0):
        with self._lock:
            self._open();stats=_OutputStats();identity=self._output_id(output)
            _check(self._lib,self._lib.zc_video_output_stats(self._handle,identity,C.byref(stats)))
            return {name:getattr(stats,name) for name,_ in stats._fields_ if name!='reserved'}
    def add_output(self,output):
        from .output_objects import OutputBridge,MuxedOutput,_path as is_path
        with self._lock:
            self._open()
            if len(self.outputs)>=8: raise RuntimeError('Output capacity exhausted')
            bridge=OutputBridge(self,MuxedOutput(output) if is_path(output) else output)
            identity=C.c_uint64();accepted=False
            try:
                bridge.start();self._check_bridge_distinct(bridge)
                self._checked(self._lib.zc_video_add_callbacks(self._handle,C.byref(bridge.cb),C.byref(identity)))
                accepted=True;self._extra_bridges[identity.value]=bridge;self._extra_targets[identity.value]=output
                bridge.commit()
                return identity.value
            except BaseException:
                try:
                    if accepted: self.remove_output(identity.value)
                    else: bridge.stop()
                except Exception: pass
                raise
    def remove_output(self,output):
        with self._lock:
            self._open();identity=self._output_id(output)
            if identity==0: self.close_output();return
            status=self._lib.zc_video_remove_output(self._handle,identity)
            stats=_OutputStats();attached=self._lib.zc_video_output_stats(self._handle,identity,C.byref(stats))==0
            bridge=None
            if not attached:
                self._extra_targets.pop(identity,None);bridge=self._extra_bridges.pop(identity,None)
            try: self._checked(status)
            except BaseException:
                if bridge is not None:
                    try: bridge.stop()
                    except Exception: pass
                raise
            if bridge is not None: bridge.stop()
    def _sync_split(self):
        if self._split_staged and not self.buffer_stats['split_pending']:
            old=self._bridge;self._bridge=self._next_bridge;self._next_bridge=None;self._split_staged=False
            self._primary_output=self._next_output;self._next_output=None
            if old is not None:
                if self._bridge is not None and self._bridge.pts is not None and self._bridge.pts is old.pts:
                    old.owns_pts=False;self._bridge.owns_pts=True
                old.stop()
    def _after_native(self,status):
        # A packet callback can fail after native ownership switched. Reconcile
        # even then, preserving the original failure and the active callbacks.
        try: self._checked(status)
        except BaseException:
            try: self._sync_split()
            except Exception: pass
            raise
        self._sync_split()
    def _attach_object(self,output,pts,split):
        from .output_objects import OutputBridge,MuxedOutput,_path
        target=output
        if _path(output): output=MuxedOutput(output)
        if split and self._bridge is not None: pts=self._bridge.pts
        bridge=OutputBridge(self,output,pts)
        if split and pts is not None: bridge.owns_pts=False
        accepted=False
        try:
            bridge.start()
            self._check_bridge_distinct(bridge)
            name='zc_video_split_callbacks' if split else 'zc_video_open_callbacks'
            self._checked(getattr(self._lib,name)(self._handle,C.byref(bridge.cb)))
            accepted=True
            if split: self._next_bridge=bridge;self._split_staged=True;self._next_output=target
            else: self._bridge=bridge;self._primary_output=target
            bridge.commit()
        except BaseException:
            try:
                if accepted:
                    if split: self.cancel_split()
                    else: self.close_output()
                else: bridge.stop()
            except Exception: pass
            raise
    def open_output(self,output,*,_pts=None):
        from .output_objects import _path
        with self._lock:
            self._open()
            if _path(output) and (_pts is None or _pts.target is None):
                self._path_call('zc_video_open_output',output);self._primary_output=output;return
            if self.buffer_stats['output_open']: raise RuntimeError('Output already open')
            self._attach_object(output,_pts,False)
    def split(self,output):
        from .output_objects import _path
        with self._lock:
            self._open();self._sync_split()
            if self.buffer_stats['split_pending']: raise RuntimeError('Split already pending')
            if _path(output) and (self._bridge is None or self._bridge.pts is None or self._bridge.pts.target is None):
                self._path_call('zc_video_split',output);self._split_staged=True;self._next_output=output
            else: self._attach_object(output,None,True)
    def close_output(self):
        with self._lock:
            self._open();status=self._lib.zc_video_close_output(self._handle)
            stats=_BufferStats();_check(self._lib,self._lib.zc_video_buffer_stats(self._handle,C.byref(stats)))
            try: self._checked(status)
            finally:
                if not stats.output_open:
                    self._primary_output=None
                    if self._bridge is not None:
                        bridge=self._bridge;self._bridge=None;bridge.stop()
    def cancel_split(self):
        with self._lock:
            self._open()
            self._checked(self._lib.zc_video_cancel_split(self._handle))
            bridge=self._next_bridge;self._next_bridge=None;self._split_staged=False;self._next_output=None
            if bridge is not None: bridge.stop()
    def _stop_bridges(self):
        bridges=(self._bridge,self._next_bridge,*self._extra_bridges.values());self._bridge=self._next_bridge=None;self._split_staged=False
        self._extra_bridges.clear();self._extra_targets.clear();self._primary_output=self._next_output=None
        failure=None
        for bridge in bridges:
            if bridge is not None:
                try: bridge.stop()
                except BaseException as error:
                    if failure is None: failure=error
        if failure is not None: raise failure
    def close(self):
        from .output_objects import guard_callback
        guard_callback()
        with self._lock:
            if self._handle.value:
                status=self._lib.zc_video_close(self._handle);self._handle=C.c_void_p()
                try: self._checked(status)
                except BaseException:
                    try: self._stop_bridges()
                    except Exception: pass
                    raise
                self._stop_bridges()
    def __enter__(self): return self
    def __exit__(self,*exc): self.close()

from .audio import AudioCapture
from .outputs import CircularOutput, CircularOutput2, RotatingOutput
from .output_objects import Output, FileOutput, MuxedOutput, PacketInfo, StreamInfo
__all__ += ["AudioCapture", "CircularOutput", "CircularOutput2", "RotatingOutput", "Output", "FileOutput", "MuxedOutput", "PacketInfo", "StreamInfo"]
from .picamera2 import Picamera2, MJPEGEncoder, H264Encoder, HEVCEncoder
__all__ += ["Picamera2", "MJPEGEncoder", "H264Encoder", "HEVCEncoder"]
