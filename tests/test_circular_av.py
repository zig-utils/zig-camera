"""Non-destructive pre-roll, bounded PCM eviction and independent AAC decode."""
import ctypes as C
import os
from pathlib import Path
import tempfile
import unittest
from zigcamera import Camera, Recorder, AudioCapture, CameraError, CircularOutput, Picamera2, H264Encoder, _AudioBufferStats
from zigcamera.audio import AudioFeed
from test_aac_mp4 import inspect
from check_aac_mp4 import parse

ENABLED=os.environ.get('ZC_TEST_AAC')=='1'

@unittest.skipUnless(ENABLED,'optional Home AAC')
class CircularAvTests(unittest.TestCase):
    def test_snapshot_is_repeatable_and_live_open_close_split_continue(self):
        self.assertEqual(C.sizeof(_AudioBufferStats),40)
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
                root=Path(directory);camera.start();feed=AudioFeed(source)
                with Recorder(width=128,height=96,fps=24,codec=codec,gop=4,circular={'max_frames':6},audio={'sample_rate':48000}) as recorder:
                    def write(i):
                        feed.through(recorder,(i+1)*1_000_000_000//24)
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                    for i in range(12): write(i)
                    before=recorder.buffer_stats;audio=recorder.audio_buffer_stats;recording_stats=recorder.stats
                    first=round(before['first_ns']*24/1_000_000_000);count=before['frames']
                    for name in ('one','two'):
                        recorder.save_buffer(root/f'{name}.mp4')
                        self.assertEqual(recorder.buffer_stats,before);self.assertEqual(recorder.audio_buffer_stats,audio);self.assertEqual(recorder.stats,recording_stats)
                        inspect(self,root/f'{name}.mp4',count=count,first=first,samples=count*2000,start_sample=first*2000)
                    self.assertEqual((root/'one.mp4').read_bytes(),(root/'two.mp4').read_bytes())
                    recorder.open_output(root/'live.mp4')
                    self.assertEqual(recorder.stats['audio_written_frames'],(count-1)*2000)
                    for i in range(12,16): write(i)
                    recorder.save_buffer(root/'during.mp4')
                    recorder.split(root/'split.mp4')
                    for i in range(16,20): write(i)
                    recorder.close_output()
                    for i in range(20,24): write(i)
                    recorder.open_output(root/'again.mp4')
                    for i in range(24,28): write(i)
                live=parse(root/'live.mp4');n=len(live[1]['samples'])
                inspect(self,root/'live.mp4',count=n,first=first,samples=n*2000,start_sample=first*2000)
                split=parse(root/'split.mp4');n2=len(split[1]['samples'])
                inspect(self,root/'split.mp4',count=n2,first=first+n,samples=n2*2000,start_sample=(first+n)*2000)
                again=parse(root/'again.mp4');n3=len(again[1]['samples'])
                inspect(self,root/'again.mp4',count=n3,first=28-n3,samples=n3*2000,start_sample=(28-n3)*2000)
                self.assertEqual(camera.stats['leased'],0)

    def test_audio_eviction_advances_snapshot_to_covered_keyframe(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',block_frames=480) as source:
                camera.start();feed=AudioFeed(source)
                with Recorder(width=128,height=96,fps=24,codec=codec,gop=4,circular={'max_frames':30},audio={'sample_rate':48000,'buffer_frames':24000,'max_blocks':64}) as recorder:
                    for i in range(40):
                        feed.through(recorder,(i+1)*1_000_000_000//24)
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                    audio=recorder.audio_buffer_stats;video=recorder.buffer_stats
                    self.assertLessEqual(audio['frames'],24000);self.assertLessEqual(audio['bytes'],48000);self.assertGreater(audio['evicted_frames'],0)
                    first=next(i for i in range(0,40,4) if i*1_000_000_000//24>=audio['first_ns'])
                    self.assertGreater(first,round(video['first_ns']*24/1_000_000_000))
                    count=round(video['last_ns']*24/1_000_000_000)+1-first
                    path=Path(directory)/'evicted.mp4';recorder.save_buffer(path)
                    inspect(self,path,count=count,first=first,samples=count*2000,start_sample=first*2000)
                    self.assertEqual(recorder.audio_buffer_stats,audio)

    def test_empty_and_uncovered_history_leave_existing_file_intact(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
            path=Path(directory)/'keep.mp4';path.write_bytes(b'keep');camera.start()
            with Recorder(width=128,height=96,fps=24,codec='hevc',gop=100,circular={},audio={'sample_rate':48000,'buffer_frames':2400}) as recorder:
                with self.assertRaises(CameraError): recorder.save_buffer(path)
                for i in range(4):
                    recorder.write_audio(bytes(4000),timestamp_ns=i*1_000_000_000//24)
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                with self.assertRaises(CameraError): recorder.save_buffer(path)
                self.assertEqual(path.read_bytes(),b'keep')

    def test_late_audio_and_video_gaps_keep_sample_clock(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2,block_frames=441,start_ns=4_002_000_000) as source:
                camera.start();feed=AudioFeed(source);path=Path(directory)/'offset.mp4'
                with Recorder(width=128,height=96,fps=25,codec=codec,gop=4,circular={},audio={'sample_rate':44100,'channels':2}) as recorder:
                    for i in range(6):
                        ts=4_000_000_000+i*40_000_000+(100_000_000 if i>=3 else 0)
                        feed.through(recorder,ts+40_000_000)
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=ts)
                    count=recorder.buffer_stats['frames'];end=300_000_000 if count==5 else 340_000_000
                    samples=((end-2_000_000)*44100+999_999_999)//1_000_000_000
                    recorder.save_buffer(path)
                    info=inspect(self,path,count=count,samples=samples,offset_us=2000,rate=44100,channels=2)
                    self.assertEqual(info[1]['times'],[0,40000,80000,220000,260000,300000][:count])

    def test_missing_audio_coverage_is_retryable_without_truncation(self):
        from test_audio_rotation import expected
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
            camera.start();path=Path(directory)/'keep.mp4';path.write_bytes(b'keep')
            with Recorder(width=128,height=96,fps=25,codec='hevc',gop=4,circular={},audio={'sample_rate':48000}) as recorder:
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
                with self.assertRaises(CameraError): recorder.save_buffer(path)
                self.assertEqual(path.read_bytes(),b'keep')
                recorder.write_audio(expected(480),timestamp_ns=0)
                with self.assertRaises(CameraError) as failure: recorder.save_buffer(path)
                self.assertEqual(failure.exception.status,-4);self.assertEqual(path.read_bytes(),b'keep')
                recorder.write_audio(expected(1440,start=480),timestamp_ns=10_000_000)
                recorder.save_buffer(path);inspect(self,path,count=1,samples=1920)

    def test_live_output_history_overrun_fails_and_releases_resources(self):
        from test_audio_rotation import expected
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
            camera.start();recorder=Recorder(width=128,height=96,fps=25,codec='hevc',circular={},audio={'sample_rate':48000,'buffer_frames':1920})
            recorder.open_output(Path(directory)/'live.mp4')
            recorder.write_audio(expected(1920),timestamp_ns=0)
            with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            with self.assertRaises(CameraError) as failure: recorder.write_audio(expected(1920,start=1920),timestamp_ns=40_000_000)
            self.assertEqual(failure.exception.status,-4)
            with self.assertRaises(CameraError): recorder.close()
            self.assertFalse(recorder._handle.value);self.assertEqual(camera.stats['leased'],0)

    def test_facade_background_audio_and_snapshot(self):
        from test_modes_recording import wait_frames
        with tempfile.TemporaryDirectory() as directory,Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(128,96)}))
            circular=CircularOutput(max_frames=6)
            recording=camera.start_recording(H264Encoder(iperiod=4),circular,fps=24,audio={'backend':'synthetic','codec':'aac'})
            wait_frames(recording,12)
            path=Path(directory)/'snapshot.mp4';circular.save(path)
            self.assertGreater(circular.audio_stats['frames'],0)
            info=parse(path);n=len(info[1]['samples']);self.assertEqual(info[2]['presented_frames'],n*2000)
            camera.stop_recording();self.assertFalse(recording._audio.source._handle.value)

if __name__=='__main__': unittest.main()
