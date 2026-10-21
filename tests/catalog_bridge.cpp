// Exercise real ControlValue traversal without physical camera hardware. Keeping
// the implementation in this translation unit tests exactly the system-STL bridge.
#include "../native/libcamera.cpp"
#include <cassert>
namespace {
std::vector<std::pair<int,uint64_t>> sync_calls;
int fail_sync_fd=-1;
int testSync(int fd,uint64_t flags) {
    sync_calls.emplace_back(fd,flags);
    return fd==fail_sync_fd ? -1 : 0;
}
struct Captured {
    zcd_catalog_record record{};
    zcd_catalog_value value{};
    std::string name, vendor, label;
    std::vector<uint8_t> bytes;
    unsigned records=0, values=0, ends=0;
    int failure=0;
};
int record(void *ctx,const zcd_catalog_record *r) {
    auto &out=*static_cast<Captured *>(ctx);out.record=*r;
    out.name=std::string(r->name,r->name_length);
    out.vendor=r->vendor_length ? std::string(r->vendor,r->vendor_length) : "";
    ++out.records;return out.failure;
}
int value(void *ctx,const zcd_catalog_value *v) {
    auto &out=*static_cast<Captured *>(ctx);out.value=*v;
    out.label=v->label_length ? std::string(v->label,v->label_length) : "";
    out.bytes.clear();if(v->length)out.bytes.assign(v->data,v->data+v->length);
    ++out.values;return out.failure;
}
int end(void *ctx){auto &out=*static_cast<Captured *>(ctx);++out.ends;return out.failure;}
template<class T> T read(const std::vector<uint8_t> &bytes,size_t offset=0) {
    assert(offset+sizeof(T)<=bytes.size());T result;std::memcpy(&result,bytes.data()+offset,sizeof(T));return result;
}
}
template<class T> void extraType(const zcd_catalog_sink &sink,Captured &out,T input,uint32_t expected) {
    if constexpr(std::is_constructible_v<ControlValue,T>) {
        assert(catalogValue(sink,0,ControlValue(input))==ZC_OK);
        assert(out.value.kind==expected && out.value.count==1);
    }
}
int main() {
    for(uint32_t value=1;value<=8;++value) {
        Orientation orientation=Orientation::Rotate0;
        assert(nativeOrientation(value,orientation));
        uint32_t actual=99;
        assert(negotiatedOrientation(value,orientation,true,actual)==ZC_OK && actual==value);
        actual=99;
        const uint32_t other=value==1 ? 2 : 1;
        assert(negotiatedOrientation(other,orientation,true,actual)==ZC_UNSUPPORTED && actual==99);
        assert(negotiatedOrientation(other,orientation,false,actual)==ZC_OK && actual==value);
    }
    Orientation invalid_orientation=Orientation::Rotate0;
    assert(!nativeOrientation(0,invalid_orientation) && !nativeOrientation(9,invalid_orientation));
    uint32_t untouched=123;
    assert(negotiatedOrientation(1,static_cast<Orientation>(99),false,untouched)==ZC_UNSUPPORTED && untouched==123);
    assert(sameBayerLayout("SRGGB12","SBGGR12"));
    assert(sameBayerLayout("SGRBG10_CSI2P","SGBRG10_CSI2P"));
    assert(!sameBayerLayout("SRGGB12","SBGGR10"));
    assert(!sameBayerLayout("SRGGB12","SBGGR12_CSI2P"));
    assert(!sameBayerLayout("SRGGB12","SFOOO12"));
    Captured out;
    const zcd_catalog_sink sink{&out,record,value,end};
    extraType(sink,out,uint16_t(43210),9);
    extraType(sink,out,uint32_t(0xffffffff),10);
    extraType(sink,out,Point(-2,7),11);
    const int64_t exact=9007199254740993LL;
    assert(catalogValue(sink,0,ControlValue(exact))==ZC_OK);
    assert(out.value.kind==4 && out.value.native_type==ControlTypeInteger64);
    assert(out.value.count==1 && read<int64_t>(out.bytes)==exact);
    assert(catalogValue(sink,2,ControlValue(int32_t(-17)),"minimum")==ZC_OK);
    assert(out.value.role==2 && out.label=="minimum" && out.value.kind==3);
    assert(read<int32_t>(out.bytes)==-17);
    const uint16_t endian=1;
    assert(bool(out.value.flags&2)==bool(*reinterpret_cast<const uint8_t *>(&endian)));
    assert(catalogValue(sink,0,ControlValue(true))==ZC_OK);
    assert(out.value.kind==1 && out.bytes.size()==1 && out.bytes[0]==1);
    const std::array<float,9> matrix{1,2,3,4,5,6,7,8,9};
    assert(catalogValue(sink,0,ControlValue(Span<const float>(matrix.data(),matrix.size())))==ZC_OK);
    assert(out.value.kind==5 && out.value.count==9 && (out.value.flags&1));
    assert(out.bytes.size()==36 && read<float>(out.bytes,32)==9);
    const std::array<Rectangle,2> rectangles{Rectangle(-3,4,640,480),Rectangle(11,-12,32,24)};
    assert(catalogValue(sink,0,ControlValue(Span<const Rectangle>(rectangles.data(),rectangles.size())))==ZC_OK);
    assert(out.value.kind==7 && out.value.count==2 && out.bytes.size()==32);
    assert(read<int32_t>(out.bytes)==-3 && read<uint32_t>(out.bytes,8)==640);
    assert(read<int32_t>(out.bytes,20)==-12 && read<uint32_t>(out.bytes,28)==24);
    assert(catalogValue(sink,0,ControlValue(Size(4056,3040)))==ZC_OK);
    assert(out.value.kind==8 && out.bytes.size()==8 && read<uint32_t>(out.bytes,4)==3040);
    ControlValue string;string.reserve(ControlTypeString,true,5);
    std::memcpy(string.data().data(),"trail",5);
    assert(catalogValue(sink,0,string)==ZC_OK);
    assert(out.value.kind==6 && out.value.count==5 && std::string(out.bytes.begin(),out.bytes.end())=="trail");
    assert(catalogValue(sink,3,ControlValue())==ZC_OK);
    assert(out.value.kind==0 && out.value.count==0 && out.bytes.empty());
    assert(portableType(static_cast<ControlType>(200))==255);
    assert(beginCatalog(sink,static_cast<const ControlId *>(nullptr),7,1234,ControlTypeFloat)==ZC_OK);
    assert(out.name=="#1234" && out.record.id==1234 && out.record.group==7 && out.record.flags==0);
    assert(beginCatalog(sink,static_cast<const ControlId *>(&controls::Brightness),0,0,ControlTypeFloat)==ZC_OK);
    assert(out.name=="Brightness" && out.record.app_id==ZC_BRIGHTNESS && out.record.kind==5);
    assert(enumCatalog(sink,static_cast<const ControlId *>(&controls::AfMode))==ZC_OK);
    ControlList list(controls::controls);
    list.set(controls::SensorTimestamp,exact);
    list.set(controls::ColourGains,Span<const float,2>({1.25f,1.5f}));
    out.records=out.values=out.ends=0;
    assert(catalogList(sink,list)==ZC_OK);
    assert(out.records==2 && out.values==2 && out.ends==2);
    out.failure=ZC_BUSY;
    assert(catalogList(sink,list)==ZC_BUSY);
    assert(catalogValue(sink,0,ControlValue(exact))==ZC_BUSY);
    // Raw typed input conversion uses exact payload widths and byte order.
    const uint8_t big_integer[8]={0,0x20,0,0,0,0,0,1};
    zcd_catalog_value typed{};typed.kind=4;typed.count=1;typed.data=big_integer;typed.length=8;
    ControlValue converted;
    assert(inputValue(&controls::SensorTimestamp,typed,converted)==ZC_OK);
    assert(converted.get<int64_t>()==9007199254740993LL);
    const ControlInfo precise(ControlValue(int64_t(0)),ControlValue(int64_t(9007199254740992LL)));
    assert(!rangeValue(converted,precise));
    typed.length=7;
    assert(inputValue(&controls::SensorTimestamp,typed,converted)==ZC_INVALID);
    const uint8_t bad_boolean[1]={2};typed.kind=1;typed.count=1;typed.data=bad_boolean;typed.length=1;
    assert(inputValue(&controls::AeEnable,typed,converted)==ZC_INVALID);
    const uint8_t not_finite[4]={0,0,0x80,0x7f};typed.kind=5;typed.flags=2;typed.data=not_finite;typed.length=4;
    assert(inputValue(&controls::Brightness,typed,converted)==ZC_INVALID);
    const auto rect=ControlValue(Rectangle(5,6,10,11));
    assert(rangeValue(rect,ControlInfo(ControlValue(Rectangle(0,0,1,1)),ControlValue(Rectangle(0,0,20,20)))));
    assert(!rangeValue(ControlValue(Rectangle(15,6,10,11)),ControlInfo(ControlValue(Rectangle(0,0,1,1)),ControlValue(Rectangle(0,0,20,20)))));
    const auto sizes=std::array<Size,2>{Size(5,6),Size(5,200)};
    assert(!rangeValue(ControlValue(Span<const Size>(sizes.data(),sizes.size())),ControlInfo(ControlValue(Size(1,1)),ControlValue(Size(100,100)))));
    const std::array<ControlValue,2> choices{ControlValue(int32_t(0)),ControlValue(int32_t(2))};
    const ControlInfo choice_range(Span<const ControlValue>(choices.data(),choices.size()));
    assert(rangeValue(ControlValue(int32_t(2)),choice_range));
    assert(!rangeValue(ControlValue(int32_t(1)),choice_range));
    // Commit is one publication boundary; a retired or stale preparation cannot
    // publish twice. These ControlLists are real libcamera containers.
    Device fake;
    fake.pending=ControlList(controls::controls);fake.desired=ControlList(controls::controls);
    auto prepared=new PreparedControls(&fake);
    prepared->pending.set(controls::ExposureTime,int32_t(1234));
    prepared->desired.set(controls::ExposureTime,int32_t(1234));
    uint64_t revision=0;
    assert(zcd_commit_native_controls(&fake,prepared,&revision)==ZC_OK && revision==1);
    assert(fake.pending.get(controls::ExposureTime).value()==1234);
    assert(zcd_commit_native_controls(&fake,prepared,&revision)==ZC_STALE);
    zcd_close_native_controls(prepared);
    prepared=new PreparedControls(&fake);++fake.control_revision;
    assert(zcd_commit_native_controls(&fake,prepared,&revision)==ZC_STALE);
    zcd_close_native_controls(prepared);

    // Real mmap permissions and exact DMA direction/cleanup without camera DMA.
    Device access;
    access.slots.resize(1);access.sync_call=testSync;
    auto &slot=access.slots[0];slot.fd_count=2;slot.fds[0]=7;slot.fds[1]=8;
    assert(access.sync(0,true)==ZC_OK);
    assert(sync_calls[0].second==(DMA_BUF_SYNC_START|DMA_BUF_SYNC_READ));
    assert(access.sync(0,false)==ZC_OK);
    assert(sync_calls[2].second==(DMA_BUF_SYNC_END|DMA_BUF_SYNC_READ));
    Mapping memory;memory.length=4096;
    memory.base=mmap(nullptr,memory.length,PROT_READ,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    assert(memory.base!=MAP_FAILED);
    slot.mappings.push_back(std::move(memory));
    assert(zcd_enable_writable(&access)==ZC_OK && access.writable);
    static_cast<uint8_t *>(slot.mappings[0].base)[0]=42;
    sync_calls.clear();
    assert(access.sync(0,true)==ZC_OK && access.sync(0,false)==ZC_OK);
    assert(sync_calls[0].second==(DMA_BUF_SYNC_START|DMA_BUF_SYNC_RW));
    assert(sync_calls[2].second==(DMA_BUF_SYNC_END|DMA_BUF_SYNC_RW));
    sync_calls.clear();fail_sync_fd=8;
    assert(access.sync(0,true)==ZC_IO && sync_calls.size()==3);
    assert(sync_calls[2].first==7 && sync_calls[2].second==(DMA_BUF_SYNC_END|DMA_BUF_SYNC_RW));
    sync_calls.clear();fail_sync_fd=7;
    assert(access.sync(0,false)==ZC_IO && sync_calls.size()==2);
    fail_sync_fd=-1;
    Device denied;denied.slots.resize(1);
    Mapping invalid;invalid.length=4096;
    denied.slots[0].mappings.push_back(std::move(invalid));
    assert(zcd_enable_writable(&denied)==ZC_IO && !denied.writable);
}
