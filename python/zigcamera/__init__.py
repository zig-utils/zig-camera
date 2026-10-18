"""Small ctypes interface to zig-camera ABI v1; no NumPy dependency.

Borrowed views must stay inside their context and frame lease. Use copy_rgb()
for owned bytes or numpy() for an owned ndarray. Never close borrowed DMA fds.
"""
from __future__ import annotations
import ctypes as C
import ctypes.util
import os
import sys
from contextlib import contextmanager
from pathlib import Path

__all__ = ["Camera", "Frame", "CameraError"]

class _Config(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in ("width", "height", "buffer_count", "camera_index", "policy", "exposure_us", "frame_duration_us")] + [
        ("analogue_gain", C.c_float), ("lens_position", C.c_float), ("raw", C.c_uint32), ("raw_format", C.c_char * 32)]
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
        "zc_abi_version": ([], C.c_uint32),
        "zc_default_config": ([C.POINTER(_Config)], None),
        "zc_open": ([C.POINTER(_Config), C.POINTER(C.c_void_p)], C.c_int),
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
    def __init__(self, *, library=None, simulate=False, policy="latest", **options):
        self._lib = _load(library)
        self._handle = C.c_void_p()
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
        self._check(self._lib.zc_open(C.byref(config), C.byref(self._handle)))
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
        self._open(); self._check(self._lib.zc_start(self._handle)); return self
    def stop(self):
        self._open(); self._check(self._lib.zc_stop(self._handle))
    def acquire(self, timeout_ms=5000):
        self._open(); native = _Frame()
        self._check(self._lib.zc_acquire(self._handle, _u32(timeout_ms), C.byref(native)))
        frame = Frame(self, native)
        self._leases[native.token] = frame
        return frame
    @property
    def stats(self):
        self._open(); s = _Stats(); self._check(self._lib.zc_get_stats(self._handle, C.byref(s)))
        return {name: getattr(s, name) for name, _ in s._fields_}
    def close(self):
        if self._handle.value:
            self._check(self._lib.zc_close(self._handle))
            self._handle = C.c_void_p()
    def __enter__(self): return self
    def __exit__(self, *exc):
        self.stop()
        for lease in list(self._leases.values()): lease.release()
        self.close()

class Frame:
    def __init__(self, camera, native):
        self._camera = camera; self._native = native; self._views = 0
    def _live(self):
        if not self._native.token: raise RuntimeError("Frame was released")
    @property
    def metadata(self):
        self._live()
        names = ("sequence", "timestamp_ns", "exposure_us", "analogue_gain", "red_gain", "blue_gain")
        return {n: getattr(self._native, n) for n in names}
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
    def save_jpeg(self, path, quality=98):
        self._live()
        self._camera._check(self._camera._lib.zc_save_jpeg(self._camera._handle, self._native.token, os.fsencode(path), _u32(quality)))
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
