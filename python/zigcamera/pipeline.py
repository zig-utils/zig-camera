"""Single capture worker shared by recording, preview and AF jobs."""
import threading
from . import CameraError
class CapturePump:
    def __init__(self,camera):
        self.camera=camera;self.stop_event=threading.Event();self.error=None
        self.thread=threading.Thread(target=self._run,name='zig-camera-capture',daemon=True)
        self.thread.start()
    def _run(self):
        try:
            while not self.stop_event.is_set():
                try: frame=self.camera.acquire(timeout_ms=100)
                except CameraError as error:
                    if error.status==-3: continue
                    raise
                with frame:
                    with self.camera._async_lock:
                        recording=self.camera._recording
                        if recording is not None:
                            try: recording.write(frame)
                            except Exception as error: recording.error=error
                        preview=self.camera._preview
                        if preview is not None:
                            try: preview.publish(frame)
                            except Exception as error: preview.error=error
                self.camera._maybe_stop_pump()
        except Exception as error:
            self.error=error
            with self.camera._async_lock:
                if self.camera._recording is not None: self.camera._recording.error=error
    def close(self):
        self.stop_event.set()
        if threading.current_thread() is not self.thread: self.thread.join()

class Recording:
    def __init__(self,camera,recorder,fps):
        self.camera=camera;self.recorder=recorder;self.fps=fps;self.frames=0;self.error=None;self.closed=False
    @property
    def thread(self):
        # Compatibility for existing callers inspecting worker lifetime.
        return self._thread
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
