// A narrow C++ boundary: discovery, negotiation, reusable libcamera requests,
// persistent read-only plane mappings and mandatory DMA-BUF CPU synchronization.
// Ownership, ready queues, leases and consumer policy live in Zig.
#include "zig_camera.h"
#include <libcamera/libcamera.h>
#include <libcamera/control_ids.h>
#include <libcamera/formats.h>
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

using namespace libcamera;
using Completion = void (*)(void *, uint32_t, const zc_frame *, const zc_metadata *, int);
namespace {
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
    std::vector<Mapping> mappings;
    std::array<int, ZC_MAX_PLANES * 2> fds{};
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
struct Device {
    CameraManager manager;
    std::shared_ptr<Camera> camera;
    std::unique_ptr<CameraConfiguration> config;
    std::unique_ptr<FrameBufferAllocator> allocator;
    std::vector<Slot> slots;
    zc_config requested{};
    zc_capture_options options{};
    zc_info info{};
    void *context = nullptr;
    Completion callback = nullptr;
    ControlList pending;
    ControlList desired;
    uint64_t control_revision=0;
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
    bool manager_started = false, acquired = false, started = false, connected = false;

    ~Device() {
        if (started) camera->stop();
        if (connected) camera->requestCompleted.disconnect(this);
        // Requests must be destroyed before the buffers they reference.
        slots.clear();
        allocator.reset();
        if (acquired) camera->release();
        camera.reset();
        if (manager_started) manager.stop();
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
    int init(const zc_config &cfg, const zc_capture_options &opts, void *ctx, Completion complete) {
        requested = cfg; options = opts; context = ctx; callback = complete;
        if (manager.start() < 0) return ZC_DEVICE;
        manager_started = true;
        const auto cameras = manager.cameras();
        if (cfg.camera_index >= cameras.size()) return ZC_DEVICE;
        camera = cameras[cfg.camera_index];
        if (camera->acquire() < 0) return ZC_BUSY;
        acquired = true;
        pending=ControlList(camera->controls());desired=ControlList(camera->controls());
        const StreamRole role = opts.role == ZC_VIDEO ? StreamRole::VideoRecording : opts.role == ZC_PREVIEW ? StreamRole::Viewfinder : StreamRole::StillCapture;
        const std::vector<StreamRole> roles = cfg.raw ? std::vector<StreamRole>{role, StreamRole::Raw} : std::vector<StreamRole>{role};
        config = camera->generateConfiguration(roles);
        if (!config || config->size() != roles.size()) return ZC_UNSUPPORTED;
        auto &main = config->at(0);
        // libcamera's BGR888 fourcc stores R,G,B bytes on little endian hosts.
        main.pixelFormat = formats::BGR888;
        main.colorSpace = ColorSpace::Sycc;
        main.colorSpace->ycbcrEncoding = ColorSpace::YcbcrEncoding::None;
        main.colorSpace->range = ColorSpace::Range::Full;
        if (cfg.width) main.size = {cfg.width, cfg.height};
        main.bufferCount = cfg.buffer_count;
        if (cfg.raw) {
            auto &raw = config->at(1);
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
        if (status == CameraConfiguration::Invalid) return ZC_UNSUPPORTED;
        if (main.pixelFormat != formats::BGR888) return ZC_UNSUPPORTED;
        if (cfg.raw && cfg.raw_format[0] && config->at(1).pixelFormat.toString() != cfg.raw_format)
            return ZC_UNSUPPORTED;
        if (cfg.raw && opts.unpacked_raw) {
            const auto name = config->at(1).pixelFormat.toString();
            if (name.empty() || name[0] != 'S' || name.find('_') != std::string::npos) return ZC_UNSUPPORTED;
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
        if (cfg.raw) info.raw = geometry(config->at(1));
        slots.resize(count);
        for (size_t i = 0; i < count; ++i) {
            auto &slot = slots[i];
            slot.request = camera->createRequest(i);
            if (!slot.request) return ZC_NOMEM;
            slot.frame.main = info.main; slot.frame.raw = info.raw;
            for (size_t s = 0; s < config->size(); ++s) {
                auto *stream = config->at(s).stream();
                auto *buffer = allocator->buffers(stream)[i].get();
                if (slot.request->addBuffer(stream, buffer) < 0) return ZC_DEVICE;
                const int rc = map(buffer, s == 0 ? slot.frame.main : slot.frame.raw, slot);
                if (rc) return rc;
            }
        }
        info.main.plane_count = slots[0].frame.main.plane_count;
        info.raw.plane_count = slots[0].frame.raw.plane_count;
        camera->requestCompleted.connect(this, &Device::completed);
        connected = true;
        return ZC_OK;
    }
    void completed(Request *request) {
        if (request->status() == Request::RequestCancelled) return;
        const auto index = static_cast<uint32_t>(request->cookie());
        auto &frame = slots[index].frame;
        for (size_t s = 0; s < config->size(); ++s) {
            const auto *buffer = request->findBuffer(config->at(s).stream());
            const auto &metadata = buffer->metadata();
            auto &stream = s == 0 ? frame.main : frame.raw;
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
        frame.exposure_us = meta.get(controls::ExposureTime).value_or(0);
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
        zc_metadata extra{};extra.struct_size=sizeof(extra);extra.sequence=frame.sequence;extra.timestamp_ns=frame.timestamp_ns;
        extra.control_revision=slots[index].control_revision;extra.exposure_us=frame.exposure_us;extra.analogue_gain=frame.analogue_gain;extra.red_gain=frame.red_gain;extra.blue_gain=frame.blue_gain;
        extra.af_state=-1;extra.af_pause_state=-1;
        const auto af=meta.get(controls::AfState);if(af){extra.af_state=*af;extra.valid|=1;}
        const auto pause=meta.get(controls::AfPauseState);if(pause)extra.af_pause_state=*pause;
        const auto lens=meta.get(controls::LensPosition);if(lens){extra.lens_position=*lens;extra.valid|=2;}
        const auto duration=meta.get(controls::FrameDuration);if(duration && *duration>=0){extra.frame_duration_us=*duration;extra.valid|=4;}
        const auto crop=meta.get(controls::ScalerCrop);if(crop){extra.crop[0]=crop->x;extra.crop[1]=crop->y;extra.crop[2]=crop->width;extra.crop[3]=crop->height;extra.valid|=8;}
        callback(context, index, &frame, &extra,ZC_OK);
    }
    int start() {
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
        if (rc < 0) return ZC_DEVICE;
        started = true;
        return ZC_OK;
    }
    int queue(uint32_t index) {
        if (index >= slots.size()) return ZC_INVALID;
        auto &slot = slots[index];
        if (slot.used) slot.request->reuse(Request::ReuseBuffers);
        slot.used = true;
        slot.request->controls()=pending;slot.control_revision=control_revision;
        if(camera->queueRequest(slot.request.get())<0)return ZC_DEVICE;
        pending.clear();return ZC_OK;
    }
    int sync(uint32_t index, bool begin) {
        auto &slot = slots[index];
        int result = ZC_OK;
        for (size_t i = 0; i < slot.fd_count; ++i) {
            dma_buf_sync sync{};
            sync.flags = (begin ? DMA_BUF_SYNC_START : DMA_BUF_SYNC_END) | DMA_BUF_SYNC_READ;
            int rc;
            do { rc = ioctl(slot.fds[i], DMA_BUF_IOCTL_SYNC, &sync); } while (rc < 0 && errno == EINTR);
            if (rc < 0) {
                if (begin) {
                    for (size_t j = 0; j < i; ++j) {
                        dma_buf_sync undo{}; undo.flags = DMA_BUF_SYNC_END | DMA_BUF_SYNC_READ;
                        int undo_rc;
                        do { undo_rc = ioctl(slot.fds[j], DMA_BUF_IOCTL_SYNC, &undo); } while (undo_rc < 0 && errno == EINTR);
                    }
                }
                if (begin) return ZC_IO;
                // End CPU access on every plane even if an earlier fd failed.
                result = ZC_IO;
            }
        }
        return result;
    }
};
}
extern "C" int zcd_open(const zc_config *cfg, const zc_capture_options *opts, void *ctx, Completion cb, Device **out, zc_info *info) {
    *out = nullptr;
    try {
        auto device = std::make_unique<Device>();
        const int rc = device->init(*cfg, *opts, ctx, cb);
        if (rc) return rc;
        *info = device->info; *out = device.release(); return ZC_OK;
    } catch (const std::bad_alloc &) { return ZC_NOMEM; }
      catch (...) { return ZC_DEVICE; }
}
extern "C" int zcd_start(Device *device) { try { return device->start(); } catch (...) { return ZC_DEVICE; } }
extern "C" int zcd_queue(Device *device, uint32_t index) { try { return device->queue(index); } catch (...) { return ZC_DEVICE; } }
extern "C" int zcd_sync(Device *device, uint32_t index, bool begin) { return device->sync(index, begin); }
extern "C" int zcd_stop(Device *device) {
    if (!device->started) return ZC_OK;
    const int rc = device->camera->stop();
    if (rc < 0) return ZC_DEVICE;
    device->started = false;
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
