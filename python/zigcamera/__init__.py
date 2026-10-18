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
class _RawMetadata(C.Structure):
    _fields_ = [("valid",C.c_uint32),("black_levels",C.c_float*4),("camera_to_srgb",C.c_float*9),("model",C.c_char*128)]
class _VideoConfig(C.Structure):
    _fields_ = [(n,C.c_uint32) for n in ("width","height","fps_num","fps_den","codec","bitrate","quality","gop")]
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
    def __init__(self, *, library=None, simulate=False, policy="latest", role="still", unpacked_raw=False, noise_reduction=None, **options):
        self._lib = _load(library)
        self._handle = C.c_void_p()
        self._recording = None
        self._preview=None;self._pump=None;self._af_job=None;self._async_lock=threading.RLock();self._control_info=None
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
        self._check(self._lib.zc_open_ex(C.byref(config),C.byref(capture),C.byref(self._handle)))
        native = _Info()
        self._check(self._lib.zc_get_info(self._handle, C.byref(native)))
        self.info = {"backend": "synthetic" if native.backend == 0 else "libcamera", "camera_id": native.camera_id.decode(),
                     "buffer_count": native.buffer_count, "main": _geometry(native.main), "raw": _geometry(native.raw)}
        if (native.backend == 0) != bool(simulate):
            self.close()
            raise ValueError("Synthetic builds require simulate=True; real builds require simulate=False")
    def _check(self, status):
        if status: raise CameraError(status, self._lib.zc_status_string(status).decode())
    def _open(self):
        if not self._handle.value: raise RuntimeError("Camera is closed")
    def start(self):
        self._open(); self._check(self._lib.zc_start(self._handle)); self._started=True
        if self._preview is not None: self._ensure_pump()
        return self
    def stop(self):
        self._open();failure=None
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
            if self._recording is not None or (self._preview is not None and self._preview.running) or (self._af_job is not None and not self._af_job.done()): return
            pump=self._pump
            if pump is not None and threading.current_thread() is pump.thread:
                pump.stop_event.set();return
            self._pump=None
        if pump is not None: pump.close()
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
    def acquire(self, timeout_ms=5000):
        self._open(); native = _Frame()
        self._check(self._lib.zc_acquire(self._handle, _u32(timeout_ms), C.byref(native)))
        frame = Frame(self, native)
        self._leases[native.token] = frame
        return frame
    def capture_array(self, timeout_ms=5000):
        with self.acquire(timeout_ms) as frame: return frame.numpy()
    def capture_buffer(self, timeout_ms=5000):
        with self.acquire(timeout_ms) as frame: return frame.copy_rgb()
    def capture_metadata(self, timeout_ms=5000):
        with self.acquire(timeout_ms) as frame: return frame.metadata
    def capture_file(self,path,timeout_ms=5000):
        with self.acquire(timeout_ms) as frame: frame.save(path)
    def start_recording(self,path,*,fps=30,quality=90,codec="mjpeg",bitrate=0,gop=0):
        from .pipeline import Recording
        self._open()
        with self._async_lock:
            if self._recording is not None: raise RuntimeError('Recording already active')
            if not self._started: self.start()
            recorder=Recorder(path,width=self.info['main']['width'],height=self.info['main']['height'],fps=fps,quality=quality,codec=codec,bitrate=bitrate,gop=gop,library=self._lib._name)
            recording=Recording(self,recorder,fps);self._recording=recording
            recording._thread=self._ensure_pump().thread
            return recording
    def stop_recording(self):
        with self._async_lock:
            recording=self._recording;self._recording=None
        self._maybe_stop_pump()
        if recording is not None: recording.close()
    def start_preview(self,*,title='zig-camera',startup_timeout=5):
        from .async_preview import AsyncPreview
        self._open()
        with self._async_lock:
            if self._preview is not None: raise RuntimeError('Preview already active')
            window=AsyncPreview(self,title,startup_timeout)
            self._preview=window
            if self._started: self._ensure_pump()
            return window
    def stop_preview(self):
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
    def plane(self, index=0, *, raw=False):
        """Borrow a read-only memoryview. Do not keep it or derived views after exit."""
        self._live()
        stream = self._native.raw if raw else self._native.main
        if not 0 <= index < stream.plane_count: raise IndexError("No such plane")
        plane = stream.planes[index]
        array = (C.c_uint8 * plane.bytes_used).from_address(C.addressof(plane.data.contents))
        view = memoryview(array).cast("B").toreadonly()
        self._views += 1
        try: yield view
        finally:
            view.release(); self._views -= 1
    def copy_rgb(self):
        """Owned, tightly packed RGB bytes (explicit copy)."""
        self._live(); s = self._native.main
        with self.plane() as view:
            return b"".join(view[y*s.stride:y*s.stride+s.width*3] for y in range(s.height))
    def numpy(self):
        """Owned HxWx3 RGB ndarray; NumPy is an optional application dependency."""
        import numpy as np
        s = self._native.main
        with self.plane() as view:
            return np.ndarray((s.height, s.width, 3), dtype=np.uint8, buffer=view, strides=(s.stride, 3, 1)).copy()
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
    def __init__(self,path,*,width,height,fps=30,quality=90,codec="mjpeg",bitrate=0,gop=0,library=None):
        self._lib=_load(library); self._handle=C.c_void_p(); config=_VideoConfig()
        self._lib.zc_default_video_config(C.byref(config))
        codecs={"mjpeg":3,"h264":1,"hevc":2}
        if codec not in codecs: raise ValueError("codec must be mjpeg, h264 or hevc")
        config.codec=codecs[codec];config.bitrate=_u32(bitrate);config.gop=_u32(gop)
        config.width=_u32(width); config.height=_u32(height); config.fps_num=_u32(fps); config.quality=_u32(quality)
        _check(self._lib,self._lib.zc_video_open(_path(path),C.byref(config),C.byref(self._handle)))
    def write(self,frame,*,timestamp_ns=None):
        if not self._handle.value: raise RuntimeError("Recorder is closed")
        frame._live()
        ts=frame._native.timestamp_ns if timestamp_ns is None else timestamp_ns
        if not isinstance(ts,int) or not 0<=ts<2**64: raise ValueError("Invalid timestamp")
        _check(self._lib,self._lib.zc_video_write(self._handle,C.byref(frame._native),ts))
    def close(self):
        if self._handle.value:
            status=self._lib.zc_video_close(self._handle); self._handle=C.c_void_p(); _check(self._lib,status)
    def __enter__(self): return self
    def __exit__(self,*exc): self.close()

from .picamera2 import Picamera2, MJPEGEncoder, H264Encoder, HEVCEncoder
__all__ += ["Picamera2", "MJPEGEncoder", "H264Encoder", "HEVCEncoder"]
