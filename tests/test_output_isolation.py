"""Per-attachment split commit/cancel and isolated sink faults."""
import asyncio
import ctypes as C
import io
import os
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import CancelledError
from zigcamera import Camera,Recorder,AudioCapture,MuxedOutput,Picamera2,MJPEGEncoder,CameraError,_OutputState,_OutputResult
from zigcamera.audio import AudioFeed
from test_direct_outputs import Collector,write
from test_modes_recording import wait_frames
from test_aac_mp4 import inspect
from test_audio_rotation import expected
AAC=os.environ.get('ZC_TEST_AAC')=='1'

class SplitIsolationTests(unittest.TestCase):
    def test_parallel_extra_splits_keep_ids_and_primary_continuous(self):
        first=Collector();a=Collector();b=Collector();next_a=Collector();next_b=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([first,a,b],width=32,height=32,fps=25) as recorder:
                self.assertEqual((C.sizeof(_OutputState),C.sizeof(_OutputResult)),(24,32))
                for i in range(4): write(camera,recorder,i)
                recorder.split_output(1,next_a);recorder.split_output(2,next_b)
                with self.assertRaises(RuntimeError): recorder.split_output(1,Collector())
                with self.assertRaises(CameraError): recorder.remove_output(1)
                self.assertTrue(recorder.output_status(1)['pending']);recorder.cancel_output_split(2)
                self.assertFalse(next_b.recording);self.assertFalse(next_b.events)
                write(camera,recorder,4)
                self.assertEqual(recorder.output_status(1)['generation'],1);self.assertEqual(recorder.output_status(1)['split_state'],2)
                self.assertEqual(recorder.outputs,(first,next_a,b));self.assertFalse(a.recording)
                self.assertEqual(next_a.events[0][1]['timestamp'],0)
                for i in range(5,9): write(camera,recorder,i)
            self.assertEqual(len(first.events),9);self.assertEqual(len(a.events)+len(next_a.events),9);self.assertEqual(len(b.events),9)

    def test_eight_independent_pending_splits_and_bounded_replacement(self):
        outputs=[Collector() for _ in range(8)];replacements=[Collector() for _ in range(8)]
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(outputs,width=32,height=32,fps=25) as recorder:
                write(camera,recorder,0)
                for i in range(8): recorder.split_output(i,replacements[i])
                with self.assertRaisesRegex(RuntimeError,'capacity'): recorder.add_output(Collector())
                write(camera,recorder,1)
                self.assertTrue(all(recorder.output_status(i)['generation']==1 for i in range(8)))
                self.assertEqual(recorder.outputs,tuple(replacements))
                self.assertTrue(all(not output.recording for output in outputs))
                self.assertTrue(all(len(output.events)==1 for output in replacements))

    def test_async_jobs_per_output_cancellation_await_and_callbacks(self):
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}));original=[Collector() for _ in range(3)]
            recording=camera.start_recording(MJPEGEncoder(),original,fps=25,failure_policy='isolate');wait_frames(recording,4)
            first=Collector();second=Collector();third=Collector();notified=threading.Event()
            with camera._camera._async_lock:
                job_a=camera.split_recording_output(1,first,wait=False,signal_function=lambda job:notified.set())
                job_b=recording.split_output(2,second)
                with self.assertRaises(TimeoutError): job_a.result(.001)
                self.assertTrue(job_b.cancel());self.assertFalse(job_b.cancel())
                with self.assertRaises(CancelledError): job_b.result(1)
                self.assertFalse(second.recording)
                job_c=camera.split_recording_output(2,third,wait=False)
            async def result(): return await job_c
            self.assertIs(asyncio.run(result()),third);self.assertIs(job_a.result(5),first);self.assertTrue(notified.wait(5))
            self.assertFalse(job_a.cancel());self.assertFalse(original[1].recording)
            wait_frames(recording,recording.frames+3);camera.stop_recording();self.assertFalse(third.recording)
            self.assertIsNone(recording.error)

    def test_sink_packet_failure_is_quarantined_without_stopping_healthy_outputs(self):
        class Bad(Collector):
            calls=0
            def outputframe(self,*args,**kwargs): self.calls+=1;raise ValueError('isolated packet failure')
        for position in (0,1):
            with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
                camera.start();bad=Bad();healthy=Collector();outputs=[healthy,healthy];outputs[position]=bad;outputs[1-position]=healthy
                recorder=Recorder(outputs,width=32,height=32,fps=25,failure_policy='isolate')
                for i in range(10): write(camera,recorder,i)
                errors=recorder.output_errors;self.assertIsInstance(errors[position],ValueError);self.assertEqual(bad.calls,1)
                self.assertEqual(len(healthy.events),10);self.assertEqual(recorder.output_status(position)['error_code'],-6)
                recorder.close();self.assertEqual(bad.calls,1);self.assertFalse(bad.recording);self.assertFalse(healthy.recording)
                self.assertIs(recorder.output_errors[position],errors[position]);self.assertEqual(camera.stats['leased'],0)

    def test_new_sink_failure_fails_only_its_async_job_after_commit(self):
        class Bad(Collector):
            def outputframe(self,*args,**kwargs): raise OSError('new sink failure')
        with Camera(simulate=True,width=32,height=32) as camera:
            first=Collector();second=Collector();recording=camera.start_recording([first,second],fps=25,failure_policy='isolate')
            wait_frames(recording,4);bad=Bad();job=recording.split_output(1,bad)
            with self.assertRaisesRegex(OSError,'new sink'): job.result(5)
            self.assertEqual(recording.output_status(1)['generation'],1);self.assertFalse(second.recording)
            start=recording.frames;wait_frames(recording,start+5);self.assertIsNone(recording.error)
            self.assertIsInstance(recording.output_errors[1],OSError)
            recording.remove_output(1);replacement=Collector();identity=recording.add_output(replacement)
            self.assertNotEqual(identity,1);wait_frames(recording,recording.frames+3);camera.stop_recording()
            self.assertTrue(replacement.events);self.assertFalse(bad.recording)

    def test_pending_guards_include_other_pending_sinks_and_snapshots(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);camera.start()
            with Recorder(width=32,height=32,circular={}) as recorder:
                recorder.open_output(Collector());identity=recorder.add_output(Collector());write(camera,recorder,0)
                path=root/'pending.mkv';recorder.split_output(identity,path);before=path.read_bytes()
                with self.assertRaises(CameraError): recorder.split(path)
                with self.assertRaises(CameraError): recorder.add_output(MuxedOutput(path))
                with self.assertRaises(CameraError): recorder.save_buffer(path,wait=False)
                self.assertEqual(path.read_bytes(),before);recorder.cancel_output_split(identity)
                shared=io.BytesIO();recorder.split_output(identity,MuxedOutput(shared,format='mkv'))
                before=shared.getvalue()
                with self.assertRaisesRegex(ValueError,'distinct'): recorder.split(MuxedOutput(shared,format='mkv'))
                self.assertEqual(shared.getvalue(),before);recorder.cancel_output_split(identity)

    def test_pcm_failure_does_not_pin_queue_or_disrupt_other_pcm(self):
        class Bad(Collector):
            calls=0
            def outputframe(self,frame,**kwargs):
                if kwargs['audio']: self.calls+=1;raise ValueError('audio sink failure')
                super().outputframe(frame,**kwargs)
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();bad=Bad();good=Collector()
            with Recorder([bad,good],width=32,height=32,fps=25,audio={'sample_rate':48000,'buffer_frames':3840},failure_policy='isolate') as recorder:
                for i in range(30):
                    recorder.write_audio(expected(1920,start=i*1920),timestamp_ns=i*40_000_000);write(camera,recorder,i)
                self.assertEqual(bad.calls,1);self.assertLessEqual(recorder.stats['audio_queued_frames'],1920)
            self.assertEqual(b''.join(e[0] for e in good.events if e[1]['audio']),expected(30*1920))

    def test_stop_cancels_all_pending_jobs_and_pending_hooks_release_slots(self):
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording([Collector(),Collector(),Collector()],fps=25,failure_policy='isolate');wait_frames(recording,3)
            pending=[Collector() for _ in range(3)]
            with camera._async_lock:
                jobs=[recording.split_output(i,pending[i]) for i in range(3)]
                camera.stop_recording()
            for job in jobs:
                with self.assertRaises(CancelledError): job.result(1)
            self.assertTrue(all(not output.recording for output in pending));self.assertTrue(all(not output.events for output in pending))

    def test_shared_history_overflow_remains_fatal_with_isolation_enabled(self):
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();recorder=Recorder(width=32,height=32,circular={'delay_ms':1000,'max_frames':1},failure_policy='isolate')
            recorder.add_output(Collector());write(camera,recorder,0)
            with self.assertRaises(CameraError): write(camera,recorder,1)
            with self.assertRaises(CameraError): recorder.close()
            self.assertEqual(camera.stats['leased'],0)

    def test_stop_hook_failure_is_reported_by_job_without_poisoning_new_sink(self):
        class BadStop(Collector):
            def stop(self): super().stop();raise ValueError('isolated old stop failure')
        with Camera(simulate=True,width=32,height=32) as camera:
            original=BadStop();replacement=Collector()
            recording=camera.start_recording([Collector(),original],fps=25,failure_policy='isolate');wait_frames(recording,3)
            job=recording.split_output(1,replacement)
            with self.assertRaisesRegex(ValueError,'old stop'): job.result(5)
            self.assertFalse(original.recording);self.assertTrue(replacement.recording)
            self.assertEqual(recording.output_status(1)['error_code'],0)
            self.assertIsInstance(recording.output_errors[1],ValueError);wait_frames(recording,recording.frames+4)
            self.assertIsNone(recording.error);camera.stop_recording()

    def test_cancel_reentry_from_output_callback_is_rejected_before_native_mutation(self):
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();jobs=[]
            class Reentry(Collector):
                def outputframe(self,*args,**kwargs):
                    if jobs: jobs[0].cancel()
                    super().outputframe(*args,**kwargs)
            # Use a stopped worker so the test controls frame delivery under the lock.
            from zigcamera.pipeline import Recording
            recorder=Recorder([Reentry(),Collector()],width=32,height=32,fps=25,failure_policy='isolate')
            recording=Recording(camera,recorder,25)
            write(camera,recorder,0);jobs.append(recording.split_output(1,Collector()))
            # Preparation is now asynchronous; hold manual frame delivery until
            # the replacement is staged, then exercise callback cancellation at
            # exactly the same native handoff as the original regression.
            self.assertTrue(jobs[0].preparation_done.wait(5));self.assertTrue(jobs[0].staged)
            write(camera,recorder,1);recording._complete_splits()
            self.assertIsInstance(recorder.output_errors[0],RuntimeError)
            self.assertIn('re-entry',str(recorder.output_errors[0]));self.assertTrue(jobs[0].done());self.assertFalse(jobs[0].cancel())
            recording.close()

    def test_prepare_failure_and_policy_validation_leave_current_outputs_writable(self):
        class Bad(Collector):
            def _add_stream(self,*args,**kwargs): raise ValueError('isolated metadata failure')
        with self.assertRaises(ValueError): Recorder([],width=32,height=32,failure_policy='invalid')
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();primary=Collector();secondary=Collector()
            with Recorder([primary,secondary],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                write(camera,recorder,0);bad=Bad()
                with self.assertRaisesRegex(ValueError,'metadata'): recorder.split_output(1,bad)
                self.assertFalse(bad.recording);self.assertFalse(recorder.output_status(1)['pending'])
                write(camera,recorder,1);self.assertEqual(len(secondary.events),2);self.assertEqual(recorder.output_errors,{})

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_delayed_parallel_aac_splits_independently_decode(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2) as source:
                camera.start();feed=AudioFeed(source);root=Path(directory);streams=[io.BytesIO() for _ in range(5)];pts=[io.StringIO() for _ in range(5)]
                outputs=[MuxedOutput(streams[i],pts[i],format='mp4') for i in range(5)]
                with Recorder(width=128,height=96,fps=25,codec=codec,gop=100,circular={'delay_ms':120,'max_frames':32},audio={'sample_rate':44100,'channels':2},failure_policy='isolate') as recorder:
                    recorder.open_output(outputs[0]);recorder.add_output(outputs[1]);recorder.add_output(outputs[2])
                    for i in range(20):
                        if i==8: recorder.split_output(1,outputs[3]);recorder.split_output(2,outputs[4])
                        feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
                path=root/'main.mp4';path.write_bytes(streams[0].getvalue());inspect(self,path,count=20,samples=20*1764,rate=44100,channels=2)
                for before,after in ((1,3),(2,4)):
                    start=0
                    for index in (before,after):
                        n=len(pts[index].getvalue().splitlines());path=root/f'{index}.mp4';path.write_bytes(streams[index].getvalue())
                        inspect(self,path,count=n,first=start,samples=n*1764,start_sample=start*1764,rate=44100,channels=2);start+=n
                    self.assertEqual(start,20)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_old_finish_failure_aborts_only_its_split_and_healthy_mp4_decodes(self):
        class BadPatch(MuxedOutput):
            fail=False
            def _patch(self,*args):
                if self.fail: raise OSError('isolated old finish failure')
                return super()._patch(*args)
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2) as source:
            camera.start();feed=AudioFeed(source);healthy=io.BytesIO();bad=BadPatch(io.BytesIO(),format='mp4');pending=Collector()
            recorder=Recorder([MuxedOutput(healthy,format='mp4'),bad],width=128,height=96,fps=25,codec='h264',audio={'sample_rate':44100,'channels':2},failure_policy='isolate')
            for i in range(20):
                if i==7: bad.fail=True;recorder.split_output(1,pending)
                feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
            self.assertFalse(pending.events);self.assertFalse(pending.recording)
            self.assertEqual(recorder.output_status(1)['generation'],0);self.assertEqual(recorder.output_status(1)['split_state'],3)
            self.assertIsInstance(recorder._split_results[1],OSError);self.assertTrue(bad.recording)
            recorder.close();path=Path(directory)/'healthy.mp4';path.write_bytes(healthy.getvalue())
            inspect(self,path,count=20,samples=20*1764,rate=44100,channels=2)
            self.assertIsInstance(recorder.output_errors[1],OSError)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_close_reports_new_finalization_failure_while_other_sink_finishes(self):
        class BadPatch(MuxedOutput):
            def _patch(self,*args): raise OSError('isolated close failure')
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
            camera.start();feed=AudioFeed(source);healthy=io.BytesIO();bad=BadPatch(io.BytesIO(),format='mp4')
            recorder=Recorder([bad,MuxedOutput(healthy,format='mp4')],width=128,height=96,fps=25,codec='h264',audio={'sample_rate':48000},failure_policy='isolate')
            for i in range(8): feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
            recorder.close();self.assertIsInstance(recorder.output_errors[0],OSError)
            self.assertEqual(recorder.output_status(0)['error_code'],-6)
            path=Path(directory)/'healthy.mp4';path.write_bytes(healthy.getvalue());inspect(self,path,count=8,samples=8*1920)

if __name__=='__main__': unittest.main()
