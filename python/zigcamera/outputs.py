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
