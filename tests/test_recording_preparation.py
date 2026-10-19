"""Startup/split preparation owns resources off capture until publication."""
import asyncio
import ctypes as C
import io
import os
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import CancelledError
from unittest.mock import patch
from zigcamera import Camera,Recorder,Picamera2,MJPEGEncoder,CircularOutput2,MuxedOutput,FileOutput,CameraError
from test_direct_outputs import Collector,write
from test_output_jobs import HookGate
from test_async_output_io import until
from test_modes_recording import wait_frames

class HeaderGate(MuxedOutput):
    def __init__(self,target=None,*,failure=None):
        super().__init__(io.BytesIO() if target is None else target,format='mkv')
        self.entered=threading.Event();self.resume=threading.Event();self.failure=failure;self.first=True
    def _write(self,data):
        if self.first:
            self.first=False;self.entered.set()
            if not self.resume.wait(10): raise RuntimeError('header gate timed out')
            if self.failure is not None: raise self.failure
        super()._write(data)

class PreparationTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('ZC_TEST_AAC')=='1','optional Home AVC/HEVC and AAC')
    def test_async_startup_and_split_mp4_segments_decode_with_exact_av_boundaries(self):
        from test_aac_mp4 import inspect
        from check_aac_mp4 import parse
        from zigcamera.pipeline import Recording
        original=Recording.write
        for codec in ('h264','hevc'):
            with self.subTest(codec=codec),tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                root=Path(directory);first=root/'first.mp4';second=root/'second.mp4'
                accepted=[]
                def trace(recording,frame):
                    result=original(recording,frame);accepted.append(int(frame._native.sequence));return result
                # Capture can discard a frame before encoder input while a
                # public lock is busy. Validate decoded pixels against accepted
                # input sequences rather than assuming the camera never skips.
                with patch.object(Recording,'write',trace):
                    starting=camera.start_recording(MuxedOutput(first),codec=codec,fps=25,gop=4,
                        audio={'backend':'synthetic','sample_rate':48000,'channels':2,'codec':'aac'},
                        async_io={'max_ops':65536,'max_bytes':16*1024*1024},wait=False)
                    recording=starting.result(10)
                    wait_frames(recording,8);replacement=MuxedOutput(second)
                    self.assertIs(recording.split(replacement).result(10),replacement)
                    wait_frames(recording,recording.frames+6);camera.stop_recording(wait=False).result(10)
                old_count=len(parse(first)[1]['samples']);new_count=len(parse(second)[1]['samples'])
                self.assertGreater(old_count,0);self.assertGreater(new_count,0)
                self.assertEqual(old_count+new_count,recording.frames)
                self.assertEqual(len(accepted),recording.frames)
                inspect(self,first,count=old_count,samples=old_count*1920,rate=48000,channels=2,sequences=accepted[:old_count])
                inspect(self,second,count=new_count,first=old_count,samples=new_count*1920,
                    start_sample=old_count*1920,rate=48000,channels=2,sequences=accepted[old_count:])

    def test_standalone_cancellation_wins_between_readiness_and_publication(self):
        from zigcamera.split_preparation import SplitPreparation
        entered=threading.Event();resume=threading.Event();original=SplitPreparation.stage
        def delayed(preparation,job):
            entered.set()
            if not resume.wait(5): raise RuntimeError('publication release timed out')
            return original(preparation,job)
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();first=Collector();replacement=Collector()
            with Recorder(first,width=32,height=32) as recorder:
                write(camera,recorder,0)
                try:
                    with patch.object(SplitPreparation,'stage',delayed):
                        job=recorder.split(replacement,wait=False)
                        self.assertTrue(entered.wait(5));self.assertTrue(job.cancel());resume.set()
                        with self.assertRaises(CancelledError): job.result(5)
                    self.assertFalse(recorder.buffer_stats['split_pending']);self.assertFalse(replacement.recording)
                    self.assertFalse(recorder._split_preparations)
                    write(camera,recorder,1);self.assertEqual(len(first.events),2)
                    self.assertEqual(recorder.output_status()['generation'],0)
                finally:
                    resume.set()
                    if recorder.buffer_stats['split_pending']: recorder.cancel_split()

    def test_recorder_close_cancels_preparation_waiting_on_camera_publication_lock(self):
        from zigcamera.pipeline import Recording
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();recorder=Recorder(Collector(),width=32,height=32)
            recording=Recording(camera,recorder,25)
            with camera._async_lock:
                job=recording.split(Collector())
                def ready():
                    with job.lock: return job.native.phase==2
                until(ready)
                closing=recorder.close(wait=False);closing.result(5)
            with self.assertRaises(CancelledError): job.result(5)
            self.assertFalse(recorder._handle.value);self.assertFalse(recorder._split_preparations)
            recording.close()

    def test_queued_split_cancel_and_spawn_failure_release_reservations(self):
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording(Collector());wait_frames(recording,3);sink=Collector()
            with patch.object(threading.Thread,'start',lambda thread:None): job=recording.split(sink)
            self.assertTrue(job.cancel());job.thread.run()
            with self.assertRaises(CancelledError): job.result(5)
            self.assertFalse(sink.lifecycle);self.assertFalse(recording.recorder._split_preparations)
            with patch.object(threading.Thread,'start',side_effect=RuntimeError('split spawn failed')): job=recording.split(sink)
            with self.assertRaisesRegex(RuntimeError,'spawn failed'): job.result(5)
            self.assertFalse(sink.lifecycle);self.assertFalse(recording.recorder._split_preparations)
            self.assertIs(recording.split(sink).result(5),sink);camera.stop_recording()

    def test_startup_admission_uses_bounded_camera_slots(self):
        with Camera(simulate=True,width=32,height=32) as camera:
            for _ in range(32): self.assertTrue(camera._job_slots.acquire(False))
            sink=Collector()
            try:
                with self.assertRaisesRegex(RuntimeError,'capacity'): camera.start_recording(sink,wait=False)
                self.assertFalse(sink.lifecycle)
            finally:
                for _ in range(32): camera._job_slots.release()
            camera.start_recording(sink);camera.stop_recording()

    def test_startup_signal_errors_are_separate_and_finished_job_drops_operation(self):
        callback_done=threading.Event()
        def signal(job):
            self.assertIsNotNone(job.result());callback_done.set();raise ValueError('signal failed')
        with Camera(simulate=True,width=32,height=32) as camera:
            job=camera.start_recording(Collector(),signal_function=signal)
            recording=job.result(5);self.assertTrue(callback_done.wait(5));until(lambda:job.callback_error is not None)
            self.assertIsInstance(job.callback_error,ValueError);self.assertIsNone(job.operation)
            wait_frames(recording,3);camera.stop_recording()

    def test_preparation_failure_preserves_original_when_cleanup_also_fails(self):
        failure=OSError('original header failure')
        class DoubleFailure(HeaderGate):
            def stop(self): super().stop();raise ValueError('cleanup failed')
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording(Collector());sink=DoubleFailure(failure=failure);sink.resume.set()
            job=recording.split(sink)
            with self.assertRaises(OSError) as caught: job.result(5)
            self.assertIs(caught.exception,failure);self.assertIsInstance(job.cleanup_error,ValueError)
            self.assertFalse(sink.recording);self.assertFalse(recording.recorder._split_preparations)
            camera.stop_recording()

    def test_source_failure_during_preparation_is_reported_after_owned_cleanup(self):
        failure=OSError('capture output failed')
        class Failing(Collector):
            fail=False
            def outputframe(self,*args,**kwargs):
                if self.fail: raise failure
                super().outputframe(*args,**kwargs)
        first=Failing();pending=HeaderGate()
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording(first);wait_frames(recording,3);job=recording.split(pending)
            try:
                self.assertTrue(pending.entered.wait(5));first.fail=True
                until(lambda:recording.error is not None);self.assertFalse(job.done())
                pending.resume.set()
                with self.assertRaises(OSError) as caught: job.result(5)
                self.assertIs(caught.exception,failure);self.assertFalse(pending.recording)
            finally:
                pending.resume.set()
                with self.assertRaises(OSError): camera.stop_recording()

    def test_startup_hooks_run_off_caller_and_capture_remains_available(self):
        for hook in ('start','metadata'):
            with self.subTest(hook=hook),Camera(simulate=True,width=32,height=32) as camera:
                camera.start();sink=HookGate(hook)
                job=camera.start_recording(sink,wait=False,async_io={'max_ops':65536,'max_bytes':16*1024*1024})
                try:
                    self.assertTrue(sink.entered.wait(5));self.assertIsNone(camera._recording)
                    self.assertNotEqual(sink.hook_thread,threading.get_ident())
                    for _ in range(3): self.assertGreaterEqual(camera.capture_metadata()['sequence'],0)
                    self.assertFalse(job.done())
                    with self.assertRaisesRegex(RuntimeError,'startup'): camera.start_recording(Collector(),wait=False)
                    sink.resume.set();recording=job.result(5);wait_frames(recording,4)
                    self.assertIs(camera._recording,recording);self.assertFalse(job.cancel())
                finally: sink.resume.set();camera.stop_recording()

    def test_cancelled_claimed_startup_releases_claim_only_after_hook_cleanup(self):
        sink=HookGate('start')
        with Camera(simulate=True,width=32,height=32) as camera:
            camera.start();job=camera.start_recording(sink,wait=False)
            try:
                self.assertTrue(sink.entered.wait(5));self.assertTrue(job.cancel());self.assertFalse(job.cancel())
                self.assertTrue(sink.recording);self.assertFalse(job.done())
                stopping=camera.stop_recording(wait=False)
                with self.assertRaises(TimeoutError): stopping.result(.01)
                with self.assertRaisesRegex(RuntimeError,'attached'): Recorder(sink,width=32,height=32)
                sink.resume.set()
                with self.assertRaises(CancelledError): job.result(5)
                stopping.result(5);self.assertIsNone(camera._recording)
                self.assertEqual(sink.lifecycle.count('stop'),1)
                next_recording=camera.start_recording(sink);wait_frames(next_recording,3);camera.stop_recording()
            finally: sink.resume.set();camera.stop_recording()

    def test_startup_header_and_audio_initialization_are_owned_by_job(self):
        sink=HeaderGate()
        with Camera(simulate=True,width=32,height=32) as camera:
            job=camera.start_recording(sink,audio={'backend':'synthetic','sample_rate':8000},wait=False)
            try:
                self.assertTrue(sink.entered.wait(5));self.assertIsNone(camera._recording)
                camera.capture_metadata();sink.resume.set();recording=job.result(5)
                wait_frames(recording,5);camera.stop_recording(wait=False).result(5)
                self.assertGreater(recording.recorder._final_states[0]['generation']+len(sink.fileoutput.getvalue()),0)
            finally: sink.resume.set();camera.stop_recording()

    def test_group_startup_failure_cleans_audio_and_all_started_outputs(self):
        failure=OSError('startup metadata failed');first=Collector();bad=HookGate('metadata',failure=failure);bad.resume.set()
        with Camera(simulate=True,width=32,height=32) as camera:
            job=camera.start_recording([first,bad],audio={'backend':'synthetic','sample_rate':8000},wait=False)
            with self.assertRaises(OSError) as caught: job.result(5)
            self.assertIs(caught.exception,failure);self.assertIsNone(camera._recording)
            self.assertEqual(first.lifecycle.count('stop'),1);self.assertEqual(bad.lifecycle.count('stop'),1)
            camera.start_recording(first);camera.stop_recording()

    def test_queued_startup_cancel_and_spawn_failure_never_claim_outputs(self):
        with Camera(simulate=True,width=32,height=32) as camera:
            sink=Collector()
            with patch.object(threading.Thread,'start',lambda thread:None): job=camera.start_recording(sink,wait=False)
            self.assertTrue(job.cancel());job.thread.run()
            with self.assertRaises(CancelledError): job.result()
            self.assertFalse(sink.lifecycle)
            with patch.object(threading.Thread,'start',side_effect=RuntimeError('startup spawn failed')): job=camera.start_recording(sink,wait=False)
            with self.assertRaisesRegex(RuntimeError,'spawn failed'): job.result()
            self.assertFalse(sink.lifecycle)
            camera.start_recording(sink);camera.stop_recording()

    def test_camera_close_waits_for_startup_cleanup_and_never_publishes_after_stop(self):
        camera=Camera(simulate=True,width=32,height=32);slow=HookGate('start')
        job=camera.start_recording(slow,wait=False);finished=threading.Event();errors=[]
        try:
            self.assertTrue(slow.entered.wait(5))
            def close():
                try: camera.close()
                except Exception as error: errors.append(error)
                finally: finished.set()
            thread=threading.Thread(target=close);thread.start()
            self.assertFalse(finished.wait(.02));self.assertTrue(camera._handle.value)
            slow.resume.set();thread.join(5);self.assertTrue(finished.is_set());self.assertFalse(errors)
            with self.assertRaises(CancelledError): job.result(5)
            self.assertIsNone(camera._recording);self.assertFalse(camera._handle.value)
        finally: slow.resume.set();camera.close()

    def test_startup_stop_while_owner_holds_publication_lock_does_not_deadlock(self):
        with Camera(simulate=True,width=32,height=32) as camera:
            with camera._async_lock:
                job=camera.start_recording(Collector(),wait=False)
                camera.stop_recording()
            with self.assertRaises(CancelledError): job.result(5)

    def test_async_facade_start_and_circular_binding_are_awaitable(self):
        async def run():
            with Picamera2(simulate=True) as camera:
                camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
                output=CircularOutput2(buffer_duration_ms=0)
                recording=await camera.start_recording(MJPEGEncoder(),output,wait=False,async_io={'max_ops':65536,'max_bytes':16*1024*1024})
                self.assertIs(output._recording,recording)
                await output.open_output(Collector(),wait=False);wait_frames(recording,3)
                await camera.stop_recording(wait=False)
                camera.start_recording(MJPEGEncoder(),Collector());camera.stop_recording()
        asyncio.run(run())

    def test_mode_switch_is_rejected_during_startup_without_interrupting_it(self):
        slow=HookGate('metadata')
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            job=camera.start_recording(MJPEGEncoder(),slow,wait=False)
            try:
                self.assertTrue(slow.entered.wait(5))
                with self.assertRaisesRegex(RuntimeError,'recording'): camera.switch_mode('preview')
                slow.resume.set();recording=job.result(5);wait_frames(recording,3)
            finally: slow.resume.set();camera.stop_recording()

    def test_split_start_metadata_and_headers_do_not_block_current_output(self):
        for sink in (HookGate('start'),HookGate('metadata'),HeaderGate()):
            with self.subTest(sink=type(sink).__name__),Camera(simulate=True,width=32,height=32) as camera:
                first=Collector();recording=camera.start_recording(first,async_io={'max_ops':65536,'max_bytes':16*1024*1024})
                try:
                    wait_frames(recording,3);job=recording.split(sink)
                    self.assertTrue(sink.entered.wait(5));before=recording.frames
                    wait_frames(recording,before+5);self.assertFalse(job.done())
                    self.assertEqual(recording.output_status()['generation'],0)
                    sink.resume.set();self.assertIs(job.result(5),sink)
                    self.assertEqual(first.lifecycle.count('stop'),1)
                finally: sink.resume.set();camera.stop_recording()

    def test_split_cancel_during_headers_discards_only_prepared_sink(self):
        pending=HeaderGate()
        with Camera(simulate=True,width=32,height=32) as camera:
            first=Collector();recording=camera.start_recording(first,async_io={'max_ops':65536,'max_bytes':16*1024*1024})
            try:
                wait_frames(recording,3);job=recording.split(pending);self.assertTrue(pending.entered.wait(5))
                self.assertTrue(job.cancel());self.assertFalse(job.done());self.assertFalse(job.cancel())
                with self.assertRaisesRegex(RuntimeError,'preparation'): recording.remove_output(0)
                before=recording.frames;wait_frames(recording,before+5);pending.resume.set()
                with self.assertRaises(CancelledError): job.result(5)
                self.assertEqual(recording.output_status()['generation'],0);self.assertFalse(pending.recording)
                self.assertTrue(first.recording);self.assertFalse(recording.recorder._split_preparations)
            finally: pending.resume.set();camera.stop_recording()

    def test_failed_async_split_preserves_original_error_and_old_recording(self):
        failure=OSError('header preparation failed');pending=HeaderGate(failure=failure);pending.resume.set()
        with Camera(simulate=True,width=32,height=32) as camera:
            first=Collector();recording=camera.start_recording(first)
            job=recording.split(pending)
            with self.assertRaises(OSError) as caught: job.result(5)
            self.assertIs(caught.exception,failure);self.assertTrue(first.recording)
            before=recording.frames;wait_frames(recording,before+5)
            self.assertIsNone(recording.error);self.assertEqual(recording.output_status()['generation'],0)
            camera.stop_recording()

    def test_stop_waits_for_claimed_split_cleanup_without_late_commit(self):
        pending=HeaderGate()
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording(Collector(),async_io={'max_ops':65536,'max_bytes':16*1024*1024});wait_frames(recording,3)
            job=recording.split(pending)
            try:
                self.assertTrue(pending.entered.wait(5));closing=camera.stop_recording(wait=False)
                with self.assertRaises(TimeoutError): closing.result(.01)
                pending.resume.set();closing.result(5)
                with self.assertRaises(CancelledError): job.result(5)
                self.assertFalse(pending.recording);self.assertFalse(recording.recorder._handle.value)
            finally: pending.resume.set();camera.stop_recording()

    def test_eight_concurrent_preparations_are_bounded_and_cancel_independently(self):
        pending=[HeaderGate() for _ in range(8)]
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording([Collector() for _ in range(8)],async_io={'max_ops':65536,'max_bytes':16*1024*1024},failure_policy='isolate');wait_frames(recording,3)
            jobs=[recording.split_output(i,sink) for i,sink in enumerate(pending)]
            try:
                for sink in pending: self.assertTrue(sink.entered.wait(5))
                with self.assertRaisesRegex(RuntimeError,'pending'): recording.split_output(1,Collector())
                self.assertTrue(jobs[2].cancel());before=recording.frames;wait_frames(recording,before+5)
                for sink in pending: sink.resume.set()
                for i,job in enumerate(jobs):
                    if i==2:
                        with self.assertRaises(CancelledError): job.result(5)
                    else: self.assertIs(job.result(5),pending[i])
                self.assertEqual(recording.output_status(2)['generation'],0)
                self.assertFalse(recording.recorder._split_preparations)
            finally:
                for sink in pending: sink.resume.set()
                camera.stop_recording()

    def test_prepared_file_reservation_blocks_hardlink_aliases_before_truncation(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32) as camera:
            root=Path(directory);(root/'prepared.mkv').write_bytes(b'keep during alias guard');sink=HeaderGate(root/'prepared.mkv');recording=camera.start_recording(Collector())
            job=recording.split(sink)
            try:
                self.assertTrue(sink.entered.wait(5));os.link(root/'prepared.mkv',root/'alias.mkv')
                before=(root/'prepared.mkv').read_bytes()
                with self.assertRaises((CameraError,ValueError)): recording.add_output(MuxedOutput(root/'alias.mkv'))
                self.assertEqual((root/'prepared.mkv').read_bytes(),before)
                job.cancel();sink.resume.set()
                with self.assertRaises(CancelledError): job.result(5)
            finally: sink.resume.set();camera.stop_recording()

    def test_standalone_async_preparation_can_cancel_claimed_work_and_close_waits(self):
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();pending=HeaderGate();recorder=Recorder(Collector(),width=32,height=32)
            try:
                write(camera,recorder,0);job=recorder.split(pending,wait=False);self.assertTrue(pending.entered.wait(5))
                write(camera,recorder,1);self.assertTrue(job.cancel());closing=recorder.close(wait=False)
                with self.assertRaises(TimeoutError): closing.result(.01)
                pending.resume.set()
                with self.assertRaises(CancelledError): job.result(5)
                closing.result(5);self.assertFalse(pending.recording)
            finally: pending.resume.set();recorder.close()

if __name__=='__main__': unittest.main()
