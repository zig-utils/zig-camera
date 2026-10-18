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

class CaptureJob:
    """One bounded capture operation. Queued cancellation wins; running work finishes.

    result(timeout) only limits the wait; timeout_ms limits waiting for a frame.
    Callbacks run on a separate thread and may outlive camera.close().
    """
    def __init__(self,camera,operation,timeout_ms,signal_function,retain):
        import time
        self.camera=camera;self.operation=operation;self.signal_function=signal_function;self.retain=retain
        self.deadline=time.monotonic()+timeout_ms/1000
        self.event=threading.Event();self.lock=threading.Lock();self.state='queued'
        self.value=None;self.error=None;self.callback_error=None;self._abandoned=False
    def done(self): return self.event.is_set()
    def cancelled(self): return isinstance(self.error,CancelledError) and self.done()
    def _finish(self,value=None,error=None):
        with self.lock:
            if self._abandoned and self.retain and value is not None:
                try: value.release()
                except Exception as failure: error=failure
                else: error=CancelledError('Capture await cancelled')
                value=None
            self.value=value;self.error=error;self.state='finished';self.event.set()
        if self.signal_function is None: self.camera._job_slots.release()
        else:
            def notify():
                try: self.signal_function(self)
                except Exception as failure: self.callback_error=failure
                finally: self.camera._job_slots.release()
            threading.Thread(target=notify,name='zig-camera-capture-callback',daemon=True).start()
    def _claim(self):
        import time
        with self.lock:
            if self.state!='queued': return False
            if time.monotonic()>=self.deadline:
                self.state='expired';return False
            self.state='running';return True
    def cancel(self):
        with self.camera._async_lock:
            with self.lock:
                if self.state!='queued': return False
                self.state='cancelled'
            self.camera._capture_jobs.remove(self)
        self._finish(error=CancelledError('Capture cancelled'))
        self.camera._maybe_stop_pump()
        return True
    def result(self,timeout=None):
        if not self.event.wait(timeout): raise TimeoutError('Job result not ready')
        if self.error is not None: raise self.error
        return self.value
    get_result=result
    async def _await(self):
        try: return await asyncio.to_thread(self.result)
        except asyncio.CancelledError:
            if not self.cancel() and self.retain:
                with self.lock:
                    self._abandoned=True
                    if self.done() and self.value is not None:
                        self.value.release();self.value=None;self.error=CancelledError('Capture await cancelled')
            raise
    def __await__(self): return self._await().__await__()
