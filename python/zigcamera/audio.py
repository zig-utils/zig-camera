"""Explicit bounded S16LE audio capture; ALSA uses the sensor's BOOTTIME clock."""
import ctypes as C
import threading
import time
from collections import deque
from . import _load, _u32, _check, _AudioConfig, _AudioBlock, CameraError

class AudioCapture:
    """Owns a capture device. read/close serialize; read timeout is at most 1 second.

    Synthetic capture is deterministic and unpaced, for tests only. No device is
    opened until this object is constructed. Returned bytes are owned by Python.
    """
    def __init__(self,*,device='default',backend='alsa',sample_rate=48000,channels=1,block_frames=480,start_ns=0,library=None):
        self._lib=_load(library);self._handle=C.c_void_p();self._lock=threading.Lock()
        if backend not in ('alsa','synthetic'): raise ValueError('Unknown audio backend')
        if not isinstance(device,str) or '\0' in device: raise ValueError('Invalid audio device')
        if not isinstance(start_ns,int) or not 0<=start_ns<2**64: raise ValueError('Invalid audio origin')
        cfg=_AudioConfig();self._lib.zc_default_audio_config(C.byref(cfg))
        cfg.backend=int(backend=='alsa');cfg.sample_rate=_u32(sample_rate);cfg.channels=_u32(channels);cfg.block_frames=_u32(block_frames);cfg.start_ns=start_ns
        _check(self._lib,self._lib.zc_audio_open(C.byref(cfg),device.encode(),C.byref(self._handle)))
        self.backend=backend;self.sample_rate=sample_rate;self.channels=channels;self.block_frames=block_frames
        self._buffer=(C.c_uint8*(block_frames*channels*2))()
    def read(self,timeout_ms=100):
        _u32(timeout_ms)
        if timeout_ms>1000: raise ValueError('Audio timeout must be <=1000ms')
        with self._lock:
            if not self._handle.value: raise RuntimeError('Audio capture is closed')
            out=_AudioBlock();status=self._lib.zc_audio_read(self._handle,self._buffer,len(self._buffer),timeout_ms,C.byref(out))
            if status==-3: return None
            _check(self._lib,status)
            return {'data':bytes(self._buffer[:out.frames*self.channels*2]),'timestamp_ns':out.timestamp_ns,'frames':out.frames,'clock_error_ns':out.clock_error_ns}
    def close(self):
        with self._lock:
            if self._handle.value:
                status=self._lib.zc_audio_close(self._handle);self._handle=C.c_void_p();_check(self._lib,status)
    def __enter__(self): return self
    def __exit__(self,*exc): self.close()

class AudioFeed:
    """Recording-owned reader; never runs on libcamera's completion callback."""
    def __init__(self,source):
        self.source=source;self.blocks=deque();self.condition=threading.Condition();self.stop=threading.Event();self.error=None;self.coverage=None;self.thread=None;self.clock_error_ns=0;self.max_clock_error_ns=0
        if source.backend!='synthetic':
            self.thread=threading.Thread(target=self._read,name='zig-camera-audio',daemon=True);self.thread.start()
    def _read(self):
        try:
            while not self.stop.is_set():
                block=self.source.read(100)
                if block is None: continue
                with self.condition:
                    if self.stop.is_set(): break
                    if len(self.blocks)>=128: raise RuntimeError('Audio reader queue exhausted')
                    self.blocks.append(block);self.condition.notify_all()
        except Exception as error:
            with self.condition: self.error=error;self.condition.notify_all()
    def through(self,recorder,end_ns):
        deadline=time.monotonic()+1
        while self.coverage is None or self.coverage<end_ns:
            if self.source.backend=='synthetic': block=self.source.read(0)
            else:
                with self.condition:
                    while not self.blocks:
                        if self.error is not None: raise self.error
                        remaining=deadline-time.monotonic()
                        if remaining<=0: raise TimeoutError('Audio did not reach video timestamp within 1s')
                        self.condition.wait(remaining)
                    if self.error is not None: raise self.error
                    block=self.blocks.popleft()
            self.clock_error_ns=block.get('clock_error_ns',0);self.max_clock_error_ns=max(self.max_clock_error_ns,abs(self.clock_error_ns))
            recorder.write_audio(block['data'],timestamp_ns=block['timestamp_ns'])
            self.coverage=block['timestamp_ns']+block['frames']*1_000_000_000//self.source.sample_rate
        if self.error is not None: raise self.error
    def close(self):
        self.stop.set()
        with self.condition: self.condition.notify_all()
        if self.thread is not None: self.thread.join()
        self.source.close()
