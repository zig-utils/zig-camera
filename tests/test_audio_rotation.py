import ctypes as C
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import wave
from unittest.mock import patch
from zigcamera import Camera,CameraError,Recorder,AudioCapture,RotatingOutput,Picamera2,MJPEGEncoder,_AudioConfig,_AudioBlock,_RecordingOptions,_RecordingStats
from zigcamera.pipeline import Recording
from zigcamera.audio import AudioFeed
from check_av import parse,access_units

CODECS=os.environ.get('ZC_TEST_CODECS')=='1'

def expected(frames,start=0,channels=1):
    return b''.join(struct.pack('<h',((i%200)-100)*100*(1 if ch==0 else -1)) for i in range(start,start+frames) for ch in range(channels))

class AudioTests(unittest.TestCase):
    def test_abi_synthetic_capture_and_validation(self):
        self.assertEqual([C.sizeof(t) for t in (_AudioConfig,_AudioBlock,_RecordingOptions,_RecordingStats)],[32,24,24,72])
        with AudioCapture(backend='synthetic',channels=2,block_frames=441,sample_rate=44100,start_ns=7) as audio:
            a=audio.read(0);b=audio.read(0)
            self.assertEqual(a['data'],expected(441,channels=2));self.assertEqual(a['timestamp_ns'],7)
            self.assertEqual(b['timestamp_ns'],10000007);self.assertEqual(b['data'],expected(441,441,2))
            with self.assertRaises(ValueError): audio.read(1001)
        with self.assertRaises(RuntimeError): audio.read()
        for opts in ({'channels':3},{'sample_rate':1},{'block_frames':0},{'start_ns':2**64}):
            with self.assertRaises((CameraError,ValueError)): AudioCapture(backend='synthetic',**opts)
    def test_pcm_av_split_clips_once_and_decodes_independently(self):
        decoder=os.environ.get('ZC_INDEPENDENT_DECODER')
        for codec in (('mjpeg','h264','hevc') if CODECS else ('mjpeg',)):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                paths=[Path(directory)/f'{codec}-{n}.mkv' for n in (0,1)];camera.start()
                with AudioCapture(backend='synthetic',channels=2) as audio, Recorder(paths[0],width=128,height=96,fps=24,codec=codec,gop=0 if codec=='mjpeg' else 100,audio={'sample_rate':48000,'channels':2}) as recorder:
                    feed=AudioFeed(audio)
                    for i in range(12):
                        if i==5: recorder.split(paths[1])
                        ts=1_000_000+i*1_000_000_000//24
                        feed.through(recorder,ts+1_000_000_000//24)
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=ts)
                    self.assertEqual(recorder.stats['audio_enabled'],1)
                    self.assertLessEqual(recorder.stats['audio_queued_frames'],5000)
                payload=b'';count=0
                for path in paths:
                    info=parse(path);pcm=b''.join(p for _,p,_ in info['audio']);payload+=pcm
                    self.assertEqual(info['channels'],2);self.assertLess(info['audio'][0][0],1_000_000_000//48000)
                    if codec!='mjpeg' and decoder:
                        kind,aus=access_units(path,info);subprocess.run([decoder,kind,str(aus),str(len(info['video'])),str(count)],check=True)
                    elif codec=='mjpeg':
                        try: from PIL import Image
                        except ImportError: pass
                        else:
                            import io
                            for _,packet,_ in info['video']: Image.open(io.BytesIO(packet)).load()
                    count+=len(info['video'])
                    if os.environ.get('ZC_TEST_AUDIO')=='1':
                        import json
                        identified=json.loads(subprocess.check_output(['mkvmerge','-J',str(path)]));self.assertEqual(len(identified['tracks']),2)
                        out=path.with_suffix('.wav');subprocess.run(['mkvextract',str(path),'tracks',f'1:{out}'],check=True,stdout=subprocess.DEVNULL)
                        with wave.open(str(out),'rb') as wav:
                            self.assertEqual(wav.getframerate(),48000);self.assertEqual(wav.getnchannels(),2);self.assertEqual(wav.readframes(wav.getnframes()),pcm)
                self.assertEqual(count,12);self.assertEqual(payload,expected(24000,start=48,channels=2))
    def test_capture_gap_preserves_continuous_pcm_at_fractional_sample_boundary(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            path=Path(directory)/'gap.mkv';camera.start()
            with AudioCapture(backend='synthetic',sample_rate=44100,block_frames=441,start_ns=3_998_000_000) as source,Recorder(path,width=32,height=32,fps=25,audio={'sample_rate':44100}) as recorder:
                feed=AudioFeed(source)
                for i in range(6):
                    ts=4_000_000_000+i*40_000_000+(100_000_000 if i>=3 else 0)
                    feed.through(recorder,ts+40_000_000)
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=ts)
                self.assertEqual(recorder.stats['audio_trimmed_frames'],89)
            info=parse(path)
            self.assertEqual([t for t,_,_ in info['video']],[0,40_000_000,80_000_000,220_000_000,260_000_000,300_000_000])
            self.assertEqual(b''.join(p for _,p,_ in info['audio']),expected(14994,start=89))
    def test_pcm_queue_bounds_and_unsupported_combinations(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaises(CameraError): Recorder(root/'a.mp4',width=32,height=32,audio={'sample_rate':48000})
            with self.assertRaises(ValueError): Recorder(width=32,height=32,circular={},audio={'sample_rate':48000})
            with Recorder(root/'a.mkv',width=32,height=32,audio={'sample_rate':48000,'buffer_frames':4,'max_blocks':2}) as recorder:
                recorder.write_audio(expected(4),timestamp_ns=0)
                for data,ts,status in ((expected(1),1000000,-4),(b'x',1000000,-1)):
                    with self.assertRaises(CameraError) as failure: recorder.write_audio(data,timestamp_ns=ts)
                    self.assertEqual(failure.exception.status,status)
                self.assertEqual(recorder.stats['audio_frames'],4)
                for op in (lambda:recorder.save_buffer(root/'b.mkv'),recorder.close_output):
                    with self.assertRaises(CameraError): op()
    def test_background_facade_recording_and_audio_failure_shutdown(self):
        from test_modes_recording import wait_frames
        with tempfile.TemporaryDirectory() as directory,Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            recording=camera.start_recording(MJPEGEncoder(),Path(directory)/'a.mkv',fps=24,audio={'backend':'synthetic'})
            wait_frames(recording,6);camera.stop_recording()
            self.assertFalse(recording.thread.is_alive());self.assertFalse(recording._audio.source._handle.value)
            info=parse(Path(directory)/'a.mkv');self.assertEqual(len(b''.join(p for _,p,_ in info['audio']))//2,len(info['video'])*2000)
            with patch.object(AudioFeed,'through',side_effect=OSError('injected audio failure')):
                recording=camera.start_recording(MJPEGEncoder(),Path(directory)/'bad.mkv',audio={'backend':'synthetic'})
                deadline=time.monotonic()+5
                while recording.error is None and time.monotonic()<deadline: time.sleep(.002)
                with self.assertRaisesRegex(OSError,'injected'): camera.stop_recording()
                self.assertFalse(recording._audio.source._handle.value);self.assertEqual(camera._camera.stats['leased'],0)
    def test_clock_mismatch_and_pump_start_failure_close_owned_audio(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32) as camera:
            root=Path(directory)
            with self.assertRaises(ValueError): camera.start_recording(root/'a.mkv',audio=True)
            source=AudioCapture(backend='synthetic')
            with patch('zigcamera.AudioCapture',return_value=source),patch.object(camera,'_ensure_pump',side_effect=RuntimeError('injected startup failure')):
                with self.assertRaisesRegex(RuntimeError,'startup failure'): camera.start_recording(root/'a.mkv',audio={'backend':'synthetic'})
            self.assertFalse(source._handle.value);self.assertIsNone(camera._recording)
    def test_reader_full_queue_and_stall_are_bounded(self):
        class Source:
            backend='alsa';sample_rate=48000
            def read(self,timeout): return dict(data=expected(1),frames=1,timestamp_ns=0)
            def close(self): self.closed=True
        source=Source();feed=AudioFeed(source)
        feed.thread.join(2);self.assertFalse(feed.thread.is_alive());self.assertLessEqual(len(feed.blocks),128)
        with self.assertRaisesRegex(RuntimeError,'queue exhausted'): feed.through(None,1000)
        feed.close();self.assertTrue(source.closed)
    @unittest.skipUnless(os.environ.get('ZC_TEST_AUDIO')=='1','optional ALSA null device')
    def test_alsa_null_and_missing_device(self):
        with AudioCapture(device='null') as source:
            block=source.read(100);self.assertGreater(block['frames'],0);self.assertGreater(block['timestamp_ns'],0)
        with self.assertRaises(CameraError): AudioCapture(device='zig_camera_nonexistent_device')

class RotationTests(unittest.TestCase):
    def test_duration_and_byte_rotation_have_no_empty_tail_or_missing_samples(self):
        for audio in (False,True):
            for limits in ({'duration_ms':100},{'max_bytes':1}):
                with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
                    root=Path(directory);output=RotatingOutput(root/'segment-{index:03d}.mkv',**limits);camera.start()
                    recorder=Recorder(output.path(0),width=32,height=32,fps=24,audio={'sample_rate':48000} if audio else None,exclusive=True)
                    source=AudioCapture(backend='synthetic') if audio else None
                    recording=Recording(camera,recorder,24,audio=source,rotation=output)
                    for i in range(12):
                        with camera.acquire() as frame: recording.write(frame)
                    with self.assertRaises(RuntimeError): recording.split(root/'manual.mkv')
                    recording.close();paths=sorted(root.glob('*.mkv'));self.assertGreater(len(paths),1)
                    if audio:
                        clips=[parse(p) for p in paths];self.assertEqual(sum(len(c['video']) for c in clips),12)
                        self.assertEqual(b''.join(p for c in clips for _,p,_ in c['audio']),expected(24000))
                    else:
                        from test_modes_recording import jpeg_frames
                        self.assertEqual(sum(len(jpeg_frames(p)) for p in paths),12)
                        self.assertTrue(all(jpeg_frames(p) for p in paths))
    @unittest.skipUnless(CODECS,'optional Home codecs')
    def test_compressed_rotations_decode_and_preserve_audio(self):
        from check_mp4 import parse as mp4_parse,access_units as mp4_units
        decoder=os.environ.get('ZC_INDEPENDENT_DECODER')
        for codec in ('h264','hevc'):
            for audio in (False,True):
                suffix='mkv' if audio else 'mp4'
                with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                    root=Path(directory);output=RotatingOutput(root/f'{{index:03d}}.{suffix}',duration_ms=100);camera.start()
                    recorder=Recorder(output.path(0),width=128,height=96,codec=codec,gop=100,fps=24,audio={'sample_rate':48000} if audio else None,exclusive=True)
                    recording=Recording(camera,recorder,24,audio=AudioCapture(backend='synthetic') if audio else None,rotation=output)
                    for i in range(12):
                        with camera.acquire() as frame: recording.write(frame)
                    recording.close();count=0;payload=b'';paths=sorted(root.glob(f'*.{suffix}'));self.assertGreater(len(paths),1)
                    for path in paths:
                        if audio:
                            info=parse(path);n=len(info['video']);payload+=b''.join(p for _,p,_ in info['audio']);kind,aus=access_units(path,info)
                        else:
                            info=mp4_parse(path);n=len(info['times']);kind=codec;aus=mp4_units(path,info)
                            self.assertEqual(info['times'][0],0);self.assertTrue(info['keys'][0])
                        if decoder: subprocess.run([decoder,kind,str(aus),str(n),str(count)],check=True)
                        count+=n
                    self.assertEqual(count,12)
                    if audio: self.assertEqual(payload,expected(24000))
    def test_collision_leaves_existing_file_and_current_recording_intact(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);(root/'1.mkv').write_bytes(b'keep');camera.start()
            output=RotatingOutput(root/'{index}.mkv',max_bytes=1)
            recorder=Recorder(output.path(0),width=32,height=32,exclusive=True);recording=Recording(camera,recorder,30,rotation=output)
            with camera.acquire() as frame:
                with self.assertRaises(CameraError): recording.write(frame)
            recording.close();self.assertEqual((root/'1.mkv').read_bytes(),b'keep')
            with self.assertRaises(CameraError): Recorder(output.path(0),width=32,height=32,exclusive=True)
        for pattern,options in (('a.mkv',{'max_bytes':1}),('{index:999999999d}.mkv',{'max_bytes':1}),('{index!s}.mkv',{'max_bytes':1}),('{index}.mkv',{}),('{index}.mkv',{'duration_ms':0})):
            with self.assertRaises(ValueError): RotatingOutput(pattern,**options)

if __name__=='__main__': unittest.main()
