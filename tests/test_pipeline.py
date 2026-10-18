import asyncio
import ctypes as C
import threading
import time
import unittest
from concurrent.futures import CancelledError
from zigcamera import Camera, CameraError, Picamera2, _PipelineOptions, _PipelineInfo, _SensorMode, _Stream

class PipelineTests(unittest.TestCase):
    def test_additive_abi(self):
        self.assertEqual(C.sizeof(_PipelineOptions),44)
        self.assertEqual(C.sizeof(_PipelineInfo),224)
        self.assertEqual(C.sizeof(_SensorMode),44)
    def test_modes_selection_lores_and_raw_share_lease(self):
        with Camera(simulate=True,width=66,height=34,raw=True,sensor={'output_size':(640,480),'bit_depth':12},lores={'size':(18,10)}) as camera:
            self.assertIn({'size':(640,480),'bit_depth':12,'format':'SRGGB12'},camera.sensor_modes)
            self.assertEqual(camera.info['sensor']['output_size'],(640,480))
            self.assertEqual(camera.info['raw']['width'],640)
            camera.start()
            with camera.acquire() as frame:
                desc=frame.stream('lores')
                self.assertEqual((desc.width,desc.height,desc.stride,desc.plane_count),(18,10,64,3))
                data=frame.copy_buffer('lores')
                self.assertEqual(len(data),270)
                try: import numpy
                except ImportError: pass
                else: self.assertEqual(frame.numpy('lores').shape,(15,18))
                # Same mapped storage represented as a single physical plane.
                merged=_Stream.from_buffer_copy(desc);merged.plane_count=1
                merged.planes[0].length=merged.planes[0].bytes_used=64*10*3//2
                out=(C.c_uint8*270)()
                camera._check(camera._lib.zc_copy_stream(C.byref(merged),out,len(out)))
                self.assertEqual(bytes(out),data)
                desc.planes[2].bytes_used=1
                self.assertEqual(camera._lib.zc_copy_stream(C.byref(desc),out,len(out)),-1)
                token=frame._native.token
                camera.stop()
                self.assertEqual(frame.copy_buffer('lores'),data)
            stale=_Stream()
            self.assertEqual(camera._lib.zc_get_stream(camera._handle,token,2,C.byref(stale)),-5)
    def test_rgb_lores_and_invalid_modes(self):
        for sensor in ({'output_size':(640,480),'bit_depth':10},{'output_size':(1,1),'bit_depth':12}):
            with self.assertRaises(CameraError): Camera(simulate=True,sensor=sensor)
        for lores in ({'size':(17,10)},{'size':(80,20)},{'size':(10,0)}):
            with self.assertRaises((CameraError,ValueError)): Camera(simulate=True,width=66,height=34,lores=lores)
        with Camera(simulate=True,width=66,height=34,lores={'size':(17,9),'format':'BGR888'}) as camera:
            camera.start()
            with camera.acquire() as frame:
                data=frame.copy_rgb('lores')
                self.assertEqual(len(data),17*9*3)
                self.assertEqual(data[3],66//17)
    def test_jobs_cancel_timeout_capacity_and_stop(self):
        with Camera(simulate=True,width=16,height=16,buffer_count=2,policy='fifo') as camera:
            camera.start();held=[camera.acquire(),camera.acquire()]
            try:
                job=camera.capture_metadata(wait=False)
                self.assertTrue(job.cancel());self.assertFalse(job.cancel())
                with self.assertRaises(CancelledError): job.result()
                job=camera.capture_metadata(wait=False,timeout_ms=1)
                with self.assertRaises(TimeoutError): job.result(2)
                jobs=[camera.capture_metadata(wait=False) for _ in range(32)]
                with self.assertRaises(RuntimeError): camera.capture_metadata(wait=False)
                camera.stop()
                for job in jobs:
                    with self.assertRaises(CancelledError): job.result(1)
            finally:
                for frame in held: frame.release()
    def test_request_job_transfers_lease_callback_and_restarts_worker(self):
        with Camera(simulate=True,width=16,height=16) as camera:
            camera.start()
            for _ in range(10):
                job=camera.capture_request(wait=False)
                frame=job.result(2)
                self.assertTrue(frame._native.token);frame.release()
            called=threading.Event();threads=[]
            def callback(job):
                threads.append(threading.current_thread().name)
                self.assertEqual(job.result()['exposure_us'],10000)
                called.set()
            job=camera.capture_metadata(signal_function=callback)
            self.assertTrue(called.wait(2));self.assertEqual(threads,['zig-camera-capture-callback'])
            camera.stop();self.assertEqual(camera.stats['leased'],0)
    def test_facade_async_and_lores(self):
        with Picamera2(simulate=True) as camera:
            mode=camera.sensor_modes[0]
            cfg=camera.create_preview_configuration(main={'size':(64,32)},lores={'size':(16,8)},sensor={'output_size':mode['size'],'bit_depth':mode['bit_depth']})
            camera.configure(cfg);camera.start()
            config=camera.camera_configuration()
            self.assertEqual(config['lores']['format'],'YUV420')
            job=camera.capture_buffer('lores',wait=False)
            self.assertEqual(len(camera.wait(job,2)),16*8*3//2)
            job=camera.capture_request(wait=False)
            with job.result(2) as request:
                self.assertEqual(len(request.make_buffer('main')),64*32*3)
                self.assertIn('Sequence',request.get_metadata())
            async def capture(): return await camera.capture_metadata(wait=False)
            self.assertIn('SensorTimestamp',asyncio.run(capture()))
    def test_cancelled_running_await_releases_request(self):
        with Camera(simulate=True,width=16,height=16) as camera:
            camera.start();entered=threading.Event();release=threading.Event()
            def retain(frame): entered.set();release.wait(2);return frame
            job=camera._capture(retain,wait=False,retain=True)
            self.assertTrue(entered.wait(2))
            async def cancel():
                async def wait(): return await job
                task=asyncio.create_task(wait());await asyncio.sleep(.01)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                release.set()
                self.assertTrue(await asyncio.to_thread(job.event.wait,2))
            asyncio.run(cancel())
            self.assertTrue(job.cancelled());self.assertEqual(camera.stats['leased'],0)
    def test_jobs_share_recording_and_focus_and_surface_file_errors(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory, Camera(simulate=True,width=16,height=16) as camera:
            camera.start_recording(Path(directory)/'capture.mkv')
            focus=camera.autofocus_cycle(wait=False)
            jobs=[camera.capture_metadata(wait=False) for _ in range(8)]
            for job in jobs: self.assertIn('sequence',job.result(2))
            self.assertTrue(focus.result(2))
            job=camera.capture_file(Path(directory)/'missing'/'bad.ppm',wait=False)
            with self.assertRaises(OSError): job.result(2)
            camera.stop_recording();camera.stop()
            self.assertEqual(camera.stats['leased'],0)
    def test_callback_cannot_block_pump_and_callback_errors_are_visible(self):
        with Camera(simulate=True,width=16,height=16) as camera:
            camera.start();entered=threading.Event();release=threading.Event()
            def callback(job):
                entered.set();release.wait(2);raise ValueError('callback failure')
            job=camera.capture_metadata(signal_function=callback)
            self.assertTrue(entered.wait(2))
            try: self.assertIn('sequence',camera.capture_metadata(wait=False).result(2))
            finally: release.set()
            end=time.monotonic()+2
            while job.callback_error is None and time.monotonic()<end: time.sleep(.001)
            self.assertIsInstance(job.callback_error,ValueError)

if __name__=='__main__': unittest.main()
