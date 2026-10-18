"""Validate MP4 structure, timestamps and GOPs; extract AUs for independent decoders.
No FFmpeg. Arguments: file.mp4 [independent-decode executable]. Fixtures: 128x96,
12 FIFO synthetic frames, 24fps, GOP4; --gap variant has a 100ms capture gap.
"""
import struct
import subprocess
import sys
from pathlib import Path

def u32(data,at=0): return struct.unpack_from('>I',data,at)[0]
def boxes(data,start=0,end=None):
    end=len(data) if end is None else end
    while start<end:
        assert end-start>=8,(start,end)
        size=u32(data,start);kind=data[start+4:start+8]
        assert size>=8 and start+size<=end,(kind,size,start,end)
        yield kind,start+8,start+size
        start+=size
    assert start==end

def child(data,start,end,name):
    return next((s,e) for k,s,e in boxes(data,start,end) if k==name)

def parse(path):
    data=path.read_bytes();top=list(boxes(data))
    assert top[0][0]==b'ftyp' and top[1][0]==b'moov'
    s,e=top[1][1:]
    for kind in (b'trak',b'mdia',b'minf',b'stbl',b'stsd'): s,e=child(data,s,e,kind)
    assert u32(data,s+4)==1
    kind,entry,end=next(boxes(data,s+8,e));assert kind in (b'avc1',b'hvc1')
    assert struct.unpack_from('>HH',data,entry+24)==(128,96)
    cs,ce=child(data,entry+78,end,b'avcC' if kind==b'avc1' else b'hvcC')
    config=data[cs:ce];parameters=[]
    if kind==b'avc1':
        assert config[0]==1 and config[4]&3==3
        pos=6
        for _ in range(config[5]&31):
            n=int.from_bytes(config[pos:pos+2],'big');pos+=2;parameters.append(config[pos:pos+n]);pos+=n
        count=config[pos];pos+=1
        for _ in range(count):
            n=int.from_bytes(config[pos:pos+2],'big');pos+=2;parameters.append(config[pos:pos+n]);pos+=n
        assert {p[0]&31 for p in parameters}=={7,8}
        codec='h264'
    else:
        assert config[0]==1 and config[21]&3==3
        pos=23
        for _ in range(config[22]):
            pos+=1;count=int.from_bytes(config[pos:pos+2],'big');pos+=2
            for _ in range(count):
                n=int.from_bytes(config[pos:pos+2],'big');pos+=2;parameters.append(config[pos:pos+n]);pos+=n
        assert {p[0]>>1&63 for p in parameters}=={32,33,34}
        codec='hevc'
    units=[b''.join(b'\0\0\0\1'+nal for nal in parameters)];times=[];durations=[];keys=[]
    for index,(kind,start,end) in enumerate(top):
        if kind!=b'moof': continue
        traf=child(data,start,end,b'traf')
        ts,te=child(data,*traf,b'tfhd');assert te-ts==8 and u32(data,ts)==0x20000
        ts,te=child(data,*traf,b'tfdt');assert u32(data,ts)==0x1000000
        dts=struct.unpack_from('>Q',data,ts+4)[0]
        ts,te=child(data,*traf,b'trun');assert u32(data,ts)==0x701 and u32(data,ts+4)==1
        offset,duration,size,flags=struct.unpack_from('>IIII',data,ts+8)
        nextkind,ms,me=top[index+1];assert nextkind==b'mdat' and size==me-ms
        assert start-8+offset==ms
        sample=data[ms:me];pos=0;nals=[]
        while pos<len(sample):
            n=u32(sample,pos);pos+=4;assert n>0 and pos+n<=len(sample)
            nals.append(sample[pos:pos+n]);pos+=n
        units.append(b''.join(b'\0\0\0\1'+nal for nal in nals))
        times.append(dts);durations.append(duration);keys.append(not bool(flags&0x10000))
    return {'codec':codec,'units':units,'times':times,'durations':durations,'keys':keys}

def access_units(path,info):
    aus=path.with_suffix('.aus')
    with aus.open('wb') as out:
        for unit in info['units']: out.write(struct.pack('>I',len(unit))+unit)
    return aus

def inspect(path):
    info=parse(path);times=info['times'];durations=info['durations'];keys=info['keys']
    assert len(times)==12,len(times)
    expected=[i*1_000_000//24+(100_000 if 'gap' in path.stem and i>=6 else 0) for i in range(12)]
    assert times==expected,(times,expected)
    assert durations==[b-a for a,b in zip(times,times[1:])]+[1_000_000//24],durations
    assert [i for i,key in enumerate(keys) if key]==[0,4,8],keys
    return info['codec'],access_units(path,info)

if __name__=='__main__':
    path=Path(sys.argv[1]);codec,aus=inspect(path)
    if len(sys.argv)>2: subprocess.run([sys.argv[2],codec,str(aus)],check=True)
    print(f'{path.name}: MP4 sizes/config, 12 frames, capture timeline and GOP validated')
