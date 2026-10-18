import os
from pathlib import Path
import tempfile
import time
import unittest
from zigcamera import Camera, CameraError, Recorder, Picamera2, H264Encoder, HEVCEncoder

ENABLED=os.environ.get('ZC_TEST_CODECS')=='1'

def make_clip(path,codec,*,gap=False):
    with Camera(simulate=True,width=128,height=96,role='video',policy='fifo') as camera:
        camera.start()
        with Recorder(path,width=128,height=96,fps=24,codec=codec,gop=4,quality=90) as recorder:
            for i in range(12):
                with camera.acquire() as frame:
                    recorder.write(frame,timestamp_ns=i*1_000_000_000//24+(100_000_000 if gap and i>=6 else 0))
        assert camera.stats['leased']==0

class CodecTests(unittest.TestCase):
    @unittest.skipIf(ENABLED,'optional codecs enabled')
    def test_disabled_codecs_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(CameraError) as error: Recorder(Path(directory)/'unavailable.mp4',width=32,height=32,codec='h264')
            self.assertEqual(error.exception.status,-8)
    @unittest.skipUnless(ENABLED,'optional Home codec job')
    def test_codec_constraints_and_monotonic_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            for codec in ('h264','hevc'):
                for width,height in ((17,16),(16,17),(8,8)):
                    with self.assertRaises(CameraError): Recorder(Path(directory)/'invalid.mp4',width=width,height=height,codec=codec)
                with self.assertRaises(CameraError): Recorder(Path(directory)/'wrong.mkv',width=32,height=32,codec=codec)
                with Camera(simulate=True,width=32,height=32,role='video',policy='fifo') as camera:
                    camera.start()
                    with Recorder(Path(directory)/f'{codec}.mp4',width=32,height=32,codec=codec,bitrate=100_000,gop=2) as recorder:
                        with camera.acquire() as frame:
                            recorder.write(frame,timestamp_ns=1000)
                            for invalid in (1000,999,1999):
                                with self.assertRaises(CameraError) as error: recorder.write(frame,timestamp_ns=invalid)
                                self.assertEqual(error.exception.status,-1)
                            recorder.write(frame,timestamp_ns=40000)
                    self.assertEqual(camera.stats['leased'],0)
    @unittest.skipUnless(ENABLED,'optional Home codec job')
    def test_picamera_recording_drains_and_restarts(self):
        with tempfile.TemporaryDirectory() as directory:
            with Picamera2(simulate=True) as camera:
                camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
                for encoder in (H264Encoder(bitrate=100_000,iperiod=4),HEVCEncoder(bitrate=100_000,iperiod=4)):
                    recording=camera.start_recording(encoder,Path(directory)/f'{type(encoder).__name__}.mp4',fps=24)
                    deadline=time.monotonic()+3
                    while recording.frames<6 and recording.error is None and time.monotonic()<deadline: time.sleep(.005)
                    camera.stop_recording()
                    self.assertGreaterEqual(recording.frames,6)
                    self.assertFalse(recording.thread.is_alive())
                    self.assertEqual(camera._camera.stats['leased'],0)
                camera.stop()

if __name__=='__main__':
    import sys
    directory=Path(sys.argv[1])
    for codec in ('h264','hevc'):
        for gap in (False,True):
            path=directory/f'home-{codec}{"-gap" if gap else ""}.mp4'
            make_clip(path,codec,gap=gap)
