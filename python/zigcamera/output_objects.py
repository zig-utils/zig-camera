"""Reusable output protocol, explicit stream ownership and Home container sinks."""
import ctypes as C
import io
import os
import threading
from dataclasses import dataclass
from pathlib import Path

_callback_state=threading.local()
_claim_lock=threading.Lock()
_claims={}

def guard_callback():
    if getattr(_callback_state,'active',False): raise RuntimeError('Camera/recorder re-entry from an output callback is not supported')

def _path(value): return isinstance(value,(str,bytes,os.PathLike))

def _fd(stream):
    try: return stream.fileno()
    except (AttributeError,OSError,ValueError): return -1

def _write_all(stream,data):
    offset=0
    while offset<len(data):
        count=stream.write(data[offset:])
        if not isinstance(count,int) or count<=0 or count>len(data)-offset: raise OSError('Output stream made no write progress')
        offset+=count

def _open_owned(path,text=False):
    # Opening reserves identity but leaves existing bytes untouched until the
    # native identity checks accept the attachment and the first write occurs.
    fd=os.open(os.fspath(path),os.O_RDWR|os.O_CREAT,0o666)
    try: return os.fdopen(fd,'r+' if text else 'r+b',encoding='ascii' if text else None)
    except Exception: os.close(fd);raise

class PtsStream:
    def __init__(self,target=None):
        self.target=target;self.stream=None;self.owned=False;self.pending=False;self.lib=None
    def start(self,lib):
        if self.stream is not None: raise RuntimeError('PTS stream already active')
        self.lib=lib
        if self.target is None: return
        self.owned=_path(self.target)
        self.stream=_open_owned(self.target,True) if self.owned else self.target
        if not callable(getattr(self.stream,'write',None)):
            self.stream=None;raise TypeError('PTS requires a writable text or binary stream')
        self.pending=self.owned
    def commit(self):
        if self.pending:
            self.stream.seek(0);self.stream.truncate(0);self.pending=False
    def write(self,timestamp):
        if self.stream is None or timestamp is None: return
        if not isinstance(timestamp,int) or not 0<=timestamp<2**64: raise ValueError('Invalid PTS timestamp')
        buffer=(C.c_uint8*32)();length=C.c_uint32()
        if self.lib is None:
            from . import _load
            self.lib=_load()
        from . import _check
        _check(self.lib,self.lib.zc_format_pts(timestamp,buffer,32,C.byref(length)))
        line=bytes(buffer[:length.value])
        if not isinstance(self.stream,(io.BufferedIOBase,io.RawIOBase)): line=line.decode('ascii')
        self.commit()
        _write_all(self.stream,line)
        flush=getattr(self.stream,'flush',None)
        if flush is not None: flush()
    def stop(self):
        stream=self.stream;self.stream=None
        if stream is None: return
        try:
            flush=getattr(stream,'flush',None)
            if flush is not None: flush()
        finally:
            if self.owned: stream.close()
        self.owned=False;self.pending=False

@dataclass(frozen=True)
class PacketInfo:
    codec: str
    timestamp_ns: int
    keyframe: bool
    audio: bool

@dataclass(frozen=True)
class StreamInfo:
    index: int
    codec: str
    width: int=0
    height: int=0
    sample_rate: int=0
    channels: int=0
    extradata: bytes=b''

class Output:
    """Synchronous packet consumer. Override outputframe; never re-enter capture.

    Packet bytes are owned Python bytes. Timestamps passed to outputframe are
    integer microseconds; PacketInfo retains the nanosecond timestamp.
    """
    supports_audio=True
    needs_pacing=False
    needs_add_stream=False
    def __init__(self,pts=None):
        self.recording=False;self._pts=PtsStream(pts);self._lib=None
    @property
    def ptsoutput(self): return self._pts.stream if self._pts.stream is not None else self._pts.target
    @ptsoutput.setter
    def ptsoutput(self,value):
        if self.recording: raise RuntimeError('Close output before changing its PTS stream')
        self._pts=PtsStream(value)
    def start(self):
        if self.recording: raise RuntimeError('Output is already recording')
        self._pts.start(self._lib);self.recording=True
    def stop(self):
        self.recording=False;self._pts.stop()
    def outputtimestamp(self,timestamp): self._pts.write(timestamp)
    def outputframe(self,frame,keyframe=True,timestamp=None,packet=None,audio=False):
        if self.recording and not audio: self.outputtimestamp(timestamp)
    def _add_stream(self,encoder_stream,*args,**kwargs): pass

class FileOutput(Output):
    """Elementary JPEG/Annex B output, with optional PTS. Audio is unsupported.

    Paths are opened/closed per session; borrowed binary streams remain open and
    are written at their current position. Owned files reset on their first frame.
    """
    supports_audio=False
    def __init__(self,file=None,pts=None):
        super().__init__(pts);self._file=file;self._stream=None;self._owned=False;self._pending=False;self._first=True
    @property
    def fileoutput(self): return self._stream if self._stream is not None else self._file
    @fileoutput.setter
    def fileoutput(self,value):
        if self.recording: raise RuntimeError('Close output before changing its file')
        self._file=value
    def start(self):
        if self.recording: raise RuntimeError('Output is already recording')
        self._owned=_path(self._file);self._first=True
        self._stream=_open_owned(self._file) if self._owned else self._file
        try:
            if self._stream is not None and (isinstance(self._stream,io.TextIOBase) or not callable(getattr(self._stream,'write',None))): raise TypeError('FileOutput requires a writable binary stream')
            self._pending=self._owned
            super().start()
            first,second=_fd(self._stream),_fd(self._pts.stream)
            if self._stream is not None and self._stream is self._pts.stream: raise ValueError('Media and PTS streams must be distinct')
            if first>=0 and second>=0:
                a,b=os.fstat(first),os.fstat(second)
                if (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino): raise ValueError('Media and PTS files must be distinct')
        except Exception:
            try: super().stop()
            finally:
                if self._owned and self._stream is not None: self._stream.close()
                self._stream=None
            raise
    def _reset(self):
        if self._pending:
            self._stream.seek(0);self._stream.truncate(0);self._pending=False
    def outputframe(self,frame,keyframe=True,timestamp=None,packet=None,audio=False):
        if audio: raise RuntimeError('FileOutput does not support audio')
        if not self.recording: return
        if self._first:
            if not keyframe: return
            self._first=False
        if self._stream is not None:
            self._reset();_write_all(self._stream,frame)
            flush=getattr(self._stream,'flush',None)
            if flush is not None: flush()
        self.outputtimestamp(timestamp)
    def stop(self):
        try: super().stop()
        finally:
            stream=self._stream;self._stream=None
            if stream is not None:
                try:
                    flush=getattr(stream,'flush',None)
                    if flush is not None: flush()
                finally:
                    if self._owned: stream.close()

class MuxedOutput(FileOutput):
    """Home MP4/MKV writer to a reusable path or binary file-like stream.

    Seekable streams reset to offset zero per session, including borrowed ones.
    AAC MP4 requires seek/tell/truncate. Borrowed streams are never closed.
    """
    supports_audio=True
    needs_add_stream=True
    def __init__(self,file,pts=None,*,format=None):
        super().__init__(file,pts)
        self.format=format or (Path(os.fsdecode(file)).suffix.lstrip('.') if _path(file) else None)
        if self.format not in ('mp4','mkv'): raise ValueError('MuxedOutput format must be mp4 or mkv')
        self.seekable=False
    def start(self):
        super().start()
        try:
            if self._stream is None: raise ValueError('MuxedOutput requires a stream')
            self.seekable=all(callable(getattr(self._stream,name,None)) for name in ('seek','tell','truncate'))
            if self.seekable and callable(getattr(self._stream,'seekable',None)): self.seekable=self._stream.seekable()
            self._pending=self.seekable
        except Exception: self.stop();raise
    def outputframe(self,frame,keyframe=True,timestamp=None,packet=None,audio=False):
        raise RuntimeError('MuxedOutput receives bytes through the native Home writer')
    def _write(self,data):
        self._reset();_write_all(self._stream,data)
    def _patch(self,offset,data):
        position=self._stream.tell()
        try: self._stream.seek(offset);_write_all(self._stream,data)
        finally: self._stream.seek(position)

class OutputBridge:
    def __init__(self,recorder,output,pts=None):
        self.recorder=recorder;self.output=output;self.pts=pts;self.started=False;self.claimed=False
        from . import _OutputCallbacks,_PacketCallback,_WriteCallback,_PatchCallback
        self.cb=_OutputCallbacks();self.cb.struct_size=C.sizeof(self.cb)
        self.cb.file_fd=self.cb.pts_fd=self.cb.secondary_pts_fd=-1
        self.packet_callback=_PacketCallback(self._packet)
        self.write_callback=_WriteCallback(self._write)
        self.patch_callback=_PatchCallback(self._patch)
        self.cb.packet=self.packet_callback
        self.cb.format=1 if isinstance(output,MuxedOutput) and output.format=='mp4' else 2 if isinstance(output,MuxedOutput) else 0
        if isinstance(output,MuxedOutput): self.cb.write=self.write_callback
    def _hook(self,operation):
        previous=getattr(_callback_state,'active',False);_callback_state.active=True
        try: return operation()
        finally: _callback_state.active=previous
    def _invoke(self,operation):
        try: self._hook(operation);return 0
        except BaseException as error:
            if not isinstance(error,Exception):
                original=error;error=RuntimeError(f'Output callback aborted: {error}');error.__cause__=original
            if self.recorder._callback_error is None: self.recorder._callback_error=error
            return -6
    def _write(self,context,data,length): return self._invoke(lambda:self.output._write(C.string_at(data,length)))
    def _patch(self,context,offset,data,length): return self._invoke(lambda:self.output._patch(offset,C.string_at(data,length)))
    def _packet(self,context,event):
        def deliver():
            e=event.contents;audio=bool(e.flags&2);key=bool(e.flags&1);codec={1:'h264',2:'hevc',3:'mjpeg',4:'pcm_s16le'}[e.codec]
            timestamp=e.timestamp_ns//1000
            if isinstance(self.output,MuxedOutput): self.output.outputtimestamp(timestamp)
            else:
                info=PacketInfo(codec,e.timestamp_ns,key,audio)
                self.output.outputframe(C.string_at(e.data,e.length),keyframe=key,timestamp=timestamp,packet=info,audio=audio)
            if not audio and self.pts is not None: self.pts.write(timestamp)
        return self._invoke(deliver)
    def start(self):
        if not all(callable(getattr(self.output,name,None)) for name in ('start','stop','outputframe')): raise TypeError('Output requires start, stop and outputframe')
        if self.recorder._audio_spec is not None and not getattr(self.output,'supports_audio',True): raise ValueError('This output does not support audio')
        with _claim_lock:
            if id(self.output) in _claims or getattr(self.output,'recording',False): raise RuntimeError('Output is already attached or recording')
            _claims[id(self.output)]=self;self.claimed=True
        try:
            if isinstance(self.output,Output): self.output._lib=self.recorder._lib
            self.started=True;self._hook(self.output.start)
            add_stream=getattr(self.output,'_add_stream',None)
            if add_stream is not None:
                for info,params in self.recorder._streams(): self._hook(lambda:add_stream(info,info.codec,**params))
            if self.pts is not None: self.pts.start(self.recorder._lib)
            if isinstance(self.output,FileOutput): self.cb.file_fd=_fd(self.output._stream)
            if isinstance(self.output,Output): self.cb.pts_fd=_fd(self.output._pts.stream)
            if self.pts is not None: self.cb.secondary_pts_fd=_fd(self.pts.stream)
            streams=[]
            if isinstance(self.output,FileOutput): streams.append(self.output._stream)
            if isinstance(self.output,Output): streams.append(self.output._pts.stream)
            if self.pts is not None: streams.append(self.pts.stream)
            active=[s for s in streams if s is not None]
            if len({id(s) for s in active})!=len(active): raise ValueError('Media and PTS streams must be distinct')
            if isinstance(self.output,MuxedOutput):
                if self.output.seekable: self.cb.patch=self.patch_callback
                if self.output._pts.target is None and (self.pts is None or self.pts.target is None): self.cb.packet=type(self.packet_callback)()
        except Exception:
            self.stop();raise
    def commit(self):
        self._hook(self._commit)
    def _commit(self):
        # Only truncate auxiliary/elementary files after native descriptor and
        # snapshot-reservation checks accepted the complete attachment.
        if isinstance(self.output,FileOutput) and not isinstance(self.output,MuxedOutput): self.output._reset()
        if isinstance(self.output,Output): self.output._pts.commit()
        if self.pts is not None: self.pts.commit()
    def stop(self):
        try:
            if self.started:
                self.started=False;self._hook(self.output.stop)
        finally:
            try:
                if self.pts is not None: self._hook(self.pts.stop)
            finally:
                if self.claimed:
                    with _claim_lock: _claims.pop(id(self.output),None);self.claimed=False
                self.cb.packet=type(self.packet_callback)() if self.packet_callback is not None else self.cb.packet
                self.cb.write=type(self.write_callback)() if self.write_callback is not None else self.cb.write
                self.cb.patch=type(self.patch_callback)() if self.patch_callback is not None else self.cb.patch
                self.packet_callback=self.write_callback=self.patch_callback=None
