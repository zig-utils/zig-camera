import ctypes as C
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from zigcamera import Camera, CameraError, Recorder, Preview, _CaptureOptions, _RawMetadata, _VideoConfig

class MediaTests(unittest.TestCase):
    def test_additive_abi_and_open_options(self):
        self.assertEqual(C.sizeof(_CaptureOptions),16)
        self.assertEqual(C.sizeof(_RawMetadata),184)
        self.assertEqual(C.sizeof(_VideoConfig),32)
        with self.assertRaises(CameraError): Camera(simulate=True,unpacked_raw=True)
        with self.assertRaises(CameraError): Camera(simulate=True,noise_reduction=5)
    def test_home_jpeg_and_dng_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            jpg=Path(directory)/'frame.jpg'; dng=Path(directory)/'frame.dng'
            with Camera(simulate=True,width=128,height=96,raw=True,unpacked_raw=True) as cam:
                cam.start()
                with cam.acquire() as frame:
                    frame.save_jpeg(jpg);frame.save_dng(dng)
                    self.assertEqual(frame.raw_metadata['valid'],7)
                    self.assertEqual(frame.raw_metadata['model'],'zig-camera synthetic')
                self.assertEqual(cam.stats['leased'],0)
            self.assertTrue(jpg.read_bytes().endswith(b'\xff\xd9'))
            self.assertEqual(dng.read_bytes()[:4],b'II*\0')
            try:
                from PIL import Image
            except ImportError: return
            image=Image.open(jpg); image.load()
            self.assertEqual(image.size,(128,96))
            self.assertTrue(all(abs(a-b)<=5 for a,b in zip(image.getpixel((60,25)),(60,25,111))))
            try:
                import tifffile
                import rawpy
            except ImportError: return
            with tifffile.TiffFile(dng) as file:
                self.assertEqual(file.asarray()[7,5],405)
                self.assertEqual(file.pages[0].tags[50717].value,4095)
            with rawpy.imread(str(dng)) as raw:
                self.assertEqual(raw.white_level,4095)
                self.assertEqual(raw.black_level_per_channel,[64]*4)
                self.assertEqual(raw.postprocess(use_camera_wb=True).shape,(96,128,3))
    def test_record_timestamp_validation_and_release(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'clip.mkv'
            with Camera(simulate=True,width=17,height=9,role='video',policy='fifo') as cam:
                cam.start()
                with Recorder(path,width=17,height=9,fps=24) as recorder:
                    for i in range(12):
                        with cam.acquire() as frame:
                            recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                            if i==0:
                                with self.assertRaises(CameraError) as error: recorder.write(frame,timestamp_ns=0)
                                self.assertEqual(error.exception.status,-1)
                self.assertEqual(cam.stats['leased'],0)
            data=path.read_bytes()
            self.assertTrue(data.startswith(b'\x1aE\xdf\xa3'))
            self.assertIn(b'V_MJPEG',data)
            self.assertEqual(data.count(b'\xff\xd8'),12)
            with self.assertRaises(CameraError): Recorder(Path(directory)/'bad.mp4',width=17,height=9)
    def test_background_recording_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            with Camera(simulate=True,width=16,height=16,role='video') as cam:
                recording=cam.start_recording(Path(directory)/'background.mkv')
                time.sleep(0.03)
                cam.stop_recording()
                self.assertFalse(recording.thread.is_alive())
                self.assertEqual(cam.stats['leased'],0)
    @unittest.skipUnless(os.environ.get('ZC_TEST_PREVIEW')=='1','SDL headless preview job')
    def test_sdl_preview_and_thread_contract(self):
        with Camera(simulate=True,width=17,height=9) as cam:
            cam.start()
            with Preview(17,9) as window:
                with cam.acquire() as frame: self.assertTrue(window.show(frame))
                errors=[]
                def close_elsewhere():
                    try: window.close()
                    except CameraError as error: errors.append(error.status)
                thread=threading.Thread(target=close_elsewhere);thread.start();thread.join()
                self.assertEqual(errors,[-2])
                with cam.acquire() as frame: self.assertTrue(window.show(frame))
