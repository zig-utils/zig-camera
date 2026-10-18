"""Single capture worker shared by recording, preview and AF jobs."""
import threading
from . import CameraError
class CapturePump:
    def __init__(self,camera):
        self.camera=camera;self.stop_event=threading.Event();self.error=None
        self.thread=threading.Thread(target=self._run,name='zig-camera-capture',daemon=True)
        self.thread.start()
    def _expire(self):
        import time
        expired=[]
        if not self.camera._async_lock.acquire(False): return
        try:
            for job in list(self.camera._capture_jobs):
                if time.monotonic()>=job.deadline:
                    with job.lock: job.state='expired'
                    self.camera._capture_jobs.remove(job);expired.append(job)
        finally: self.camera._async_lock.release()
        for job in expired: job._finish(error=TimeoutError('Capture frame deadline expired'))
    def _run(self):
        try:
            while not self.stop_event.is_set():
                self._expire()
                try: frame=self.camera.acquire(timeout_ms=100,_internal=True)
                except CameraError as error:
                    if error.status==-3:
                        self._expire()
                        if self.camera._async_lock.acquire(False):
                            try: self.camera._maybe_stop_pump()
                            finally: self.camera._async_lock.release()
                        continue
                    raise
                job=None;retained=False;value=None;failure=None
                try:
                    if self.stop_event.is_set(): continue
                    if not self.camera._async_lock.acquire(timeout=.02): continue
                    try:
                        if self.stop_event.is_set(): continue
                        recording=self.camera._recording
                        if recording is not None:
                            try: recording.write(frame)
                            except Exception as error: recording.error=error
                        preview=self.camera._preview
                        if preview is not None:
                            try: preview.publish(frame)
                            except Exception as error: preview.error=error
                        if self.camera._capture_jobs:
                            job=self.camera._capture_jobs.popleft();self.camera._active_capture_job=job
                            if not job._claim(): failure=TimeoutError('Capture frame deadline expired')
                    finally: self.camera._async_lock.release()
                    if job is not None and failure is None:
                        try:
                            value=job.operation(frame);retained=job.retain
                            if retained: frame._internal=False
                        except Exception as error: failure=error
                finally:
                    if not retained:
                        try: frame.release()
                        except Exception as error:
                            if failure is None: failure=error
                    if job is not None:
                        job._finish(value,failure);self.camera._active_capture_job=None
                if failure is not None and job is None: raise failure
                if self.camera._async_lock.acquire(False):
                    try: self.camera._maybe_stop_pump()
                    finally: self.camera._async_lock.release()
        except Exception as error:
            self.error=error
            recording=self.camera._recording
            if recording is not None: recording.error=error
            while not self.stop_event.is_set():
                if self.camera._async_lock.acquire(timeout=.02):
                    try: pending=list(self.camera._capture_jobs);self.camera._capture_jobs.clear()
                    finally: self.camera._async_lock.release()
                    for job in pending: job._finish(error=error)
                    break
    def close(self):
        self.stop_event.set()
        if threading.current_thread() is not self.thread: self.thread.join()

class Recording:
    def __init__(self,camera,recorder,fps):
        self.camera=camera;self.recorder=recorder;self.fps=fps;self.frames=0;self.error=None;self.closed=False;self._split_job=None
    @property
    def thread(self): return self._thread
    def write(self,frame):
        if self.error is not None: return
        timestamp=self.frames*1_000_000_000//self.fps if self.camera.info['backend']=='synthetic' else frame._native.timestamp_ns
        try: self.recorder.write(frame,timestamp_ns=timestamp)
        except Exception as error:
            if self._split_job is not None: self._split_job._finish(error=error)
            raise
        self.frames+=1
        if self._split_job is not None and not self._split_job.done() and not self.recorder.buffer_stats['split_pending']:
            self._split_job._finish(self._split_job.path)
    def split(self,path,signal_function=None):
        from .jobs import OperationJob
        with self.camera._async_lock:
            if self.closed or self.error is not None: raise RuntimeError('Recording is not writable')
            if self._split_job is not None and not self._split_job.done(): raise RuntimeError('Split already pending')
            if not self.camera._job_slots.acquire(False): raise RuntimeError('Job capacity exhausted')
            try: self.recorder.split(path)
            except Exception: self.camera._job_slots.release();raise
            job=OperationJob(signal_function=signal_function,release_slot=self.camera._job_slots.release,cancel_function=self._cancel_split)
            job.state='running';job.path=path;self._split_job=job
            return job
    def _cancel_split(self,job):
        from concurrent.futures import CancelledError
        with self.camera._async_lock:
            if job.done(): return False
            self.recorder.cancel_split()
            job._finish(error=CancelledError('Recording split cancelled'))
            return True
    def save_buffer(self,path):
        with self.camera._async_lock: self.recorder.save_buffer(path)
    def open_output(self,path):
        with self.camera._async_lock: self.recorder.open_output(path)
    def close_output(self):
        with self.camera._async_lock: self.recorder.close_output()
    @property
    def buffer_stats(self):
        with self.camera._async_lock: return self.recorder.buffer_stats
    def close(self):
        if self.closed: return
        if self.camera._recording is self:
            self.camera.stop_recording();return
        self.closed=True
        if self._split_job is not None and not self._split_job.done(): self._cancel_split(self._split_job)
        try: self.recorder.close()
        finally:
            if self.error is not None: raise self.error
