"""Owned recording preparation; no output hook runs under the camera lock."""
import threading
from contextlib import contextmanager
from concurrent.futures import CancelledError
from .jobs import OperationJob,PreparationJob

def asynchronous(wait,signal): return wait is False or (wait is None and signal is not None)

@contextmanager
def camera_lock(camera,job):
    while not camera._async_lock.acquire(timeout=.02):
        if job.cancel_requested: raise CancelledError('Recording startup cancelled')
    try: yield
    finally: camera._async_lock.release()

def startup(camera,path,options,wait,signal,circular_output=None):
    from .output_objects import guard_callback
    guard_callback()
    with camera._async_lock:
        camera._open()
        if camera._closing: raise RuntimeError('Camera is closing')
        if camera._recording is not None: raise RuntimeError('Recording already active')
        if camera._startup_job is not None and not camera._startup_job.done(): raise RuntimeError('Recording startup already pending')
        if camera._startup_stop_job is not None and not camera._startup_stop_job.done(): raise RuntimeError('Recording startup is still closing')
        if camera._stopping_recording is not None:
            job=camera._stopping_recording.recorder._close_job
            if job is None or not job.done(): raise RuntimeError('Previous recording is still closing')
            camera._stopping_recording=None
        if not camera._started: camera._stopping=False
        if not camera._job_slots.acquire(False): raise RuntimeError('Job capacity exhausted')
        # Copy option dictionaries and the output list, never caller-owned sinks.
        options={key:dict(value) if isinstance(value,dict) else value for key,value in options.items()}
        path=list(path) if isinstance(path,(list,tuple)) else path
        def cancel(job):
            with camera._async_lock: return job.request_cancel()
        def after(job):
            if camera._async_lock.acquire(False):
                try:
                    if camera._startup_job is job and job.done(): camera._startup_job=None
                finally: camera._async_lock.release()
        job=PreparationJob(camera._lib,lambda job:run_startup(camera,job,path,options,circular_output),signal,camera._job_slots.release,cancel,after_prepare=after)
        job.thread_name='zig-camera-recording-start';camera._startup_job=job
    job.start(inline=not asynchronous(wait,signal))
    return job if asynchronous(wait,signal) else job.result()

def run_startup(camera,job,path,options,circular_output):
    from . import Recorder,AudioCapture
    from .pipeline import Recording
    from .outputs import RotatingOutput
    source=recorder=recording=None;published=False
    def check():
        if job.abort_error is not None: raise job.abort_error
        if job.cancel_requested: raise CancelledError('Recording startup cancelled')
    try:
        with camera_lock(camera,job):
            camera._open();check()
            if camera._stopping or camera._closing: raise CancelledError('Camera is stopping')
            if not camera._started: camera.start()
            width=camera.info['main']['width'];height=camera.info['main']['height'];library=camera._lib._name
            synthetic=camera.info['backend']=='synthetic'
        rotation=path if isinstance(path,RotatingOutput) else None
        if rotation is not None:
            if options['circular'] is not None: raise ValueError('Rotation requires a file output')
            rotation._available();path=rotation.path(0)
        audio=options.pop('audio');encoding={}
        if audio is not None and audio is not False:
            spec={} if audio is True else dict(audio)
            encoding={name:spec.pop(name) for name in ('codec','bitrate') if name in spec}
            spec.setdefault('backend','alsa')
            if synthetic != (spec['backend']=='synthetic'): raise ValueError('Audio and camera must use the same clock source')
            source=AudioCapture(library=library,**spec);check()
        recorder=Recorder(path,width=width,height=height,library=library,audio=None if source is None else {'sample_rate':source.sample_rate,'channels':source.channels,**encoding},exclusive=rotation is not None,**options)
        check();recording=Recording(camera,recorder,options['fps'],audio=source,rotation=rotation)
        if not job.step(2): raise CancelledError('Recording startup cancelled')
        with camera_lock(camera,job):
            camera._open();check()
            if camera._stopping or camera._closing: raise CancelledError('Camera is stopping')
            camera._recording=recording
            try:
                recording._thread=camera._ensure_pump().thread
                if rotation is not None: rotation._bind(recording)
                if circular_output is not None: circular_output._bind(recording)
                if not job.step(3): raise CancelledError('Recording startup cancelled')
            except Exception: camera._recording=None;raise
            published=True
        return recording
    except BaseException:
        # Cleanup is owned by this worker and precedes observable completion.
        operations=[recording.close] if recording is not None else [*([] if recorder is None else [recorder.close]),*([] if source is None else [source.close])]
        for operation in operations:
            try: operation()
            except Exception as error:
                if job.cleanup_error is None: job.cleanup_error=error
        raise
    finally:
        if not published and camera._async_lock.acquire(False):
            try: camera._maybe_stop_pump()
            finally: camera._async_lock.release()

def stop_startup(camera,wait,signal):
    """Return (handled, result), including a single reserved cleanup waiter."""
    with camera._async_lock:
        previous=camera._startup_stop_job
        if previous is not None and not previous.done() and threading.current_thread() is not previous.thread:
            job=previous
        else:
            pending=camera._startup_job
            if pending is None or pending.done(): return False,None
            pending.request_cancel()
            # Publication and cancellation use this same lock. Either detach
            # the published recording now, or cancellation prevents publication.
            # The waiter must never need a lock held by its synchronous caller.
            recording=camera._recording
            if recording is not None:
                camera._recording=None;camera._stopping_recording=recording
            def stop():
                pending.event.wait()
                if recording is not None: recording.close()
                if pending.cleanup_error is not None: raise pending.cleanup_error
            job=OperationJob(stop,signal);job.thread_name='zig-camera-startup-stop'
            job.cancel_function=lambda _:False;camera._startup_stop_job=job;job.start()
    return True,job if asynchronous(wait,signal) else job.result()
