"""Owned native sink queues, per-output pressure and worker lifetimes."""
import ctypes as C
import io
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from zigcamera import Camera,Recorder,CameraError,FileOutput,MuxedOutput,_OutputIoStats
from zigcamera.output_objects import PtsStream
from test_direct_outputs import Collector,write
from test_modes_recording import wait_frames
from test_audio_rotation import expected
from test_aac_mp4 import inspect
AAC=os.environ.get('ZC_TEST_AAC')=='1'

class Slow(Collector):
    def __init__(self):
        super().__init__();self.entered=threading.Event();self.resume=threading.Event();self.threads=[]
    def outputframe(self,*args,**kwargs):
        self.entered.set()
        if not self.resume.wait(5): raise RuntimeError('test sink release timed out')
        self.threads.append(threading.get_ident());return super().outputframe(*args,**kwargs)

def until(predicate):
    end=time.monotonic()+5
    while not predicate():
        if time.monotonic()>end: raise AssertionError('condition timed out')
        time.sleep(.001)

class AsyncIoTests(unittest.TestCase):
    def test_worker_copies_owned_packets_and_healthy_output_keeps_advancing(self):
        slow=Slow();healthy=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([slow,healthy],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_io(0,max_bytes=65536,max_ops=8)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
                    for i in range(1,6): write(camera,recorder,i)
                    self.assertEqual(len(healthy.events),6);self.assertFalse(slow.events)
                    stats=recorder.output_io_stats()
                    self.assertEqual(C.sizeof(_OutputIoStats),88)
                    self.assertEqual(stats['queued_ops'],6);self.assertLessEqual(stats['queued_bytes'],65536)
                    self.assertEqual(stats['accepted_ops'],6);self.assertEqual(stats['completed_ops'],0)
                finally: slow.resume.set()
                recorder.drain_output_io()
                self.assertEqual([e[0] for e in slow.events],[e[0] for e in healthy.events])
                self.assertTrue(all(t!=threading.get_ident() for t in slow.threads))
                stats=recorder.output_io_stats();self.assertEqual(stats['queued_bytes'],0);self.assertEqual(stats['completed_ops'],6)
            self.assertEqual(slow.lifecycle.count('stop'),1)

    def test_inflight_capacity_quarantines_only_full_sink_and_recovery_waits(self):
        slow=Slow();healthy=Collector();fresh=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,slow],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_io(1,max_bytes=32768,max_ops=1)
                recorder.set_output_recovery(1,lambda attempt,error:fresh,retry_delay_ms=0)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
                    for i in range(1,8): write(camera,recorder,i)
                    self.assertEqual(len(healthy.events),8)
                    self.assertEqual(recorder.output_status(1)['error_code'],-4)
                    stats=recorder.output_io_stats(1)
                    self.assertEqual(stats['high_ops'],1);self.assertEqual(stats['rejected_ops'],1)
                    self.assertEqual(recorder.recovery_status(1)['attempts'],0)
                    self.assertTrue(slow.recording)
                finally: slow.resume.set()
                with self.assertRaises(CameraError): recorder.drain_output_io(1)
                write(camera,recorder,8);write(camera,recorder,9);recorder.drain_output_io(1)
                self.assertEqual(recorder.output_status(1)['generation'],1)
                self.assertEqual(len(fresh.events),1);self.assertFalse(slow.recording)
                self.assertEqual(recorder.output_io_stats(1)['max_ops'],1)

    def test_oversized_operation_never_calls_the_sink(self):
        healthy=Collector();small=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,small],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_io(1,max_bytes=1,max_ops=4);write(camera,recorder,0)
                self.assertFalse(small.events);self.assertEqual(len(healthy.events),1)
                self.assertEqual(recorder.output_io_stats(1)['rejected_ops'],1)
                self.assertEqual(recorder.output_status(1)['error_code'],-1)

    def test_wait_backpressure_timeout_is_bounded_and_local(self):
        slow=Slow();healthy=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,slow],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_io(1,max_ops=1,backpressure='wait',timeout_ms=30)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
                    begin=time.monotonic();write(camera,recorder,1);elapsed=time.monotonic()-begin
                    self.assertGreaterEqual(elapsed,.015);self.assertLess(elapsed,1)
                    self.assertEqual(len(healthy.events),2);self.assertEqual(recorder.output_io_stats(1)['rejected_ops'],1)
                finally: slow.resume.set()

    def test_wait_backpressure_resumes_when_inflight_operation_finishes(self):
        slow=Slow()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(slow,width=32,height=32,fps=25) as recorder:
                recorder.set_output_io(max_ops=1,backpressure='wait',timeout_ms=2000)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
                    timer=threading.Timer(.03,slow.resume.set);timer.start()
                    write(camera,recorder,1);timer.join();recorder.drain_output_io()
                    self.assertEqual(len(slow.events),2);self.assertEqual(recorder.output_io_stats()['rejected_ops'],0)
                finally: slow.resume.set()

    def test_async_split_commits_without_waiting_for_old_worker(self):
        slow=Slow();healthy=Collector();new=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([slow,healthy],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_io(max_bytes=65536,max_ops=16)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
                    recorder.split(new)
                    for i in range(1,5): write(camera,recorder,i)
                    state=recorder.output_status();self.assertEqual(state['generation'],1);self.assertTrue(state['pending'])
                    self.assertEqual(len(healthy.events),5);self.assertFalse(new.events)
                    self.assertTrue(slow.recording);self.assertTrue(new.recording)
                    with self.assertRaises(RuntimeError): recorder.split(Collector())
                finally: slow.resume.set()
                recorder.drain_output_io()
                self.assertFalse(recorder.output_status()['pending']);self.assertFalse(slow.recording)
                self.assertEqual(len(slow.events),1);self.assertEqual(len(new.events),4)
                self.assertIsNone(recorder._split_results[0]);self.assertEqual(new.events[0][1]['timestamp'],0)

    def test_late_retired_worker_error_fails_split_and_keeps_new_sink_healthy(self):
        class Failing(Slow):
            def outputframe(self,*args,**kwargs): super().outputframe(*args,**kwargs);raise OSError('retired sink failed')
        slow=Failing();healthy=Collector();new=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,slow],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_io(1,max_ops=16)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5));recorder.split_output(1,new)
                    for i in range(1,5): write(camera,recorder,i)
                    self.assertEqual(len(healthy.events),5);self.assertTrue(recorder.output_status(1)['pending'])
                finally: slow.resume.set()
                with self.assertRaisesRegex(OSError,'retired'): recorder.drain_output_io(1)
                self.assertIsInstance(recorder._split_results[1],OSError)
                self.assertEqual(recorder.output_status(1)['error_code'],0)
                self.assertEqual(recorder.output_io_stats(1)['split_error'],-6)
                self.assertFalse(slow.recording)
                write(camera,recorder,5);recorder.drain_output_io(1)
                self.assertEqual(len(new.events),5);self.assertEqual(len(healthy.events),6)

    def test_pending_cancellation_does_not_wait_for_active_predecessor(self):
        slow=Slow();pending=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(slow,width=32,height=32,fps=25) as recorder:
                recorder.set_output_io(max_ops=8)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
                    recorder.split(pending);recorder.cancel_split()
                    self.assertFalse(pending.recording);self.assertTrue(slow.recording)
                finally: slow.resume.set()
                recorder.drain_output_io();self.assertEqual(len(slow.events),1)

    def test_callback_reentry_is_rejected_before_waiting_for_producer_locks(self):
        failures=[]
        class Reentry(Collector):
            def outputframe(self,*args,**kwargs):
                for operation in (lambda:recorder.output_stats(),lambda:recorder.close(),lambda:camera.stop()):
                    try: operation()
                    except RuntimeError as error: failures.append(str(error))
                return super().outputframe(*args,**kwargs)
        sink=Reentry()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(sink,width=32,height=32,fps=25) as recorder:
                recorder.set_output_io();write(camera,recorder,0);recorder.drain_output_io()
                self.assertEqual(len(failures),3);self.assertTrue(all('re-entry' in f for f in failures))
                self.assertEqual(len(sink.events),1)

    def test_fail_fast_worker_failure_surfaces_original_exception_and_closes_all(self):
        class Failing(Collector):
            def outputframe(self,*args,**kwargs): raise OSError('async failure')
        sink=Failing();healthy=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();recorder=Recorder([healthy,sink],width=32,height=32,fps=25)
            recorder.set_output_io(1);write(camera,recorder,0)
            until(lambda:recorder.output_io_stats(1)['error_code']!=0)
            with self.assertRaisesRegex(OSError,'async failure'): write(camera,recorder,1)
            with self.assertRaises(CameraError): recorder.close()
            self.assertFalse(sink.recording);self.assertFalse(healthy.recording)
            self.assertEqual(len(healthy.events),1)

    def test_close_waits_for_inflight_callbacks_before_releasing_contexts(self):
        slow=Slow();errors=[];done=threading.Event()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();recorder=Recorder(slow,width=32,height=32,fps=25);recorder.set_output_io()
            write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
            def close():
                try: recorder.close()
                except Exception as error: errors.append(error)
                finally: done.set()
            closer=threading.Thread(target=close);closer.start()
            try:
                self.assertFalse(done.wait(.03));self.assertTrue(slow.recording)
            finally: slow.resume.set()
            closer.join(5);self.assertFalse(closer.is_alive());self.assertFalse(errors)
            self.assertFalse(slow.recording);self.assertEqual(len(slow.events),1)

    def test_shared_circular_pts_epoch_order_survives_overlapping_workers(self):
        class SlowFile(FileOutput):
            def outputframe(self,*args,**kwargs):
                entered.set()
                if not resume.wait(5): raise RuntimeError('test release timed out')
                return super().outputframe(*args,**kwargs)
        entered=threading.Event();resume=threading.Event();first=io.BytesIO();second=io.BytesIO()
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();pts=PtsStream(Path(directory)/'observer.pts')
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':0},failure_policy='isolate') as recorder:
                old=SlowFile(first);new=FileOutput(second);recorder.open_output(old,_pts=pts);recorder.set_output_io(max_ops=16)
                descriptor=pts.stream.fileno()
                try:
                    write(camera,recorder,0);self.assertTrue(entered.wait(5));recorder.split(new)
                    for i in range(1,5): write(camera,recorder,i)
                    self.assertEqual(pts.stream.fileno(),descriptor);self.assertFalse(second.getvalue())
                finally: resume.set()
                recorder.drain_output_io();self.assertEqual(pts.stream.fileno(),descriptor)
            self.assertFalse(first.closed);self.assertFalse(second.closed);self.assertIsNone(pts.stream)
            self.assertEqual((Path(directory)/'observer.pts').read_text().splitlines(),['0.000','0.000','40.000','80.000','120.000'])

    def test_eight_workers_keep_one_full_sink_isolated(self):
        slow=Slow();others=[Collector() for _ in range(7)]
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([slow,*others],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                for identity in range(8): recorder.set_output_io(identity,max_bytes=32768,max_ops=1 if identity==0 else 8)
                try:
                    write(camera,recorder,0);self.assertTrue(slow.entered.wait(5))
                    for i in range(1,5): write(camera,recorder,i)
                    for identity in range(1,8): recorder.drain_output_io(identity)
                    self.assertEqual([len(s.events) for s in others],[5]*7)
                    self.assertEqual(recorder.output_status()['error_code'],-4)
                finally: slow.resume.set()

    def test_background_async_split_job_waits_for_retirement_and_cannot_cancel_commit(self):
        slow=Slow();healthy=Collector();new=Collector()
        with Camera(simulate=True,width=32,height=32) as camera:
            with camera._async_lock:
                recording=camera.start_recording([healthy,slow],fps=25,failure_policy='isolate')
                recording.set_output_io(1,max_ops=65536,max_bytes=8*1024*1024)
            try:
                self.assertTrue(slow.entered.wait(5));wait_frames(recording,3)
                job=recording.split_output(1,new)
                until(lambda:recording.output_status(1)['generation']==1)
                self.assertFalse(job.done());self.assertFalse(job.cancel())
                begin=recording.frames;wait_frames(recording,begin+4);self.assertIsNone(recording.error)
            finally: slow.resume.set()
            self.assertIs(job.result(5),new);camera.stop_recording()
            self.assertFalse(slow.recording);self.assertFalse(new.recording)

    def test_validation_and_serialized_midstream_configuration(self):
        with Recorder(Collector(),width=32,height=32) as recorder:
            for options in ({'max_bytes':0},{'max_ops':0},{'backpressure':'drop'},{'timeout_ms':0}):
                with self.assertRaises(ValueError): recorder.set_output_io(**options)
            recorder.set_output_io()
            with self.assertRaises(CameraError): recorder.set_output_io()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(Collector(),width=32,height=32,fps=25) as recorder:
                write(camera,recorder,0)
                recorder.set_output_io();write(camera,recorder,1);recorder.drain_output_io()
                self.assertEqual(recorder.output_stats()["frames"],2)

    @unittest.skipUnless(AAC,'AAC build required')
    def test_async_mp4_writes_patches_splits_delays_and_aac_decode_independently(self):
        for codec in ('h264','hevc'):
            with self.subTest(codec=codec),tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                camera.start();root=Path(directory);paths=[root/name for name in ('live.mp4','first.mp4','second.mp4')]
                pts=io.StringIO();outputs=[MuxedOutput(paths[0],pts=pts),paths[1]]
                with Recorder(outputs,width=128,height=96,fps=25,codec=codec,gop=4,audio={'sample_rate':44100,'channels':2,'buffer_frames':44100},failure_policy='isolate') as recorder:
                    for identity in (0,1): recorder.set_output_io(identity,max_bytes=1024*1024,max_ops=4096)
                    recorder.set_output_delay(1,delay_ms=80,max_bytes=131072,max_frames=20)
                    for i in range(20):
                        if i==10: recorder.split_output(1,paths[2])
                        recorder.write_audio(expected(1764,start=i*1764,channels=2),timestamp_ns=i*40_000_000)
                        write(camera,recorder,i)
                    recorder.drain_output_io(1);start=recorder.output_stats(1)['first_ns']//40_000_000
                    self.assertEqual(recorder.output_io_stats(1)['rejected_ops'],0)
                self.assertEqual(pts.getvalue().splitlines(),[f'{i*40}.000' for i in range(20)])
                inspect(self,paths[0],count=20,samples=35280,rate=44100,channels=2)
                inspect(self,paths[1],count=start,samples=start*1764,rate=44100,channels=2)
                inspect(self,paths[2],count=20-start,first=start,samples=(20-start)*1764,start_sample=start*1764,rate=44100,channels=2)

    def test_startup_options_per_output_defaults_and_dynamic_addition(self):
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([Collector(),Collector()],width=32,height=32,fps=25,async_io={1:{'max_ops':32}}) as recorder:
                self.assertEqual(recorder.output_io_stats(0)['max_ops'],0)
                self.assertEqual(recorder.output_io_stats(1)['max_ops'],32)
                identity=recorder.add_output(Collector(),async_io={'max_ops':16})
                for i in range(3): write(camera,recorder,i)
                recorder.drain_output_io(identity);self.assertEqual(recorder.output_stats(identity)['frames'],3)
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':0},async_io={'max_ops':24}) as recorder:
                recorder.open_output(Collector());self.assertEqual(recorder.output_io_stats()['max_ops'],24)
                identity=recorder.add_output(Collector());self.assertEqual(recorder.output_io_stats(identity)['max_ops'],24)
                write(camera,recorder,0)
        first=Collector()
        with self.assertRaises(ValueError): Recorder(first,width=32,height=32,async_io={'max_ops':0})
        self.assertFalse(first.recording)
        from zigcamera import Picamera2,MJPEGEncoder
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            recording=camera.start_recording(MJPEGEncoder(),Collector(),async_io={'max_ops':1024})
            wait_frames(recording,3);self.assertEqual(recording.output_io_stats()['max_ops'],1024);camera.stop_recording()

    def test_split_job_completes_without_a_new_camera_frame(self):
        slow=Slow();new=Collector()
        with Camera(simulate=True,width=32,height=32,buffer_count=4) as camera:
            recording=camera.start_recording(slow,fps=25,failure_policy='isolate',async_io={'max_ops':65536,'max_bytes':16*1024*1024})
            leases=[]
            try:
                self.assertTrue(slow.entered.wait(5));job=recording.split(new)
                until(lambda:recording.output_status()['generation']==1)
                # Hold every camera lease after the key has committed. The pump
                # must poll completed I/O even when acquire times out.
                for _ in range(4): leases.append(camera.acquire(_internal=True))
                with camera._async_lock: frames=recording.frames
                slow.resume.set();self.assertIs(job.result(5),new)
                self.assertEqual(recording.frames,frames)
            finally:
                slow.resume.set()
                for frame in leases: frame.release()
                camera.stop_recording()

    def test_stop_finishes_already_committed_split_after_worker_drain(self):
        slow=Slow();new=Collector();errors=[]
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording(slow,fps=25,failure_policy='isolate',async_io={'max_ops':65536})
            try:
                self.assertTrue(slow.entered.wait(5));job=recording.split(new)
                until(lambda:recording.output_status()['generation']==1)
                def stop():
                    try: camera.stop_recording()
                    except Exception as error: errors.append(error)
                stopper=threading.Thread(target=stop);stopper.start()
                self.assertFalse(job.done());slow.resume.set();stopper.join(5)
                self.assertFalse(stopper.is_alive());self.assertFalse(errors);self.assertIs(job.result(5),new)
            finally: slow.resume.set();camera.stop_recording()

    def test_queued_pcm_payloads_remain_owned_and_sample_exact(self):
        slow=Slow();healthy=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([slow,healthy],width=32,height=32,fps=25,audio={'sample_rate':8000,'buffer_frames':8000},failure_policy='isolate',async_io={0:{'max_bytes':65536,'max_ops':128}}) as recorder:
                try:
                    for i in range(10):
                        recorder.write_audio(expected(320,start=i*320),timestamp_ns=i*40_000_000)
                        write(camera,recorder,i)
                    self.assertEqual(len([e for e in healthy.events if not e[1]['audio']]),10)
                    self.assertFalse(slow.events)
                finally: slow.resume.set()
                recorder.drain_output_io()
            pcm=b''.join(data for data,event in slow.events if event['audio'])
            self.assertEqual(pcm,expected(3200))
            self.assertEqual(len([e for e in slow.events if not e[1]['audio']]),10)

    def test_retired_media_identity_stays_reserved_until_worker_finishes(self):
        entered=threading.Event();resume=threading.Event()
        class SlowMuxed(MuxedOutput):
            armed=False
            def _write(self,data):
                if self.armed:
                    entered.set()
                    if not resume.wait(5): raise RuntimeError('test release timed out')
                return super()._write(data)
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();root=Path(directory);old=SlowMuxed(root/'old.mkv');new=root/'new.mkv'
            with Recorder([Collector(),old],width=32,height=32,fps=25,failure_policy='isolate',async_io={1:{'max_ops':128}}) as recorder:
                old.armed=True
                try:
                    write(camera,recorder,0);self.assertTrue(entered.wait(5))
                    recorder.split_output(1,new);write(camera,recorder,1)
                    before=(root/'old.mkv').read_bytes()
                    with self.assertRaises(CameraError): recorder.add_output(root/'old.mkv')
                    self.assertEqual((root/'old.mkv').read_bytes(),before);self.assertTrue(old.recording)
                    with self.assertRaises(CameraError): recorder.remove_output(1)
                finally: resume.set()
                recorder.drain_output_io(1);self.assertFalse(old.recording)
                identity=recorder.add_output(root/'old.mkv');write(camera,recorder,2)
                self.assertNotEqual(identity,1)

    def test_rotation_stop_keeps_committed_file_while_old_worker_drains(self):
        from zigcamera import RotatingOutput
        from zigcamera.pipeline import Recording
        entered=threading.Event();resume=threading.Event();done=threading.Event();errors=[]
        class SlowMuxed(MuxedOutput):
            armed=False
            def _write(self,data):
                if self.armed:
                    entered.set()
                    if not resume.wait(5): raise RuntimeError('test release timed out')
                return super()._write(data)
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();root=Path(directory);policy=RotatingOutput(root/'{index}.mkv',duration_ms=40)
            old=SlowMuxed(root/'0.mkv');recorder=Recorder(old,width=32,height=32,fps=25,exclusive=True,failure_policy='isolate',async_io={'max_ops':128})
            recording=Recording(camera,recorder,25,rotation=policy);old.armed=True
            try:
                for i in range(3):
                    with camera.acquire() as frame: recording.write(frame)
                self.assertTrue(entered.wait(5));self.assertEqual(recorder.output_status()['generation'],1)
                self.assertTrue(recorder.output_status()['pending'])
                def close():
                    try: recording.close()
                    except Exception as error: errors.append(error)
                    finally: done.set()
                closer=threading.Thread(target=close);closer.start()
                self.assertFalse(done.wait(.03));resume.set();closer.join(5)
                self.assertFalse(closer.is_alive());self.assertFalse(errors)
                self.assertEqual(recording.current_path,str(root/'1.mkv'))
                self.assertEqual((root/'0.mkv').read_bytes().count(b'\xff\xd8'),2)
                self.assertEqual((root/'1.mkv').read_bytes().count(b'\xff\xd8'),1)
            finally: resume.set();recording.close()
