import asyncio
import ctypes as C
import io
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from concurrent.futures import CancelledError
from zigcamera import Camera,CameraError,Recorder,Picamera2,MJPEGEncoder,CircularOutput,_BufferConfig,_BufferStats
from zigcamera.jobs import OperationJob

CODECS=os.environ.get('ZC_TEST_CODECS')=='1'

def jpeg_frames(path):
    data=path.read_bytes();frames=[];pos=0
    while True:
        start=data.find(b'\xff\xd8',pos)
        if start<0: break
        end=data.index(b'\xff\xd9',start)+2;frames.append(data[start:end]);pos=end
    return frames

def wait_frames(recording,count):
    end=time.monotonic()+5
    while recording.frames<count and recording.error is None and time.monotonic()<end: time.sleep(.002)
    if recording.error is not None: raise recording.error
    assert recording.frames>=count

class ModeTests(unittest.TestCase):
    def test_async_modes_temporary_capture_and_restore(self):
        with Picamera2(simulate=True) as camera:
            small=camera.create_preview_configuration(main={'size':(64,32)})
            big=camera.create_preview_configuration(main={'size':(128,96)})
            camera.configure(small);camera.start()
            job=camera.switch_mode(big,wait=False)
            self.assertEqual(job.result(5)['main']['size'],(128,96))
            async def capture(): return await camera.switch_mode_and_capture_buffer(small,wait=False,num_frames=2)
            self.assertEqual(len(asyncio.run(capture())),64*32*3)
            self.assertEqual(camera.camera_configuration()['main']['size'],(128,96))
            self.assertTrue(camera._camera._started)
            called=threading.Event()
            def callback(job):
                self.assertIn('SensorTimestamp',job.result());self.assertEqual(camera.camera_configuration()['main']['size'],(128,96));called.set()
            job=camera.switch_mode_and_capture_metadata(small,signal_function=callback)
            self.assertTrue(called.wait(5));self.assertIsNone(job.callback_error)
    def test_failed_target_and_failed_capture_restore_previous_mode(self):
        with Picamera2(simulate=True) as camera, tempfile.TemporaryDirectory() as directory:
            previous=camera.create_preview_configuration(main={'size':(64,32)})
            camera.configure(previous);camera.start()
            invalid=camera.create_preview_configuration(sensor={'output_size':(1,1),'bit_depth':12})
            with self.assertRaises(CameraError): camera.switch_mode(invalid)
            self.assertEqual(len(camera.capture_buffer()),64*32*3)
            with self.assertRaises(OSError): camera.switch_mode_and_capture_file(camera.create_still_configuration(main={'size':(128,96)},raw=None),Path(directory)/'missing'/'test.ppm')
            self.assertEqual(len(camera.capture_buffer()),64*32*3)
            result=camera.switch_mode_and_capture_file(previous,Path(directory)/'test.jpg',wait=False).result(5)
            self.assertIn('Sequence',result)
    def test_lease_and_recording_guards_leave_active_mode_intact(self):
        with Picamera2(simulate=True) as camera, tempfile.TemporaryDirectory() as directory:
            small=camera.create_preview_configuration(main={'size':(32,32)})
            camera.configure(small);camera.start()
            with camera.capture_request() as request:
                with self.assertRaises(RuntimeError): camera.switch_mode('preview')
                self.assertTrue(camera._camera._started);self.assertEqual(len(request.make_buffer()),32*32*3)
            recording=camera.start_recording(MJPEGEncoder(),Path(directory)/'clip.mkv')
            with self.assertRaises(RuntimeError): camera.switch_mode('preview')
            wait_frames(recording,2);camera.stop_recording()
            self.assertEqual(camera.camera_configuration()['main']['size'],(32,32))
    def test_mode_submission_is_bounded_and_queued_cancel_is_terminal(self):
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_preview_configuration(main={'size':(32,32)}));camera.start()
            with camera._operation_lock:
                job=camera.switch_mode('preview',wait=False)
                with self.assertRaises(RuntimeError): camera.switch_mode('preview',wait=False)
            job.result(5)
            job=OperationJob(lambda:1);self.assertTrue(job.cancel());job.start()
            with self.assertRaises(CancelledError): job.result(1)
            self.assertFalse(job.cancel())
    def test_stopping_focus_does_not_join_a_callback_waiting_on_mode_lock(self):
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_preview_configuration(main={'size':(16,16)}));camera.start()
            entered=threading.Event();stopped=threading.Event();errors=[]
            def callback(job): entered.set();camera.camera_configuration()
            def stop():
                try: camera._camera.stop()
                except Exception as error: errors.append(error)
                finally: stopped.set()
            with camera._operation_lock:
                camera._camera.autofocus_cycle(wait=False,signal_function=callback)
                self.assertTrue(entered.wait(3))
                thread=threading.Thread(target=stop);thread.start()
                completed=stopped.wait(3)
            thread.join(3);self.assertTrue(completed);self.assertFalse(errors)
    def test_mode_deadline_and_restoration_failures_are_visible(self):
        from unittest.mock import patch
        from zigcamera.modes import ModeRestoreError
        with Picamera2(simulate=True) as camera:
            original=camera.create_preview_configuration(main={'size':(32,32)})
            camera.configure(original);camera.start()
            # Dispatch-stage deadline: rollback happens before error notification.
            with patch('zigcamera.modes.time.monotonic',side_effect=[0,1]):
                with self.assertRaises(TimeoutError): camera.switch_mode('preview',timeout_ms=1)
            self.assertEqual(camera.camera_configuration()['main']['size'],(32,32));self.assertTrue(camera._camera._started)
            configure=camera.configure
            camera.configure=lambda config:(_ for _ in ()).throw(ValueError('injected configure failure'))
            try:
                with self.assertRaises(ModeRestoreError) as failure: camera.switch_mode('preview')
                self.assertIsInstance(failure.exception.operation_error,ValueError)
                self.assertIsInstance(failure.exception.restoration_error,ValueError)
            finally: camera.configure=configure
            camera.start()
    @unittest.skipUnless(os.environ.get('ZC_TEST_PREVIEW')=='1','optional SDL job')
    def test_mode_round_trip_restarts_preview_at_restored_geometry(self):
        with Picamera2(simulate=True) as camera:
            camera.configure(camera.create_preview_configuration(main={'size':(32,32)}));camera.start_preview(startup_timeout=15);camera.start()
            original=camera._camera._preview
            result=camera.switch_mode_and_capture_buffer(camera.create_preview_configuration(main={'size':(64,32)}),wait=False,timeout_ms=30000).result(40)
            self.assertEqual(len(result),64*32*3);self.assertFalse(original.process.is_alive())
            self.assertEqual(camera._camera._preview.width,32);self.assertTrue(camera._camera._preview.running)

class RecordingTests(unittest.TestCase):
    def test_abi_and_circular_limits_snapshots_and_continuing_output(self):
        self.assertEqual(C.sizeof(_BufferConfig),24);self.assertEqual(C.sizeof(_BufferStats),64)
        with tempfile.TemporaryDirectory() as directory, Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
            root=Path(directory);camera.start()
            with Recorder(width=128,height=96,fps=24,circular={'max_frames':4,'max_bytes':100000,'duration_ms':5000}) as recorder:
                with self.assertRaises(CameraError): recorder.save_buffer(root/'empty.mkv')
                for i in range(12):
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                stats=recorder.buffer_stats
                self.assertEqual(stats['frames'],4);self.assertLessEqual(stats['bytes'],100000);self.assertEqual(stats['evicted'],8)
                recorder.save_buffer(root/'snapshot.mkv');self.assertEqual(recorder.buffer_stats,stats)
                recorder.open_output(root/'live.mkv')
                with self.assertRaises(CameraError): recorder.save_buffer(root/'live.mkv')
                os.link(root/'live.mkv',root/'alias.mkv')
                with self.assertRaises(CameraError): recorder.split(root/'alias.mkv')
                for i in range(12,14):
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                recorder.close_output()
                self.assertEqual(len(jpeg_frames(root/'snapshot.mkv')),4)
                self.assertEqual(len(jpeg_frames(root/'live.mkv')),6)
                try: from PIL import Image
                except ImportError: pass
                else:
                    for i,payload in enumerate(jpeg_frames(root/'live.mkv'),8):
                        image=Image.open(io.BytesIO(payload));image.load()
                        self.assertLessEqual(abs(image.getpixel((60,25))[2]-(i%4)*37),6)
    def test_split_preserves_every_frame_and_failed_prepare_preserves_old_file(self):
        with tempfile.TemporaryDirectory() as directory, Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);camera.start()
            with Recorder(root/'a.mkv',width=32,height=32,fps=24) as recorder:
                for i in range(12):
                    if i==5:
                        before=(root/'a.mkv').read_bytes()
                        with self.assertRaises(CameraError): recorder.split(root/'a.mkv')
                        self.assertEqual((root/'a.mkv').read_bytes(),before)
                        with self.assertRaises(CameraError): recorder.split(root/'missing'/'bad.mkv')
                        recorder.split(root/'b.mkv')
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                self.assertEqual(recorder.buffer_stats['split_pending'],0);self.assertEqual(recorder.buffer_stats['segments'],2)
            self.assertEqual(len(jpeg_frames(root/'a.mkv')),5);self.assertEqual(len(jpeg_frames(root/'b.mkv')),7)
    def test_split_requested_before_first_frame_produces_two_nonempty_files(self):
        from check_mp4 import parse,access_units
        decoder=os.environ.get('ZC_INDEPENDENT_DECODER')
        for codec in (('mjpeg','h264','hevc') if CODECS else ('mjpeg',)):
            suffix='mkv' if codec=='mjpeg' else 'mp4'
            with tempfile.TemporaryDirectory() as directory, Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                paths=[Path(directory)/f'{part}.{suffix}' for part in ('a','b')];camera.start()
                with Recorder(paths[0],width=128,height=96,codec=codec,fps=24,gop=0 if codec=='mjpeg' else 100) as recorder:
                    recorder.split(paths[1])
                    for i in range(8):
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                total=0
                for path in paths:
                    if codec=='mjpeg': count=len(jpeg_frames(path))
                    else:
                        info=parse(path);count=len(info['times']);self.assertTrue(info['keys'][0]);self.assertEqual(info['times'][0],0)
                        if decoder: subprocess.run([decoder,codec,str(access_units(path,info)),str(count),str(total)],check=True)
                    self.assertGreater(count,0);total+=count
                self.assertEqual(total,8)
    def test_unresolved_standalone_split_close_keeps_final_input_in_old_output(self):
        from check_mp4 import parse
        for codec in (('mjpeg','h264','hevc') if CODECS else ('mjpeg',)):
            suffix='mkv' if codec=='mjpeg' else 'mp4'
            with tempfile.TemporaryDirectory() as directory, Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                root=Path(directory);camera.start();recorder=Recorder(root/f'a.{suffix}',width=128,height=96,codec=codec)
                recorder.split(root/f'b.{suffix}')
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
                with self.assertRaises(CameraError) as failure: recorder.close()
                self.assertEqual(failure.exception.status,-2);self.assertFalse(recorder._handle.value)
                count=len(jpeg_frames(root/f'a.{suffix}')) if codec=='mjpeg' else len(parse(root/f'a.{suffix}')['times'])
                self.assertEqual(count,1)
    def test_facade_circular_output_and_async_split(self):
        with tempfile.TemporaryDirectory() as directory, Picamera2(simulate=True) as camera:
            root=Path(directory);camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            circular=CircularOutput(max_frames=6,max_bytes=100000,buffer_duration_ms=5000)
            recording=camera.start_recording(MJPEGEncoder(),circular,fps=24);wait_frames(recording,8)
            self.assertLessEqual(circular.stats['frames'],6)
            circular.open_output(root/'a.mkv')
            job=camera.split_recording(root/'b.mkv',wait=False)
            self.assertEqual(job.result(5),root/'b.mkv');wait_frames(recording,recording.frames+2)
            circular.close_output();circular.save(root/'snapshot.mkv');camera.stop_recording()
            self.assertGreater(len(jpeg_frames(root/'a.mkv')),0);self.assertGreater(len(jpeg_frames(root/'b.mkv')),0)
            with self.assertRaises(RuntimeError): circular.open_output(root/'closed.mkv')
    def test_split_cancel_and_stop_with_no_available_frame(self):
        with tempfile.TemporaryDirectory() as directory, Camera(simulate=True,width=16,height=16,buffer_count=2,policy='fifo') as camera:
            root=Path(directory);camera.start();held=[camera.acquire(),camera.acquire()]
            try:
                camera.start_recording(root/'a.mkv')
                job=camera.split_recording(root/'b.mkv',wait=False);self.assertTrue(job.cancel())
                with self.assertRaises(CancelledError): job.result()
                job=camera.split_recording(root/'c.mkv',wait=False);camera.stop_recording()
                with self.assertRaises(CancelledError): job.result()
            finally:
                for frame in held: frame.release()
    @unittest.skipUnless(CODECS,'optional Home codecs')
    def test_avc_hevc_splits_and_ring_snapshots_decode_independently(self):
        from check_mp4 import parse,access_units
        decoder=os.environ.get('ZC_INDEPENDENT_DECODER')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for codec in ('h264','hevc'):
                paths=[root/f'{codec}-{part}.mp4' for part in ('a','b')]
                with Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                    camera.start()
                    with Recorder(paths[0],width=128,height=96,fps=24,codec=codec,gop=100) as recorder:
                        for i in range(12):
                            if i==5: recorder.split(paths[1])
                            with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24+(100_000_000 if i>=6 else 0))
                        self.assertFalse(recorder.buffer_stats['split_pending'])
                first_index=0
                for path in paths:
                    info=parse(path);count=len(info['times']);self.assertGreater(count,0);self.assertTrue(info['keys'][0]);self.assertEqual(info['times'][0],0)
                    timeline=lambda i:i*1_000_000//24+(100_000 if i>=6 else 0)
                    expected=[timeline(i+first_index)-timeline(first_index) for i in range(count)]
                    self.assertEqual(info['times'],expected)
                    last_duration=timeline(first_index+count)-timeline(first_index+count-1) if first_index+count<12 else 1_000_000//24
                    self.assertEqual(info['durations'],[b-a for a,b in zip(expected,expected[1:])]+[last_duration])
                    if decoder: subprocess.run([decoder,codec,str(access_units(path,info)),str(count),str(first_index)],check=True)
                    first_index+=count
                self.assertEqual(first_index,12)
                with Camera(simulate=True,width=128,height=96,policy='fifo') as camera:
                    camera.start()
                    with Recorder(width=128,height=96,fps=24,codec=codec,gop=4,circular={'max_frames':6,'max_bytes':100000,'duration_ms':5000}) as recorder:
                        for i in range(12):
                            with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                        stats=recorder.buffer_stats;self.assertLessEqual(stats['frames'],6);self.assertGreater(stats['frames'],0)
                        path=root/f'{codec}-snapshot.mp4';recorder.save_buffer(path)
                        info=parse(path);self.assertEqual(len(info['times']),stats['frames']);self.assertTrue(info['keys'][0]);self.assertEqual(info['times'][0],0)
                        if decoder: subprocess.run([decoder,codec,str(access_units(path,info)),str(stats['frames']),str(round(stats['first_ns']*24/1e9))],check=True)
                        # Resume after the snapshot without draining/restarting encoder.
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=12*1_000_000_000//24)

if __name__=='__main__': unittest.main()
