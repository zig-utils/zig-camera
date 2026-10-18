import asyncio
import ctypes as C
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from concurrent.futures import CancelledError
from zigcamera import Camera, CameraError, Picamera2
from zigcamera.controls import Control,ControlInfo,Metadata

def until(predicate,timeout=3):
    deadline=time.monotonic()+timeout
    while not predicate():
        if time.monotonic()>deadline: raise AssertionError('Timed out waiting for worker')
        time.sleep(.005)

class ControlTests(unittest.TestCase):
    def test_control_layout_ranges_atomicity_and_live_frame_metadata(self):
        self.assertEqual(C.sizeof(Control),144);self.assertEqual(C.sizeof(ControlInfo),120);self.assertEqual(C.sizeof(Metadata),96)
        with Camera(simulate=True,width=17,height=9,policy='fifo') as camera:
            self.assertIn('AfMode',camera.control_info)
            self.assertEqual(camera.control_info['FrameDurationLimits']['max_count'],2)
            camera.start()
            with camera.acquire() as old:
                old_meta=old.metadata
                with self.assertRaises(CameraError): camera.set_controls({'ExposureTime':25000,'Brightness':99})
                with self.assertRaises(ValueError): camera.set_controls({'ColourGains':(float('nan'),1)})
                with self.assertRaises(CameraError): camera.set_controls({'ScalerCrop':(16,0,2,2)})
                with self.assertRaises(NotImplementedError): camera.set_controls({'NotAControl':1})
                revision=camera.set_controls({'AeEnable':False,'ExposureTime':25000,'AnalogueGain':2,'ColourGains':(1.2,1.5),'FrameDurationLimits':(40000,50000),'ScalerCrop':(1,1,10,6),'AfWindows':[(1,1,8,4)]})
                self.assertEqual(old.metadata,old_meta)
                owned=(C.c_uint8*(17*9*3))()
                camera._check(camera._lib.zc_copy_rgb(C.byref(old._native),owned,len(owned)))
                self.assertEqual(bytes(owned),old.copy_rgb())
            for _ in range(8):
                with camera.acquire() as frame: metadata=frame.metadata
            self.assertEqual(metadata['control_revision'],revision);self.assertEqual(metadata['exposure_us'],25000)
            self.assertEqual(metadata['frame_duration_us'],40000);self.assertEqual(metadata['crop'],(1,1,10,6))
            before=camera.stats['delivered'];observer=camera.wait_metadata()
            self.assertEqual(camera.stats['delivered'],before)
            with self.assertRaises(CameraError) as error: camera.wait_metadata(observer['event_id'],timeout_ms=0)
            self.assertEqual(error.exception.status,-3)
    def test_autofocus_job_callback_and_await(self):
        with Camera(simulate=True,width=32,height=24) as camera:
            camera.start();called=threading.Event();seen=[]
            def signal(job): seen.append(job.result());called.set()
            job=camera.autofocus_cycle(wait=False,signal_function=signal)
            self.assertTrue(job.result(timeout=3));self.assertTrue(called.wait(3));self.assertEqual(seen,[True])
            job.join();self.assertEqual(camera.stats['leased'],0)
            async def focus(): return await camera.autofocus_cycle(wait=False)
            self.assertTrue(asyncio.run(focus()))
    def test_cancel_timeout_and_stop_with_all_buffers_held(self):
        with Camera(simulate=True,width=16,height=16,policy='fifo') as camera:
            camera.start();leases=[camera.acquire() for _ in range(4)]
            job=camera.autofocus_cycle(wait=False)
            self.assertTrue(job.cancel())
            with self.assertRaises(CancelledError): job.result(timeout=3)
            job.join()
            job=camera.autofocus_cycle(wait=False,timeout=.03)
            with self.assertRaises(TimeoutError): job.result(timeout=3)
            job.join()
            job=camera.autofocus_cycle(wait=False)
            camera.stop()
            with self.assertRaises(RuntimeError): job.result(timeout=3)
            for frame in leases: frame.release()
            camera.start();self.assertTrue(camera.autofocus_cycle())
    def test_picamera_configuration_and_runtime_controls(self):
        with Picamera2(simulate=True) as camera:
            config=camera.create_video_configuration(main={'size':(32,24)},controls={'AeEnable':False,'ExposureTime':20000,'AnalogueGain':2,'FrameDurationLimits':(40000,50000)})
            camera.configure(config);self.assertIn('LensPosition',camera.camera_controls);camera.start()
            for _ in range(6): metadata=camera.capture_metadata()
            self.assertEqual(metadata['ExposureTime'],20000)
            revision=camera.set_controls({'ExposureValue':1.5})
            self.assertGreater(revision,0)
            self.assertTrue(camera.autofocus_cycle())

class AsyncPreviewTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('ZC_TEST_PREVIEW')=='1','SDL dummy preview job')
    def test_preview_before_start_shares_capture_with_recording_and_af(self):
        with tempfile.TemporaryDirectory() as directory:
            with Camera(simulate=True,width=32,height=24,role='video') as camera:
                preview=camera.start_preview()
                self.assertTrue(preview.running);self.assertNotEqual(preview.process.pid,os.getpid())
                camera.start();recording=camera.start_recording(Path(directory)/'shared.mkv')
                until(lambda:preview.published>=3 and preview.rendered.value>0 and recording.frames>=6)
                self.assertIs(recording.thread,camera._pump.thread)
                self.assertTrue(camera.autofocus_cycle())
                before=recording.frames;camera.stop_preview();self.assertFalse(preview.process.is_alive())
                until(lambda:recording.frames>before)
                camera.stop_recording();self.assertFalse(recording.thread.is_alive());self.assertEqual(camera.stats['leased'],0)
                again=camera.start_preview();until(lambda:again.published>0);camera.stop();self.assertFalse(again.process.is_alive())
    @unittest.skipUnless(os.environ.get('ZC_TEST_PREVIEW')=='1','SDL dummy preview job')
    def test_display_failure_is_reported_and_child_reaped(self):
        with Camera(simulate=True,width=16,height=16) as camera:
            preview=camera.start_preview();preview.process.kill();preview.process.join()
            with self.assertRaises(RuntimeError): camera.stop_preview()
            self.assertFalse(preview.process.is_alive());self.assertEqual(camera.stats['leased'],0)
