"""SDL display process, with a single shared RGB slot and nonblocking publication.
The child owns SDL's main thread. No camera handle/lease crosses the process.
"""
import ctypes as C
import multiprocessing as MP
import time
from . import CameraError

def _display(library,width,height,title,pixels,lock,version,stop,connection,rendered):
    from . import Preview,_Frame
    try:
        frame=_Frame();frame.token=1;frame.main.width=width;frame.main.height=height;frame.main.stride=width*3;frame.main.plane_count=1;frame.main.format=b'BGR888'
        frame.main.planes[0].data=C.cast(pixels,C.POINTER(C.c_uint8));frame.main.planes[0].length=len(pixels);frame.main.planes[0].bytes_used=len(pixels)
        with Preview(width,height,title=title,library=library) as window:
            connection.send(('ready',0,''))
            while not stop.value:
                with lock:
                    # Poll events even before the first capture (slot begins black).
                    status=window._lib.zc_preview_show(window._handle,C.byref(frame))
                    if status==1: break
                    if status: window._lib.zc_status_string.restype=C.c_char_p;raise CameraError(status,window._lib.zc_status_string(status).decode())
                    rendered.value=version.value
                time.sleep(.01)
        connection.send(('closed',0,''))
    except BaseException as error:
        try: connection.send(('error',getattr(error,'status',0),str(error)))
        except (BrokenPipeError,EOFError): pass
    finally: connection.close()

class AsyncPreview:
    def __init__(self,camera,title,startup_timeout):
        self.camera=camera;self.error=None;self.closed=False;self.published=0;self.dropped=0
        self.width=camera.info['main']['width'];self.height=camera.info['main']['height']
        if not isinstance(startup_timeout,(int,float)) or not 0<startup_timeout<=60: raise ValueError('Invalid preview startup timeout')
        context=MP.get_context('spawn')
        self.pixels=context.RawArray('B',self.width*self.height*3);self.lock=context.Lock();self.version=context.Value('Q',0,lock=False);self.rendered=context.Value('Q',0,lock=False);self.stop=context.Value('b',False,lock=False)
        self.connection,child=context.Pipe(duplex=False)
        self.process=context.Process(target=_display,args=(str(camera._lib._name),self.width,self.height,title,self.pixels,self.lock,self.version,self.stop,child,self.rendered),name='zig-camera-preview',daemon=True)
        self.process.start();child.close()
        try:
            if not self.connection.poll(startup_timeout): raise TimeoutError('Preview process did not start')
            message,status,detail=self.connection.recv()
            if message!='ready':
                if status: raise CameraError(status,detail)
                raise RuntimeError(detail or 'Preview process failed')
        except BaseException:
            self._close_process();raise
    @property
    def running(self): return not self.closed and self.process.is_alive()
    def publish(self,frame):
        if not self.running: return
        if self.error is not None: return
        if not self.lock.acquire(False): self.dropped+=1;return
        try:
            self.camera._check(self.camera._lib.zc_copy_rgb(C.byref(frame._native),C.cast(self.pixels,C.POINTER(C.c_uint8)),len(self.pixels)))
            self.version.value+=1;self.published+=1
        finally: self.lock.release()
    def _close_process(self):
        self.stop.value=True;self.process.join(2)
        if self.process.is_alive():
            self.process.terminate();self.process.join(.5)
            if self.process.is_alive(): self.process.kill();self.process.join(1)
            if self.process.is_alive(): raise RuntimeError('Could not reap preview process')
        self.connection.close();self.closed=True
    def close(self):
        if self.camera._preview is self:
            self.camera.stop_preview();return
        if self.closed: return
        # The display is joined before inspecting its final response.
        self.stop.value=True;self.process.join(2)
        try:
            while self.connection.poll():
                try: message,status,detail=self.connection.recv()
                except EOFError: break
                if message=='error': self.error=CameraError(status,detail) if status else RuntimeError(detail)
            if self.error is None and self.process.exitcode not in (None,0): self.error=RuntimeError(f'Preview process exited with status {self.process.exitcode}')
        finally: self._close_process()
        if self.error is not None: raise self.error
    def __enter__(self): return self
    def __exit__(self,*exc): self.close()
