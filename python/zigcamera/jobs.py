"""Autofocus job monitors native two-phase state without consuming frames."""
import asyncio
import ctypes as C
import threading
from concurrent.futures import CancelledError
class AutofocusJob:
    def __init__(self,camera,job_id,timeout,signal_function):
        self.camera=camera;self.id=job_id;self.timeout=timeout;self.signal_function=signal_function
        self.event=threading.Event();self.value=None;self.error=None;self.callback_error=None;self.state=1
        self.thread=threading.Thread(target=self._run,name='zig-camera-autofocus',daemon=True)
    def start(self): self.thread.start()
    def done(self): return self.event.is_set()
    def _run(self):
        try:
            state=C.c_uint32()
            status=self.camera._lib.zc_autofocus_wait(self.camera._handle,self.id,int(self.timeout*1000),C.byref(state))
            if status==-3:
                self.camera._check(self.camera._lib.zc_autofocus_cancel(self.camera._handle,self.id))
                raise TimeoutError('Autofocus scan timed out')
            self.camera._check(status);self.state=state.value
            if self.state==5: raise CancelledError('Autofocus cancelled')
            if self.state==6: raise RuntimeError('Camera stopped during autofocus')
            self.value=self.state==3
        except Exception as error: self.error=error
        finally:
            self.event.set()
            self.camera._maybe_stop_pump()
            if self.signal_function is not None:
                try: self.signal_function(self)
                except Exception as error: self.callback_error=error
    def result(self,timeout=None):
        if not self.event.wait(timeout): raise TimeoutError('Job result not ready')
        if self.error is not None: raise self.error
        return self.value
    get_result=result
    def cancel(self):
        if self.done(): return False
        self.camera._check(self.camera._lib.zc_autofocus_cancel(self.camera._handle,self.id))
        state=C.c_uint32()
        status=self.camera._lib.zc_autofocus_wait(self.camera._handle,self.id,0,C.byref(state))
        self.camera._check(status)
        return state.value==5
    def join(self):
        if threading.current_thread() is not self.thread: self.thread.join()
    async def _await(self):
        try: return await asyncio.to_thread(self.result)
        except asyncio.CancelledError:
            self.cancel();raise
    def __await__(self): return self._await().__await__()
