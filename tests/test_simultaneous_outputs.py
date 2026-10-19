"""Shared video, bounded attachment identities and independent PCM timelines."""
import ctypes as C
import io
import os
from pathlib import Path
import tempfile
import unittest
from zigcamera import Camera,Recorder,AudioCapture,FileOutput,MuxedOutput,Picamera2,MJPEGEncoder,CameraError,_OutputStats
from zigcamera.audio import AudioFeed
from test_direct_outputs import Collector,write
from test_modes_recording import wait_frames
from test_audio_rotation import expected
from check_av import parse as mkv
from test_aac_mp4 import inspect

AAC=os.environ.get('ZC_TEST_AAC')=='1'

class SimultaneousTests(unittest.TestCase):
    def test_initial_list_encodes_identical_packets_and_detaches_independently(self):
        self.assertEqual(C.sizeof(_OutputStats),48)
        first=Collector();second=Collector();third=Collector();raw=io.BytesIO();elementary=FileOutput(raw)
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([first,second,elementary],width=32,height=32,fps=25) as recorder:
                self.assertEqual(recorder.outputs,(first,second,elementary))
                for i in range(3): write(camera,recorder,i)
                self.assertEqual(first.events,second.events)
                identity=recorder.add_output(third)
                self.assertTrue(recorder.output_stats(identity)['waiting_key'])
                write(camera,recorder,3)
                self.assertEqual(third.events[0][1]['timestamp'],0)
                recorder.remove_output(second)
                self.assertFalse(second.recording);self.assertTrue(first.recording);self.assertTrue(third.recording)
                for i in range(4,8): write(camera,recorder,i)
                self.assertEqual(recorder.output_stats(first)['frames'],8)
                self.assertEqual(recorder.output_stats(third)['frames'],5)
            self.assertEqual(raw.getvalue(),b''.join(e[0] for e in first.events))
            self.assertFalse(raw.closed)
            self.assertEqual([len(o.events) for o in (first,second,third)],[8,4,5])
            self.assertEqual([o.lifecycle.count('stop') for o in (first,second,third)],[1,1,1])

    def test_empty_list_all_removed_reuse_and_stale_id_rejection(self):
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();out=Collector()
            with Recorder([],width=32,height=32,fps=25) as recorder:
                for i in range(3): write(camera,recorder,i)
                first=recorder.add_output(out);write(camera,recorder,3)
                recorder.remove_output(first)
                second=recorder.add_output(out);self.assertNotEqual(first,second)
                with self.assertRaises(CameraError): recorder.remove_output(first)
                self.assertTrue(out.recording)
                write(camera,recorder,4);recorder.remove_output(second)
                self.assertEqual(recorder.outputs,())
                for i in range(5,8): write(camera,recorder,i)
            self.assertEqual([event[1]['timestamp'] for event in out.events],[0,0]);self.assertEqual(out.lifecycle.count('stop'),2)

    def test_capacity_duplicate_objects_and_aliases_are_checked_before_writes(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);camera.start();stream=io.BytesIO();first=MuxedOutput(stream,format='mkv')
            with Recorder(first,width=32,height=32,fps=25) as recorder:
                write(camera,recorder,0);before=stream.getvalue()
                with self.assertRaisesRegex(ValueError,'distinct'): recorder.add_output(MuxedOutput(stream,format='mkv'))
                self.assertEqual(stream.getvalue(),before)
                with self.assertRaisesRegex(RuntimeError,'attached'): recorder.add_output(first)
                for i in range(7): recorder.add_output(Collector())
                untouched=root/'capacity.mkv';untouched.write_bytes(b'keep')
                with self.assertRaisesRegex(RuntimeError,'capacity'): recorder.add_output(MuxedOutput(untouched))
                self.assertEqual(untouched.read_bytes(),b'keep');write(camera,recorder,1)
            path=root/'extra.mkv';alias=root/'alias.mkv'
            with Recorder(Collector(),width=32,height=32,fps=25) as recorder:
                extra=MuxedOutput(path,root/'extra.pts');recorder.add_output(extra);write(camera,recorder,0)
                os.link(path,alias);before=path.read_bytes()
                for operation in (lambda:recorder.add_output(MuxedOutput(alias)),lambda:recorder.split(alias)):
                    with self.assertRaises(CameraError): operation()
                    self.assertEqual(path.read_bytes(),before)
                recorder.close_output()
                with self.assertRaises(CameraError): recorder.open_output(alias)
                self.assertEqual(path.read_bytes(),before)

    def test_snapshot_reservations_include_every_output(self):
        from unittest.mock import patch
        from zigcamera.jobs import OperationJob
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);camera.start()
            with Recorder(width=32,height=32,fps=25,circular={}) as recorder:
                extra=MuxedOutput(root/'extra.mkv');recorder.add_output(extra)
                for i in range(5): write(camera,recorder,i)
                with self.assertRaises(CameraError): recorder.save_buffer(root/'extra.mkv',wait=False)
                snap=root/'reserved.mkv';snap.write_bytes(b'keep')
                with patch.object(OperationJob,'start',lambda job:job): job=recorder.save_buffer(snap,wait=False)
                try:
                    with self.assertRaises(CameraError): recorder.add_output(MuxedOutput(snap))
                    self.assertEqual(snap.read_bytes(),b'keep')
                finally: self.assertTrue(job.cancel())

    def test_primary_splits_do_not_interrupt_other_outputs(self):
        first=Collector();continuous=Collector();second=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([first,continuous],width=32,height=32,fps=25) as recorder:
                for i in range(4): write(camera,recorder,i)
                recorder.split(second)
                for i in range(4,8): write(camera,recorder,i)
                self.assertEqual(recorder.outputs,(second,continuous))
                recorder.remove_output(second)
                for i in range(8,10): write(camera,recorder,i)
            self.assertEqual(len(continuous.events),10);self.assertEqual(len(first.events)+len(second.events),8)
            self.assertEqual(continuous.events[:4],first.events)

    def test_pcm_windows_clip_each_attachment_and_release_without_consumers(self):
        for delay in (None,80):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2) as source:
                root=Path(directory);camera.start();feed=AudioFeed(source)
                streams=[io.BytesIO(),io.BytesIO()];pts=[io.StringIO(),io.StringIO()]
                outputs=[MuxedOutput(streams[i],pts[i],format='mkv') for i in range(2)]
                circular=None if delay is None else {'delay_ms':delay,'max_frames':32}
                with Recorder([outputs[0]] if circular is None else None,width=32,height=32,fps=25,circular=circular,audio={'sample_rate':44100,'channels':2,'buffer_frames':44100}) as recorder:
                    if circular is not None: recorder.open_output(outputs[0])
                    for i in range(20):
                        if i==5: recorder.add_output(outputs[1])
                        if i==13: recorder.remove_output(outputs[1])
                        feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
                counts=[]
                for index in range(2):
                    path=root/f'{index}.mkv';path.write_bytes(streams[index].getvalue());info=mkv(path);count=len(info['video']);counts.append(count)
                    first=0 if index==0 else 5 if delay is None else 3
                    self.assertEqual(b''.join(p for _,p,_ in info['audio']),expected(count*1764,start=first*1764,channels=2))
                    self.assertEqual(pts[index].getvalue().splitlines(),[f'{i*40}.000' for i in range(count)])
                self.assertEqual(counts,[20,8])
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder([],width=32,height=32,fps=25,audio={'sample_rate':48000,'buffer_frames':3840}) as recorder:
                for i in range(80):
                    recorder.write_audio(expected(1920,start=i*1920),timestamp_ns=i*40_000_000);write(camera,recorder,i)
                self.assertLessEqual(recorder.stats['audio_queued_frames'],1920)
                out=Collector();recorder.add_output(out)
                for i in range(80,84):
                    recorder.write_audio(expected(1920,start=i*1920),timestamp_ns=i*40_000_000);write(camera,recorder,i)
                self.assertEqual(b''.join(e[0] for e in out.events if e[1]['audio']),expected(3*1920,start=80*1920))

    def test_prepare_delivery_and_stop_failures_keep_other_contexts_owned(self):
        class Bad(Collector):
            def outputframe(self,*args,**kwargs): raise ValueError('extra delivery failure')
        class BadStart(Collector):
            def start(self): super().start();raise ValueError('extra start failure')
        class BadStop(Collector):
            def stop(self): super().stop();raise ValueError('extra stop failure')
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();first=Collector();second=Collector();bad=Bad()
            recorder=Recorder([first,second],width=32,height=32,fps=25)
            with self.assertRaisesRegex(ValueError,'start'): recorder.add_output(BadStart())
            write(camera,recorder,0);identity=recorder.add_output(bad)
            with self.assertRaisesRegex(ValueError,'delivery'): write(camera,recorder,1)
            self.assertTrue(bad.recording);self.assertTrue(first.recording);self.assertTrue(second.recording)
            recorder.remove_output(identity);self.assertFalse(bad.recording)
            with self.assertRaises(CameraError): recorder.close()
            self.assertFalse(first.recording);self.assertFalse(second.recording)
            recorder=Recorder([Collector(),BadStop(),Collector()],width=32,height=32)
            outputs=recorder.outputs
            with self.assertRaisesRegex(ValueError,'stop'): recorder.close()
            self.assertFalse(recorder._handle.value);self.assertTrue(all(not o.recording for o in outputs))
            self.assertEqual(camera.stats['leased'],0)

    def test_picamera_list_and_serialized_dynamic_attachment(self):
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}));first=Collector();second=Collector();third=Collector()
            recording=camera.start_recording(MJPEGEncoder(),[first,second],fps=25);wait_frames(recording,4)
            identity=camera.add_recording_output(third)
            wait_frames(recording,recording.frames+4)
            self.assertGreater(recording.output_stats(identity)['frames'],0)
            camera.remove_recording_output(second);self.assertFalse(second.recording)
            wait_frames(recording,recording.frames+3);camera.stop_recording()
            self.assertFalse(first.recording);self.assertFalse(third.recording)

    def test_reentry_from_attachment_and_detachment_hooks_is_rejected(self):
        with Recorder([],width=32,height=32) as recorder:
            class Bad(Collector):
                def _add_stream(self,*args,**kwargs): recorder.add_output(Collector())
            with self.assertRaisesRegex(RuntimeError,'re-entry'): recorder.add_output(Bad())
            self.assertEqual(recorder.outputs,())

    def test_failed_group_startup_and_empty_attachments_release_all_claims(self):
        first=Collector()
        class Bad(Collector):
            def _add_stream(self,*args,**kwargs): raise ValueError('group metadata failure')
        bad=Bad()
        with self.assertRaisesRegex(ValueError,'metadata'): Recorder([first,bad],width=32,height=32)
        self.assertFalse(first.recording);self.assertFalse(bad.recording)
        with Recorder([],width=32,height=32) as recorder:
            identity=recorder.add_output(first)
            self.assertTrue(recorder.output_stats(identity)['waiting_key']);recorder.remove_output(identity)
            self.assertFalse(first.recording);self.assertEqual(first.lifecycle.count('stop'),2)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_failed_mp4_finalization_does_not_skip_healthy_sink_finalization(self):
        class BadPatch(MuxedOutput):
            fail=False
            def _patch(self,*args):
                if self.fail: raise OSError('extra finalization failure')
                return super()._patch(*args)
        for detach in (False,True):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2) as source:
                camera.start();feed=AudioFeed(source);healthy=io.BytesIO();bad=BadPatch(io.BytesIO(),format='mp4')
                recorder=Recorder([MuxedOutput(healthy,format='mp4'),bad],width=128,height=96,fps=25,codec='h264',audio={'sample_rate':44100,'channels':2})
                for i in range(8):
                    feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
                bad.fail=True
                if detach:
                    with self.assertRaisesRegex(OSError,'finalization'): recorder.remove_output(bad)
                    self.assertFalse(bad.recording)
                    for i in range(8,12):
                        feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
                    recorder.close();count=12
                else:
                    with self.assertRaisesRegex(OSError,'finalization'): recorder.close()
                    self.assertFalse(bad.recording);count=8
                path=Path(directory)/'healthy.mp4';path.write_bytes(healthy.getvalue())
                inspect(self,path,count=count,samples=count*1764,rate=44100,channels=2)
                self.assertFalse(recorder._handle.value)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_delayed_primary_aac_splits_leave_parallel_audio_continuous(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2) as source:
            camera.start();feed=AudioFeed(source);root=Path(directory)
            streams=[io.BytesIO() for _ in range(3)];pts=[io.StringIO() for _ in range(3)]
            outputs=[MuxedOutput(streams[i],pts[i],format='mp4') for i in range(3)]
            with Recorder(width=128,height=96,fps=25,codec='h264',gop=100,circular={'delay_ms':120,'max_frames':32},audio={'sample_rate':44100,'channels':2}) as recorder:
                recorder.open_output(outputs[0]);recorder.add_output(outputs[2])
                for i in range(20):
                    if i==9: recorder.split(outputs[1])
                    feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
            start=0
            for index in (0,1):
                count=len(pts[index].getvalue().splitlines());path=root/f'{index}.mp4';path.write_bytes(streams[index].getvalue())
                inspect(self,path,count=count,first=start,samples=count*1764,start_sample=start*1764,rate=44100,channels=2);start+=count
            self.assertEqual(start,20)
            path=root/'continuous.mp4';path.write_bytes(streams[2].getvalue())
            inspect(self,path,count=20,samples=20*1764,rate=44100,channels=2)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_simultaneous_aac_mp4_pcm_and_packets_independently_decode(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2) as source:
                root=Path(directory);camera.start();feed=AudioFeed(source)
                streams=[io.BytesIO() for _ in range(3)];pts=[io.StringIO() for _ in range(3)]
                outputs=[MuxedOutput(streams[0],pts[0],format='mp4'),MuxedOutput(streams[1],pts[1],format='mp4'),MuxedOutput(streams[2],pts[2],format='mkv')]
                packets=Collector()
                with Recorder([outputs[0],outputs[2],packets],width=128,height=96,fps=25,codec=codec,gop=100,audio={'sample_rate':44100,'channels':2,'codec':'aac'}) as recorder:
                    for i in range(20):
                        if i==5: recorder.add_output(outputs[1])
                        if i==14:
                            stats=recorder.output_stats(outputs[1]);start=stats['first_ns']//40_000_000
                            count=stats['frames'];recorder.remove_output(outputs[1])
                        feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
                for index,(begin,n) in enumerate(((0,20),(start,count))):
                    path=root/f'{index}.mp4';path.write_bytes(streams[index].getvalue())
                    info=inspect(self,path,count=n,first=begin,samples=n*1764,start_sample=begin*1764,rate=44100,channels=2)
                    self.assertEqual(pts[index].getvalue().splitlines(),[f'{t//1000}.{t%1000:03}' for t in info[1]['times']])
                path=root/'parallel.mkv';path.write_bytes(streams[2].getvalue());info=mkv(path)
                self.assertEqual(len(info['video']),20);self.assertEqual(b''.join(p for _,p,_ in info['audio']),expected(20*1764,channels=2))
                self.assertEqual(b''.join(e[0] for e in packets.events if e[1]['audio']),expected(20*1764,channels=2))
                self.assertEqual(len([e for e in packets.events if not e[1]['audio']]),20)

if __name__=='__main__': unittest.main()
