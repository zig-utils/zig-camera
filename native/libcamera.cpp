// A narrow C++ boundary: discovery, negotiation, reusable libcamera requests,
// persistent plane mappings and mandatory DMA-BUF CPU synchronization.
// Ownership, ready queues, leases and consumer policy live in Zig.
#include "zig_camera.h"
#include "zig_camera_catalog_bridge.h"
#include <libcamera/libcamera.h>
#include <libcamera/control_ids.h>
#include <libcamera/formats.h>
#include <libcamera/orientation.h>
#include <linux/dma-buf.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>
#include <array>
#include <memory>
#include <vector>
#include <algorithm>
#include <limits>
#include <new>
#include <cmath>
#include <mutex>
#include <type_traits>
#include <utility>
#include <atomic>

using namespace libcamera;
using Completion = void (*)(void *, uint32_t, const zc_frame *, const zc_metadata *, int);
extern "C" int zct_tuning_manager_begin();
extern "C" void zct_tuning_manager_end();
namespace {
bool nativeOrientation(uint32_t value,Orientation &out) {
    switch(value) {
    case ZC_ROTATE0:out=Orientation::Rotate0;return true;
    case ZC_ROTATE0_MIRROR:out=Orientation::Rotate0Mirror;return true;
    case ZC_ROTATE180:out=Orientation::Rotate180;return true;
    case ZC_ROTATE180_MIRROR:out=Orientation::Rotate180Mirror;return true;
    case ZC_ROTATE90_MIRROR:out=Orientation::Rotate90Mirror;return true;
    case ZC_ROTATE270:out=Orientation::Rotate270;return true;
    case ZC_ROTATE270_MIRROR:out=Orientation::Rotate270Mirror;return true;
    case ZC_ROTATE90:out=Orientation::Rotate90;return true;
    default:return false;
    }
}
int negotiatedOrientation(uint32_t requested,Orientation actual,bool strict,uint32_t &out) {
    for(uint32_t value=1;value<=8;++value) {
        Orientation native=Orientation::Rotate0;
        if(nativeOrientation(value,native) && native==actual) {
            if(strict && requested!=value)return ZC_UNSUPPORTED;
            out=value;return ZC_OK;
        }
    }
    return ZC_UNSUPPORTED;
}
bool sameBayerLayout(const std::string &requested,const std::string &actual) {
    const auto bayer=[](const std::string &name) {
        if(name.size()<6 || name[0]!='S')return false;
        const auto pattern=name.substr(1,4);
        return pattern=="RGGB" || pattern=="BGGR" || pattern=="GRBG" || pattern=="GBRG";
    };
    return bayer(requested) && bayer(actual) && requested.substr(5)==actual.substr(5);
}
int cpuSync(int fd,uint64_t flags) {
    dma_buf_sync value{};value.flags=flags;
    int rc;do {rc=ioctl(fd,DMA_BUF_IOCTL_SYNC,&value);}while(rc<0 && errno==EINTR);
    return rc;
}
struct Mapping {
    void *base = MAP_FAILED;
    size_t length = 0;
    Mapping() = default;
    Mapping(const Mapping &) = delete;
    Mapping &operator=(const Mapping &) = delete;
    Mapping(Mapping &&m) noexcept : base(m.base), length(m.length) { m.base = MAP_FAILED; }
    ~Mapping() { if (base != MAP_FAILED) munmap(base, length); }
};
struct Slot {
    std::unique_ptr<Request> request;
    zc_frame frame{};
    zc_stream lores{};
    std::vector<Mapping> mappings;
    std::array<int, ZC_MAX_PLANES * 3> fds{};
    size_t fd_count = 0;
    bool used = false;
    zc_raw_metadata raw_metadata{};
    uint64_t control_revision=0;
};
void text(char *dst, size_t n, const std::string &s) {
    std::memcpy(dst, s.data(), std::min(n - 1, s.size()));
    dst[std::min(n - 1, s.size())] = 0;
}
bool has(const std::shared_ptr<Camera> &camera, const ControlId &id) {
    return camera->controls().find(&id) != camera->controls().end();
}
// Newer libcamera has manual/auto mode controls absent from older headers.
// Resolve those by name, while keeping the minimum supported build API small.
void setMode(ControlList &controls, const std::shared_ptr<Camera> &camera, const char *name, int32_t value) {
    for (const auto &entry : camera->controls()) {
        if (entry.first->name() == name) { controls.set(entry.first->id(), ControlValue(value)); return; }
    }
}
// Resolve names in the configured camera map, including vendor controls.
const char *controlNames[]={nullptr,"AeEnable","ExposureTime","AnalogueGain","ExposureValue",
 "AwbEnable","ColourGains","Brightness","Contrast","Saturation","Sharpness",
 "FrameDurationLimits","LensPosition","AfMode","AfTrigger","AfRange","AfSpeed",
 "AfMetering","AfWindows","ScalerCrop","NoiseReductionMode","AeMeteringMode",
 "AeExposureMode","AwbMode","ExposureTimeMode","AnalogueGainMode","AfPause",
 "AeConstraintMode","ColourTemperature","AeFlickerMode","AeFlickerPeriod"};
bool numbers(const ControlValue &v,double *out) {
    switch(v.type()) {
    case ControlTypeBool: out[0]=v.get<bool>(); return true;
    case ControlTypeInteger32:
        if(v.isArray()) {const auto values=v.get<Span<const int32_t>>();for(size_t i=0;i<std::min(size_t(4),values.size());i++)out[i]=values[i];}
        else {out[0]=v.get<int32_t>();} return true;
    case ControlTypeInteger64:
        if(v.isArray()) {const auto values=v.get<Span<const int64_t>>();for(size_t i=0;i<std::min(size_t(4),values.size());i++)out[i]=values[i];}
        else {out[0]=static_cast<double>(v.get<int64_t>());} return true;
    case ControlTypeFloat:
        if(v.isArray()) {const auto values=v.get<Span<const float>>();for(size_t i=0;i<std::min(size_t(4),values.size());i++)out[i]=values[i];}
        else {out[0]=v.get<float>();} return true;
    case ControlTypeRectangle: {
        const auto r=v.isArray() ? v.get<Span<const Rectangle>>()[0] : v.get<Rectangle>();
        out[0]=r.x;out[1]=r.y;out[2]=r.width;out[3]=r.height;return true;
    }
    default:return false;
    }
}
// Typed introspection is pulled by consumers. Completion callbacks only publish
// the request, never allocate/serialize catalogs or run consumer callbacks.
template<class T, class = void> struct HasCatalogInfo : std::false_type {};
template<class T> struct HasCatalogInfo<T, std::void_t<decltype(std::declval<T>().vendor()), decltype(std::declval<T>().isInput()), decltype(std::declval<T>().isArray()), decltype(std::declval<T>().size())>> : std::true_type {};
template<class T, class = void> struct HasEnumerators : std::false_type {};
template<class T> struct HasEnumerators<T, std::void_t<decltype(std::declval<T>().enumerators())>> : std::true_type {};
template<class T> bool typeIs(ControlType type) {
    if constexpr (std::is_constructible_v<ControlValue, T>) return ControlValue(T{}).type() == type;
    return false;
}
uint32_t portableType(ControlType type) {
    switch (type) {
    case ControlTypeNone: return 0; case ControlTypeBool: return 1;
    case ControlTypeByte: return 2; case ControlTypeInteger32: return 3;
    case ControlTypeInteger64: return 4; case ControlTypeFloat: return 5;
    case ControlTypeString: return 6; case ControlTypeRectangle: return 7;
    case ControlTypeSize: return 8; default: break;
    }
    if(typeIs<uint16_t>(type))return 9;
    if(typeIs<uint32_t>(type))return 10;
    if(typeIs<Point>(type))return 11;
    return 255;
}
uint32_t appControl(const std::string &name) {
    for(size_t i=1;i<sizeof(controlNames)/sizeof(*controlNames);i++)if(name==controlNames[i])return i;
    return 0;
}
template<class T> int beginCatalog(const zcd_catalog_sink &s, const T *id, uint32_t group, uint32_t fallback, ControlType type, uint32_t extra_flags=0, uint32_t app_override=UINT32_MAX) {
    const std::string name=id ? id->name() : "#"+std::to_string(fallback);
    zcd_catalog_record r{};r.group=group;r.id=id ? id->id() : fallback;
    r.app_id=app_override==UINT32_MAX?appControl(name):app_override;r.native_type=type;r.kind=portableType(type);
    r.name=name.data();r.name_length=name.size();
    if constexpr (HasCatalogInfo<T>::value) {
        if(id) {
            r.flags=8|16|32|(id->isInput()?1:0)|(id->isOutput()?2:0)|(id->isArray()?4:0);
            r.extent=id->size()>UINT32_MAX ? UINT32_MAX : id->size();
            r.vendor=id->vendor().data();r.vendor_length=id->vendor().size();
        }
    }
    if constexpr (HasEnumerators<T>::value) if(id)r.flags|=64;
    r.flags|=extra_flags;
    return s.begin(s.context,&r);
}
template<class T> void component(std::vector<uint8_t> &data, T field) {
    const auto *p=reinterpret_cast<const uint8_t *>(&field);
    data.insert(data.end(),p,p+sizeof(T));
}
template<class T> void geometryValues(const ControlValue &v, std::vector<uint8_t> &data) {
    auto append=[&](const T &g) {
        if constexpr (std::is_same_v<T,Rectangle>) {component(data,int32_t(g.x));component(data,int32_t(g.y));component(data,uint32_t(g.width));component(data,uint32_t(g.height));}
        else if constexpr(std::is_same_v<T,Size>) {component(data,uint32_t(g.width));component(data,uint32_t(g.height));}
        else {component(data,int32_t(g.x));component(data,int32_t(g.y));}
    };
    if constexpr (std::is_constructible_v<ControlValue,T>) {
        if(v.isArray())for(const auto &g:v.get<Span<const T>>())append(g);
        else append(v.get<T>());
    }
}
int catalogValue(const zcd_catalog_sink &s, uint32_t role, const ControlValue &v, const std::string &label="") {
    if(v.numElements()>UINT32_MAX || v.data().size()>4*1024*1024)return ZC_BUSY;
    const uint16_t endian=1;
    zcd_catalog_value out{};out.role=role;out.kind=portableType(v.type());out.native_type=v.type();
    out.flags=(v.isArray()?1:0)|(*reinterpret_cast<const uint8_t *>(&endian)?2:0);
    out.count=v.numElements();out.data=v.data().data();out.length=v.data().size();out.label=label.data();out.label_length=label.size();
    std::vector<uint8_t> packed;
    if(out.kind==7 || out.kind==8 || out.kind==11) {
        const size_t width=out.kind==7 ? 16 : 8;
        if(out.count>(4*1024*1024)/width)return ZC_BUSY;
        packed.reserve(size_t(out.count)*width);
        if(out.kind==7)geometryValues<Rectangle>(v,packed);
        else if(out.kind==8)geometryValues<Size>(v,packed);
        else geometryValues<Point>(v,packed);
        out.data=packed.data();out.length=packed.size();
    }
    return s.value(s.context,&out);
}
template<class T> int enumCatalog(const zcd_catalog_sink &s, const T *id) {
    if constexpr (HasEnumerators<T>::value) {
        for(const auto &entry:id->enumerators()) {
            const int rc=catalogValue(s,5,ControlValue(entry.first),entry.second);
            if(rc)return rc;
        }
    }
    return ZC_OK;
}
template<class T> bool standardMetadataName(const T *id,const char *name) {
    if(id->name()!=name)return false;
    if constexpr(HasCatalogInfo<T>::value) return id->vendor()=="libcamera";
    return true;
}
int catalogList(const zcd_catalog_sink &s, const ControlList &list, uint32_t group=0) {
    const auto *ids=list.idMap();
    for(const auto &entry:list) {
        const ControlId *id=nullptr;
        if(ids){const auto found=ids->find(entry.first);if(found!=ids->end())id=found->second;}
        int rc=beginCatalog(s,id,group,entry.first,entry.second.type());if(rc)return rc;
        rc=catalogValue(s,0,entry.second);if(rc)return rc;
        rc=s.end(s.context);if(rc)return rc;
    }
    return ZC_OK;
}
// libcamera permits only one CameraManager object in a process. Serialize
// startup/shutdown and hold a lease through every Device and discovery snapshot.
struct ManagerHost {
    std::mutex mutex;
    std::unique_ptr<CameraManager> manager;
    size_t users=0;
    int acquire() {
        std::lock_guard<std::mutex> lock(mutex);
        const int tuning=zct_tuning_manager_begin();
        if(tuning)return tuning;
        // Balance the Zig policy lease even if allocation/startup throws.
        struct Rollback { bool active=true; ~Rollback(){if(active)zct_tuning_manager_end();} } rollback;
        if(users==0) {
            // Older libcamera does not reset its initialization latch on stop.
            // Construct a fresh manager after the previous one is destroyed.
            auto next=std::make_unique<CameraManager>();
            if(next->start()<0)return ZC_DEVICE;
            manager=std::move(next);
        }
        ++users;rollback.active=false;return ZC_OK;
    }
    void release() {
        std::lock_guard<std::mutex> lock(mutex);
        if(--users==0)manager.reset();
        zct_tuning_manager_end();
    }
};
ManagerHost &managerHost(){static ManagerHost host;return host;}
struct ManagerLease {
    bool held=false;
    int acquire(){const int rc=managerHost().acquire();held=rc==ZC_OK;return rc;}
    ~ManagerLease(){if(held)managerHost().release();}
    ManagerLease()=default;
    ManagerLease(const ManagerLease &)=delete;
    ManagerLease &operator=(const ManagerLease &)=delete;
};

// A manager watch owns a policy/manager lease even with no acquired Device.
// Plain member slots run synchronously on the SDK emitter. They publish only
// into Zig's preallocated queue; consumer code never runs on this thread.
using CameraNotice = void (*)(void *,uint32_t,const uint8_t *,size_t);
struct WatchCallbacks : std::enable_shared_from_this<WatchCallbacks> {
    std::mutex mutex;
    void *context=nullptr;
    CameraNotice callback=nullptr;
    void deliverId(uint32_t kind,const uint8_t *id,size_t length) {
        const auto keep=shared_from_this();
        std::lock_guard<std::mutex> lock(mutex);
        if(callback)callback(context,kind,id,length);
    }
    void deliver(uint32_t kind,const std::shared_ptr<Camera> &camera) {
        const auto keep=shared_from_this();
        if(camera)deliverId(kind,reinterpret_cast<const uint8_t *>(camera->id().data()),camera->id().size());
    }
    void added(std::shared_ptr<Camera> camera){deliver(ZC_CAMERA_ADDED,camera);}
    void removed(std::shared_ptr<Camera> camera){deliver(ZC_CAMERA_REMOVED,camera);}
    void retire(){std::lock_guard<std::mutex> lock(mutex);callback=nullptr;context=nullptr;}
};
struct ManagerWatch {
    ManagerLease lease;
    std::shared_ptr<WatchCallbacks> callbacks;
    bool added=false,removed=false;
    ~ManagerWatch() {
        // Join active callback scopes before releasing the Zig context. Keep
        // the manager and relay alive through both signal disconnections.
        if(callbacks)callbacks->retire();
        if(added)managerHost().manager->cameraAdded.disconnect(callbacks.get());
        if(removed)managerHost().manager->cameraRemoved.disconnect(callbacks.get());
    }
};

static PixelFormat processedPixelFormat(uint32_t format) { switch(format) { case ZC_RGB24:return formats::BGR888;case ZC_BGR24:return formats::RGB888;case ZC_RGBX32:return formats::XBGR8888;case ZC_BGRX32:return formats::XRGB8888;case ZC_YVU420:return formats::YVU420;case ZC_NV12:return formats::NV12;case ZC_NV21:return formats::NV21;default:return formats::YUV420; } }
static bool processedYuv(uint32_t format) { return format==ZC_YUV420 || format==ZC_YVU420 || format==ZC_NV12 || format==ZC_NV21; }
static ColorSpace processedColorSpace(uint32_t format) {
    auto color=ColorSpace::Sycc;
    if(!processedYuv(format))color.ycbcrEncoding=ColorSpace::YcbcrEncoding::None;
    return color;
}
static std::optional<ColorSpace> requestedProcessedColorSpace(uint32_t format,const zc_color_space &requested) {
    if(requested.present==0)return processedColorSpace(format);
    if(requested.struct_size!=sizeof(requested) || requested.present!=1)return std::nullopt;
    ColorSpace color=ColorSpace::Sycc;
    switch(requested.primaries) {
    case ZC_PRIMARIES_SMPTE170M:color.primaries=ColorSpace::Primaries::Smpte170m;break;
    case ZC_PRIMARIES_REC709:color.primaries=ColorSpace::Primaries::Rec709;break;
    case ZC_PRIMARIES_REC2020:color.primaries=ColorSpace::Primaries::Rec2020;break;
    default:return std::nullopt;
    }
    switch(requested.transfer) {
    case ZC_TRANSFER_LINEAR:color.transferFunction=ColorSpace::TransferFunction::Linear;break;
    case ZC_TRANSFER_SRGB:color.transferFunction=ColorSpace::TransferFunction::Srgb;break;
    case ZC_TRANSFER_REC709:color.transferFunction=ColorSpace::TransferFunction::Rec709;break;
    default:return std::nullopt;
    }
    switch(requested.ycbcr_encoding) {
    case ZC_YCBCR_NONE:color.ycbcrEncoding=ColorSpace::YcbcrEncoding::None;break;
    case ZC_YCBCR_REC601:color.ycbcrEncoding=ColorSpace::YcbcrEncoding::Rec601;break;
    case ZC_YCBCR_REC709:color.ycbcrEncoding=ColorSpace::YcbcrEncoding::Rec709;break;
    case ZC_YCBCR_REC2020:color.ycbcrEncoding=ColorSpace::YcbcrEncoding::Rec2020;break;
    default:return std::nullopt;
    }
    if(requested.range==ZC_RANGE_FULL)color.range=ColorSpace::Range::Full;
    else if(requested.range==ZC_RANGE_LIMITED)color.range=ColorSpace::Range::Limited;
    else return std::nullopt;
    if(!processedYuv(format)) { color.ycbcrEncoding=ColorSpace::YcbcrEncoding::None;color.range=ColorSpace::Range::Full; }
    else if(!processedYuv(format) || color.ycbcrEncoding==ColorSpace::YcbcrEncoding::None)return std::nullopt;
    return color;
}
struct Device;
struct CallbackState : std::enable_shared_from_this<CallbackState> {
    std::mutex mutex; Device *owner=nullptr;
    void completed(Request *request);
    void disconnected();
    void retire(){std::lock_guard<std::mutex> lock(mutex);owner=nullptr;}
};
struct Device {
    std::atomic<bool> removed{false};
    std::shared_ptr<CallbackState> callbacks;
    bool loss_connected=false;
    void disconnected() {
        if(!removed.exchange(true,std::memory_order_acq_rel) && callback)
            callback(context,UINT32_MAX,nullptr,nullptr,ZC_DISCONNECTED);
    }
    ManagerLease manager_lease;
    std::shared_ptr<Camera> camera;
    std::unique_ptr<CameraConfiguration> config;
    std::unique_ptr<FrameBufferAllocator> allocator;
    std::vector<Slot> slots;
    zc_config requested{};
    zc_capture_options options{};
    zc_pipeline_info pipeline{};
    std::vector<zc_sensor_mode> modes;
    bool has_lores=false;
    size_t raw_index=1;
    zc_stream &stream(Slot &slot,size_t index) {
        return index==0 ? slot.frame.main : has_lores && index==1 ? slot.lores : slot.frame.raw;
    }
    zc_info info{};
    void *context = nullptr;
    Completion callback = nullptr;
    ControlList pending;
    ControlList desired;
    uint64_t control_revision=0;
    bool writable=false;
    int (*sync_call)(int,uint64_t)=cpuSync;
    const ControlId *controlId(uint32_t id) const {
        if(id==0 || id>=sizeof(controlNames)/sizeof(*controlNames))return nullptr;
        for(const auto &entry:camera->controls())if(entry.first->name()==controlNames[id])return entry.first;
        return nullptr;
    }
    int controlInfo(uint32_t id,zc_control_info *out) const {
        *out={};const auto *control=controlId(id);if(!control)return ZC_UNSUPPORTED;
        const auto &range=camera->controls().at(control);
        out->id=id;out->min_count=1;out->max_count=1;
        switch(control->type()) {
        case ControlTypeBool:out->type=ZC_BOOL;break;
        case ControlTypeInteger32:case ControlTypeInteger64:out->type=ZC_INT;break;
        case ControlTypeFloat:out->type=ZC_FLOAT;break;
        case ControlTypeRectangle:out->type=ZC_RECT;out->min_count=4;out->max_count=id==ZC_AF_WINDOWS?16:4;break;
        default:return ZC_UNSUPPORTED;
        }
        if(id==ZC_COLOUR_GAINS || id==ZC_FRAME_DURATION_LIMITS)out->min_count=out->max_count=2;
        for(size_t i=0;i<4;i++)out->def[i]=std::numeric_limits<double>::quiet_NaN();
        if(!numbers(range.min(),out->min)||!numbers(range.max(),out->max))return ZC_UNSUPPORTED;
        numbers(range.def(),out->def);
        if(out->min_count==2 && !range.min().isArray())out->min[1]=out->min[0];
        if(out->min_count==2 && !range.max().isArray())out->max[1]=out->max[0];
        if(out->type==ZC_INT && out->max_count==1) {
            for(const auto &value:range.values()) {double v[4]{};if(numbers(value,v)&&v[0]>=0&&v[0]<64)out->enum_mask|=uint64_t(1)<<static_cast<unsigned>(v[0]);}
        }
        return ZC_OK;
    }
    int setControls(const zc_control *values,uint32_t count,uint64_t *revision) {
        if(removed.load(std::memory_order_acquire))return ZC_DISCONNECTED;
        if(control_revision==UINT64_MAX)return ZC_STATE;
        auto next=pending;auto saved=desired;
        // AeEnable is a convenience for both newer mode controls; explicit modes
        // in the same batch take precedence, independently of dictionary order.
        for(uint32_t i=0;i<count;i++)if(values[i].id==ZC_AE_ENABLE) {
            const int32_t mode=values[i].values[0]!=0 ? 0 : 1;
            setMode(next,camera,"ExposureTimeMode",mode);setMode(next,camera,"AnalogueGainMode",mode);
            setMode(saved,camera,"ExposureTimeMode",mode);setMode(saved,camera,"AnalogueGainMode",mode);
        }
        for(uint32_t i=0;i<count;i++) {
            const auto &v=values[i];const auto *id=controlId(v.id);if(!id)return ZC_UNSUPPORTED;
            ControlValue value;
            if(v.type==ZC_BOOL)value=ControlValue(v.values[0]!=0);
            else if(v.type==ZC_RECT) {
                std::array<Rectangle,4> rect;
                for(size_t j=0;j<v.count/4;j++)rect[j]=Rectangle(static_cast<int>(v.values[j*4]),static_cast<int>(v.values[j*4+1]),static_cast<unsigned>(v.values[j*4+2]),static_cast<unsigned>(v.values[j*4+3]));
                if(v.id==ZC_SCALER_CROP)value=ControlValue(rect[0]);else value=ControlValue(Span<const Rectangle>(rect.data(),v.count/4));
            } else if(id->type()==ControlTypeFloat) {
                if(v.count==1)value=ControlValue(static_cast<float>(v.values[0]));
                else {std::array<float,16> f{};for(size_t j=0;j<v.count;j++)f[j]=v.values[j];value=ControlValue(Span<const float>(f.data(),v.count));}
            } else if(id->type()==ControlTypeInteger64) {
                if(v.count==1)value=ControlValue(static_cast<int64_t>(v.values[0]));
                else {std::array<int64_t,16> n{};for(size_t j=0;j<v.count;j++)n[j]=v.values[j];value=ControlValue(Span<const int64_t>(n.data(),v.count));}
            } else value=ControlValue(static_cast<int32_t>(v.values[0]));
            next.set(id->id(),value);
            if(v.id!=ZC_AF_TRIGGER && v.id!=ZC_AF_PAUSE)saved.set(id->id(),value);
        }
        pending=std::move(next);desired=std::move(saved);*revision=++control_revision;return ZC_OK;
    }
    bool acquired = false, started = false, connected = false;

    ~Device() {
        // Slots retain relay state while executing. Retire the owner under its mutex,
        // joining any active callback before request/map storage is destroyed.
        if(callbacks)callbacks->retire();
        if (started) camera->stop();
        if (connected) camera->requestCompleted.disconnect(callbacks.get());
        if (loss_connected) camera->disconnected.disconnect(callbacks.get());
        // Requests must be destroyed before the buffers they reference.
        slots.clear();
        allocator.reset();
        if (acquired) camera->release();
        camera.reset();
    }
    static zc_stream geometry(const StreamConfiguration &cfg) {
        zc_stream stream{};
        stream.width = cfg.size.width; stream.height = cfg.size.height; stream.stride = cfg.stride;
        text(stream.format, sizeof(stream.format), cfg.pixelFormat.toString());
        return stream;
    }
    int map(FrameBuffer *buffer, zc_stream &stream, Slot &slot) {
        if (buffer->planes().size() > ZC_MAX_PLANES) return ZC_UNSUPPORTED;
        stream.plane_count = buffer->planes().size();
        const long page = sysconf(_SC_PAGESIZE);
        if (page <= 0) return ZC_IO;
        for (size_t i = 0; i < buffer->planes().size(); ++i) {
            const auto &plane = buffer->planes()[i];
            if (plane.offset == FrameBuffer::Plane::kInvalidOffset) return ZC_UNSUPPORTED;
            const uint64_t start = plane.offset / page * page;
            const uint64_t delta = plane.offset - start;
            const uint64_t length = delta + plane.length;
            if (!plane.length || length > std::numeric_limits<size_t>::max()) return ZC_DEVICE;
            Mapping mapping;
            mapping.length = static_cast<size_t>(length);
            mapping.base = mmap(nullptr, mapping.length, PROT_READ, MAP_SHARED, plane.fd.get(), start);
            if (mapping.base == MAP_FAILED) return ZC_IO;
            auto &p = stream.planes[i];
            p.data = static_cast<const uint8_t *>(mapping.base) + delta;
            p.length = plane.length; p.offset = plane.offset; p.fd = plane.fd.get();
            if (std::find(slot.fds.begin(), slot.fds.begin() + slot.fd_count, p.fd) == slot.fds.begin() + slot.fd_count)
                slot.fds[slot.fd_count++] = p.fd;
            slot.mappings.push_back(std::move(mapping));
        }
        return ZC_OK;
    }
    uint32_t actual_orientation=ZC_ROTATE0;
    int init(const zc_config &cfg, const zc_pipeline_options &pipe, const zc_processed_options &processed,uint32_t orientation,bool strict,void *ctx, Completion complete, const std::string *selected_id=nullptr) {
        const auto &opts=pipe.capture;
        const auto main_format=processed.main_format;
        requested = cfg; options = opts; context = ctx; callback = complete;
        const int manager_rc=manager_lease.acquire();
        if(manager_rc)return manager_rc;
        if(selected_id) {
            camera=managerHost().manager->get(*selected_id);
            if(!camera)return ZC_DEVICE;
        } else {
            const auto cameras = managerHost().manager->cameras();
            if (cfg.camera_index >= cameras.size()) return ZC_DEVICE;
            camera = cameras[cfg.camera_index];
        }
        callbacks=std::make_shared<CallbackState>();callbacks->owner=this;
        camera->disconnected.connect(callbacks.get(),&CallbackState::disconnected);
        loss_connected=true;
        const int acquire_rc=camera->acquire();
        if(acquire_rc<0) {if(acquire_rc==-ENODEV){disconnected();return ZC_DISCONNECTED;}return ZC_BUSY;}
        acquired = true;
        pending=ControlList(camera->controls());desired=ControlList(camera->controls());
        // Inspect raw formats once, before configuring. Discovery never changes
        // a live pipeline and deliberately does not invent per-mode frame rates.
        auto raw_modes=camera->generateConfiguration({StreamRole::Raw});
        if(raw_modes && raw_modes->size()==1) {
            const auto &formats=raw_modes->at(0).formats();
            for(const auto &pixel:formats.pixelformats()) {
                const auto name=pixel.toString();
                if(name.empty() || name[0]!='S')continue;
                const auto digit=name.find_first_of("0123456789");
                if(digit==std::string::npos)continue;
                const auto depth=std::stoul(name.substr(digit));
                if(depth<8 || depth>16)continue;
                for(const auto &size:formats.sizes(pixel)) {
                    zc_sensor_mode mode{};mode.width=size.width;mode.height=size.height;mode.bit_depth=depth;
                    text(mode.format,sizeof(mode.format),name);modes.push_back(mode);
                }
            }
        }
        has_lores=pipe.lores_width!=0;raw_index=has_lores?2:1;
        const StreamRole role = opts.role == ZC_VIDEO ? StreamRole::VideoRecording : opts.role == ZC_PREVIEW ? StreamRole::Viewfinder : StreamRole::StillCapture;
        std::vector<StreamRole> roles{role};
        if(has_lores)roles.push_back(StreamRole::Viewfinder);
        if(cfg.raw)roles.push_back(StreamRole::Raw);
        config = camera->generateConfiguration(roles);
        if (!config || config->size() != roles.size()) return ZC_UNSUPPORTED;
        if(!nativeOrientation(orientation,config->orientation))return ZC_INVALID;
        auto &main_request = config->at(0);
        // libcamera's BGR888 fourcc stores R,G,B bytes on little endian hosts.
        main_request.pixelFormat = processedPixelFormat(main_format);
        main_request.colorSpace = requestedProcessedColorSpace(main_format,processed.color_space);
        if(!main_request.colorSpace)return ZC_UNSUPPORTED;
        if (cfg.width) main_request.size = {cfg.width, cfg.height};
        main_request.bufferCount = cfg.buffer_count;
        if(has_lores) {
            auto &lores=config->at(1);
            lores.size={pipe.lores_width,pipe.lores_height};
            lores.pixelFormat=processedPixelFormat(pipe.lores_format);
            lores.colorSpace=requestedProcessedColorSpace(pipe.lores_format,processed.color_space);
            if(!lores.colorSpace)return ZC_UNSUPPORTED;
            lores.bufferCount=cfg.buffer_count;
        }
        if(pipe.sensor_width) {
            const bool found=std::any_of(modes.begin(),modes.end(),[&](const zc_sensor_mode &m){return m.width==pipe.sensor_width && m.height==pipe.sensor_height && m.bit_depth==pipe.sensor_bit_depth;});
            if(!found)return ZC_UNSUPPORTED;
            config->sensorConfig=SensorConfiguration();
            config->sensorConfig->outputSize={pipe.sensor_width,pipe.sensor_height};
            config->sensorConfig->bitDepth=pipe.sensor_bit_depth;
        }
        if (cfg.raw) {
            auto &raw = config->at(raw_index);
            if(pipe.sensor_width)raw.size={pipe.sensor_width,pipe.sensor_height};
            raw.bufferCount = cfg.buffer_count;
            if (opts.unpacked_raw && !cfg.raw_format[0]) {
                const auto native = raw.pixelFormat.toString();
                std::string pattern;
                for (const char *p : {"RGGB", "BGGR", "GRBG", "GBRG"}) if (native.find(p) != std::string::npos) pattern = p;
                if (pattern.empty()) return ZC_UNSUPPORTED;
                // Ask for uncompressed 16-bit Bayer; validate() can choose a native
                // unpacked depth, but compressed/packed substitutions are rejected below.
                raw.pixelFormat = PixelFormat::fromString("S" + pattern + "16");
            }
            if (cfg.raw_format[0]) {
                raw.pixelFormat = PixelFormat::fromString(cfg.raw_format);
                if (!raw.pixelFormat.isValid()) return ZC_INVALID;
            }
        }
        const auto status = config->validate();
        if (status == CameraConfiguration::Invalid || config->size()!=roles.size()) return ZC_UNSUPPORTED;
        const int orientation_rc=negotiatedOrientation(orientation,config->orientation,strict,actual_orientation);
        if(orientation_rc)return orientation_rc;
        const auto &main = config->at(0);
        if (main.pixelFormat != processedPixelFormat(main_format) || (processedYuv(main_format) && ((main.size.width|main.size.height|main.stride)&1))) return ZC_UNSUPPORTED;
        if (cfg.raw && cfg.raw_format[0] && config->at(raw_index).pixelFormat.toString() != cfg.raw_format) {
            // A sensor flip can change CFA phase while preserving depth/packing.
            // The negotiated descriptor is authoritative for DNG and consumers.
            if(orientation==ZC_ROTATE0 || !sameBayerLayout(cfg.raw_format,config->at(raw_index).pixelFormat.toString()))return ZC_UNSUPPORTED;
        }
        if (cfg.raw && opts.unpacked_raw) {
            const auto name = config->at(raw_index).pixelFormat.toString();
            if (name.empty() || name[0] != 'S' || name.find('_') != std::string::npos) return ZC_UNSUPPORTED;
        }
        pipeline.struct_size=sizeof(pipeline);
        if(config->sensorConfig) {
            const auto &sensor=*config->sensorConfig;
            pipeline.sensor_width=sensor.outputSize.width;pipeline.sensor_height=sensor.outputSize.height;pipeline.sensor_bit_depth=sensor.bitDepth;
        }
        if(pipe.sensor_width && (pipeline.sensor_width!=pipe.sensor_width || pipeline.sensor_height!=pipe.sensor_height || pipeline.sensor_bit_depth!=pipe.sensor_bit_depth))return ZC_UNSUPPORTED;
        if(has_lores) {
            const auto &lores=config->at(1);
            if(lores.pixelFormat!=processedPixelFormat(pipe.lores_format) || lores.size.width>main.size.width || lores.size.height>main.size.height || (processedYuv(pipe.lores_format) && ((lores.size.width|lores.size.height|lores.stride)&1)))return ZC_UNSUPPORTED;
            pipeline.lores=geometry(lores);
        }
        if (camera->configure(config.get()) < 0) return ZC_DEVICE;
        if (cfg.exposure_us && (!has(camera, controls::ExposureTime) || !has(camera, controls::AnalogueGain) || !has(camera, controls::AeEnable)))
            return ZC_UNSUPPORTED;
        if (cfg.frame_duration_us && !has(camera, controls::FrameDurationLimits)) return ZC_UNSUPPORTED;
        if (cfg.lens_position >= 0 && (!has(camera, controls::LensPosition) || !has(camera, controls::AfMode)))
            return ZC_UNSUPPORTED;
        allocator = std::make_unique<FrameBufferAllocator>(camera);
        size_t count = ZC_MAX_BUFFERS;
        for (auto &stream : *config) {
            if (allocator->allocate(stream.stream()) < 0) return ZC_NOMEM;
            count = std::min(count, allocator->buffers(stream.stream()).size());
        }
        if (count < 2 || count > ZC_MAX_BUFFERS) return ZC_DEVICE;
        info.backend = ZC_LIBCAMERA; info.buffer_count = count;
        text(info.camera_id, sizeof(info.camera_id), camera->id());
        info.main = geometry(main);
        if (cfg.raw) info.raw = geometry(config->at(raw_index));
        slots.resize(count);
        for (size_t i = 0; i < count; ++i) {
            auto &slot = slots[i];
            slot.request = camera->createRequest(i);
            if (!slot.request) return ZC_NOMEM;
            slot.frame.main = info.main; slot.frame.raw = info.raw;slot.lores=pipeline.lores;
            for (size_t s = 0; s < config->size(); ++s) {
                auto *stream = config->at(s).stream();
                auto *buffer = allocator->buffers(stream)[i].get();
                if (slot.request->addBuffer(stream, buffer) < 0) return ZC_DEVICE;
                const int rc = map(buffer, this->stream(slot,s), slot);
                if (rc) return rc;
            }
        }
        info.main.plane_count = slots[0].frame.main.plane_count;
        info.raw.plane_count = slots[0].frame.raw.plane_count;
        pipeline.lores.plane_count=slots[0].lores.plane_count;
        camera->requestCompleted.connect(callbacks.get(),&CallbackState::completed);
        connected = true;
        return removed.load(std::memory_order_acquire) ? ZC_DISCONNECTED : ZC_OK;
    }
    void completed(Request *request) {
        if(removed.load(std::memory_order_acquire))return;
        if (request->status() == Request::RequestCancelled) return;
        const auto index = static_cast<uint32_t>(request->cookie());
        auto &frame = slots[index].frame;
        for (size_t s = 0; s < config->size(); ++s) {
            const auto *buffer = request->findBuffer(config->at(s).stream());
            const auto &metadata = buffer->metadata();
            auto &stream = this->stream(slots[index],s);
            if (metadata.status != FrameMetadata::FrameSuccess || metadata.planes().size() != stream.plane_count) {
                callback(context, index, nullptr, nullptr,ZC_DEVICE); return;
            }
            for (size_t p = 0; p < stream.plane_count; ++p) {
                if (metadata.planes()[p].bytesused > stream.planes[p].length) {
                    callback(context, index, nullptr, nullptr,ZC_DEVICE); return;
                }
                stream.planes[p].bytes_used = metadata.planes()[p].bytesused;
            }
            if (s == 0) { frame.sequence = metadata.sequence; frame.timestamp_ns = metadata.timestamp; }
        }
        const auto &meta = request->metadata();
        const auto sensor_timestamp=meta.get(controls::SensorTimestamp);
        if(sensor_timestamp && *sensor_timestamp>0)frame.timestamp_ns=*sensor_timestamp;
        const auto exposure=meta.get(controls::ExposureTime);
        frame.exposure_us = exposure && *exposure>=0 ? *exposure : 0;
        frame.analogue_gain = meta.get(controls::AnalogueGain).value_or(0);
        frame.red_gain = 0; frame.blue_gain = 0;
        const auto gains = meta.get(controls::ColourGains);
        if (gains) { frame.red_gain = (*gains)[0]; frame.blue_gain = (*gains)[1]; }
        auto &raw_meta = slots[index].raw_metadata;
        raw_meta = {};
        const auto model = camera->properties().get(properties::Model);
        text(raw_meta.model, sizeof(raw_meta.model), model.value_or(camera->id()));
        const auto black = meta.get(controls::SensorBlackLevels);
        if (black) { for (int i=0; i<4; ++i) raw_meta.black_levels[i] = (*black)[i]; raw_meta.valid |= 1; }
        const auto matrix = meta.get(controls::ColourCorrectionMatrix);
        if (matrix) { for (int i=0; i<9; ++i) raw_meta.camera_to_srgb[i] = (*matrix)[i]; raw_meta.valid |= 2; }
        if (gains) raw_meta.valid |= 4;
        zc_metadata extra{};if(sensor_timestamp && *sensor_timestamp>0)extra.valid|=16;if(exposure && *exposure>=0)extra.valid|=64;extra.struct_size=sizeof(extra);extra.sequence=frame.sequence;extra.timestamp_ns=frame.timestamp_ns;
        extra.control_revision=slots[index].control_revision;extra.exposure_us=frame.exposure_us;extra.analogue_gain=frame.analogue_gain;extra.red_gain=frame.red_gain;extra.blue_gain=frame.blue_gain;
        extra.af_state=-1;extra.af_pause_state=-1;
        const auto af=meta.get(controls::AfState);if(af){extra.af_state=*af;extra.valid|=1;}
        const auto pause=meta.get(controls::AfPauseState);if(pause){extra.af_pause_state=*pause;extra.valid|=32;}
        const auto lens=meta.get(controls::LensPosition);if(lens){extra.lens_position=*lens;extra.valid|=2;}
        const auto duration=meta.get(controls::FrameDuration);if(duration && *duration>=0){extra.frame_duration_us=*duration;extra.valid|=4;}
        const auto crop=meta.get(controls::ScalerCrop);if(crop){extra.crop[0]=crop->x;extra.crop[1]=crop->y;extra.crop[2]=crop->width;extra.crop[3]=crop->height;extra.valid|=8;}
        callback(context, index, &frame, &extra,ZC_OK);
    }
    int start() {
        if(removed.load(std::memory_order_acquire))return ZC_DISCONNECTED;
        ControlList control(camera->controls());
        // Match Picamera2's still-image quality policy when the camera supports it.
        const uint32_t nr = options.noise_reduction == UINT32_MAX ? (options.role == ZC_STILL ? 2 : options.role == ZC_VIDEO ? 1 : 3) : options.noise_reduction;
        setMode(control, camera, "NoiseReductionMode", nr);
        if (requested.exposure_us) {
            control.set(controls::AeEnable, false);
            setMode(control, camera, "ExposureTimeMode", 1);
            setMode(control, camera, "AnalogueGainMode", 1);
            control.set(controls::ExposureTime, static_cast<int32_t>(requested.exposure_us));
            control.set(controls::AnalogueGain, requested.analogue_gain);
        }
        if (requested.frame_duration_us) {
            const int64_t duration = requested.frame_duration_us;
            control.set(controls::FrameDurationLimits, Span<const int64_t, 2>({duration, duration}));
        }
        if (has(camera, controls::AfMode)) {
            control.set(controls::AfMode, requested.lens_position >= 0 ? controls::AfModeManual : controls::AfModeContinuous);
            if (requested.lens_position >= 0) control.set(controls::LensPosition, requested.lens_position);
        }
        for(const auto &entry:desired)control.set(entry.first,entry.second);
        const int rc = camera->start(&control);
        if (rc < 0) {if(rc==-ENODEV){disconnected();return ZC_DISCONNECTED;}return ZC_DEVICE;}
        started = true;
        return ZC_OK;
    }
    int queue(uint32_t index) {
        if(removed.load(std::memory_order_acquire))return ZC_DISCONNECTED;
        if (index >= slots.size()) return ZC_INVALID;
        auto &slot = slots[index];
        if (slot.used) slot.request->reuse(Request::ReuseBuffers);
        slot.used = true;
        slot.request->controls()=pending;slot.control_revision=control_revision;
        const int queued=camera->queueRequest(slot.request.get());
        if(queued<0){if(queued==-ENODEV){disconnected();return ZC_DISCONNECTED;}return ZC_DEVICE;}
        pending.clear();return ZC_OK;
    }
    int sync(uint32_t index, bool begin) {
        auto &slot = slots[index];
        int result = ZC_OK;
        const uint64_t access=writable ? DMA_BUF_SYNC_RW : DMA_BUF_SYNC_READ;
        for (size_t i = 0; i < slot.fd_count; ++i) {
            const int rc=sync_call(slot.fds[i],(begin ? DMA_BUF_SYNC_START : DMA_BUF_SYNC_END)|access);
            if (rc < 0) {
                if (begin) {
                    for (size_t j = 0; j < i; ++j) {
                        (void)sync_call(slot.fds[j],DMA_BUF_SYNC_END|access);
                    }
                }
                if (begin) return ZC_IO;
                // End CPU access on every plane even if an earlier fd failed.
                result = ZC_IO;
            }
        }
        return result;
    }
    int enableWritable() {
        if(started)return ZC_STATE;
        for(auto &slot:slots)for(auto &map:slot.mappings) {
            // Partial permission upgrades are harmless on failure: writable
            // access remains disabled and all public read pointers stay const.
            if(mprotect(map.base,map.length,PROT_READ|PROT_WRITE)<0)
                return errno==EACCES || errno==EPERM ? ZC_UNSUPPORTED : ZC_IO;
        }
        writable=true;return ZC_OK;
    }
};
void CallbackState::completed(Request *request) {
    const auto relay=shared_from_this();
    std::lock_guard<std::mutex> lock(relay->mutex);
    if(relay->owner)relay->owner->completed(request);
}
void CallbackState::disconnected() {
    const auto relay=shared_from_this();
    std::lock_guard<std::mutex> lock(relay->mutex);
    if(relay->owner)relay->owner->disconnected();
}

}
extern "C" int zcd_open(const zc_config *cfg, const zc_pipeline_options *opts,const zc_processed_options *processed,uint32_t orientation,bool strict,uint32_t *actual, void *ctx, Completion cb, Device **out, zc_info *info,zc_pipeline_info *pipeline) {
    *out = nullptr;
    try {
        auto device = std::make_unique<Device>();
        const int rc = device->init(*cfg, *opts,*processed,orientation,strict, ctx, cb);
        if (rc) return rc;
        *info = device->info; *pipeline=device->pipeline;*actual=device->actual_orientation; *out = device.release(); return ZC_OK;
    } catch (const std::bad_alloc &) { return ZC_NOMEM; }
      catch (...) { return ZC_DEVICE; }
}
extern "C" int zcd_start(Device *device) { try { return device->start(); } catch (...) { return ZC_DEVICE; } }
extern "C" int zcd_queue(Device *device, uint32_t index) { try { return device->queue(index); } catch (...) { return ZC_DEVICE; } }
extern "C" int zcd_sync(Device *device, uint32_t index, bool begin) { return device->sync(index, begin); }
extern "C" int zcd_enable_writable(Device *device) { return device->enableWritable(); }
extern "C" int zcd_stop(Device *device) {
    if (!device->started) {device->pending.clear();return ZC_OK;}
    const int rc = device->camera->stop();
    if (rc < 0 && !(rc==-ENODEV && device->removed.load(std::memory_order_acquire))) return ZC_DEVICE;
    device->started = false;
    device->pending.clear();
    return ZC_OK;
}
extern "C" void zcd_close(Device *device) { delete device; }

extern "C" int zcd_metadata(Device *device, uint32_t index, zc_raw_metadata *out) {
    if (index >= device->slots.size()) return ZC_INVALID;
    *out = device->slots[index].raw_metadata;
    return ZC_OK;
}

extern "C" int zcd_control_info(Device *device,uint32_t id,zc_control_info *out) {
    try{return device->controlInfo(id,out);}catch(...){return ZC_DEVICE;}
}
extern "C" int zcd_set_controls(Device *device,const zc_control *values,uint32_t count,uint64_t *revision) {
    try{return device->setControls(values,count,revision);}catch(const std::bad_alloc &){return ZC_NOMEM;}catch(...){return ZC_DEVICE;}
}

extern "C" int zcd_sensor_modes(Device *device,zc_sensor_mode *modes,uint32_t capacity,uint32_t *count) {
    *count=device->modes.size();
    if(!modes)return capacity==0 ? ZC_OK : ZC_INVALID;
    if(capacity<*count)return ZC_INVALID;
    std::copy(device->modes.begin(),device->modes.end(),modes);return ZC_OK;
}
static zc_color_space portableColorSpace(const std::optional<ColorSpace> &space) {
    zc_color_space out{};out.struct_size=sizeof(out);
    if(!space)return out;
    out.present=1;
    switch(space->primaries) {
    case ColorSpace::Primaries::Raw:out.primaries=ZC_PRIMARIES_RAW;break;
    case ColorSpace::Primaries::Smpte170m:out.primaries=ZC_PRIMARIES_SMPTE170M;break;
    case ColorSpace::Primaries::Rec709:out.primaries=ZC_PRIMARIES_REC709;break;
    case ColorSpace::Primaries::Rec2020:out.primaries=ZC_PRIMARIES_REC2020;break;
    default:break;
    }
    switch(space->transferFunction) {
    case ColorSpace::TransferFunction::Linear:out.transfer=ZC_TRANSFER_LINEAR;break;
    case ColorSpace::TransferFunction::Srgb:out.transfer=ZC_TRANSFER_SRGB;break;
    case ColorSpace::TransferFunction::Rec709:out.transfer=ZC_TRANSFER_REC709;break;
    default:break;
    }
    switch(space->ycbcrEncoding) {
    case ColorSpace::YcbcrEncoding::None:out.ycbcr_encoding=ZC_YCBCR_NONE;break;
    case ColorSpace::YcbcrEncoding::Rec601:out.ycbcr_encoding=ZC_YCBCR_REC601;break;
    case ColorSpace::YcbcrEncoding::Rec709:out.ycbcr_encoding=ZC_YCBCR_REC709;break;
    case ColorSpace::YcbcrEncoding::Rec2020:out.ycbcr_encoding=ZC_YCBCR_REC2020;break;
    default:break;
    }
    switch(space->range) {
    case ColorSpace::Range::Full:out.range=ZC_RANGE_FULL;break;
    case ColorSpace::Range::Limited:out.range=ZC_RANGE_LIMITED;break;
    default:break;
    }
    return out;
}
extern "C" int zcd_color_space(Device *device,uint32_t stream,zc_color_space *out) {
    size_t index=0;
    switch(stream) {
    case ZC_MAIN:break;
    case ZC_RAW:if(!device->requested.raw)return ZC_UNSUPPORTED;index=device->raw_index;break;
    case ZC_LORES:if(!device->has_lores)return ZC_UNSUPPORTED;index=1;break;
    default:return ZC_INVALID;
    }
    *out=portableColorSpace(device->config->at(index).colorSpace);return ZC_OK;
}
extern "C" int zcd_lores(Device *device,uint32_t index,zc_stream *out) {
    if(index>=device->slots.size())return ZC_INVALID;
    if(!device->has_lores)return ZC_UNSUPPORTED;
    *out=device->slots[index].lores;return ZC_OK;
}

extern "C" int zcd_camera_watch_open(void *context,CameraNotice callback,ManagerWatch **out) {
    *out=nullptr;
    try {
        auto watch=std::make_unique<ManagerWatch>();
        const int rc=watch->lease.acquire();if(rc)return rc;
        watch->callbacks=std::make_shared<WatchCallbacks>();
        watch->callbacks->context=context;watch->callbacks->callback=callback;
        auto &manager=*managerHost().manager;
        manager.cameraAdded.connect(watch->callbacks.get(),&WatchCallbacks::added);watch->added=true;
        manager.cameraRemoved.connect(watch->callbacks.get(),&WatchCallbacks::removed);watch->removed=true;
        *out=watch.release();return ZC_OK;
    }catch(const std::bad_alloc &){return ZC_NOMEM;}catch(...){return ZC_DEVICE;}
}
extern "C" void zcd_camera_watch_close(ManagerWatch *watch){delete watch;}

extern "C" int zcd_discover(const zcd_catalog_sink *s) {
    try {
        ManagerLease lease;
        const int rc=lease.acquire();if(rc)return rc;
        const auto cameras=managerHost().manager->cameras();
        if(cameras.size()>UINT32_MAX)return ZC_BUSY;
        for(size_t i=0;i<cameras.size();i++) {
            const auto &camera=cameras[i];
            zcd_catalog_record r{};r.group=i;r.kind=6;r.name="CameraId";r.name_length=8;
            int result=s->begin(s->context,&r);if(result)return result;
            zcd_catalog_value v{};v.kind=6;v.flags=1;v.count=camera->id().size();v.data=reinterpret_cast<const uint8_t *>(camera->id().data());v.length=camera->id().size();
            result=s->value(s->context,&v);if(result)return result;
            result=s->end(s->context);if(result)return result;
            result=catalogList(*s,camera->properties(),i);if(result)return result;
        }
        return ZC_OK;
    }catch(const std::bad_alloc &){return ZC_NOMEM;}catch(...){return ZC_DEVICE;}
}
extern "C" int zcd_catalog(Device *device,uint32_t kind,uint32_t index,const zcd_catalog_sink *s) {
    try {
        if(kind==2)return catalogList(*s,device->camera->properties());
        if(kind==4) {
            if(index>=device->slots.size())return ZC_INVALID;
            return catalogList(*s,device->slots[index].request->metadata());
        }
        if(kind!=3)return ZC_INVALID;
        for(const auto &entry:device->camera->controls()) {
            int rc=beginCatalog(*s,entry.first,0,entry.first->id(),entry.first->type());if(rc)return rc;
            const ControlValue *values[]={&entry.second.min(),&entry.second.max(),&entry.second.def()};
            for(uint32_t i=0;i<3;i++){rc=catalogValue(*s,i+1,*values[i]);if(rc)return rc;}
            for(const auto &value:entry.second.values()){rc=catalogValue(*s,4,value);if(rc)return rc;}
            rc=enumCatalog(*s,entry.first);if(rc)return rc;
            rc=s->end(s->context);if(rc)return rc;
        }
        return ZC_OK;
    }catch(const std::bad_alloc &){return ZC_NOMEM;}catch(...){return ZC_DEVICE;}
}

extern "C" int zcd_open_id(const zc_config *cfg,const zc_pipeline_options *opts,const zc_processed_options *processed,uint32_t orientation,bool strict,uint32_t *actual,const uint8_t *id,uint32_t length,void *ctx,Completion cb,Device **out,zc_info *info,zc_pipeline_info *pipeline) {
    *out=nullptr;
    try {
        auto device=std::make_unique<Device>();
        const std::string selected(reinterpret_cast<const char *>(id),length);
        const int rc=device->init(*cfg,*opts,*processed,orientation,strict,ctx,cb,&selected);
        if(rc)return rc;
        *info=device->info;*pipeline=device->pipeline;*actual=device->actual_orientation;*out=device.release();return ZC_OK;
    }catch(const std::bad_alloc &){return ZC_NOMEM;}catch(...){return ZC_DEVICE;}
}
extern "C" int zcd_camera_id(Device *device,uint8_t *data,uint64_t capacity,uint64_t *length) {
    const auto &id=device->camera->id();*length=id.size();
    if(!data)return capacity==0 ? ZC_OK : ZC_INVALID;
    if(capacity<id.size())return ZC_INVALID;
    std::memcpy(data,id.data(),id.size());return ZC_OK;
}

// Preparing copies pending/backend replay state and validates everything before
// publication. Zig can allocate its owned journal before this transaction commits.
namespace {
struct PreparedControls {
    Device *owner;
    uint64_t version;
    ControlList pending, desired;
    bool committed=false;
    explicit PreparedControls(Device *d):owner(d),version(d->control_revision),pending(d->pending),desired(d->desired){}
};
size_t elementWidth(uint32_t kind) {
    switch(kind){case 1:case 2:case 6:return 1;case 9:return 2;case 3:case 5:case 10:return 4;case 4:case 8:case 11:return 8;case 7:return 16;default:return 0;}
}
template<class T> T inputNumber(const zcd_catalog_value &v,size_t element) {
    T out{};auto *bytes=reinterpret_cast<uint8_t *>(&out);
    const uint16_t endian=1;const bool same=bool(v.flags&2)==bool(*reinterpret_cast<const uint8_t *>(&endian));
    for(size_t i=0;i<sizeof(T);i++)bytes[i]=v.data[element*sizeof(T)+(same ? i : sizeof(T)-1-i)];
    return out;
}
template<class T> int makeGeometry(const zcd_catalog_value &v,ControlValue &out) {
    if constexpr(std::is_constructible_v<ControlValue,T>) {
        std::vector<T> items;items.reserve(v.count);
        for(size_t i=0;i<v.count;i++) {
            if constexpr(std::is_same_v<T,Rectangle>) items.emplace_back(inputNumber<int32_t>(v,i*4),inputNumber<int32_t>(v,i*4+1),inputNumber<uint32_t>(v,i*4+2),inputNumber<uint32_t>(v,i*4+3));
            else if constexpr(std::is_same_v<T,Size>)items.emplace_back(inputNumber<uint32_t>(v,i*2),inputNumber<uint32_t>(v,i*2+1));
            else items.emplace_back(inputNumber<int32_t>(v,i*2),inputNumber<int32_t>(v,i*2+1));
        }
        out=v.flags&1 ? ControlValue(Span<const T>(items.data(),items.size())) : ControlValue(items[0]);return ZC_OK;
    }
    return ZC_UNSUPPORTED;
}
int inputValue(const ControlId *id,const zcd_catalog_value &v,ControlValue &out) {
    const uint32_t type=portableType(id->type());
    if(type==0 || type==255)return ZC_UNSUPPORTED;
    if(v.kind!=type)return ZC_INVALID;
    const size_t width=elementWidth(type);
    if(v.length>4*1024*1024 || v.length!=uint64_t(v.count)*width || (!(v.flags&1) && type!=6 && v.count!=1))return ZC_INVALID;
    if(type==7)return makeGeometry<Rectangle>(v,out);
    if(type==8)return makeGeometry<Size>(v,out);
    if(type==11)return makeGeometry<Point>(v,out);
    out.reserve(id->type(),bool(v.flags&1)||type==6,v.count);
    auto data=out.data();if(data.size()!=v.length)return ZC_INVALID;
    const uint16_t endian=1;const bool same=bool(v.flags&2)==bool(*reinterpret_cast<const uint8_t *>(&endian));
    for(size_t i=0;i<v.count;i++)for(size_t j=0;j<width;j++)data[i*width+j]=v.data[i*width+(same ? j : width-1-j)];
    if(type==1)for(const auto b:data)if(b>1)return ZC_INVALID;
    if(type==5)for(size_t i=0;i<v.count;i++){float f;std::memcpy(&f,data.data()+i*4,4);if(!std::isfinite(f))return ZC_INVALID;}
    return ZC_OK;
}
template<class T> bool numericRange(const ControlValue &v,const ControlValue &bound,bool minimum) {
    if(bound.isNone())return true;
    if(v.type()!=bound.type() || (bound.numElements()!=1 && bound.numElements()!=v.numElements()))return false;
    const auto data=v.data(),limits=bound.data();
    for(size_t i=0;i<v.numElements();i++) {
        T number,edge;std::memcpy(&number,data.data()+i*sizeof(T),sizeof(T));
        std::memcpy(&edge,limits.data()+(bound.numElements()==1?0:i)*sizeof(T),sizeof(T));
        if(minimum ? number<edge : number>edge)return false;
    }
    return true;
}
template<class T> bool geometryRange(const ControlValue &v,const ControlInfo &range) {
    if constexpr(std::is_constructible_v<ControlValue,T>) {
        const auto &lo=range.min(),&hi=range.max();
        for(const auto *bound:{&lo,&hi})if(!bound->isNone() && (bound->type()!=v.type() || (bound->numElements()!=1 && bound->numElements()!=v.numElements())))return false;
        auto element=[](const ControlValue &value,size_t i){return value.isArray()?value.get<Span<const T>>()[value.numElements()==1?0:i]:value.get<T>();};
        for(size_t i=0;i<v.numElements();i++) {
            const auto value=element(v,i);
            if(!lo.isNone()) {
                const auto bound=element(lo,i);
                if constexpr(std::is_same_v<T,Rectangle>) {if(value.x<bound.x||value.y<bound.y||value.width<bound.width||value.height<bound.height)return false;}
                else if constexpr(std::is_same_v<T,Size>) {if(value.width<bound.width||value.height<bound.height)return false;}
                else if(value.x<bound.x||value.y<bound.y)return false;
            }
            if(!hi.isNone()) {
                const auto bound=element(hi,i);
                if constexpr(std::is_same_v<T,Rectangle>) {if(int64_t(value.x)+value.width>int64_t(bound.x)+bound.width||int64_t(value.y)+value.height>int64_t(bound.y)+bound.height)return false;}
                else if constexpr(std::is_same_v<T,Size>) {if(value.width>bound.width||value.height>bound.height)return false;}
                else if(value.x>bound.x||value.y>bound.y)return false;
            }
        }
        return true;
    }
    return false;
}

bool rangeValue(const ControlValue &v,const ControlInfo &range) {
    const uint32_t type=portableType(v.type());
    auto both=[&](auto value){using T=decltype(value);return numericRange<T>(v,range.min(),true)&&numericRange<T>(v,range.max(),false);};
    switch(type) {
    case 1:case 2:if(!both(uint8_t{}))return false;break;
    case 3:if(!both(int32_t{}))return false;break;
    case 4:if(!both(int64_t{}))return false;break;
    case 5:if(!both(float{}))return false;break;
    case 9:if(!both(uint16_t{}))return false;break;
    case 10:if(!both(uint32_t{}))return false;break;
    case 7:if(!geometryRange<Rectangle>(v,range))return false;break;
    case 8:if(!geometryRange<Size>(v,range))return false;break;
    case 11:if(!geometryRange<Point>(v,range))return false;break;
    default:break;
    }
    if(!range.values().empty()) {
        if(!v.isArray() || type==6){for(const auto &choice:range.values())if(v==choice)return true;return false;}
        for(const auto &choice:range.values())if(v==choice)return true;
        const auto data=v.data();const auto width=elementWidth(type);
        for(size_t i=0;i<v.numElements();i++) {
            bool found=false;
            for(const auto &choice:range.values())if(!choice.isArray() && choice.type()==v.type() && choice.data().size()==width && std::memcmp(data.data()+i*width,choice.data().data(),width)==0){found=true;break;}
            if(!found)return false;
        }
    }
    return true;
}
template<class T> int writableShape(const T *id,const ControlValue &v) {
    if constexpr(HasCatalogInfo<T>::value) {
        if(!id->isInput())return ZC_UNSUPPORTED;
        if(v.type()!=ControlTypeString && id->isArray()!=v.isArray())return ZC_INVALID;
        if(id->isArray() && id->size()!=std::numeric_limits<size_t>::max() && id->size()!=v.numElements())return ZC_INVALID;
    }
    return ZC_OK;
}
template<class T> bool expectedVendor(const T *id,const zcd_catalog_record &r) {
    if(!(r.flags&32))return true;
    if constexpr(HasCatalogInfo<T>::value)return id->vendor()==(r.vendor_length?std::string(r.vendor,r.vendor_length):std::string{});
    return r.vendor_length==0;
}
}
extern "C" int zcd_prepare_native_controls(Device *device,const zcd_control_input *inputs,uint32_t count,const zcd_catalog_sink *sink,PreparedControls **out) {
    if(device->removed.load(std::memory_order_acquire)){*out=nullptr;return ZC_DISCONNECTED;}
    *out=nullptr;
    try {
        if(device->control_revision==UINT64_MAX)return ZC_STATE;
        auto staged=std::make_unique<PreparedControls>(device);
        struct Value {const ControlId *id;ControlValue value;bool persistent;uint32_t app;};
        std::vector<Value> values;values.reserve(count);
        for(uint32_t i=0;i<count;i++) {
            const auto &r=inputs[i].record;const auto found=device->camera->controls().find(r.id);
            if(found==device->camera->controls().end())return ZC_UNSUPPORTED;
            const auto *id=found->first;
            if((r.name_length && id->name()!=std::string(r.name,r.name_length))||!expectedVendor(id,r))return ZC_UNSUPPORTED;
            ControlValue value;int rc=inputValue(id,inputs[i].value,value);if(rc)return rc;
            rc=writableShape(id,value);if(rc)return rc;
            if(!rangeValue(value,found->second))return ZC_INVALID;
            for(const auto &previous:values)if(previous.id==id)return ZC_INVALID;
            const auto named=appControl(id->name());
            const uint32_t app=named && device->controlId(named)==id ? named : 0;
            if(app==ZC_AE_ENABLE && (value.type()!=ControlTypeBool || value.isArray()))return ZC_INVALID;
            if(app==ZC_COLOUR_GAINS && (!value.isArray()||value.numElements()!=2))return ZC_INVALID;
            if(app==ZC_AF_WINDOWS && !value.isArray())return ZC_INVALID;
            if(app==ZC_SCALER_CROP && value.isArray())return ZC_INVALID;
            if(app==ZC_FRAME_DURATION_LIMITS && value.type()==ControlTypeInteger64){if(!value.isArray())return ZC_INVALID;const auto limits=value.get<Span<const int64_t>>();if(limits.size()!=2||limits[0]>limits[1])return ZC_INVALID;}
            values.push_back({id,std::move(value),!(r.flags&128)&&app!=ZC_AF_TRIGGER&&app!=ZC_AF_PAUSE,app});
        }
        for(const auto &v:values)if(v.app==ZC_AE_ENABLE) {
            const int32_t mode=v.value.get<bool>()?0:1;
            setMode(staged->pending,device->camera,"ExposureTimeMode",mode);setMode(staged->pending,device->camera,"AnalogueGainMode",mode);
            if(v.persistent){setMode(staged->desired,device->camera,"ExposureTimeMode",mode);setMode(staged->desired,device->camera,"AnalogueGainMode",mode);}
        }
        for(const auto &v:values) {
            staged->pending.set(v.id->id(),v.value);
            if(v.persistent)staged->desired.set(v.id->id(),v.value);
            int rc=beginCatalog(*sink,v.id,0,v.id->id(),v.id->type(),v.persistent?0:128,v.app);if(rc)return rc;
            rc=catalogValue(*sink,0,v.value);if(rc)return rc;
            rc=sink->end(sink->context);if(rc)return rc;
        }
        *out=staged.release();return ZC_OK;
    }catch(const std::bad_alloc &){return ZC_NOMEM;}catch(...){return ZC_DEVICE;}
}
extern "C" int zcd_commit_native_controls(Device *device,PreparedControls *p,uint64_t *revision) {
    if(device->removed.load(std::memory_order_acquire))return ZC_DISCONNECTED;
    if(p->owner!=device || p->committed || p->version!=device->control_revision)return ZC_STALE;
    if(device->control_revision==UINT64_MAX)return ZC_STATE;
    device->pending=std::move(p->pending);device->desired=std::move(p->desired);
    *revision=++device->control_revision;p->committed=true;return ZC_OK;
}
extern "C" void zcd_close_native_controls(PreparedControls *p){delete p;}

extern "C" int zcd_photo_values(Device *device,uint32_t index,zcd_photo_metadata *out) {
    *out={}; if(index>=device->slots.size()) return ZC_INVALID;
    const auto &metadata=device->slots[index].request->metadata();
    if(const auto gain=metadata.get(controls::DigitalGain)) { out->valid|=1; out->digital_gain=*gain; }
    // Name lookup supports older headers without a FrameWallClock declaration.
    const auto *ids=metadata.idMap();
    if(ids) for(const auto &entry:metadata) {
        const auto found=ids->find(entry.first);
        if(found==ids->end() || !standardMetadataName(found->second,"FrameWallClock")) continue;
        if(entry.second.type()!=ControlTypeInteger64 || entry.second.isArray()) continue;
        const auto stamp=entry.second.get<int64_t>();
        if(stamp>0) { out->valid|=2; out->wallclock_ns=stamp; } break;
    }
    return ZC_OK;
}
template<class T> bool synchronizationMetadataName(const T *id,const char *name) {
    if(!id || id->name()!=name)return false;
    if constexpr(HasCatalogInfo<T>::value)
        return id->vendor()=="rpi" || id->vendor()=="libcamera";
    return true; // Older ControlId headers have no vendor provenance.
}
extern "C" int zcd_frame_sync_state(Device *device,uint32_t index,zc_frame_sync_state *out) {
    *out={};out->struct_size=sizeof(*out);
    if(index>=device->slots.size())return ZC_INVALID;
    const auto &metadata=device->slots[index].request->metadata();
    const auto *ids=metadata.idMap();
    if(!ids)return ZC_OK;
    for(const auto &entry:metadata) {
        const auto found=ids->find(entry.first);
        if(found==ids->end())continue;
        const auto *id=found->second;
        const auto &value=entry.second;
        if(synchronizationMetadataName(id,"SyncReady")) {
            if(out->valid&1)return ZC_DEVICE;
            if(value.type()!=ControlTypeBool || value.isArray())return ZC_UNSUPPORTED;
            out->ready=value.get<bool>();out->valid|=1;
        }else if(synchronizationMetadataName(id,"SyncTimer")) {
            if(out->valid&2)return ZC_DEVICE;
            if(value.type()!=ControlTypeInteger64 || value.isArray())return ZC_UNSUPPORTED;
            out->timer_us=value.get<int64_t>();out->valid|=2;
        }
    }
    return ZC_OK;
}
