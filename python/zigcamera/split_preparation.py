"""A reserved output recipe owns headers/containers until keyframe staging."""
import ctypes as C
import threading
from concurrent.futures import CancelledError

class SplitPreparation:
    def __init__(self,recorder,identity,target):
        from .output_objects import OutputBridge,MuxedOutput,_path
        self.recorder=recorder;self.identity=identity;self.target=target
        self.native=C.c_void_p();self.done=threading.Event();self.bridge=None;self.transferred=False
        self.path=target if _path(target) else None
        with recorder._lock:
            recorder._open();recorder._sync_split();state=recorder._state(identity)
            if identity in recorder._split_preparations or state['pending']: raise RuntimeError('Split already pending for this output')
            if identity in recorder._retiring: raise RuntimeError('Output lifecycle is still retiring')
            if state['error_code']: raise RuntimeError('Output is quarantined; detach before reattaching')
            self.generation=state['generation'];self.streams=recorder._streams()
            old=recorder._bridge if identity==0 else recorder._extra_bridges.get(identity)
            pts=old.pts if old is not None and identity==0 else None
            if self.path is None or (pts is not None and pts.target is not None):
                self.bridge=OutputBridge(recorder,MuxedOutput(target) if self.path is not None else target,pts)
                if pts is not None: self.bridge.owns_pts=False
                self.path=None
            recorder._split_preparations[identity]=self
    def abandon(self):
        with self.recorder._lock:
            if self.recorder._split_preparations.get(self.identity) is self: self.recorder._split_preparations.pop(self.identity)
        self.done.set()
    def run(self,job=None,recording=None):
        from . import _path
        r=self.recorder;bridge=self.bridge
        def check():
            if job is not None:
                if job.abort_error is not None: raise job.abort_error
                if job.cancel_requested: raise CancelledError('Split preparation cancelled')
        failure=None
        try:
            check()
            if bridge is not None: bridge.start(self.streams)
            check()
            with r._lock:
                r._open()
                if bridge is not None: r._check_bridge_distinct(bridge)
                else: r._check_retiring_path(self.path)
                r._checked_bridge(r._lib.zc_video_prepare_split(r._handle,self.identity,None if self.path is None else _path(self.path),None if bridge is None else C.byref(bridge.cb),C.byref(self.native)),bridge)
            # Uses copied configuration and reserved descriptors, no recorder
            # state or camera lease. Slow sink writes cannot hold capture locks.
            r._checked_bridge(r._lib.zc_prepared_output_build(self.native),bridge)
            if bridge is not None: bridge.commit()
            check()
            if job is not None and not job.step(2): raise CancelledError('Split preparation cancelled')
            if recording is None: self.stage(job)
            else:
                # A synchronous stop may be called by the owner while it holds
                # this lock. Poll cancellation while waiting, so cleanup never
                # depends on acquiring that owner's publication lock.
                while not recording.camera._async_lock.acquire(timeout=.02): check()
                try:
                    if recording.closed or recording.error is not None: raise CancelledError('Recording stopped during split preparation')
                    check();self.stage(job)
                finally: recording.camera._async_lock.release()
            return self.target
        except BaseException as error: failure=error;raise
        finally:
            try:
                try:
                    with r._lock:
                        if self.native.value: r._lib.zc_prepared_output_close(self.native);self.native=C.c_void_p()
                    if bridge is not None and not self.transferred: bridge.stop()
                except Exception as error:
                    if failure is None: raise
                    if job is not None: job.cleanup_error=error
            finally: self.abandon()
    def stage(self,job):
        r=self.recorder
        with r._lock:
            r._open()
            r._checked_bridge(r._lib.zc_video_commit_split(r._handle,self.native),self.bridge)
            self.transferred=True
            r._split_results.pop(self.identity,None);r._lifecycle_errors.pop(self.identity,None)
            if self.identity==0:
                r._next_bridge=self.bridge;r._next_output=self.target;r._split_staged=True;r._split_generation=self.generation
            else: r._extra_pending[self.identity]=(self.bridge,self.target,self.generation)
            if job is not None: job.staged=True;job.generation=self.generation;job.state='running'

def submit(recorder,current,target,wait,signal):
    from .jobs import PreparationJob
    from .recording_jobs import asynchronous
    if not asynchronous(wait,signal):
        with recorder._lock: recorder._open();identity=recorder._output_id(current)
        SplitPreparation(recorder,identity,target).run();return None
    with recorder._lifecycle_lock:
        recorder._open()
        if not recorder._lifecycle_slots.acquire(False): raise RuntimeError('Output job capacity exhausted')
    try:
        with recorder._lock: identity=recorder._output_id(current)
        preparation=SplitPreparation(recorder,identity,target)
    except BaseException: recorder._lifecycle_slots.release();raise
    try:
        with recorder._lifecycle_lock: recorder._open()
        def cancel(job):
            with recorder._lock:
                if job.staged: return False
                return job.request_cancel()
        def release():
            with recorder._lifecycle_lock: recorder._output_jobs.discard(job)
            recorder._lifecycle_slots.release()
        def run(job): preparation.run(job);job.step(3)
        job=PreparationJob(recorder._lib,run,signal,release,cancel,unclaimed=preparation.abandon)
        job.thread_name='zig-camera-output-prepare'
        with recorder._lifecycle_lock:
            recorder._open();recorder._output_jobs.add(job)
    except BaseException:
        preparation.abandon();recorder._lifecycle_slots.release();raise
    return job.start()
