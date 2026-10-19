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
            if recording is not None:
                recording.error=error
                if recording._split_job is not None: recording._split_job._finish(error=error)
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
    def __init__(self,camera,recorder,fps,*,audio=None,rotation=None):
        self.camera=camera;self.recorder=recorder;self.fps=fps;self.frames=0;self.error=None;self.closed=False;self._split_job=None
        from .audio import AudioFeed
        self._audio=None;self._rotation=rotation;self._rotation_pending=None;self._rotation_index=0
        self.current_path=None if rotation is None else rotation.path(0)
        if rotation is not None: recorder.set_rotation(duration_ns=rotation.duration_ns,max_bytes=rotation.max_bytes)
        if audio is not None: self._audio=AudioFeed(audio)
    @property
    def stats(self):
        with self.camera._async_lock:
            stats=self.recorder.stats
            if self._audio is not None: stats.update(clock_error_ns=self._audio.clock_error_ns,max_clock_error_ns=self._audio.max_clock_error_ns)
            return stats
    @property
    def thread(self): return self._thread
    def write(self,frame):
        if self.error is not None: return
        timestamp=self.frames*1_000_000_000//self.fps if self.camera.info['backend']=='synthetic' else frame._native.timestamp_ns
        try:
            if self._audio is not None:
                if self.camera.info['backend']!='synthetic' and frame.metadata.get('timestamp_clock')!='boottime': raise RuntimeError('Camera does not provide SensorTimestamp in BOOTTIME')
                self._audio.through(self.recorder,timestamp+1_000_000_000//self.fps)
            self.recorder.write(frame,timestamp_ns=timestamp)
            if self._rotation is not None: self._rotate()
        except Exception as error:
            if self._split_job is not None: self._split_job._finish(error=error)
            raise
        self.frames+=1
        if self._split_job is not None and not self._split_job.done() and not self.recorder.buffer_stats['split_pending']:
            self._split_job._finish(self._split_job.path)
    def _rotate(self):
        import os
        if self._rotation_pending is not None and not self.recorder.buffer_stats['split_pending']:
            self._rotation_index+=1;self.current_path=self._rotation.path(self._rotation_index);self._rotation_pending=None
        if self.recorder.stats['rotation_due']:
            path=self._rotation.path(self._rotation_index+1)
            self.recorder.split(path)
            identity=os.stat(path,follow_symlinks=False)
            self._rotation_pending=(path,identity.st_dev,identity.st_ino)
    def _discard_rotation(self):
        import os
        if self._rotation_pending is None: return
        if not self.recorder.buffer_stats['split_pending']:
            self._rotation_index+=1;self.current_path=self._rotation.path(self._rotation_index);self._rotation_pending=None;return
        self.recorder.cancel_split()
        path,dev,ino=self._rotation_pending;self._rotation_pending=None
        try:
            info=os.stat(path,follow_symlinks=False)
            if (info.st_dev,info.st_ino)==(dev,ino): os.unlink(path)
        except FileNotFoundError: pass
    def split(self,path,signal_function=None):
        from .jobs import OperationJob
        with self.camera._async_lock:
            if self.closed or self.error is not None: raise RuntimeError('Recording is not writable')
            if self._rotation is not None: raise RuntimeError('Manual splits are disabled during automatic rotation')
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
            if not self.recorder.buffer_stats['split_pending']:
                job._finish(job.path);return False
            try: self.recorder.cancel_split()
            except Exception as error:
                job._finish(error=error);raise
            job._finish(error=CancelledError('Recording split cancelled'))
            return True
    def save_buffer(self,path,*,wait=None,signal_function=None):
        with self.camera._async_lock: job=self.recorder.save_buffer(path,wait=False,signal_function=signal_function)
        if wait is True or (wait is None and signal_function is None): job.result();return None
        return job
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
        failure=self.error
        operations=[]
        if self._split_job is not None and not self._split_job.done(): operations.append(lambda:self._cancel_split(self._split_job))
        if self._audio is not None: operations.append(self._audio.close)
        operations.extend((self._discard_rotation,self.recorder.close))
        for operation in operations:
            try: operation()
            except Exception as error:
                if failure is None: failure=error
        if failure is not None: raise failure
