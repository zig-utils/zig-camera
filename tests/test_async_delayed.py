"""Owned snapshot jobs and bounded delayed A/V forwarding, without FFmpeg."""
import asyncio
import ctypes as C
from concurrent.futures import CancelledError
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from zigcamera import Camera, Recorder, AudioCapture, CameraError, CircularOutput, CircularOutput2, Picamera2, MJPEGEncoder
from zigcamera.audio import AudioFeed
from zigcamera.jobs import OperationJob
from check_av import parse as mkv
from test_audio_rotation import expected
from check_aac_mp4 import parse as mp4
from test_aac_mp4 import inspect
AAC=os.environ.get('ZC_TEST_AAC')=='1'

class AsyncSnapshotTests(unittest.TestCase):
    def test_worker_owns_frozen_window_after_stop_and_history_eviction(self):
        entered=threading.Event();release=threading.Event();original=OperationJob.start
        def paused_start(job):
            operation=job.operation
            def paused(): entered.set();release.wait(5);return operation()
            job.operation=paused;return original(job)
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
            root=Path(directory);camera.start();feed=AudioFeed(source)
            recorder=Recorder(width=128,height=96,fps=25,circular={'max_frames':4},audio={'sample_rate':48000})
            for i in range(8):
                feed.through(recorder,(i+1)*40_000_000)
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
            try:
                with patch.object(OperationJob,'start',paused_start): job=recorder.save_buffer(root/'frozen.mkv',wait=False)
                self.assertTrue(entered.wait(2));self.assertFalse(job.done());self.assertFalse(job.cancel())
                with self.assertRaises(TimeoutError): job.result(0)
                for i in range(8,16):
                    feed.through(recorder,(i+1)*40_000_000)
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
                recorder.close();self.assertEqual(camera.stats['leased'],0)
            finally: release.set();recorder.close()
            self.assertEqual(job.result(5),root/'frozen.mkv')
            info=mkv(root/'frozen.mkv');self.assertEqual(len(info['video']),4)
            self.assertEqual(b''.join(p for _,p,_ in info['audio']),expected(7680,start=7680))

    def test_background_capture_advances_while_snapshot_worker_is_blocked(self):
        from test_modes_recording import wait_frames
        entered=threading.Event();release=threading.Event();original=OperationJob.start
        def paused_start(job):
            operation=job.operation
            def paused(): entered.set();release.wait(5);return operation()
            job.operation=paused;return original(job)
        with tempfile.TemporaryDirectory() as directory,Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            history=CircularOutput(max_frames=4)
            recording=camera.start_recording(MJPEGEncoder(),history,fps=25,audio={'backend':'synthetic'})
            wait_frames(recording,8);path=Path(directory)/'background.mkv'
            try:
                with patch.object(OperationJob,'start',paused_start): job=history.save_buffer(path,wait=False)
                self.assertTrue(entered.wait(2));self.assertFalse(job.done())
                wait_frames(recording,recording.frames+8);camera.stop_recording()
            finally: release.set()
            job.result(5);info=mkv(path)
            self.assertEqual(len(info['video']),4)
            self.assertEqual(len(b''.join(p for _,p,_ in info['audio'])),4*1920*2)

    def test_capacity_cancel_thread_failure_and_file_reservations(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();root=Path(directory)
            with Recorder(width=32,height=32,fps=25,circular={}) as recorder:
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
                jobs=[]
                with patch.object(OperationJob,'start',lambda job:job):
                    for n in range(2): jobs.append(recorder.save_buffer(root/f'{n}.mkv',wait=False))
                    with self.assertRaisesRegex(RuntimeError,'capacity'): recorder.save_buffer(root/'third.mkv',wait=False)
                alias=root/'alias.mkv';os.link(root/'0.mkv',alias)
                for op in (lambda:recorder._path_call('zc_video_save_buffer',alias),lambda:recorder.open_output(alias)):
                    with self.assertRaises(CameraError) as error: op()
                    self.assertEqual(error.exception.status,-4)
                self.assertTrue(jobs[0].cancel());self.assertTrue(jobs[0].cancelled())
                with self.assertRaises(CancelledError): jobs[0].result()
                self.assertTrue(jobs[1].cancel());self.assertEqual((root/'0.mkv').read_bytes(),b'')
                path=root/'keep.mkv';path.write_bytes(b'keep')
                with patch.object(threading.Thread,'start',side_effect=RuntimeError('injected startup')):
                    job=recorder.save_buffer(path,wait=False)
                with self.assertRaisesRegex(RuntimeError,'startup'): job.result()
                self.assertEqual(path.read_bytes(),b'keep')
                recorder.save_buffer(path,wait=False).result(5)

    @unittest.skipUnless(Path('/dev/full').exists(),'Linux write-failure device')
    def test_worker_io_failure_does_not_poison_live_recorder(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(width=32,height=32,circular={}) as recorder:
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
                before=recorder.buffer_stats
                path=Path(directory)/'full.mkv';path.symlink_to('/dev/full')
                with self.assertRaises(CameraError): recorder.save_buffer(path,wait=False).result(5)
                self.assertEqual(recorder.buffer_stats,before)
                recorder.save_buffer(Path(directory)/'good.mkv',wait=False).result(5)

    def test_future_audio_is_rejected_before_reserving_snapshot_path(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start();path=Path(directory)/'keep.mkv';path.write_bytes(b'keep')
            with Recorder(width=32,height=32,fps=25,circular={},audio={'sample_rate':48000}) as recorder:
                recorder.write_audio(expected(480),timestamp_ns=1_000_000_000)
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
                with self.assertRaises(CameraError) as error: recorder.save_buffer(path,wait=False)
                self.assertEqual(error.exception.status,-4);self.assertEqual(path.read_bytes(),b'keep')

    def test_callback_failure_result_timeout_and_asyncio_await(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            camera.start()
            with Recorder(width=32,height=32,circular={}) as recorder:
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
                callback=threading.Event()
                def notify(job): callback.set();raise RuntimeError('callback failed')
                job=recorder.save_buffer(Path(directory)/'callback.mkv',signal_function=notify)
                self.assertIsNotNone(job.result(5));self.assertTrue(callback.wait(2))
                async def wait_job(): return await recorder.save_buffer(Path(directory)/'await.mkv',wait=False)
                self.assertEqual(asyncio.run(wait_job()),Path(directory)/'await.mkv')

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_async_mp4_is_frozen_and_independently_decoded(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
                camera.start();feed=AudioFeed(source);path=Path(directory)/'snapshot.mp4'
                with Recorder(width=128,height=96,fps=24,codec=codec,gop=4,circular={'max_frames':6},audio={'sample_rate':48000}) as recorder:
                    for i in range(12):
                        feed.through(recorder,(i+1)*1_000_000_000//24)
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                    stats=recorder.buffer_stats;count=stats['frames'];first=round(stats['first_ns']*24/1_000_000_000)
                    job=recorder.save_buffer(path,wait=False)
                job.result(5);inspect(self,path,count=count,first=first,samples=count*2000,start_sample=first*2000)

class DelayedTests(unittest.TestCase):
    def test_close_drops_recent_tail_stop_flushes_and_reopen_waits_for_key(self):
        codecs=('mjpeg','h264','hevc') if AAC else ('mjpeg',)
        for codec in codecs:
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
                root=Path(directory);camera.start();feed=AudioFeed(source);ext='.mkv' if codec=='mjpeg' else '.mp4'
                recorder=Recorder(width=128,height=96,fps=25,codec=codec,gop=0 if codec=='mjpeg' else 4,circular={'delay_ms':120,'duration_ms':120,'max_frames':16},audio={'sample_rate':48000})
                def write(i):
                    feed.through(recorder,(i+1)*40_000_000)
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
                try:
                    recorder.open_output(root/f'first{ext}')
                    for i in range(10): write(i)
                    n=recorder.stats['output_frames'];self.assertGreater(n,0);self.assertLess(n,10)
                    self.assertGreater(recorder.buffer_stats['frames'],0)
                    recorder.close_output()
                    for i in range(10,14): write(i)
                    recorder.open_output(root/f'second{ext}')
                    for i in range(14,20): write(i)
                finally: recorder.close()
                if codec=='mjpeg':
                    first=mkv(root/f'first{ext}');second=mkv(root/f'second{ext}')
                    self.assertEqual(len(first['video']),7)
                    self.assertEqual(b''.join(p for _,p,_ in first['audio']),expected(7*1920))
                    self.assertEqual(len(second['video']),9)
                    self.assertEqual(b''.join(p for _,p,_ in second['audio']),expected(9*1920,start=11*1920))
                else:
                    inspect(self,root/f'first{ext}',count=n,first=0,samples=n*1920)
                    second=mp4(root/f'second{ext}');n2=len(second[1]['samples'])
                    self.assertEqual(20-n2,12)
                    inspect(self,root/f'second{ext}',count=n2,first=12,samples=n2*1920,start_sample=12*1920)

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_delayed_capture_gaps_and_stereo_offset_use_original_sample_clock(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic',sample_rate=44100,channels=2,block_frames=441,start_ns=4_002_000_000) as source:
                path=Path(directory)/'delayed.mp4';camera.start();feed=AudioFeed(source)
                with Recorder(width=128,height=96,fps=25,codec=codec,gop=4,circular={'delay_ms':100},audio={'sample_rate':44100,'channels':2}) as recorder:
                    recorder.open_output(path)
                    for i in range(6):
                        ts=4_000_000_000+i*40_000_000+(100_000_000 if i>=3 else 0)
                        feed.through(recorder,ts+40_000_000)
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=ts)
                    self.assertLess(recorder.stats['output_frames'],6)
                info=inspect(self,path,count=6,samples=14906,offset_us=2000,rate=44100,channels=2)
                self.assertEqual(info[1]['times'],[0,40000,80000,220000,260000,300000])

    @unittest.skipUnless(AAC,'optional Home AAC')
    def test_pending_split_and_stop_before_delay_elapsed(self):
        for codec in ('h264','hevc'):
            with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=128,height=96,policy='fifo') as camera,AudioCapture(backend='synthetic') as source:
                camera.start();feed=AudioFeed(source);root=Path(directory)
                with Recorder(width=128,height=96,fps=24,codec=codec,gop=100,circular={'delay_ms':500},audio={'sample_rate':48000}) as recorder:
                    recorder.open_output(root/'first.mp4')
                    for i in range(12):
                        if i==5: recorder.split(root/'second.mp4')
                        feed.through(recorder,(i+1)*1_000_000_000//24)
                        with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*1_000_000_000//24)
                    self.assertEqual(recorder.stats['output_frames'],0)
                    self.assertEqual(recorder.buffer_stats['split_pending'],1)
                total=0
                for name in ('first','second'):
                    path=root/f'{name}.mp4';info=mp4(path);count=len(info[1]['samples'])
                    inspect(self,path,count=count,first=total,samples=count*2000,start_sample=total*2000);total+=count
                self.assertEqual(total,12)

    def test_delay_zero_runtime_changes_overflow_and_facade_binding(self):
        with tempfile.TemporaryDirectory() as directory,Camera(simulate=True,width=32,height=32,policy='fifo') as camera:
            root=Path(directory);camera.start()
            with Recorder(width=32,height=32,fps=25,circular={'delay_ms':80,'max_frames':8}) as recorder:
                recorder.open_output(root/'changing.mkv')
                for i in range(5):
                    with camera.acquire() as frame: recorder.write(frame,timestamp_ns=i*40_000_000)
                self.assertEqual(recorder.stats['output_frames'],3)
                recorder.set_delay(0)
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=200_000_000)
                self.assertEqual(recorder.stats['output_frames'],6)
            self.assertEqual(len(mkv_video(root/'changing.mkv')),6)
            recorder=Recorder(width=32,height=32,circular={'delay_ms':1000,'max_frames':1})
            with camera.acquire() as frame: recorder.write(frame,timestamp_ns=0)
            with self.assertRaises(CameraError) as failure:
                with camera.acquire() as frame: recorder.write(frame,timestamp_ns=40_000_000)
            self.assertEqual(failure.exception.status,-4)
            with self.assertRaises(CameraError): recorder.close()
        from test_modes_recording import wait_frames
        with tempfile.TemporaryDirectory() as directory,Picamera2(simulate=True) as camera:
            camera.configure(camera.create_video_configuration(main={'size':(32,32)}))
            delayed=CircularOutput2(buffer_duration_ms=80,max_frames=16)
            recording=camera.start_recording(MJPEGEncoder(),delayed,fps=25,audio={'backend':'synthetic'})
            delayed.open_output(Path(directory)/'facade.mkv');wait_frames(recording,8)
            delayed.buffer_duration_ms=0;wait_frames(recording,10);camera.stop_recording()
            self.assertEqual(delayed.buffer_duration_ms,0)

# Video-only EBML tests use the existing MJPEG reader rather than the A/V parser.
def mkv_video(path):
    from check_av import elements,vint
    data=path.read_bytes();segment=next((s,e) for k,s,e in elements(data) if k==0x18538067);packets=[]
    for k,s,e in elements(data,*segment):
        if k==0x1f43b675:
            for kind,a,b in elements(data,s,e):
                if kind==0xa3:
                    _,p,_=vint(data,a);packets.append(data[p+3:b])
    return packets

if __name__=='__main__': unittest.main()
