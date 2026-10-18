"""Small independent EBML reader for streaming Matroska A/V fixtures."""
import struct

def vint(data,pos,identifier=False):
    first=data[pos];n=1
    while not first&(1<<(8-n)):
        n+=1
        assert n<=8
    value=int.from_bytes(data[pos:pos+n],'big')
    if not identifier: value&=(1<<(7*n))-1
    return value,pos+n,n

def elements(data,start=0,end=None):
    end=len(data) if end is None else end
    while start<end:
        ident,start,_=vint(data,start,True);size,start,n=vint(data,start)
        stop=end if size==(1<<(7*n))-1 else start+size
        assert stop<=end
        yield ident,start,stop
        start=stop
    assert start==end

def parse(path):
    data=path.read_bytes();segment=next((s,e) for k,s,e in elements(data) if k==0x18538067)
    video=[];audio=[];private=None;codec=None;rate=None;channels=None;scale=None
    for kind,start,end in elements(data,*segment):
        if kind==0x1549a966:
            scale=next(int.from_bytes(data[s:e],'big') for k,s,e in elements(data,start,end) if k==0x2ad7b1)
        elif kind==0x1654ae6b:
            for _,ts,te in elements(data,start,end):
                track={k:data[s:e] for k,s,e in elements(data,ts,te)}
                number=int.from_bytes(track[0xd7],'big')
                if number==1: codec=track[0x86];private=track.get(0x63a2)
                else:
                    assert track[0x86]==b'A_PCM/INT/LIT'
                    info={k:track[0xe1][s:e] for k,s,e in elements(track[0xe1])}
                    rate=int(struct.unpack('>d',info[0xb5])[0]);channels=int.from_bytes(info[0x9f],'big');assert info[0x6264]==b'\x10'
        elif kind==0x1f43b675:
            time=None
            for ident,s,e in elements(data,start,end):
                if ident==0xe7: time=int.from_bytes(data[s:e],'big')
                elif ident==0xa3:
                    number,p,_=vint(data,s);offset=struct.unpack_from('>h',data,p)[0];flags=data[p+2]
                    packet=((time+offset)*scale,data[p+3:e],bool(flags&128))
                    (video if number==1 else audio).append(packet)
    assert video and codec and rate and channels
    assert video[0][0]==0 and video[0][2]
    for track in (video,audio): assert all(a[0]<b[0] for a,b in zip(track,track[1:]))
    return dict(video=video,audio=audio,private=private,codec=codec,rate=rate,channels=channels)

def access_units(path,info):
    config=info['private'];parameters=[]
    if info['codec']==b'V_MPEG4/ISO/AVC':
        codec='h264';pos=6
        for count in (config[5]&31,None):
            if count is None: count=config[pos];pos+=1
            for _ in range(count):
                n=int.from_bytes(config[pos:pos+2],'big');pos+=2;parameters.append(config[pos:pos+n]);pos+=n
    else:
        codec='hevc';pos=23
        for _ in range(config[22]):
            pos+=1;count=int.from_bytes(config[pos:pos+2],'big');pos+=2
            for _ in range(count):
                n=int.from_bytes(config[pos:pos+2],'big');pos+=2;parameters.append(config[pos:pos+n]);pos+=n
    units=[b''.join(b'\0\0\0\1'+nal for nal in parameters)]
    for _,sample,_ in info['video']:
        pos=0;nals=[]
        while pos<len(sample):
            n=int.from_bytes(sample[pos:pos+4],'big');pos+=4
            assert n>0 and pos+n<=len(sample)
            nals.append(sample[pos:pos+n]);pos+=n
        units.append(b''.join(b'\0\0\0\1'+nal for nal in nals))
    out=path.with_suffix('.aus')
    with out.open('wb') as stream:
        for unit in units: stream.write(struct.pack('>I',len(unit))+unit)
    return codec,out
