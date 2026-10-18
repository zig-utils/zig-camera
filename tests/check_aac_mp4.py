"""Parse Home's fragmented AAC/AVC/HEVC MP4 and expose exact media/edit timelines."""
import struct
from check_mp4 import boxes,child,u32

def u64(data,pos): return struct.unpack_from('>Q',data,pos)[0]
def descriptors(data):
    pos=0
    while pos<len(data):
        tag=data[pos];pos+=1;n=0
        for _ in range(4):
            value=data[pos];pos+=1;n=(n<<7)|(value&127)
            if not value&128: break
        else: raise AssertionError('invalid descriptor length')
        assert pos+n<=len(data);yield tag,data[pos:pos+n];pos+=n

def parse(path):
    data=path.read_bytes();top=list(boxes(data));moov=next((s,e) for k,s,e in top if k==b'moov');tracks={}
    ms,me=child(data,*moov,b'mvhd');assert u32(data,ms)==0x1000000
    movie_rate=u32(data,ms+20);movie_duration=u64(data,ms+24)
    assert movie_rate==1000000
    for kind,s,e in boxes(data,*moov):
        if kind!=b'trak': continue
        ts,te=child(data,s,e,b'tkhd');assert u32(data,ts)==0x1000007
        id=u32(data,ts+20);track={'id':id,'duration_us':u64(data,ts+28),'samples':[],'times':[],'durations':[],'keys':[]}
        mdia=child(data,s,e,b'mdia');hs,he=child(data,*mdia,b'hdlr');track['kind']=data[hs+8:hs+12]
        hs,he=child(data,*mdia,b'mdhd');assert u32(data,hs)==0x1000000
        track.update(rate=u32(data,hs+20),media_duration=u64(data,hs+24))
        info=child(data,*mdia,b'minf');info=child(data,*info,b'stbl');info=child(data,*info,b'stsd')
        entry,es,ee=next(boxes(data,info[0]+8,info[1]));track['codec']=entry
        if entry==b'mp4a':
            track['channels']=struct.unpack_from('>H',data,es+16)[0]
            assert struct.unpack_from('>H',data,es+18)[0]==16 and u32(data,es+24)>>16==track['rate']
            ds,de=child(data,es+28,ee,b'esds');esdesc=dict(descriptors(data[ds+4:de]))[3]
            decoder=dict(descriptors(esdesc[3:]))[4];assert decoder[:2]==b'\x40\x15'
            asc=dict(descriptors(decoder[13:]))[5];assert len(asc)==2 and asc[0]>>3==2
            track['config']=asc
            stbl=child(data,*child(data,*mdia,b'minf'),b'stbl')
            sg,ge=child(data,*stbl,b'sgpd')
            assert u32(data,sg)==0x1000000 and data[sg+4:sg+8]==b'roll' and u32(data,sg+8)==2 and u32(data,sg+12)==1
            assert struct.unpack_from('>h',data,sg+16)[0]==-1
            edts=child(data,s,e,b'edts');ls,le=child(data,*edts,b'elst');assert u32(data,ls)==0x1000000 and u32(data,ls+4)==2
            start,empty,rate=struct.unpack_from('>QqI',data,ls+8);duration,delay,secondrate=struct.unpack_from('>QqI',data,ls+28)
            assert empty==-1 and rate==secondrate==0x10000 and delay>=0
            track.update(start_us=start,presented_us=duration,delay=delay,presented_frames=(duration*track['rate']+999999)//1000000)
        else:
            assert entry in (b'avc1',b'hvc1');track['dimensions']=struct.unpack_from('>HH',data,es+24)
            cs,ce=child(data,es+78,ee,b'avcC' if entry==b'avc1' else b'hvcC');track['config']=data[cs:ce]
        tracks[id]=track
    for i,(kind,s,e) in enumerate(top):
        if kind!=b'moof': continue
        traf=child(data,s,e,b'traf');hs,he=child(data,*traf,b'tfhd');assert u32(data,hs)==0x20000
        track=tracks[u32(data,hs+4)]
        if track['kind']==b'soun':
            sg,ge=child(data,*traf,b'sbgp')
            assert u32(data,sg)==0 and data[sg+4:sg+8]==b'roll' and struct.unpack_from('>III',data,sg+8)==(1,1,1)
        ts,te=child(data,*traf,b'tfdt');assert u32(data,ts)==0x1000000
        time=u64(data,ts+4);ts,te=child(data,*traf,b'trun');assert u32(data,ts)==0x701 and u32(data,ts+4)==1
        offset,duration,size,flags=struct.unpack_from('>IIII',data,ts+8);mk,ss,se=top[i+1]
        assert mk==b'mdat' and size==se-ss and s-8+offset==ss
        track['times'].append(time);track['durations'].append(duration);track['samples'].append(data[ss:se]);track['keys'].append(not flags&0x10000)
    assert set(tracks)=={1,2} and tracks[1]['kind']==b'vide' and tracks[2]['kind']==b'soun'
    audio=tracks[2]
    assert audio['times']==[i*1024 for i in range(len(audio['samples']))]
    assert audio['durations'][:-1]==[1024]*(len(audio['samples'])-1) and 1<=audio['durations'][-1]<=1024
    assert audio['media_duration']==sum(audio['durations'])
    assert audio['media_duration']==audio['delay']+audio['presented_frames']
    assert audio['duration_us']==audio['start_us']+audio['presented_us']
    assert movie_duration==max(tracks[1]['duration_us'],audio['duration_us'])
    return tracks

def audio_units(path,audio):
    target=path.with_suffix('.aacraw')
    with target.open('wb') as out:
        for sample in [audio['config'],*audio['samples']]: out.write(struct.pack('>I',len(sample))+sample)
    return target

def video_units(path,video):
    from check_av import access_units
    info={'private':video['config'],'codec':b'V_MPEG4/ISO/AVC' if video['codec']==b'avc1' else b'V_MPEGH/ISO/HEVC','video':list(zip(video['times'],video['samples'],video['keys']))}
    return access_units(path,info)
