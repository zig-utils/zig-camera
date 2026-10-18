"""Encoded pre-roll history backed by Home's bounded native packet ring."""
class CircularOutput:
    def __init__(self,*,buffer_duration_ms=5000,max_bytes=64*1024*1024,max_frames=300):
        self.config={'duration_ms':buffer_duration_ms,'max_bytes':max_bytes,'max_frames':max_frames}
        self._recording=None
    def _live(self):
        if self._recording is None or self._recording.closed: raise RuntimeError('Circular output is not recording')
        return self._recording
    def _bind(self,recording):
        if self._recording is not None and not self._recording.closed: raise RuntimeError('Circular output is already bound')
        self._recording=recording
    def open_output(self,path): self._live().open_output(path)
    def close_output(self): self._live().close_output()
    def save_buffer(self,path): self._live().save_buffer(path)
    save=save_buffer
    @property
    def stats(self): return self._live().buffer_stats
    @property
    def audio_stats(self): return self._live().recorder.audio_buffer_stats

class RotatingOutput:
    """Exclusive indexed files, rotated at the next independently decodable frame.

    Duration and size limits are soft. Existing paths are never overwritten.
    Files are retained; automatic deletion is deliberately not part of this API.
    """
    def __init__(self,pattern,*,duration_ms=None,max_bytes=None):
        import string
        import re
        self.pattern=str(pattern);self.duration_ns=0;self.max_bytes=0;self._recording=None
        fields=[(field,spec,conversion) for _,field,spec,conversion in string.Formatter().parse(self.pattern) if field is not None]
        if len(fields)!=1 or fields[0][0]!='index' or fields[0][2] is not None: raise ValueError('Pattern requires one {index} field')
        spec=fields[0][1]
        if not re.fullmatch(r'[0-9]{0,3}d?',spec) or int(spec.removesuffix('d') or '0')>128: raise ValueError('Index format must be decimal with width <=128')
        for value,name in ((duration_ms,'duration_ms'),(max_bytes,'max_bytes')):
            if value is not None and (not isinstance(value,int) or value<=0): raise ValueError(f'{name} must be a positive integer')
        if duration_ms is None and max_bytes is None: raise ValueError('A duration or size limit is required')
        self.duration_ns=0 if duration_ms is None else duration_ms*1_000_000
        self.max_bytes=max_bytes or 0
        if max(self.duration_ns,self.max_bytes)>=2**64: raise ValueError('Rotation limit exceeds u64')
        if self.path(0)==self.path(1): raise ValueError('Pattern must generate distinct paths')
    def path(self,index): return self.pattern.format(index=index)
    def _available(self):
        if self._recording is not None and not self._recording.closed: raise RuntimeError('Rotating output is already bound')
    def _bind(self,recording): self._available();self._recording=recording
    @property
    def current_path(self):
        if self._recording is None: return None
        return self._recording.current_path
