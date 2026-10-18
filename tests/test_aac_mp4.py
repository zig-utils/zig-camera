import array
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from zigcamera import Camera,CameraError,Recorder,AudioCapture,RotatingOutput,Picamera2,H264Encoder
from zigcamera.pipeline import Recording
from zigcamera.audio import AudioFeed
from check_aac_mp4 import parse,audio_units,video_units

ENABLED=os.environ.get('ZC_TEST_AAC')=='1'

def waveform(frames,start=0,channels=1):
    return [((i%200)-100)*100*(1 if c==0 else -1) for i in range(start,start+frames) for c in range(channels)]

def inspect(test,path,*,count,first=0,samples,start_sample=0,offset_us=0,rate=48000,channels=1):
    tracks=parse(path);video,audio=tracks[1],tracks[2]
    test.assertEqual(len(video['samples']),count);test.assertEqual(video['times'][0],0);test.assertTrue(video['keys'][0])
    test.assertEqual(audio['rate'],rate);test.assertEqual(audio['channels'],channels)
    test.assertEqual(audio['presented_frames'],samples);test.assertEqual(audio['start_us'],offset_us)
    test.assertEqual(audio['presented_us'],samples*1_000_000//rate)
    test.assertGreater(audio['delay'],0);test.assertLessEqual(len(audio['samples'])*1024-audio['delay']-samples,1023)
    decoder=os.environ.get('ZC_INDEPENDENT_DECODER')
    if decoder:
        codec,aus=video_units(path,video);subprocess.run([decoder,codec,str(aus),str(count),str(first)],check=True)
    decoder=os.environ.get('ZC_AAC_DECODER')
    if decoder:
        pcm=path.with_suffix('.pcm');subprocess.run([decoder,str(audio_units(path,audio)),str(pcm)],check=True)
        values=array.array('h');values.frombytes(pcm.read_bytes())
        import sys
        if sys.byteorder!='little': values.byteswap()
        test.assertEqual(len(values),len(audio['samples'])*1024*channels)
        actual=values[audio['delay']*channels:(audio['delay']+samples)*channels]
        expected=waveform(samples,start_sample,channels)
        rmse=math.sqrt(sum((a-b)**2 for a,b in zip(actual,expected))/len(expected))
        test.assertLess(rmse,1500,('decoded waveform/priming/channel order',path.name,rmse))
        # A one-sample shift is visible at this sawtooth's sharp boundaries;
        # explicit timing checks supplement the lossy waveform bound.
        test.assertEqual(len(actual),len(expected))
    apple=os.environ.get('ZC_APPLE_AAC_DECODER')
    if apple:
        padding=round(offset_us*rate/1_000_000)
        pcm=path.with_suffix('.apple.pcm');subprocess.run([apple,str(path),str(pcm),str(samples+padding),'0.0'],check=True)
        values=array.array('h');values.frombytes(pcm.read_bytes())
        selftest=[0]*(padding*channels)+waveform(samples,start_sample,channels)
        test.assertEqual(len(values),len(selftest))
        test.assertLess(math.sqrt(sum((a-b)**2 for a,b in zip(values,selftest))/len(selftest)),1500)
    if os.environ.get('ZC_TEST_AUDIO')=='1':
        import json
        identified=json.loads(subprocess.check_output(['mkvmerge','-J',str(path)]))
        test.assertEqual(len(identified['tracks']),2)
        test.assertEqual(identified['tracks'][1]['properties']['codec_id'],'A_AAC')
    return tracks

class AacTests(unittest.TestCase):
    @unittest.skipIf(ENABLED,'AAC enabled')
    def test_disabled_aac_is_explicit(self):
        if os.environ.get('ZC_TEST_CODECS')!='1': return
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(CameraError) as error: Recorder(Path(directory)/'no.mp4',width=32,height=32,codec='h264',audio={'sample_rate':48000})
            self.assertEqual(error.exception.status,-8)
    @unittest.skipUnless(ENABLED,'optional Home AAC')
    def test_offsets_partial_tail_rates_and_independent_decode(self):
        for codec in ('h264','hevc'):
            for rate,channels,offset in ((48000,2,0),(44100,1,2_000_000)):
                with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                    path=Path(directory)/'clip.mp4';camera.start()
                    with AudioCapture(backend='synthetic',sample_rate=rate,channels=channels,start_ns=4_000_000_000+offset) as source,Recorder(path,width=128,height=96,fps=24,codec=codec,gop=4,audio={'sample_rate':rate,'channels':channels,'codec':'aac','bitrate':128000}) as recorder:
                        feed=AudioFeed(source)
                        for i in range(12):
                            ts=4_000_000_000+i*1_000_000_000//24
                            feed.through(recorder,ts+1_000_000_000//24)
                            with camera.acquire() as frame: recorder.write(frame,timestamp_ns=ts)
                    cut=4_000_000_000+11*1_000_000_000//24+1_000_000_000//24
                    samples=((cut-(4_000_000_000+offset))*rate+999_999_999)//1_000_000_000
                    inspect(self,path,count=12,samples=samples,offset_us=offset//1000,rate=rate,channels=channels)
    @unittest.skipUnless(ENABLED,'optional Home AAC')
    def test_sub_aac_frame_clip_and_drain(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
            path=Path(directory)/'short.mp4';camera.start()
            with Recorder(path,width=128,height=96,fps=100,codec='h264',audio={'sample_rate':48000}) as recorder:
                recorder.write_audio(struct.pack('<480h',*waveform(480)),timestamp_ns=0)
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            inspect(self,path,count=1,samples=480)
    @unittest.skipUnless(ENABLED,'optional Home AAC')
    def test_video_capture_gap_keeps_audio_clock_and_content(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
            path=Path(directory)/'gap.mp4';camera.start()
            with AudioCapture(backend='synthetic') as source,Recorder(path,width=128,height=96,fps=25,codec='h264',audio={'sample_rate':48000}) as recorder:
                feed=AudioFeed(source)
                for i in range(6):
                    ts=i*40_000_000+(100_000_000 if i>=3 else 0)
                    feed.through(recorder,ts+40_000_000)
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=ts)
            info=inspect(self,path,count=6,samples=16320)
            self.assertEqual(info[1]['times'],[0,40000,80000,220000,260000,300000])
    @unittest.skipUnless(ENABLED,'optional Home AAC')
    def test_split_and_rotation_are_independent_and_sample_exact(self):
        for codec in ('h264','hevc'):
            for rotate in (False,True):
                with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                    root=Path(directory);camera.start()
                    output=RotatingOutput(root/'{index:03d}.mp4',duration_ms=100) if rotate else None
                    recorder=Recorder(root/'000.mp4',width=128,height=96,fps=24,codec=codec,gop=100,audio={'sample_rate':48000},exclusive=rotate)
                    if rotate:
                        recording=Recording(camera,recorder,24,audio=AudioCapture(backend='synthetic'),rotation=output)
                    else: source=AudioCapture(backend='synthetic');feed=AudioFeed(source)
                    for i in range(12):
                        if not rotate:
                            if i==5: recorder.split(root/'001.mp4')
                            feed.through(recorder,(i+1)*1_000_000_000//24)
                        with camera.acquire() as frame:
                            if rotate: recording.write(frame)
                            else: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                    if rotate: recording.close()
                    else: recorder.close();source.close()
                    paths=sorted(root.glob('*.mp4'));self.assertGreater(len(paths),1);first=0;audio_total=0
                    for path in paths:
                        info=parse(path);count=len(info[1]['samples']);samples=info[2]['presented_frames']
                        inspect(self,path,count=count,first=first,samples=samples,start_sample=audio_total,offset_us=info[2]['start_us'])
                        self.assertEqual(samples,count*2000);first+=count;audio_total+=samples
                    self.assertEqual(first,12);self.assertEqual(audio_total,24000)
    @unittest.skipUnless(ENABLED,'optional Home AAC')
    def test_background_mp4_audio_and_restart(self):
        from test_modes_recording import wait_frames
        with tempfile.TemporaryDirectory() as directory,Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(128,96)}))
            for i in range(2):
                path=Path(directory)/f'{i}.mp4'
                recording=camera.start_recording(H264Encoder(iperiod=4),path,fps=24,audio={'backend':'synthetic','codec':'aac','bitrate':128000})
                wait_frames(recording,6);camera.stop_recording();info=parse(path)
                self.assertEqual(info[2]['presented_frames'],len(info[1]['samples'])*2000)
                self.assertFalse(recording.thread.is_alive());self.assertFalse(recording._audio.source._handle.value)
    @unittest.skipUnless(ENABLED,'optional Home AAC')
    def test_invalid_settings_do_not_truncate_and_pcm_gap_fails_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'keep.mp4';path.write_bytes(b'keep')
            for audio in ({'sample_rate':12345},{'sample_rate':48000,'channels':3},{'sample_rate':48000,'bitrate':10},{'sample_rate':96000}):
                with self.assertRaises(CameraError): Recorder(path,width=32,height=32,codec='h264',audio=audio)
                self.assertEqual(path.read_bytes(),b'keep')
            with self.assertRaises(ValueError): Recorder(path,width=32,height=32,codec='h264',audio={'sample_rate':48000,'codec':'pcm'})
            with Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                camera.start();recorder=Recorder(Path(directory)/'gap.mp4',width=128,height=96,codec='h264',fps=25,audio={'sample_rate':48000})
                recorder.write_audio(struct.pack('<1920h',*waveform(1920)),timestamp_ns=0)
                for i in range(2):
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
                recorder.write_audio(struct.pack('<1920h',*waveform(1920)),timestamp_ns=100_000_000)
                with self.assertRaises(CameraError):
                    for i in range(2,5):
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
                with self.assertRaises(CameraError): recorder.close()
                self.assertFalse(recorder._handle.value);self.assertEqual(camera.stats['leased'],0)
                partial=parse(Path(directory)/'gap.mp4');self.assertEqual(partial[2]['presented_frames'],1920)

if __name__=='__main__': unittest.main()
