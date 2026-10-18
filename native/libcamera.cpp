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

using namespace libcamera;
using Completion = void (*)(void *, uint32_t, const zc_frame *, int);
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
struct Device {
    CameraManager manager;
    std::shared_ptr<Camera> camera;
    std::unique_ptr<CameraConfiguration> config;
    std::unique_ptr<FrameBufferAllocator> allocator;
    std::vector<Slot> slots;
    zc_config requested{};
    zc_info info{};
    void *context = nullptr;
    Completion callback = nullptr;
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
    int init(const zc_config &cfg, void *ctx, Completion complete) {
        requested = cfg; context = ctx; callback = complete;
        if (manager.start() < 0) return ZC_DEVICE;
        manager_started = true;
        const auto cameras = manager.cameras();
        if (cfg.camera_index >= cameras.size()) return ZC_DEVICE;
        camera = cameras[cfg.camera_index];
        if (camera->acquire() < 0) return ZC_BUSY;
        acquired = true;
        const std::vector<StreamRole> roles = cfg.raw ? std::vector<StreamRole>{StreamRole::StillCapture, StreamRole::Raw}
                                                    : std::vector<StreamRole>{StreamRole::StillCapture};
        config = camera->generateConfiguration(roles);
        if (!config || config->size() != roles.size()) return ZC_UNSUPPORTED;
        auto &main = config->at(0);
        // libcamera's BGR888 fourcc stores R,G,B bytes on little endian hosts.
        main.pixelFormat = formats::BGR888;
        main.colorSpace = ColorSpace::Sycc;
        if (cfg.width) main.size = {cfg.width, cfg.height};
        main.bufferCount = cfg.buffer_count;
        if (cfg.raw) {
            auto &raw = config->at(1);
            raw.bufferCount = cfg.buffer_count;
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
                callback(context, index, nullptr, ZC_DEVICE); return;
            }
            for (size_t p = 0; p < stream.plane_count; ++p) {
                if (metadata.planes()[p].bytesused > stream.planes[p].length) {
                    callback(context, index, nullptr, ZC_DEVICE); return;
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
        callback(context, index, &frame, ZC_OK);
    }
    int start() {
        ControlList control(camera->controls());
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
        return camera->queueRequest(slot.request.get()) < 0 ? ZC_DEVICE : ZC_OK;
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
extern "C" int zcd_open(const zc_config *cfg, void *ctx, Completion cb, Device **out, zc_info *info) {
    *out = nullptr;
    try {
        auto device = std::make_unique<Device>();
        const int rc = device->init(*cfg, ctx, cb);
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
