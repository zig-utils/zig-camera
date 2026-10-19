"""Direct and staged output lifetimes, real Home segment boundaries, no FFmpeg."""
import io
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import CancelledError
from zigcamera import Camera,Recorder,AudioCapture,Output,FileOutput,MuxedOutput,Picamera2,MJPEGEncoder,CircularOutput2,CameraError
from zigcamera.audio import AudioFeed
from check_av import parse as mkv
from test_audio_rotation import expected
from test_aac_mp4 import inspect
from test_modes_recording import wait_frames

AAC=os.environ.get('ZC_TEST_AAC')=='1'
CODECS=os.environ.get('ZC_TEST_CODECS')=='1'

class Collector(Output):
    def __init__(self): super().__init__();self.events=[];self.lifecycle=[]
    def start(self): super().start();self.lifecycle.append('start')
    def stop(self): self.lifecycle.append('stop');super().stop()
    def _add_stream(self,info,codec,**kwargs): self.lifecycle.append(codec)
    def outputframe(self,frame,**kwargs): self.events.append((frame,kwargs));super().outputframe(frame,**kwargs)

def write(camera,recorder,i,fps=25):
    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//fps)

class DirectOutputTests(unittest.TestCase):
    def test_direct_constructor_and_manual_splits_have_exact_lifetimes(self):
        first=Collector();second=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(first,width=32,height=32,fps=25) as recorder:
                self.assertEqual(recorder.buffer_stats['frames'],0)  # No history allocation.
                for i in range(3): write(camera,recorder,i)
                recorder.split(second)
                self.assertEqual(first.lifecycle,['start','mjpeg']);self.assertEqual(second.lifecycle,['start','mjpeg'])
                self.assertFalse(second.events)
                write(camera,recorder,3)
                self.assertEqual(first.lifecycle,['start','mjpeg','stop']);self.assertEqual(second.events[0][1]['timestamp'],0)
                self.assertFalse(recorder.buffer_stats['split_pending'])
                for i in range(4,7): write(camera,recorder,i)
            self.assertEqual(len(first.events),3);self.assertEqual(len(second.events),4)
            self.assertEqual(second.lifecycle,['start','mjpeg','stop'])
            # Claims are released and metadata is replayed for a new recorder.
            with Recorder(first,width=32,height=32) as recorder: write(camera,recorder,0)
            self.assertEqual(first.lifecycle.count('stop'),2)

    def test_direct_file_output_and_split_before_first_frame(self):
        data=[io.BytesIO(),io.BytesIO()];pts=[io.StringIO(),io.StringIO()]
        outputs=[FileOutput(data[i],pts[i]) for i in range(2)]
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(outputs[0],width=32,height=32,fps=25) as recorder:
                recorder.split(outputs[1])
                for i in range(5): write(camera,recorder,i)
            self.assertEqual([d.getvalue().count(b'\xff\xd8') for d in data],[1,4])
            self.assertEqual([p.getvalue().splitlines()[0] for p in pts],['0.000','0.000'])
            first=Collector();pending=Collector();recorder=Recorder(first,width=32,height=32)
            write(camera,recorder,0);recorder.split(pending)
            with self.assertRaises(CameraError): recorder.close()
            self.assertEqual(first.lifecycle.count('stop'),1);self.assertEqual(pending.lifecycle.count('stop'),1)
            self.assertFalse(pending.events)

    def test_direct_muxed_pcm_split_is_sample_exact(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
            camera.start();feed=AudioFeed(source);root=Path(directory)
            outputs=[MuxedOutput(io.BytesIO(),io.StringIO(),format='mkv') for _ in range(2)]
            with Recorder(outputs[0],width=32,height=32,fps=25,audio={'sample_rate':48000}) as recorder:
                for i in range(10):
                    if i==4: recorder.split(outputs[1])
                    feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
            for index,(start,count) in enumerate(((0,4),(4,6))):
                path=root/f'{index}.mkv';path.write_bytes(outputs[index].fileoutput.getvalue());info=mkv(path)
                self.assertEqual(len(info['video']),count)
                self.assertEqual(b''.join(p for _,p,_ in info['audio']),expected(count*1920,start=start*1920))
                self.assertEqual(outputs[index]._pts.target.getvalue().splitlines(),[f'{i*40}.000' for i in range(count)])
                self.assertFalse(outputs[index].fileoutput.closed)

    def test_path_object_path_transitions_and_cancellation(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);camera.start();pending=Collector();middle=Collector()
            with Recorder(root/'first.mkv',width=32,height=32,fps=25) as recorder:
                write(camera,recorder,0);recorder.split(pending)
                with self.assertRaises(RuntimeError): recorder.split(Collector())
                recorder.cancel_split();self.assertEqual(pending.lifecycle.count('stop'),1);self.assertFalse(pending.events)
                recorder.split(middle);write(camera,recorder,1)
                recorder.split(root/'last.mkv');write(camera,recorder,2);write(camera,recorder,3)
            self.assertEqual((root/'first.mkv').read_bytes().count(b'\xff\xd8'),1);self.assertEqual(len(middle.events),1)
            self.assertEqual((root/'last.mkv').read_bytes().count(b'\xff\xd8'),2);self.assertFalse(middle.recording)

    def test_pending_aliases_rejected_before_media_or_pts_truncate(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);camera.start();path=root/'live.mkv';alias=root/'alias.mkv'
            output=MuxedOutput(path,root/'live.pts')
            with Recorder(output,width=32,height=32,fps=25) as recorder:
                write(camera,recorder,0);os.link(path,alias);before=path.read_bytes()
                with self.assertRaises(CameraError): recorder.split(MuxedOutput(alias))
                self.assertEqual(path.read_bytes(),before)
                with self.assertRaises(CameraError): recorder.split(FileOutput(root/'elementary.mjpg',alias))
                self.assertEqual(path.read_bytes(),before)
                write(camera,recorder,1)
            stream=io.BytesIO();output=MuxedOutput(stream,format='mkv')
            with Recorder(output,width=32,height=32,fps=25) as recorder:
                write(camera,recorder,0);before=stream.getvalue()
                with self.assertRaisesRegex(ValueError,'distinct'): recorder.split(MuxedOutput(stream,format='mkv'))
                self.assertEqual(stream.getvalue(),before)
                with self.assertRaisesRegex(RuntimeError,'attached'): recorder.split(output)
                write(camera,recorder,1)

    def test_prepare_error_preserves_current_and_releases_pending(self):
        class Bad(Collector):
            def _add_stream(self,*args,**kwargs): raise ValueError('metadata failure')
        class NoProgress(io.BytesIO):
            def write(self,data): return 0
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();first=Collector();bad=Bad()
            with Recorder(first,width=32,height=32,fps=25) as recorder:
                write(camera,recorder,0)
                with self.assertRaisesRegex(ValueError,'metadata'): recorder.split(bad)
                self.assertFalse(bad.recording)
                with self.assertRaisesRegex(OSError,'progress'): recorder.split(MuxedOutput(NoProgress(),format='mkv'))
                self.assertFalse(recorder.buffer_stats['split_pending']);write(camera,recorder,1)
            self.assertEqual(len(first.events),2)

    def test_failure_after_commit_keeps_new_callbacks_until_close(self):
        class Bad(Collector):
            def outputframe(self,*args,**kwargs): raise ValueError('new packet failure')
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();first=Collector();second=Bad();recorder=Recorder(first,width=32,height=32,fps=25)
            write(camera,recorder,0);recorder.split(second)
            with self.assertRaisesRegex(ValueError,'new packet'): write(camera,recorder,1)
            self.assertFalse(first.recording);self.assertTrue(second.recording);self.assertIs(recorder._bridge.output,second)
            with self.assertRaises(CameraError): recorder.close()
            self.assertFalse(second.recording);self.assertEqual(camera.stats['leased'],0)

    def test_pending_stop_error_still_closes_native_and_both_outputs(self):
        class BadStop(Collector):
            def stop(self): super().stop();raise ValueError('pending stop failure')
        with Camera(simulate=True,width=32,height=32) as camera:
            recording=camera.start_recording(Collector(),fps=25)
            wait_frames(recording,3);second=BadStop()
            with camera._async_lock:
                job=recording.split(second)
                camera._recording=None
                pump=camera._pump;camera._pump=None;pump.stop_event.set()
            pump.close()
            with self.assertRaisesRegex(ValueError,'pending stop'): recording.close()
            with self.assertRaisesRegex(ValueError,'pending stop'): job.result(1)
            self.assertFalse(second.recording);self.assertFalse(recording.recorder._handle.value)
            self.assertEqual(camera.stats['leased'],0)

    def test_async_picamera_output_split_result_cancel_and_callback(self):
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}));first=Collector();second=Collector()
            recording=camera.start_recording(MJPEGEncoder(),first,fps=25);wait_frames(recording,3)
            pending=Collector()
            with camera._camera._async_lock:
                job=camera.split_recording(pending,wait=False)
                with self.assertRaises(TimeoutError): job.result(.001)
                self.assertTrue(job.cancel());self.assertFalse(job.cancel())
            with self.assertRaises(CancelledError): job.result(1)
            self.assertFalse(pending.recording);self.assertFalse(pending.events)
            called=threading.Event();states=[]
            def done(job): states.append((job.result(),first.recording));called.set()
            job=camera.split_recording(second,signal_function=done)
            self.assertIs(job.result(5),second);self.assertTrue(called.wait(5));self.assertEqual(states,[(second,False)])
            self.assertFalse(job.cancel());wait_frames(recording,recording.frames+3);camera.stop_recording()
            self.assertTrue(second.events);self.assertEqual(second.events[0][1]['timestamp'],0)

    def test_delayed_splits_transfer_circular_pts_and_stop_cancels_pending(self):
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}));pts=io.StringIO();delayed=CircularOutput2(pts,80,max_frames=32)
            recording=camera.start_recording(MJPEGEncoder(),delayed,fps=25)
            first=Collector();second=Collector();delayed.open_output(first);wait_frames(recording,7)
            self.assertIs(camera.split_recording(second,wait=False).result(5),second)
            wait_frames(recording,recording.frames+4)
            with camera._camera._async_lock:
                pending=Collector();job=camera.split_recording(pending,wait=False)
                camera.stop_recording()
            with self.assertRaises(CancelledError): job.result(1)
            self.assertFalse(pending.events);self.assertFalse(pending.recording);self.assertFalse(pts.closed)
            times=[event[1]['timestamp'] for out in (first,second) for event in out.events if not event[1]['audio']]
            self.assertEqual(pts.getvalue().splitlines(),[f'{t//1000}.{t%1000:03}' for t in times])
            self.assertEqual(times.count(0),2)

    def test_owned_circular_pts_transfer_to_path_split_uses_same_descriptor(self):
        from zigcamera.output_objects import PtsStream
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);pts=PtsStream(root/'shared.pts');first=FileOutput(root/'first.mjpg');camera.start()
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':0}) as recorder:
                recorder.open_output(first,_pts=pts)
                for i in range(3): write(camera,recorder,i)
                descriptor=pts.stream.fileno();recorder.split(root/'second.mkv');write(camera,recorder,3)
                self.assertEqual(pts.stream.fileno(),descriptor);self.assertFalse(first.recording)
                for i in range(4,6): write(camera,recorder,i)
            self.assertIsNone(pts.stream)
            self.assertEqual((root/'shared.pts').read_text().splitlines(),['0.000','40.000','80.000']*2)

    def test_old_stop_error_after_commit_retains_active_output(self):
        class BadStop(Collector):
            def stop(self): super().stop();raise ValueError('old stop failure')
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();first=BadStop();second=Collector();recorder=Recorder(first,width=32,height=32,fps=25)
            write(camera,recorder,0);recorder.split(second)
            with self.assertRaisesRegex(ValueError,'old stop'): write(camera,recorder,1)
            self.assertIs(recorder._bridge.output,second);self.assertFalse(first.recording);self.assertTrue(second.recording)
            recorder.close();self.assertFalse(second.recording)

    def test_direct_startup_failure_releases_claims_and_audio(self):
        class Bad(Collector):
            def start(self): super().start();raise ValueError('start failure')
        output=Bad()
        with self.assertRaisesRegex(ValueError,'start failure'): Recorder(output,width=32,height=32)
        self.assertFalse(output.recording)
        with Camera(simulate=True,width=32,height=32) as camera:
            with self.assertRaisesRegex(ValueError,'audio'): camera.start_recording(FileOutput(io.BytesIO()),audio={'backend':'synthetic'})
            self.assertIsNone(camera._recording)
            recording=camera.start_recording(Collector());wait_frames(recording,2);camera.stop_recording()

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_direct_aac_mp4_splits_decode_each_segment_independently(self):
        for codec in ('h264','hevc'):
            for delay in (None,120):
                with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2) as source:
                    root=Path(directory);camera.start();feed=AudioFeed(source)
                    outputs=[MuxedOutput(io.BytesIO(),io.StringIO(),format='mp4') for _ in range(2)]
                    circular=None if delay is None else {'delay_ms':delay,'max_frames':32}
                    with Recorder(outputs[0] if circular is None else None,width=128,height=96,fps=25,codec=codec,gop=100,circular=circular,audio={'sample_rate':44100,'channels':2}) as recorder:
                        if circular is not None: recorder.open_output(outputs[0])
                        for i in range(20):
                            if i==8: recorder.split(outputs[1])
                            feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
                    total=0;start_sample=0
                    for index,output in enumerate(outputs):
                        count=len(output._pts.target.getvalue().splitlines());self.assertGreater(count,0)
                        path=root/f'{index}.mp4';path.write_bytes(output.fileoutput.getvalue())
                        info=inspect(self,path,count=count,first=total,samples=count*1764,start_sample=start_sample,rate=44100,channels=2)
                        self.assertEqual(output._pts.target.getvalue().splitlines(),[f'{t//1000}.{t%1000:03}' for t in info[1]['times']])
                        total+=count;start_sample+=count*1764
                    self.assertEqual(total,20)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_old_finalization_error_keeps_pending_callbacks_until_close(self):
        class BadPatch(MuxedOutput):
            fail=False
            def _patch(self,*args):
                if self.fail: raise OSError('old finalization failure')
                return super()._patch(*args)
        with Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
            camera.start();feed=AudioFeed(source);first=BadPatch(io.BytesIO(),format='mp4');second=Collector()
            recorder=Recorder(first,width=128,height=96,fps=25,codec='h264',audio={'sample_rate':48000})
            for i in range(4): feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
            recorder.split(second);first.fail=True
            # x264 can return the requested IDR one input later.
            with self.assertRaisesRegex(OSError,'old finalization'):
                for i in range(4,10):
                    feed.through(recorder,(i+1)*40_000_000);write(camera,recorder,i)
            self.assertTrue(recorder.buffer_stats['split_pending']);self.assertTrue(first.recording);self.assertTrue(second.recording)
            self.assertFalse(second.events)
            with self.assertRaises((OSError,CameraError)): recorder.close()
            self.assertFalse(first.recording);self.assertFalse(second.recording);self.assertFalse(recorder._handle.value)

    @unittest.skipUnless(CODECS,'optional Home video codecs')
    def test_direct_elementary_split_fresh_parameters_and_independent_decode(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                camera.start();outputs=[Collector(),Collector()]
                with Recorder(outputs[0],width=128,height=96,fps=25,codec=codec,gop=100) as recorder:
                    for i in range(12):
                        if i==5: recorder.split(outputs[1])
                        write(camera,recorder,i)
                total=0
                for index,output in enumerate(outputs):
                    frames=[e[0] for e in output.events];self.assertTrue(frames);self.assertEqual(output.events[0][1]['timestamp'],0)
                    nals=frames[0].split(b'\0\0\0\1')[1:];types=(7,8) if codec=='h264' else (32,33,34)
                    kind=lambda nal: nal[0]&31 if codec=='h264' else (nal[0]>>1)&63
                    self.assertTrue(set(types).issubset(kind(nal) for nal in nals))
                    decoder=os.environ.get('ZC_INDEPENDENT_DECODER')
                    if decoder:
                        header=b''.join(b'\0\0\0\1'+nal for nal in nals if kind(nal) in types)
                        path=Path(directory)/f'{index}.aus';path.write_bytes(struct.pack('>I',len(header))+header+b''.join(struct.pack('>I',len(frame))+frame for frame in frames))
                        subprocess.run([decoder,codec,str(path),str(len(frames)),str(total)],check=True)
                    total+=len(frames)
                self.assertEqual(total,12)

if __name__=='__main__': unittest.main()
