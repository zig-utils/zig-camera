import ctypes as C
import io
import os
from pathlib import Path
import struct
import tempfile
import unittest
from zigcamera import Camera,Recorder,AudioCapture,Output,FileOutput,MuxedOutput,CircularOutput2,Picamera2,MJPEGEncoder,CameraError,_OutputPacket,_OutputCallbacks
from zigcamera.audio import AudioFeed
from test_audio_rotation import expected
from check_av import parse as mkv
from test_aac_mp4 import inspect
from check_aac_mp4 import parse as mp4
AAC=os.environ.get('ZC_TEST_AAC')=='1'
CODECS=os.environ.get('ZC_TEST_CODECS')=='1'

class OutputTests(unittest.TestCase):
    def test_abi_muxed_stream_reuse_pts_and_borrowed_ownership(self):
        self.assertEqual((C.sizeof(_OutputPacket),C.sizeof(_OutputCallbacks)),(32,56))
        media=io.BytesIO();pts=io.StringIO();output=MuxedOutput(media,pts,format='mkv')
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
            camera.start();feed=AudioFeed(source)
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':80},audio={'sample_rate':48000}) as recorder:
                def write(i):
                    feed.through(recorder,(i+1)*40_000_000)
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
                recorder.open_output(output)
                for i in range(8): write(i)
                recorder.close_output();self.assertFalse(output.recording);self.assertFalse(media.closed);self.assertFalse(pts.closed)
                path=Path(directory)/'first.mkv';path.write_bytes(media.getvalue());info=mkv(path)
                self.assertEqual(len(info['video']),6);self.assertEqual(b''.join(p for _,p,_ in info['audio']),expected(6*1920))
                self.assertEqual(pts.getvalue().splitlines(),[f'{i*40}.000' for i in range(6)])
                recorder.open_output(output)
                for i in range(8,12): write(i)
            path=Path(directory)/'second.mkv';path.write_bytes(media.getvalue());info=mkv(path)
            self.assertEqual(len(info['video']),6);self.assertEqual(b''.join(p for _,p,_ in info['audio']),expected(6*1920,start=6*1920))
            self.assertEqual(pts.getvalue().splitlines()[6:],[f'{i*40}.000' for i in range(6)])
        self.assertFalse(media.closed);self.assertFalse(pts.closed)

    def test_file_output_and_circular_pts_paths_are_reusable(self):
        from test_modes_recording import wait_frames
        with tempfile.TemporaryDirectory() as directory,Picamera2(simulate=True) as camera:
            root=Path(directory);camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            circular_pts=io.BytesIO();history=CircularOutput2(circular_pts,80,max_frames=16)
            output=FileOutput(root/'frames.mjpg',root/'frames.pts')
            for n in range(2):
                recording=camera.start_recording(MJPEGEncoder(),history,fps=25)
                history.open_output(output);wait_frames(recording,8);camera.stop_recording()
                self.assertFalse(output.recording);self.assertFalse(circular_pts.closed)
                lines=(root/'frames.pts').read_text().splitlines();self.assertGreaterEqual(len(lines),6);self.assertEqual(lines[0],'0.000')
                # Concatenated elementary JPEG frames carry no container headers.
                data=(root/'frames.mjpg').read_bytes();self.assertTrue(data.startswith(b'\xff\xd8'));self.assertEqual(data.count(b'\xff\xd8'),len(lines))
            self.assertGreater(circular_pts.getvalue().count(b'0.000\n'),1)

    def test_custom_output_receives_owned_packets_stream_info_and_rebased_pcm(self):
        class Collector(Output):
            def __init__(self): super().__init__();self.events=[];self.streams=[];self.starts=0;self.stops=0
            def start(self): super().start();self.starts+=1
            def stop(self): self.stops+=1;super().stop()
            def _add_stream(self,info,codec,**kwargs): self.streams.append((info,codec,kwargs))
            def outputframe(self,frame,keyframe=True,timestamp=None,packet=None,audio=False): self.events.append((frame,keyframe,timestamp,packet,audio))
        output=Collector()
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera,AudioCapture(backend='synthetic',start_ns=4_002_000_000,sample_rate=44100,channels=2,block_frames=441) as source:
            camera.start();feed=AudioFeed(source)
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':80},audio={'sample_rate':44100,'channels':2}) as recorder:
                recorder.open_output(output)
                for i in range(6):
                    ts=4_000_000_000+i*40_000_000+(100_000_000 if i>=3 else 0)
                    feed.through(recorder,ts+40_000_000)
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=ts)
            video=[e for e in output.events if not e[4]];audio=[e for e in output.events if e[4]]
            self.assertEqual([e[2] for e in video],[0,40000,80000,220000,260000,300000]);self.assertTrue(video[0][1])
            self.assertEqual(audio[0][2],2000);self.assertEqual(audio[0][3].timestamp_ns,2_000_000)
            self.assertEqual(b''.join(e[0] for e in audio),expected(14906,channels=2))
            self.assertEqual([e[1] for e in output.streams],['mjpeg','pcm_s16le'])
            self.assertEqual(output.streams[1][0].sample_rate,44100);self.assertEqual(output.streams[1][2]['channels'],2)
            self.assertEqual((output.starts,output.stops),(1,1));self.assertTrue(video[0][0].startswith(b'\xff\xd8'))

    def test_native_identity_checks_preserve_media_pts_and_snapshots(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();root=Path(directory);media=root/'media.mkv';media.write_bytes(b'keep');alias=root/'alias.pts';os.link(media,alias)
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':80}) as recorder:
                with self.assertRaises((CameraError,ValueError)): recorder.open_output(MuxedOutput(media,alias))
                self.assertEqual(media.read_bytes(),b'keep')
                pts=root/'good.mkv';output=MuxedOutput(media,pts);recorder.open_output(output)
                for i in range(8):
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
                before=pts.read_bytes()
                with self.assertRaises(CameraError): recorder.save_buffer(pts,wait=False)
                self.assertEqual(pts.read_bytes(),before)
                recorder.close_output()
                # A queued snapshot reservation also excludes a PTS target.
                from unittest.mock import patch
                from zigcamera.jobs import OperationJob
                snap=root/'reserved.mkv';snap.write_bytes(b'preserve')
                with patch.object(OperationJob,'start',lambda job:job): job=recorder.save_buffer(snap,wait=False)
                try:
                    with self.assertRaises(CameraError): recorder.open_output(MuxedOutput(root/'other.mkv',snap))
                    self.assertEqual(snap.read_bytes(),b'preserve')
                finally: self.assertTrue(job.cancel())

    def test_failures_reentry_and_short_writes_release_objects(self):
        class Short(io.BytesIO):
            def write(self,data): return super().write(data[:3])
        class Failing(Output):
            def outputframe(self,*args,**kwargs): raise ValueError('injected packet error')
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();output=Failing()
            recorder=Recorder(width=32,height=32,circular={'delay_ms':0});recorder.open_output(output)
            with self.assertRaisesRegex(ValueError,'injected packet'):
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            with self.assertRaises(CameraError): recorder.close()
            self.assertFalse(output.recording);self.assertEqual(camera.stats['leased'],0)
            stream=Short()
            with Recorder(width=32,height=32,circular={'delay_ms':0}) as recorder:
                recorder.open_output(FileOutput(stream))
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            self.assertTrue(stream.getvalue().startswith(b'\xff\xd8'));self.assertFalse(stream.closed)
            class Reentrant(Output):
                def outputframe(self,*args,**kwargs): recorder.close()
            recorder=Recorder(width=32,height=32,circular={'delay_ms':0});output=Reentrant();recorder.open_output(output)
            with self.assertRaisesRegex(RuntimeError,'re-entry'):
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            with self.assertRaises(CameraError): recorder.close()
            self.assertFalse(output.recording)

    def test_attachment_failures_keep_objects_reusable_and_reject_audio_fileoutput(self):
        class NoProgress(io.BytesIO):
            def write(self,data): return 0
        class BadStart(Output):
            def start(self): super().start();raise ValueError('injected start error')
        class BadMetadata(Output):
            def _add_stream(self,*args,**kwargs): raise ValueError('injected metadata error')
        class BadStop(Output):
            def stop(self): super().stop();raise ValueError('injected stop error')
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(width=32,height=32,circular={'delay_ms':0}) as recorder:
                for output in (BadStart(),BadMetadata()):
                    with self.assertRaisesRegex(ValueError,'injected'): recorder.open_output(output)
                    self.assertFalse(output.recording);self.assertEqual(recorder.buffer_stats['output_open'],0)
                output=MuxedOutput(NoProgress(),format='mkv')
                with self.assertRaisesRegex(OSError,'progress'): recorder.open_output(output)
                self.assertFalse(output.recording);self.assertEqual(recorder.buffer_stats['output_open'],0)
                output=BadStop();recorder.open_output(output)
                with self.assertRaisesRegex(ValueError,'stop error'): recorder.close_output()
                self.assertFalse(output.recording);self.assertEqual(recorder.buffer_stats['output_open'],0)
                recorder.open_output(Output());recorder.close_output()
            with Recorder(width=32,height=32,circular={'delay_ms':0},audio={'sample_rate':48000}) as recorder:
                output=FileOutput(io.BytesIO())
                with self.assertRaisesRegex(ValueError,'audio'): recorder.open_output(output)
                self.assertFalse(output.recording)

    def test_empty_accepted_session_clears_owned_media_and_pts(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);media=root/'old.h264';pts=root/'old.pts'
            media.write_bytes(b'old media');pts.write_text('old pts')
            output=FileOutput(media,pts)
            with Recorder(width=32,height=32,circular={'delay_ms':1000}) as recorder:
                recorder.open_output(output);recorder.close_output()
            self.assertEqual(media.read_bytes(),b'');self.assertEqual(pts.read_bytes(),b'')

    def test_lifecycle_hooks_cannot_close_their_recorder_during_attachment(self):
        class StartReentry(Output):
            def start(self): super().start();recorder.close()
        class MetadataReentry(Output):
            def _add_stream(self,*args,**kwargs): recorder.close()
        with Recorder(width=32,height=32,circular={'delay_ms':0}) as recorder:
            for output in (StartReentry(),MetadataReentry()):
                with self.assertRaisesRegex(RuntimeError,'re-entry'): recorder.open_output(output)
                self.assertFalse(output.recording);self.assertEqual(recorder.buffer_stats['output_open'],0)
            recorder.open_output(Output());recorder.close_output()

    def test_plain_delayed_paths_keep_native_route_and_path_splits(self):
        from test_modes_recording import wait_frames
        with tempfile.TemporaryDirectory() as directory,Picamera2(simulate=True) as camera:
            root=Path(directory);camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            delayed=CircularOutput2(buffer_duration_ms=80,max_frames=16)
            recording=camera.start_recording(MJPEGEncoder(),delayed,fps=25)
            delayed.open_output(root/'first.mkv');self.assertIsNone(recording.recorder._bridge)
            with self.assertRaisesRegex(RuntimeError,'Close output'): delayed.ptsoutput=io.StringIO()
            wait_frames(recording,8)
            job=recording.split(root/'next.mkv');job.result(5)
            wait_frames(recording,recording.frames+4);camera.stop_recording()
            self.assertTrue((root/'first.mkv').exists());self.assertTrue((root/'next.mkv').exists())

    def test_single_attachment_and_pts_only_video_exact_format(self):
        data=io.BytesIO();pts=io.StringIO();output=FileOutput(data,pts)
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(width=32,height=32,circular={'delay_ms':0}) as a,Recorder(width=32,height=32,circular={'delay_ms':0}) as b:
                a.open_output(output)
                with self.assertRaisesRegex(RuntimeError,'attached'): b.open_output(output)
                with camera.acquire() as frame: a.write(frame,timestamp_ns=7_000_000_000)
                a.close_output();b.open_output(output)
                for i in range(3):
                    with camera.acquire() as frame: b.write(frame,timestamp_ns=8_000_000_000+i*41_666_000)
            self.assertEqual(pts.getvalue().splitlines(),['0.000','0.000','41.666','83.332'])
            self.assertFalse(pts.closed);self.assertFalse(data.closed)

    def test_pts_error_and_duck_output_lifecycles(self):
        class BadPts(io.StringIO):
            def write(self,line): raise OSError('injected PTS error')
        class Duck:
            def __init__(self): self.recording=False;self.frames=[];self.stops=0
            def start(self): self.recording=True
            def stop(self): self.recording=False;self.stops+=1
            def outputframe(self,frame,**kwargs): self.frames.append((frame,kwargs))
        with Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();output=Duck()
            with Recorder(width=32,height=32,circular={'delay_ms':0}) as recorder:
                recorder.open_output(output)
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            self.assertEqual(output.stops,1);self.assertTrue(output.frames[0][0].startswith(b'\xff\xd8'))
            pts=BadPts();output=FileOutput(io.BytesIO(),pts)
            recorder=Recorder(width=32,height=32,circular={'delay_ms':0});recorder.open_output(output)
            with self.assertRaisesRegex(OSError,'PTS error'):
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            with self.assertRaises(CameraError): recorder.close()
            self.assertFalse(output.recording);self.assertFalse(pts.closed)
            text=io.StringIO('preserve')
            with Recorder(width=32,height=32,circular={'delay_ms':0}) as recorder:
                with self.assertRaises(TypeError): recorder.open_output(MuxedOutput(text,format='mkv'))
                self.assertEqual(text.getvalue(),'preserve')

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_aac_rejects_nonseekable_stream_before_writing(self):
        class Sink:
            def __init__(self): self.data=bytearray()
            def write(self,data): self.data.extend(data);return len(data)
        sink=Sink();output=MuxedOutput(sink,format='mp4')
        with Recorder(width=32,height=32,codec='h264',circular={'delay_ms':0},audio={'sample_rate':48000}) as recorder:
            with self.assertRaises(CameraError): recorder.open_output(output)
            self.assertEqual(sink.data,b'');self.assertFalse(output.recording)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_home_mp4_filelike_and_pts_independently_decode(self):
        for codec in ('h264','hevc'):
            media=io.BytesIO();pts=io.StringIO();output=MuxedOutput(media,pts,format='mp4')
            for session in range(2):
                with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
                    camera.start();feed=AudioFeed(source)
                    with Recorder(width=128,height=96,fps=24,codec=codec,gop=4,circular={'delay_ms':100},audio={'sample_rate':48000}) as recorder:
                        recorder.open_output(output)
                        for i in range(12):
                            feed.through(recorder,(i+1)*1_000_000_000//24)
                            with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                    path=Path(directory)/'stream.mp4';path.write_bytes(media.getvalue());info=inspect(self,path,count=12,samples=24000)
                    self.assertEqual(pts.getvalue().splitlines()[session*12:(session+1)*12],[f'{t//1000}.{t%1000:03}' for t in info[1]['times']])
                    self.assertFalse(media.closed);self.assertFalse(pts.closed)

    @unittest.skipUnless(CODECS,'optional Home video codecs')
    def test_elementary_annex_b_has_fresh_parameters_and_decodes(self):
        decoder=os.environ.get('ZC_INDEPENDENT_DECODER')
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                camera.start();data=io.BytesIO();pts=io.StringIO();frames=[]
                class Tap(FileOutput):
                    def outputframe(self,frame,*args,**kwargs): frames.append(frame);super().outputframe(frame,*args,**kwargs)
                output=Tap(data,pts)
                with Recorder(width=128,height=96,fps=24,codec=codec,gop=4,circular={'delay_ms':100}) as recorder:
                    recorder.open_output(output)
                    for i in range(12):
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                self.assertEqual(len(frames),12);self.assertEqual(len(pts.getvalue().splitlines()),12)
                nals=frames[0].split(b'\0\0\0\1')[1:]
                kinds=[nal[0]&31 if codec=='h264' else (nal[0]>>1)&63 for nal in nals]
                self.assertTrue(set((7,8) if codec=='h264' else (32,33,34)).issubset(kinds))
                if decoder:
                    import subprocess
                    path=Path(directory)/'raw.aus'
                    # Decoder helper consumes a header access unit followed by frames.
                    # Split parameter NALs out of the first access unit for that protocol.
                    parameters=[nal for nal in nals if (nal[0]&31 if codec=='h264' else (nal[0]>>1)&63) in ((7,8) if codec=='h264' else (32,33,34))]
                    header=b''.join(b'\0\0\0\1'+nal for nal in parameters)
                    path.write_bytes(struct.pack('>I',len(header))+header+b''.join(struct.pack('>I',len(frame))+frame for frame in frames))
                    subprocess.run([decoder,codec,str(path),'12','0'],check=True)

if __name__=='__main__': unittest.main()
