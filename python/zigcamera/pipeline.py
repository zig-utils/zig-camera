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
                try: frame=self.camera.acquire(timeout_ms=100)
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
                            job=self.camera._capture_jobs.popleft()
                            if not job._claim(): failure=TimeoutError('Capture frame deadline expired')
                    finally: self.camera._async_lock.release()
                    if job is not None and failure is None:
                        try: value=job.operation(frame);retained=job.retain
                        except Exception as error: failure=error
                finally:
                    if not retained:
                        try: frame.release()
                        except Exception as error:
                            if failure is None: failure=error
                    if job is not None: job._finish(value,failure)
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
        self.camera=camera;self.recorder=recorder;self.fps=fps;self.frames=0;self.error=None;self.closed=False
    @property
    def thread(self): return self._thread
    def write(self,frame):
        if self.error is not None: return
        timestamp=self.frames*1_000_000_000//self.fps if self.camera.info['backend']=='synthetic' else frame._native.timestamp_ns
        self.recorder.write(frame,timestamp_ns=timestamp);self.frames+=1
    def close(self):
        if self.closed: return
        if self.camera._recording is self:
            self.camera.stop_recording();return
        self.closed=True
        try: self.recorder.close()
        finally:
            if self.error is not None: raise self.error
