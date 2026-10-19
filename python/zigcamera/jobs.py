"""Autofocus job monitors native two-phase state without consuming frames."""
import asyncio
import ctypes as C
import threading
from functools import wraps
from concurrent.futures import CancelledError

def output_operation(method):
    """Optional bounded lifecycle job; preserve the synchronous default."""
    @wraps(method)
    def call(self,*args,wait=None,signal_function=None,**kwargs):
        from .output_objects import guard_callback
        guard_callback()
        asynchronous=wait is False or (wait is None and signal_function is not None)
        if method.__name__=='close' and self._close_job is not None:
            job=self._close_job
            if threading.current_thread() is job.thread: return method(self,*args,**kwargs)
            if asynchronous: return job
            if job.done() and not self._handle.value: return None
            return job.result()
        if not asynchronous and method.__name__!='close': return method(self,*args,**kwargs)
        job=self._submit_lifecycle(lambda:method(self,*args,**kwargs),signal_function,closing=method.__name__=='close')
        return job if asynchronous else job.result()
    return call
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
                def notify():
                    try: self.signal_function(self)
                    except Exception as error: self.callback_error=error
                try: threading.Thread(target=notify,name='zig-camera-autofocus-callback',daemon=True).start()
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
        self.value=None;self.error=None;self.callback_error=None;self._abandoned=False;self._delivered=False
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
            try: threading.Thread(target=notify,name='zig-camera-capture-callback',daemon=True).start()
            except Exception as failure:
                self.callback_error=failure;self.camera._job_slots.release()
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
        with self.lock:
            if self.error is not None: raise self.error
            self._delivered=True
            return self.value
    get_result=result
    async def _await(self):
        try:
            await asyncio.to_thread(self.event.wait)
            return self.result()
        except asyncio.CancelledError:
            if not self.cancel() and self.retain:
                with self.lock:
                    if self._delivered: raise
                    self._abandoned=True
                    if self.done() and self.value is not None:
                        self.value.release();self.value=None;self.error=CancelledError('Capture await cancelled')
            raise
    def __await__(self): return self._await().__await__()

class OperationJob:
    """Serialized lifecycle or segment operation; queued cancellation only."""
    def __init__(self,operation=None,signal_function=None,release_slot=None,cancel_function=None):
        self.operation=operation;self.signal_function=signal_function;self.release_slot=release_slot;self.cancel_function=cancel_function
        self.event=threading.Event();self.lock=threading.Lock();self.state='queued';self.value=None;self.error=None;self.callback_error=None
        self.thread=None
    def done(self): return self.event.is_set()
    def cancelled(self): return self.done() and isinstance(self.error,CancelledError)
    def _finish_state(self,error): pass
    def _finish(self,value=None,error=None):
        with self.lock:
            if self.state=='finished': return
            self._finish_state(error)
            self.operation=None
            self.value=value;self.error=error;self.state='finished';self.event.set()
        def notify():
            try:
                if self.signal_function is not None: self.signal_function(self)
            except Exception as failure: self.callback_error=failure
            finally:
                if self.release_slot is not None: self.release_slot()
        if self.signal_function is None: notify()
        else:
            try: threading.Thread(target=notify,name='zig-camera-operation-callback',daemon=True).start()
            except Exception as failure:
                self.callback_error=failure
                if self.release_slot is not None: self.release_slot()
    def start(self):
        def run():
            with self.lock:
                if self.state!='queued': return
                self.state='running'
            try: value=self.operation()
            except Exception as failure: self._finish(error=failure)
            else: self._finish(value)
        self.thread=threading.Thread(target=run,name=getattr(self,'thread_name','zig-camera-mode'),daemon=True)
        try: self.thread.start()
        except Exception as error: self._finish(error=error)
        return self
    def cancel(self):
        if self.cancel_function is not None: return self.cancel_function(self)
        with self.lock:
            if self.state!='queued': return False
            self.state='cancelled'
        self._finish(error=CancelledError('Operation cancelled'));return True
    def result(self,timeout=None):
        if not self.event.wait(timeout): raise TimeoutError('Job result not ready')
        if self.error is not None: raise self.error
        return self.value
    get_result=result
    async def _await(self):
        try:
            await asyncio.to_thread(self.event.wait)
            return self.result()
        except asyncio.CancelledError: self.cancel();raise
    def __await__(self): return self._await().__await__()

class PreparationJob(OperationJob):
    """Home cooperative gate: claimed cancellation completes after cleanup."""
    class Native(C.Structure):
        _fields_=[('phase',C.c_uint32),('cancel_requested',C.c_uint32)]
    def __init__(self,lib,operation,signal_function,release_slot,cancel_function,*,deferred=False,after_prepare=None,unclaimed=None):
        super().__init__(operation,signal_function,release_slot,cancel_function)
        self.lib=lib;self.native=self.Native();lib.zc_default_preparation_state(C.byref(self.native))
        self.preparation_done=threading.Event();self.deferred=deferred;self.after_prepare=after_prepare
        self.staged=False;self.cleanup_error=None;self.abort_error=None
        self.unclaimed=unclaimed
    def step(self,action):
        with self.lock: return self.lib.zc_preparation_step(C.byref(self.native),action)==1
    @property
    def cancel_requested(self):
        with self.lock: return bool(self.native.cancel_requested or self.native.phase==4)
    def request_cancel(self):
        with self.lock:
            accepted=self.lib.zc_preparation_step(C.byref(self.native),4)==1
            queued=self.native.phase==4
        if accepted and queued:
            if self.unclaimed is not None: self.unclaimed()
            self.preparation_done.set();self._finish(error=CancelledError('Preparation cancelled'))
        return accepted
    def _finish_state(self,error):
        if isinstance(error,CancelledError): self.lib.zc_preparation_step(C.byref(self.native),5)
        elif error is not None: self.lib.zc_preparation_step(C.byref(self.native),6)
    def abort(self,error):
        if self.staged or self.preparation_done.is_set(): self._finish(error=error);return
        self.abort_error=error
        with self.lock:
            queued=self.native.phase==0
            if queued: self.lib.zc_preparation_step(C.byref(self.native),6)
        if queued:
            if self.unclaimed is not None: self.unclaimed()
            self.preparation_done.set();self._finish(error=error)
        else: self.request_cancel()
    def start(self,*,inline=False):
        def run():
            try:
                with self.lock:
                    if self.lib.zc_preparation_step(C.byref(self.native),1)!=1: return
                    self.state='preparing'
                try: value=self.operation(self)
                except BaseException as error:
                    if not isinstance(error,Exception):
                        original=error;error=RuntimeError(f'Preparation aborted: {error}');error.__cause__=original
                    self._finish(error=error)
                else:
                    if not self.deferred: self._finish(value)
            finally:
                self.preparation_done.set()
                if self.after_prepare is not None: self.after_prepare(self)
        if inline:
            self.thread=threading.current_thread();run();return self
        self.thread=threading.Thread(target=run,name=getattr(self,'thread_name','zig-camera-prepare'),daemon=True)
        try: self.thread.start()
        except Exception as error:
            if self.unclaimed is not None: self.unclaimed()
            self.preparation_done.set();self._finish(error=error)
            if self.after_prepare is not None: self.after_prepare(self)
        return self

class SnapshotJob(OperationJob):
    """Independent owned snapshot; cancellation only wins before worker claim."""
    def __init__(self,operation,cleanup,signal_function,release_slot):
        super().__init__(operation=operation,signal_function=signal_function,
                         release_slot=release_slot if signal_function is not None else None)
        self._cleanup=cleanup;self._cleanup_lock=threading.Lock();self._release=release_slot
        self.thread_name='zig-camera-snapshot'
    def _finish(self,value=None,error=None):
        # Drop native fd/copies before making completion observable. Slow
        # callbacks retain only their bounded Python job slot, never media data.
        with self._cleanup_lock:
            if self._cleanup is not None:
                self._cleanup();self._cleanup=None
                if self.signal_function is None: self._release()
        super()._finish(value,error)
