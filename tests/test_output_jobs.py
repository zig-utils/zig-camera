"""Fixed-prefix drains and bounded lifecycle jobs own all resources to completion."""
import asyncio
import ctypes as C
import os
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import CancelledError
from unittest.mock import patch
from zigcamera import Camera,Recorder,CircularOutput2,FileOutput,MuxedOutput
from test_direct_outputs import Collector,write
from test_async_output_io import Slow,until
from test_modes_recording import wait_frames

class HookGate(Collector):
    def __init__(self,hook='stop',failure=None):
        super().__init__();self.hook=hook;self.failure=failure
        self.entered=threading.Event();self.resume=threading.Event();self.hook_thread=None
    def gate(self,hook):
        if hook!=self.hook: return
        self.hook_thread=threading.get_ident();self.entered.set()
        if not self.resume.wait(10): raise RuntimeError('test hook release timed out')
        if self.failure is not None: raise self.failure
    def start(self): super().start();self.gate('start')
    def _add_stream(self,*args,**kwargs): self.gate('metadata');super()._add_stream(*args,**kwargs)
    def stop(self):
        try: self.gate('stop')
        finally: super().stop()

class TwoPackets(Collector):
    def __init__(self):
        super().__init__();self.entered=[threading.Event(),threading.Event()];self.resume=[threading.Event(),threading.Event()]
    def outputframe(self,*args,**kwargs):
        index=len(self.events)
        if index<2:
            self.entered[index].set()
            if not self.resume[index].wait(10): raise RuntimeError('test packet release timed out')
        super().outputframe(*args,**kwargs)

class OutputJobTests(unittest.TestCase):
    def test_drain_preserves_first_io_failure_when_retired_stop_also_fails(self):
        first=OSError('write failed');second=OSError('stop failed')
        class Failing(Slow):
            def outputframe(self,*args,**kwargs):
                super().outputframe(*args,**kwargs);raise first
            def stop(self): super().stop();raise second
        old=Failing()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([Collector(),old],width=32,height=32,async_io={1:{}},failure_policy='isolate') as recorder:
                try:
                    write(camera,recorder,0);self.assertTrue(old.entered.wait(5))
                    recorder.split_output(1,Collector());write(camera,recorder,1);old.resume.set()
                    with self.assertRaises(OSError) as caught: recorder.drain_output_io(1)
                    self.assertIs(caught.exception,first);self.assertIs(recorder._split_results[1],first)
                    self.assertEqual(old.lifecycle.count('stop'),1)
                finally: old.resume.set()

    def test_retiring_stop_reserves_files_and_busy_id_until_hook_finishes(self):
        entered=threading.Event();resume=threading.Event()
        class SlowFile(FileOutput):
            def stop(self):
                entered.set()
                if not resume.wait(10): raise RuntimeError('file hook timed out')
                super().stop()
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            path=Path(directory)/'first.mjpg';alias=Path(directory)/'alias.mjpg';old=SlowFile(path)
            camera.start()
            with Recorder([Collector(),old],width=32,height=32,async_io={}) as recorder:
                try:
                    write(camera,recorder,0);recorder.split_output(1,Collector())
                    # Complete native retirement without Python reconciliation;
                    # alias validation must close that ownership gap itself.
                    with camera.acquire() as frame,recorder._lock:
                        recorder._checked(recorder._lib.zc_video_write(recorder._handle,C.byref(frame._native),40_000_000))
                        recorder._checked(recorder._lib.zc_video_drain_output_io(recorder._handle,1))
                    recorder.output_status(1);os.link(path,alias);before=path.read_bytes()
                    with self.assertRaisesRegex(ValueError,'retiring'): recorder.add_output(MuxedOutput(alias,format='mkv'))
                    def retiring(): recorder._sync_split();return entered.is_set()
                    until(retiring)
                    with self.assertRaisesRegex(RuntimeError,'retiring'): recorder.remove_output(1,wait=False).result(5)
                    with self.assertRaisesRegex(ValueError,'retiring'): recorder.add_output(MuxedOutput(alias,format='mkv'))
                    with self.assertRaisesRegex(ValueError,'retiring'): recorder.split(alias)
                    with self.assertRaisesRegex(ValueError,'retiring'): recorder.save_buffer(alias)
                    self.assertEqual(path.read_bytes(),before)
                finally: resume.set()
                until(lambda:1 not in recorder._retiring or recorder._retiring[1][0].done())
                recorder._sync_split();recorder.remove_output(1)

    def test_retirement_thread_start_failure_still_releases_the_output_claim(self):
        first=Collector();second=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(first,width=32,height=32,async_io={},failure_policy='isolate') as recorder:
                write(camera,recorder,0);recorder.split(second)
                # Hold the recorder lock and wait natively to make retirement
                # deterministic without starting a Python wait worker.
                with camera.acquire() as frame,recorder._lock:
                    recorder._checked(recorder._lib.zc_video_write(recorder._handle,C.byref(frame._native),40_000_000))
                    recorder._checked(recorder._lib.zc_video_drain_output_io(recorder._handle,0))
                    with patch.object(threading.Thread,'start',side_effect=RuntimeError('stop spawn failed')): recorder._sync_split()
                recorder._sync_split()
                self.assertEqual(first.lifecycle.count('stop'),1);self.assertFalse(first.recording)
                with Recorder(first,width=32,height=32): pass

    def test_queued_drain_cancellation_releases_ticket_without_cancelling_io(self):
        sink=Slow()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(sink,width=32,height=32,async_io={}) as recorder:
                try:
                    write(camera,recorder,0);self.assertTrue(sink.entered.wait(5))
                    with patch.object(threading.Thread,'start',lambda thread:None): job=recorder.drain_output_io(wait=False)
                    self.assertTrue(job.cancel());self.assertTrue(job.cancelled())
                    with self.assertRaises(CancelledError): job.result()
                    job.thread.run()  # Cancelled work never dereferences the released ticket.
                    sink.resume.set();recorder.drain_output_io();self.assertEqual(len(sink.events),1)
                finally: sink.resume.set()

    def test_thread_start_failure_releases_drain_and_allows_close_retry(self):
        recorder=Recorder(Collector(),width=32,height=32,async_io={})
        try:
            with patch.object(threading.Thread,'start',side_effect=RuntimeError('no thread')):
                draining=recorder.drain_output_io(wait=False);closing=recorder.close(wait=False)
            for job in (draining,closing):
                with self.assertRaisesRegex(RuntimeError,'no thread'): job.result()
            self.assertIsNone(recorder._close_job)
            recorder.close(wait=False).result(5)
        finally: recorder.close()

    def test_camera_close_waits_for_prior_async_stop_and_prevents_unbounded_restarts(self):
        slow=HookGate();camera=Camera(simulate=True,width=32,height=32);camera.start()
        camera.start_recording(slow,async_io={});closing=camera.stop_recording(wait=False)
        try:
            self.assertTrue(slow.entered.wait(5));self.assertFalse(closing.cancel())
            with self.assertRaisesRegex(RuntimeError,'closing'): camera.start_recording(Collector())
            finished=threading.Event()
            def close_camera(): camera.close();finished.set()
            thread=threading.Thread(target=close_camera);thread.start()
            self.assertFalse(finished.wait(.02));slow.resume.set();thread.join(5)
            self.assertTrue(finished.is_set());closing.result(5)
        finally: slow.resume.set();camera.close()

    def test_async_recovery_uses_fresh_object_and_replays_metadata(self):
        failure=OSError('sink failed')
        class Failed(Collector):
            def outputframe(self,*args,**kwargs): raise failure
        bad=Failed();fresh=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([Collector(),bad],width=32,height=32,failure_policy='isolate') as recorder:
                write(camera,recorder,0)
                recorder.recover_output(1,fresh,wait=False).result(5)
                write(camera,recorder,1)
                self.assertEqual(fresh.lifecycle,['start','mjpeg']);self.assertEqual(len(fresh.events),1)
                recorder.remove_output(1,wait=False).result(5);self.assertEqual(fresh.lifecycle.count('stop'),1)

    def test_drain_prefix_completes_while_a_later_packet_is_still_blocked(self):
        sink=TwoPackets()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(sink,width=32,height=32,async_io={}) as recorder:
                try:
                    write(camera,recorder,0);self.assertTrue(sink.entered[0].wait(5))
                    job=recorder.drain_output_io(wait=False)
                    write(camera,recorder,1)
                    with self.assertRaises(TimeoutError): job.result(.01)
                    self.assertFalse(job.cancel())
                    sink.resume[0].set();self.assertTrue(sink.entered[1].wait(5))
                    self.assertIsNone(job.result(5));self.assertFalse(sink.resume[1].is_set())
                    self.assertEqual(recorder.output_io_stats()['queued_ops'],1)
                finally:
                    for event in sink.resume: event.set()

    def test_native_job_retains_its_prefix_after_recorder_and_worker_are_destroyed(self):
        sink=Slow()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();recorder=Recorder(sink,width=32,height=32,async_io={});lib=recorder._lib
            native=C.c_void_p()
            try:
                write(camera,recorder,0);self.assertTrue(sink.entered.wait(5))
                self.assertEqual(lib.zc_video_drain_output_async(recorder._handle,0,C.byref(native)),0)
                self.assertEqual(lib.zc_output_job_wait(native,0),-3)
                closing=recorder.close(wait=False)
                with self.assertRaises(TimeoutError): closing.result(.01)
                with self.assertRaisesRegex(RuntimeError,'closing'): write(camera,recorder,1)
                sink.resume.set();closing.result(5)
                self.assertEqual(lib.zc_output_job_wait(native,0),0)
                self.assertEqual(sink.lifecycle.count('stop'),1)
            finally:
                sink.resume.set();recorder.close();lib.zc_output_job_close(native)

    def test_python_drain_and_close_jobs_can_overlap_without_losing_callbacks(self):
        sink=Slow()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();recorder=Recorder(sink,width=32,height=32,async_io={})
            try:
                write(camera,recorder,0);self.assertTrue(sink.entered.wait(5))
                drain=recorder.drain_output_io(wait=False);closing=recorder.close(wait=False)
                self.assertIs(recorder.close(wait=False),closing)
                self.assertTrue(sink.recording);self.assertFalse(closing.done())
                sink.resume.set();drain.result(5);closing.result(5)
                self.assertFalse(sink.recording);self.assertEqual(len(sink.events),1)
            finally: sink.resume.set();recorder.close()

    def test_async_start_and_stream_hooks_do_not_block_existing_capture(self):
        for hook in ('start','metadata'):
            with self.subTest(hook=hook),Camera(simulate=True,width=32,height=32) as camera:
                first=Collector();slow=HookGate(hook);camera.start();recording=camera.start_recording(first,async_io={})
                try:
                    job=recording.add_output(slow,wait=False)
                    self.assertTrue(slow.entered.wait(5));before=recording.frames
                    wait_frames(recording,before+5);self.assertFalse(job.done())
                    self.assertNotEqual(slow.hook_thread,threading.get_ident())
                    slow.resume.set();identity=job.result(5)
                    wait_frames(recording,recording.frames+5)
                    recording.remove_output(identity,wait=False).result(5)
                    self.assertEqual(slow.lifecycle.count('stop'),1)
                finally: slow.resume.set();camera.stop_recording()

    def test_split_stop_hook_runs_off_capture_and_completion_includes_hook(self):
        old=HookGate();new=Collector();healthy=Collector()
        with Camera(simulate=True,width=32,height=32) as camera:
            camera.start();recording=camera.start_recording([old,healthy],async_io={},failure_policy='isolate')
            try:
                wait_frames(recording,4);job=recording.split(new)
                self.assertTrue(old.entered.wait(5));before=recording.frames
                wait_frames(recording,before+5);self.assertTrue(new.events);self.assertFalse(job.done())
                self.assertFalse(job.cancel())
                with self.assertRaisesRegex(RuntimeError,'retiring|pending'): recording.split(Collector())
                self.assertNotEqual(old.hook_thread,recording.thread.ident)
                old.resume.set();self.assertIs(job.result(5),new)
                self.assertEqual(old.lifecycle.count('stop'),1)
            finally: old.resume.set();camera.stop_recording()

    def test_late_stop_failure_stays_with_split_and_healthy_output_continues(self):
        failure=OSError('retired flush failed');old=HookGate(failure=failure);new=Collector()
        with Camera(simulate=True,width=32,height=32) as camera:
            camera.start();recording=camera.start_recording([old,Collector()],async_io={},failure_policy='isolate')
            try:
                wait_frames(recording,3);job=recording.split(new);self.assertTrue(old.entered.wait(5))
                old.resume.set()
                with self.assertRaises(OSError) as caught: job.result(5)
                self.assertIs(caught.exception,failure);before=recording.frames;wait_frames(recording,before+5)
                self.assertIs(recording.output_errors[0],failure)
            finally: old.resume.set();camera.stop_recording()

    def test_close_waits_for_claimed_preparation_and_cleans_it_before_completion(self):
        slow=HookGate('start');first=Collector();recorder=Recorder(first,width=32,height=32)
        adding=recorder.add_output(slow,wait=False)
        try:
            self.assertTrue(slow.entered.wait(5));closing=recorder.close(wait=False)
            with self.assertRaises(TimeoutError): closing.result(.01)
            slow.resume.set()
            with self.assertRaisesRegex(RuntimeError,'closing'): adding.result(5)
            closing.result(5)
            self.assertEqual(slow.lifecycle.count('stop'),1);self.assertFalse(slow.recording)
            with Recorder(slow,width=32,height=32): pass
        finally: slow.resume.set();recorder.close()

    def test_job_capacity_is_bounded_and_close_has_a_reserved_slot(self):
        recorder=Recorder(Collector(),width=32,height=32);slow=[HookGate('start') for _ in range(16)];jobs=[]
        try:
            for sink in slow:
                jobs.append(recorder.add_output(sink,wait=False));self.assertTrue(sink.entered.wait(5))
            with self.assertRaisesRegex(RuntimeError,'capacity'): recorder.add_output(Collector(),wait=False)
            closing=recorder.close(wait=False);self.assertFalse(closing.done())
            for sink in slow: sink.resume.set()
            for job in jobs:
                with self.assertRaisesRegex(RuntimeError,'closing'): job.result(5)
            closing.result(5)
            self.assertTrue(all(s.lifecycle.count('stop')==1 for s in slow))
        finally:
            for sink in slow: sink.resume.set()
            recorder.close()

    def test_async_stop_error_and_signal_callback_error_are_distinct(self):
        failure=OSError('stop failed');slow=HookGate(failure=failure);recorder=Recorder(slow,width=32,height=32)
        called=threading.Event()
        def signal(job):
            called.set();raise ValueError('signal failed')
        job=recorder.close(signal_function=signal)
        try:
            self.assertTrue(slow.entered.wait(5));slow.resume.set()
            with self.assertRaises(OSError) as caught: job.result(5)
            self.assertIs(caught.exception,failure);self.assertTrue(called.wait(5))
            until(lambda:job.callback_error is not None);self.assertIsInstance(job.callback_error,ValueError)
            self.assertEqual(slow.lifecycle.count('stop'),1)
        finally: slow.resume.set()

    def test_lifecycle_reentry_is_rejected_before_any_lock_or_job_wait(self):
        class Reentrant(Collector):
            def stop(s):
                with self.assertRaisesRegex(RuntimeError,'callback'): recorder.close(wait=False)
                super().stop()
        sink=Reentrant();recorder=Recorder(sink,width=32,height=32)
        recorder.close(wait=False).result(5);self.assertEqual(sink.lifecycle.count('stop'),1)

    def test_circular_open_drain_close_and_camera_stop_are_awaitable(self):
        async def run():
            circular=CircularOutput2(buffer_duration_ms=0);first=Collector()
            with Camera(simulate=True,width=32,height=32) as camera:
                camera.start();recording=camera.start_recording(None,circular=circular.config,async_io={});circular._bind(recording)
                await circular.open_output(first,wait=False)
                wait_frames(recording,recording.frames+5)
                await circular.drain_output_io(wait=False)
                await circular.close_output(wait=False)
                self.assertEqual(first.lifecycle.count('stop'),1)
                await camera.stop_recording(wait=False)
                self.assertTrue(recording.closed)
        asyncio.run(run())

if __name__=='__main__': unittest.main()
