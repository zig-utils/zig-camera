import ctypes as C
import threading
import time
import unittest
from zigcamera import Camera, CameraError
from zigcamera import _Config, _Plane, _Stream, _Frame, _Info

class CameraTests(unittest.TestCase):
    def test_layout(self):
        for typ, size in ((_Config,72),(_Plane,40),(_Stream,208),(_Frame,456),(_Info,680)):
            self.assertEqual(C.sizeof(typ), size)
    def test_requires_explicit_synthetic(self):
        with self.assertRaises(ValueError): Camera()
    def test_invalid_options(self):
        for kwargs in ({"width":17}, {"analogue_gain":float("nan")}, {"buffer_count":1}):
            with self.assertRaises(CameraError): Camera(simulate=True, **kwargs)
        with self.assertRaises(ValueError): Camera(simulate=True, width=-1)
        with self.assertRaises(TypeError): Camera(simulate=True, typo=4)
    def test_capture_copy_stride_and_lifetime(self):
        with Camera(simulate=True, width=17, height=9, policy="fifo") as camera:
            camera.start()
            with camera.acquire() as frame:
                self.assertEqual(frame.metadata["sequence"], 0)
                data = frame.copy_rgb()
                self.assertEqual(len(data), 17*9*3)
                self.assertEqual(data[:6], bytes((0,0,0, 1,0,0)))
                with frame.plane() as plane:
                    self.assertTrue(plane.readonly)
                    with self.assertRaises(RuntimeError): frame.release()
                camera.stop()
                self.assertEqual(frame.copy_rgb(), data)
                with self.assertRaises(CameraError) as ex: camera.close()
                self.assertEqual(ex.exception.status, -4)
            with self.assertRaises(RuntimeError): frame.copy_rgb()
            with self.assertRaises(RuntimeError): frame.release()
            camera.start()
    def test_latest_and_stats(self):
        with Camera(simulate=True, width=2, height=1) as camera:
            camera.start()
            with camera.acquire() as frame:
                self.assertEqual(frame.metadata["sequence"], 3)
                stats = camera.stats
                self.assertEqual(stats["dropped"], 3)
                self.assertEqual(stats["leased"], 1)
                self.assertEqual(stats["ready"], 3)  # synthetic completions are immediate
    def test_stop_wakes_waiter_and_views_survive_stop(self):
        with Camera(simulate=True, width=1, height=1, buffer_count=2, policy="fifo") as camera:
            camera.start()
            held = [camera.acquire(), camera.acquire()]
            result = []
            def waiter():
                try: camera.acquire(timeout_ms=30000)
                except CameraError as ex: result.append(ex.status)
            thread = threading.Thread(target=waiter)
            thread.start()
            time.sleep(0.02)
            camera.stop()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result, [-2])
            for frame in held: frame.release()
    def test_multithreaded_capture(self):
        with Camera(simulate=True, width=1, height=1, buffer_count=8, policy="fifo") as camera:
            camera.start()
            errors = []
            def worker():
                try:
                    for _ in range(1000):
                        with camera.acquire(): pass
                except Exception as ex: errors.append(ex)
            threads = [threading.Thread(target=worker) for _ in range(4)]
            for thread in threads: thread.start()
            for thread in threads: thread.join(timeout=10)
            self.assertFalse(any(thread.is_alive() for thread in threads))
            self.assertEqual(errors, [])
            self.assertEqual(camera.stats["delivered"], 4000)
            self.assertEqual(camera.stats["leased"], 0)

if __name__ == "__main__": unittest.main()
