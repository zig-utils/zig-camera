"""Independent decoder checks for native Home JPEG and Zig DNG fixtures."""
import json
from pathlib import Path
import subprocess
import sys
from PIL import Image, JpegImagePlugin
import tifffile
root=Path(sys.argv[1])
image=Image.open(root/'home.jpg');image.load()
assert image.size==(128,96)
assert JpegImagePlugin.get_sampling(image)==0
assert all(abs(a-b)<=5 for a,b in zip(image.getpixel((60,25)),(60,25,111)))
with tifffile.TiffFile(root/'test.dng') as dng:
    page=dng.pages[0]
    assert dng.asarray().shape==(96,128)
    assert dng.asarray()[7,5]==405
    assert page.tags[50717].value==4095
    assert page.tags[33422].value==bytes([0,1,1,2])
    assert page.tags[50714].value==(65536,1024)*4
# libmatroska independently identifies the stream/container. No FFmpeg dependency.
identify=json.loads(subprocess.check_output(['mkvmerge','-J',str(root/'home.mkv')]))
track=identify['tracks'][0]
assert track['properties']['codec_id']=='V_MJPEG',track
assert track['properties']['pixel_dimensions']=='128x96',track
# Extracted packets are independently JPEG-decoded and counted.
raw=root/'mjpeg-packets.bin'
subprocess.run(['mkvextract',str(root/'home.mkv'),'tracks','--raw',f'0:{raw}'],check=True)
data=raw.read_bytes(); position=0; frames=[]
while position<len(data):
    start=data.index(b'\xff\xd8',position); end=data.index(b'\xff\xd9',start)+2
    import io
    frame=Image.open(io.BytesIO(data[start:end]));frame.load();frames.append(frame)
    position=end
assert len(frames)==12,len(frames)
for i,frame in enumerate(frames):
    assert all(abs(a-b)<=6 for a,b in zip(frame.getpixel((60,25)),(60,25,(i%4)*37)))
print('Independent JPEG, DNG tags/samples, Matroska demux and all MJPEG frame decodes passed')
