"""Serialized mode changes; frame leases never survive camera reconfiguration."""
import copy
import time
from functools import wraps
from .jobs import OperationJob

def serialized(function):
    @wraps(function)
    def call(self,*args,**kwargs):
        from .output_objects import guard_callback
        guard_callback()
        with self._operation_lock: return function(self,*args,**kwargs)
    return call

class ModeRestoreError(RuntimeError):
    def __init__(self,operation_error,restoration_error):
        self.operation_error=operation_error;self.restoration_error=restoration_error
        message=f'Mode operation failed: {operation_error}; restoration failed: {restoration_error}' if operation_error is not None else f'Capture completed; restoration failed: {restoration_error}'
        super().__init__(message)

def submit(camera,config,operation,wait,signal_function,num_frames,timeout_ms):
    if not isinstance(num_frames,int) or not 0<=num_frames<=10000: raise ValueError('Invalid frame drop count')
    if not isinstance(timeout_ms,int) or not 0<timeout_ms<=4294967295: raise ValueError('Invalid mode deadline')
    target=copy.deepcopy(config)
    with camera._mode_guard:
        if camera._mode_job is not None and not camera._mode_job.done(): raise RuntimeError('Mode switch already pending')
        if not camera._operation_slots.acquire(False): raise RuntimeError('Mode job/callback capacity exhausted')
        job=OperationJob(lambda:run(camera,target,operation,num_frames,timeout_ms),signal_function,camera._operation_slots.release)
        camera._mode_job=job;job.start()
    return job.result() if (wait is True or (wait is None and signal_function is None)) else job

def run(camera,target,operation,num_frames,timeout_ms):
    with camera._operation_lock:
        old=camera._ready()
        with old._async_lock:
            if old._recording is not None or (old._startup_job is not None and not old._startup_job.done()) or (old._startup_stop_job is not None and not old._startup_stop_job.done()): raise RuntimeError('Stop recording before switching modes')
            # Read the active transfer before inspecting leases: a finishing
            # request job marks its frame public before clearing this marker.
            active=old._active_capture_job
            if (active is not None and active.retain) or any(job.retain for job in old._capture_jobs):
                raise RuntimeError('Finish request capture jobs before switching modes')
            if any(not getattr(frame,'_internal',False) for frame in list(old._leases.values())):
                raise RuntimeError('Release all request leases before switching modes')
            old._stopping=True
        previous=copy.deepcopy(camera._config);was_started=old._started
        preview=copy.deepcopy(camera._preview_options)
        deadline=time.monotonic()+timeout_ms/1000
        def remaining():
            milliseconds=int((deadline-time.monotonic())*1000)
            if milliseconds<=0: raise TimeoutError('Mode job deadline expired')
            return min(milliseconds,4294967295)
        def change(config,start):
            if camera._camera is not None: camera._camera.stop()
            camera.configure(config)
            if start: camera._camera.start()
            if preview is not None: camera._camera.start_preview(**preview)
        def restore(): change(previous,was_started)
        try:
            change(target,True);remaining()
            for _ in range(num_frames): camera._camera.capture_metadata(remaining())
            if operation is None: return camera.camera_configuration()
            with camera._camera.capture_request(remaining()) as frame: result=operation(frame)
        except Exception as error:
            try: restore()
            except Exception as restoration_error: raise ModeRestoreError(error,restoration_error) from error
            raise
        try: restore()
        except Exception as restoration_error: raise ModeRestoreError(None,restoration_error) from restoration_error
        return result
