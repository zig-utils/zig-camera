#ifndef ZIG_CAMERA_SDK_CAPTURE_BUFFERS_HPP
#define ZIG_CAMERA_SDK_CAPTURE_BUFFERS_HPP
// Thin SDK adoption only. Zig/Home own identity, ranges, admission and lifetime.
#include "zig_camera_allocator_bridge.h"
#include <libcamera/framebuffer.h>
#include <libcamera/base/shared_fd.h>
#include <libcamera/base/unique_fd.h>
#include <array>
#include <memory>
#include <vector>
#include <limits>
#include <algorithm>
#include <fcntl.h>
namespace zc_sdk {
inline int importFrame(const zci_allocation_frame &input,std::unique_ptr<libcamera::FrameBuffer> &out) {
    if(!input.plane_count || input.plane_count>ZC_MAX_PLANES)return ZC_UNSUPPORTED;
    std::array<int,ZC_MAX_PLANES> sources{};
    std::array<libcamera::SharedFD,ZC_MAX_PLANES> descriptors;
    size_t used=0;
    std::vector<libcamera::FrameBuffer::Plane> planes;
    for(size_t p=0;p<input.plane_count;p++) {
        const auto &source=input.planes[p];
        if(source.fd<0 || !source.frame_bytes || source.frame_bytes>std::numeric_limits<unsigned int>::max() || source.offset>std::numeric_limits<unsigned int>::max()-source.frame_bytes)return ZC_UNSUPPORTED;
        size_t object=0;
        while(object<used && sources[object]!=source.fd)object++;
        if(object==used) {
            libcamera::UniqueFD descriptor(fcntl(source.fd,F_DUPFD_CLOEXEC,0));
            if(!descriptor.isValid())return ZC_IO;
            sources[used]=source.fd;descriptors[used]=libcamera::SharedFD(std::move(descriptor));used++;
        }
        libcamera::FrameBuffer::Plane plane;
        plane.fd=descriptors[object];plane.offset=source.offset;plane.length=source.frame_bytes;
        planes.push_back(std::move(plane));
    }
    out=std::make_unique<libcamera::FrameBuffer>(planes);
    return ZC_OK;
}
inline int bindFrame(const libcamera::FrameBuffer &buffer,const zci_allocation_frame &input,zc_stream &target,std::array<int,ZC_MAX_PLANES*3> &fds,size_t &count) {
    if(!input.plane_count || input.plane_count>ZC_MAX_PLANES || input.plane_count!=buffer.planes().size() || count>fds.size())return ZC_STATE;
    auto prepared=target;auto unique=fds;auto used=count;
    prepared.plane_count=input.plane_count;
    for(size_t p=0;p<input.plane_count;p++) {
        const auto &source=input.planes[p];const auto &sdk=buffer.planes()[p];
        if(!source.data || source.length<source.frame_bytes || sdk.fd.get()<0 || sdk.offset!=source.offset || sdk.length!=source.frame_bytes)return ZC_STATE;
        auto &plane=prepared.planes[p];plane={};
        plane.data=source.data;plane.length=source.frame_bytes;plane.fd=sdk.fd.get();plane.offset=source.offset;
        if(std::find(unique.begin(),unique.begin()+used,plane.fd)==unique.begin()+used) {
            if(used==unique.size())return ZC_STATE;
            unique[used++]=plane.fd;
        }
    }
    target=prepared;fds=unique;count=used;
    return ZC_OK;
}
}
#endif
