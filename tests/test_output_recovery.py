"""Bounded per-sink delays and fresh-target recovery, using Home media only."""
import ctypes as C
import io
import os
from pathlib import Path
import tempfile
import unittest
from zigcamera import Camera,Recorder,CameraError,MuxedOutput,_OutputDelay,_OutputRecovery
from test_direct_outputs import Collector,write
from test_modes_recording import wait_frames
from test_aac_mp4 import inspect
from test_audio_rotation import expected

AAC=os.environ.get('ZC_TEST_AAC')=='1'

class Broken(Collector):
    def __init__(self): super().__init__();self.calls=0
    def outputframe(self,*args,**kwargs): self.calls+=1;raise OSError('sink disconnected')

class OutputRecoveryTests(unittest.TestCase):
    def test_independent_delays_flush_owned_packets_on_stop(self):
        sinks=[Collector() for _ in range(3)]
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(sinks,width=32,height=32,fps=25) as recorder:
                self.assertEqual((C.sizeof(_OutputDelay),C.sizeof(_OutputRecovery)),(40,24))
                recorder.set_output_delay(1,delay_ms=80,max_bytes=32768,max_frames=8)
                recorder.set_output_delay(2,delay_ms=120,max_bytes=32768,max_frames=8)
                for i in range(5): write(camera,recorder,i)
                self.assertEqual([len(s.events) for s in sinks],[5,3,2])
                self.assertEqual(recorder.output_delay(1)['queued_frames'],2)
                self.assertEqual(recorder.output_delay(2)['queued_frames'],3)
                self.assertGreater(recorder.output_delay(2)['queued_bytes'],0)
            self.assertEqual([len(s.events) for s in sinks],[5,5,5])
            for sink in sinks:
                self.assertEqual([e[1]['timestamp'] for e in sink.events],[0,40000,80000,120000,160000])
                self.assertTrue(all(e[0][:2]==b'\xff\xd8' for e in sink.events))

    def test_dynamic_delay_drains_in_order_and_resize_is_atomic(self):
        sink=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(sink,width=32,height=32,fps=25) as recorder:
                recorder.set_output_delay(delay_ms=120,max_bytes=32768,max_frames=8)
                for i in range(3): write(camera,recorder,i)
                before=recorder.output_delay()
                with self.assertRaises(CameraError): recorder.set_output_delay(delay_ms=5,max_bytes=65536,max_frames=9)
                self.assertEqual(recorder.output_delay(),before)
                recorder.set_output_delay(delay_ms=0,max_bytes=32768,max_frames=8)
                self.assertFalse(sink.events)
                write(camera,recorder,3)
                self.assertEqual([e[1]['timestamp'] for e in sink.events],[0,40000,80000,120000])
                recorder.set_output_delay(delay_ms=80,max_bytes=65536,max_frames=9)
                write(camera,recorder,4)
                self.assertEqual(len(sink.events),4)
            self.assertEqual(len(sink.events),5)

    def test_detach_excludes_only_its_delayed_tail(self):
        a=Collector();b=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([a,b],width=32,height=32,fps=25) as recorder:
                recorder.set_output_delay(0,delay_ms=80,max_bytes=32768,max_frames=8)
                recorder.set_output_delay(1,delay_ms=120,max_bytes=32768,max_frames=8)
                for i in range(5): write(camera,recorder,i)
                recorder.remove_output(0);self.assertEqual(len(a.events),3)
                write(camera,recorder,5);self.assertEqual(len(b.events),3)
            self.assertEqual(len(a.events),3);self.assertEqual(len(b.events),6)

    def test_delayed_splits_keep_queue_and_stable_id(self):
        a=Collector();b=Collector();new=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([a,b],width=32,height=32,fps=25) as recorder:
                recorder.set_output_delay(1,delay_ms=80,max_bytes=32768,max_frames=8)
                for i in range(3): write(camera,recorder,i)
                recorder.split_output(1,new);write(camera,recorder,3)
                self.assertEqual(recorder.output_status(1)['generation'],1)
                self.assertEqual(recorder.output_delay(1)['delay_ns'],80_000_000)
                self.assertEqual(len(b.events),1);self.assertEqual(len(new.events),1)
                for i in range(4,7): write(camera,recorder,i)
            self.assertEqual(len(a.events),7);self.assertEqual(len(b.events)+len(new.events),7)
            self.assertEqual([e[1]['timestamp'] for e in new.events],[i*40000 for i in range(6)])

    def test_queue_overflow_is_local_and_recovery_drops_stale_tail(self):
        a=Collector();b=Collector();fresh=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([a,b],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_delay(1,delay_ms=400,max_bytes=32768,max_frames=1)
                write(camera,recorder,0);write(camera,recorder,1)
                self.assertEqual(len(a.events),2);self.assertFalse(b.events)
                self.assertNotEqual(recorder.output_status(1)['error_code'],0)
                recorder.recover_output(1,fresh)
                self.assertEqual(recorder.output_delay(1)['queued_frames'],0)
                recorder.set_output_delay(1,delay_ms=40,max_bytes=32768,max_frames=4)
                for i in range(2,6): write(camera,recorder,i)
                self.assertEqual(recorder.output_status(1)['generation'],1)
                self.assertFalse(recorder.output_errors)
            self.assertEqual(len(a.events),6);self.assertEqual(len(fresh.events),4)
            self.assertEqual(fresh.events[0][1]['timestamp'],0)
            self.assertFalse(b.recording)

    def test_auto_recovery_at_primary_and_extra_preserves_healthy_sink(self):
        for identity in (0,1):
            bad=Broken();healthy=Collector();replacement=Collector();sinks=[healthy,healthy];sinks[identity]=bad;attempts=[]
            def factory(attempt,error): attempts.append((attempt,error));return replacement
            with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
                camera.start()
                with Recorder(sinks,width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                    recorder.set_output_recovery(identity,factory,retry_delay_ms=40)
                    for i in range(6): write(camera,recorder,i)
                    self.assertEqual(len(attempts),1);self.assertEqual(attempts[0][0],1)
                    self.assertIsInstance(attempts[0][1],OSError)
                    self.assertEqual(recorder.output_status(identity)['generation'],1)
                    self.assertEqual(recorder.recovery_status(identity)['attempts'],1)
                    self.assertIsInstance(recorder.recovery_status(identity)['last_failure'],OSError)
                    self.assertFalse(recorder.output_errors);self.assertFalse(bad.recording)
                    self.assertEqual(bad.calls,1)
                self.assertEqual(len(healthy.events),6);self.assertEqual(len(replacement.events),4)
                self.assertEqual(replacement.events[0][1]['timestamp'],0)
                self.assertEqual(recorder.recovery_status(identity)['attempts'],1)

    def test_failed_factories_backoff_exhaustion_disable_and_budget_reset(self):
        bad=Broken();healthy=Collector();attempts=[]
        def factory(attempt,error): attempts.append(attempt);raise ValueError('still offline')
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,bad],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_recovery(1,factory,max_attempts=2,retry_delay_ms=40,max_delay_ms=80)
                for i in range(8): write(camera,recorder,i)
                state=recorder.recovery_status(1)
                self.assertEqual(attempts,[1,2]);self.assertTrue(state['exhausted'])
                self.assertIsInstance(state['last_error'],ValueError);self.assertIsInstance(recorder.output_errors[1],OSError)
                recorder.set_output_recovery(1,None)
                self.assertEqual(recorder.recovery_status(1)['limit'],0)
                fresh=Collector();recorder.set_output_recovery(1,lambda attempt,error:fresh,retry_delay_ms=0)
                write(camera,recorder,8);write(camera,recorder,9)
                self.assertEqual(len(fresh.events),1);self.assertFalse(recorder.output_errors)
                self.assertEqual(len(healthy.events),10)

    def test_repeated_disconnections_cannot_reset_lifetime_retry_budget(self):
        bad=Broken();replacements=[]
        def factory(attempt,error): replacement=Broken();replacements.append(replacement);return replacement
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(bad,width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_recovery(0,factory,max_attempts=2,retry_delay_ms=0)
                for i in range(8): write(camera,recorder,i)
                self.assertEqual(len(replacements),2);self.assertEqual(recorder.output_status()['generation'],2)
                self.assertEqual(recorder.recovery_status()['attempts'],2)
                self.assertTrue(recorder.recovery_status()['exhausted'])
                self.assertEqual([b.calls for b in [bad,*replacements]],[1,1,1])
            self.assertTrue(all(not b.recording for b in [bad,*replacements]))

    def test_factory_reentry_is_rejected_without_harming_capture(self):
        bad=Broken();healthy=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,bad],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_recovery(1,lambda attempt,error:recorder.remove_output(0),max_attempts=1,retry_delay_ms=0)
                for i in range(4): write(camera,recorder,i)
                self.assertIsInstance(recorder.recovery_status(1)['last_error'],RuntimeError)
                self.assertEqual(len(healthy.events),4);self.assertEqual(len(recorder.outputs),2)

    def test_recovery_preparation_failure_keeps_old_context_and_identity_guards(self):
        class BadStart(Collector):
            def start(self): super().start();raise ValueError('start failed')
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();path=Path(directory)/'healthy.mkv';bad=Broken();start=BadStart()
            with Recorder([path,bad],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                write(camera,recorder,0)
                with self.assertRaisesRegex(ValueError,'start failed'): recorder.recover_output(1,start)
                self.assertFalse(start.recording);self.assertTrue(bad.recording)
                self.assertEqual(recorder.output_status(1)['generation'],0)
                before=path.read_bytes()
                with self.assertRaises(CameraError): recorder.recover_output(1,path)
                self.assertEqual(path.read_bytes(),before);self.assertTrue(bad.recording)
                fresh=Collector();recorder.recover_output(1,fresh);write(camera,recorder,1)
                self.assertFalse(bad.recording);self.assertEqual(len(fresh.events),1)
                recorder.remove_output(1)
                with self.assertRaises(CameraError): recorder.recover_output(1,Collector())

    def test_pending_split_failure_is_terminal_before_automatic_recovery(self):
        bad=Broken();pending=Collector();fresh=Collector();healthy=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,bad],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.split_output(1,pending)
                recorder.set_output_recovery(1,lambda attempt,error:fresh,retry_delay_ms=0)
                write(camera,recorder,0)
                self.assertIsInstance(recorder._split_results[1],OSError)
                self.assertFalse(pending.recording);self.assertFalse(bad.recording)
                write(camera,recorder,1);self.assertEqual(len(fresh.events),1)

    def test_async_recording_supports_delays_and_automatic_recovery(self):
        healthy=Collector();bad=Broken();fresh=Collector()
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording([healthy,bad],fps=25,failure_policy='isolate')
            with camera._async_lock:
                recording.set_output_delay(0,delay_ms=80,max_bytes=32768,max_frames=8)
                recording.set_output_recovery(1,lambda attempt,error:fresh,retry_delay_ms=0)
                begin=recording.frames
            wait_frames(recording,begin+8)
            self.assertIsNone(recording.error);self.assertEqual(recording.output_status(1)['generation'],1)
            self.assertTrue(fresh.events);camera.stop_recording()
            self.assertFalse(healthy.recording);self.assertFalse(fresh.recording)

    def test_recorder_delay_and_attachment_delays_compose(self):
        a=Collector();b=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':40,'max_bytes':32768,'max_frames':8}) as recorder:
                recorder.open_output(a);identity=recorder.add_output(b)
                recorder.set_output_delay(identity,delay_ms=80,max_bytes=32768,max_frames=8)
                for i in range(6): write(camera,recorder,i)
                self.assertEqual([len(s.events) for s in (a,b)],[5,3])
            self.assertEqual([len(s.events) for s in (a,b)],[6,6])

    def test_recovered_async_split_still_reports_its_original_failure(self):
        healthy=Collector();original=Collector();broken=Broken();fresh=Collector()
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording([healthy,original],fps=25,failure_policy='isolate')
            wait_frames(recording,4)
            with camera._async_lock:
                recording.set_output_recovery(1,lambda attempt,error:fresh,retry_delay_ms=0)
                job=recording.split_output(1,broken)
            with self.assertRaisesRegex(OSError,'disconnected'): job.result(5)
            wait_frames(recording,recording.frames+4)
            self.assertEqual(recording.output_status(1)['generation'],2)
            self.assertEqual(recording.outputs,(healthy,fresh));self.assertIsNone(recording.error)
            camera.stop_recording();self.assertFalse(original.recording);self.assertFalse(broken.recording)

    def test_circular_observer_pts_descriptor_survives_recovery(self):
        from zigcamera.output_objects import PtsStream
        class Disconnect(Collector):
            broken=False
            def outputframe(self,*args,**kwargs):
                if self.broken: raise OSError('disconnected')
                return super().outputframe(*args,**kwargs)
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();pts=PtsStream(Path(directory)/'observer.pts');bad=Disconnect();fresh=Collector()
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':40},failure_policy='isolate') as recorder:
                recorder.open_output(bad,_pts=pts);descriptor=pts.stream.fileno()
                recorder.set_output_recovery(0,lambda attempt,error:fresh,retry_delay_ms=0)
                for i in range(6):
                    if i==2: bad.broken=True
                    write(camera,recorder,i)
                    self.assertEqual(pts.stream.fileno(),descriptor)
                self.assertEqual(recorder.output_status()['generation'],1)
                self.assertFalse(bad.recording)
            self.assertIsNone(pts.stream)
            self.assertEqual((Path(directory)/'observer.pts').read_text().splitlines(),['0.000','0.000','40.000','80.000','120.000'])

    def test_post_accept_setup_error_keeps_callbacks_owned_until_quarantine(self):
        from zigcamera import FileOutput
        class BadCommit(FileOutput):
            def _reset(self): raise OSError('reset failed after acceptance')
        bad=Broken();healthy=Collector();broken_setup=BadCommit(io.BytesIO());fresh=Collector()
        def factory(attempt,error): return broken_setup if attempt==1 else fresh
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([healthy,bad],width=32,height=32,fps=25,failure_policy='isolate') as recorder:
                recorder.set_output_recovery(1,factory,max_attempts=2,retry_delay_ms=0)
                write(camera,recorder,0)
                self.assertEqual(recorder.output_status(1)['generation'],1)
                self.assertTrue(broken_setup.recording);self.assertFalse(bad.recording)
                self.assertIsInstance(recorder.recovery_status(1)['last_error'],OSError)
                write(camera,recorder,1);write(camera,recorder,2)
                self.assertEqual(recorder.output_status(1)['generation'],2)
                self.assertFalse(broken_setup.recording);self.assertEqual(len(fresh.events),1)
                self.assertEqual(len(healthy.events),3);self.assertEqual(recorder.recovery_status(1)['attempts'],2)

    def test_validation_and_opt_in(self):
        with Recorder(Collector(),width=32,height=32) as recorder:
            with self.assertRaises(CameraError): recorder.set_output_recovery(0,lambda attempt,error:Collector())
            with self.assertRaises(RuntimeError): recorder.recover_output(0,Collector())
            for options in ({'delay_ms':-1},{'delay_ms':1,'max_frames':0},{'delay_ms':1,'max_bytes':0}):
                with self.assertRaises((ValueError,CameraError)): recorder.set_output_delay(**options)
        with Recorder(Collector(),width=32,height=32,failure_policy='isolate') as recorder:
            with self.assertRaises(RuntimeError): recorder.recover_output(0,Collector())
            with self.assertRaises(ValueError): recorder.set_output_recovery(0,lambda a,e:None,max_attempts=0)
            with self.assertRaises(ValueError): recorder.set_output_recovery(0,lambda a,e:None,retry_delay_ms=10,max_delay_ms=1)
            with self.assertRaises(TypeError): recorder.set_output_recovery(0,3)

    @unittest.skipUnless(AAC,'AAC build required')
    def test_independent_delays_preserve_complete_aac_mp4_sample_clocks(self):
        for codec in ('h264','hevc'):
            with self.subTest(codec=codec),tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
                camera.start();paths=[Path(directory)/f'{i}.mp4' for i in range(3)]
                with Recorder(paths,width=32,height=32,fps=25,codec=codec,audio={'sample_rate':44100,'channels':2,'buffer_frames':44100},failure_policy='isolate') as recorder:
                    recorder.set_output_delay(1,delay_ms=80,max_bytes=131072,max_frames=20)
                    recorder.set_output_delay(2,delay_ms=160,max_bytes=131072,max_frames=20)
                    for i in range(20):
                        recorder.write_audio(expected(1764,start=i*1764,channels=2),timestamp_ns=i*40_000_000)
                        write(camera,recorder,i)
                    for identity in (1,2):
                        self.assertEqual(recorder.output_stats(identity)['frames']+recorder.output_delay(identity)['queued_frames'],recorder.output_stats(0)['frames'])
                for path in paths: inspect(self,path,count=20,samples=35280,rate=44100,channels=2)

    @unittest.skipUnless(AAC,'AAC build required')
    def test_fresh_recovered_aac_mp4_starts_at_key_with_exact_audio_window(self):
        class Disconnect(MuxedOutput):
            armed=False
            def _write(self,data):
                if self.armed: raise OSError('media disconnected')
                return super()._write(data)
        for codec in ('h264','hevc'):
            with self.subTest(codec=codec),tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
                camera.start();root=Path(directory);good=root/'good.mp4';recovered=root/'recovered.mp4';broken=Disconnect(root/'broken.mp4')
                with Recorder([good,broken],width=32,height=32,fps=25,codec=codec,audio={'sample_rate':44100,'channels':2,'buffer_frames':44100},failure_policy='isolate') as recorder:
                    recorder.set_output_delay(1,delay_ms=80,max_bytes=131072,max_frames=20)
                    recorder.set_output_recovery(1,lambda attempt,error:recovered,retry_delay_ms=0)
                    for i in range(20):
                        if i==6: broken.armed=True
                        recorder.write_audio(expected(1764,start=i*1764,channels=2),timestamp_ns=i*40_000_000)
                        write(camera,recorder,i)
                    start=recorder.output_stats(1)['first_ns']//40_000_000
                    self.assertGreater(start,6);self.assertEqual(recorder.output_status(1)['generation'],1)
                inspect(self,good,count=20,samples=35280,rate=44100,channels=2)
                inspect(self,recovered,count=20-start,first=start,samples=(20-start)*1764,start_sample=start*1764,rate=44100,channels=2)

    @unittest.skipUnless(AAC,'AAC build required')
    def test_delayed_aac_split_and_detach_clip_each_audio_boundary(self):
        for codec in ('h264','hevc'):
            with self.subTest(codec=codec),tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
                camera.start();root=Path(directory);paths=[root/name for name in ('live.mp4','first.mp4','second.mp4')]
                with Recorder(paths[:2],width=32,height=32,fps=25,codec=codec,gop=4,audio={'sample_rate':44100,'channels':2,'buffer_frames':44100},failure_policy='isolate') as recorder:
                    recorder.set_output_delay(1,delay_ms=160,max_bytes=131072,max_frames=20)
                    for i in range(20):
                        if i==10: recorder.split_output(1,paths[2])
                        recorder.write_audio(expected(1764,start=i*1764,channels=2),timestamp_ns=i*40_000_000)
                        write(camera,recorder,i)
                        if i==16:
                            state=recorder.output_stats(1);self.assertEqual(recorder.output_status(1)['generation'],1)
                            start=state['first_ns']//40_000_000;count=state['frames']
                            self.assertGreater(start,0);self.assertGreater(count,0)
                            recorder.remove_output(1)
                inspect(self,paths[0],count=20,samples=35280,rate=44100,channels=2)
                inspect(self,paths[1],count=start,samples=start*1764,rate=44100,channels=2)
                inspect(self,paths[2],count=count,first=start,samples=count*1764,start_sample=start*1764,rate=44100,channels=2)
