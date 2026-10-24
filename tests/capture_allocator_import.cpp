// Linked to the real Zig allocator exports and system libcamera. The independent
// Home C peer owns main/syscalls and supplies memfd RAM instead of DMA hardware.
#include "zig_camera_allocator_bridge.h"
#include <libcamera/framebuffer.h>
#include <libcamera/base/unique_fd.h>
#include <libcamera/base/shared_fd.h>
#include <fcntl.h>
#include <unistd.h>
#include <memory>
#include <vector>
#include <cstring>
#include <stdexcept>
static void require(bool yes) { if(!yes)throw std::runtime_error("allocator import contract"); }
static void check(int status) { require(status==ZC_OK); }
static zc_capture_allocator_state state(zc_capture_allocator *owner) {
    zc_capture_allocator_state value{};check(zc_capture_allocator_state_get(owner,&value));return value;
}
static uint64_t acquire(zc_capture_allocator *owner) {
    zci_allocation_stream stream{};stream.width=8;stream.height=4;stream.stride=32;stream.buffer_count=2;stream.frame_bytes=128;
    std::memcpy(stream.format,"BGR888",6);
    uint64_t loan=0;check(zci_capture_allocator_acquire(owner,reinterpret_cast<const uint8_t*>("camera"),6,&stream,1,&loan));return loan;
}
static void run(unsigned scenario) {
    static_assert(sizeof(zc_capture_allocator_config)==24);
    static_assert(sizeof(zc_capture_allocator_state)==112);
    static_assert(sizeof(zci_allocation_stream)==64);
    static_assert(sizeof(zci_allocation_buffer)==32);
    zc_capture_allocator_config config{};zc_default_capture_allocator_config(&config);
    const uint64_t page=static_cast<uint64_t>(sysconf(_SC_PAGESIZE));require(page>0);
    config.max_bytes=page*8;config.max_entries=2;require(config.backend==ZC_LIBCAMERA);
    zc_capture_allocator *owner=nullptr;
    const char *path=scenario==0||scenario>=10?nullptr:"/dev/dma_heap/zig-camera-test";
    const int opened=zc_capture_allocator_open(&config,reinterpret_cast<const uint8_t*>(path),path?std::strlen(path):0,&owner);
    if(scenario==12){require(opened==ZC_IO&&owner==nullptr);return;}
    check(opened);require(owner!=nullptr);
    if(scenario==1||scenario==2||scenario==3||scenario==8) {
        zci_allocation_stream stream{};stream.width=8;stream.height=4;stream.stride=32;stream.buffer_count=2;stream.frame_bytes=128;std::memcpy(stream.format,"BGR888",6);
        uint64_t failed=99;
        require(zci_capture_allocator_acquire(owner,reinterpret_cast<const uint8_t*>("camera"),6,&stream,1,&failed)==ZC_IO&&failed==0);
        require(state(owner).borrowed==0);
        if(scenario==8)require(state(owner).retiring==1&&state(owner).used_bytes==page*2);
        else require(state(owner).entries==0);
        check(zc_capture_allocator_close(owner));return;
    }
    const uint64_t first=acquire(owner);
    zci_allocation_buffer read{};check(zci_capture_allocator_buffer(owner,first,0,0,0,&read));
    require(read.fd>=0&&read.length==page&&read.frame_bytes==128&&state(owner).used_bytes==page*2);
    uint64_t pin=0;check(zc_capture_allocator_pin(owner,&pin));
    require(state(owner).pins==1&&zc_capture_allocator_close(owner)==ZC_BUSY);
    check(zc_capture_allocator_unpin(owner,pin));
    require(zc_capture_allocator_unpin(owner,pin)==ZC_STALE);
    {
        // Same adoption path as Device: close-on-exec duplicate, owned UniqueFD,
        // then SDK SharedFD/FrameBuffer. Destroying imports leaves pool FD live.
        libcamera::UniqueFD copy(fcntl(read.fd,F_DUPFD_CLOEXEC,0));require(copy.isValid());
        libcamera::FrameBuffer::Plane plane;plane.fd=libcamera::SharedFD(std::move(copy));plane.offset=0;plane.length=read.frame_bytes;
        std::vector<libcamera::FrameBuffer::Plane> planes;planes.push_back(std::move(plane));
        auto buffer=std::make_unique<libcamera::FrameBuffer>(planes);
        require(buffer->planes()[0].fd.get()!=read.fd);
        require((fcntl(buffer->planes()[0].fd.get(),F_GETFD)&FD_CLOEXEC)!=0);
        require(buffer->planes()[0].length==128);
    }
    require(fcntl(read.fd,F_GETFD)>=0);
    if(scenario==6) {
        zci_allocation_buffer failed{};require(zci_capture_allocator_buffer(owner,first,0,0,1,&failed)==ZC_IO);
        require(failed.data==nullptr&&failed.fd==-1);
    } else {
        zci_allocation_buffer write{};check(zci_capture_allocator_buffer(owner,first,0,0,1,&write));
        require(write.data!=read.data);const_cast<uint8_t*>(write.data)[0]=0x6a;require(read.data[0]==0x6a);
    }
    if(scenario==9)zci_capture_allocator_discard(owner,first);
    else zci_capture_allocator_release(owner,first);
    const uint64_t again=acquire(owner);
    zci_allocation_buffer same{};check(zci_capture_allocator_buffer(owner,again,0,0,0,&same));
    if(scenario==9)require(same.data!=read.data&&state(owner).allocations==4&&state(owner).retiring==1);
    else require(same.data==read.data&&state(owner).allocations==2);
    if(scenario==0) {
        const uint64_t parallel=acquire(owner);zci_allocation_buffer other{};
        check(zci_capture_allocator_buffer(owner,parallel,0,0,0,&other));
        require(other.fd!=same.fd&&other.data!=same.data&&state(owner).borrowed==2);
        require(zc_capture_allocator_close(owner)==ZC_BUSY);
        zci_capture_allocator_release(owner,parallel);
    }
    zci_capture_allocator_release(owner,again);
    if(scenario==4||scenario==5||scenario==7) {
        require(zc_capture_allocator_close(owner)==ZC_IO);
        require(state(owner).closing==1);
        uint64_t blocked=99;require(zc_capture_allocator_pin(owner,&blocked)==ZC_STATE&&blocked==0);
        if(scenario!=7)require(state(owner).entries!=0);
    }
    check(zc_capture_allocator_close(owner));
}
extern "C" int capture_backing_fixture_run(uint32_t scenario) {
    try { run(scenario);return 0; }catch(...){return 1;}
}
