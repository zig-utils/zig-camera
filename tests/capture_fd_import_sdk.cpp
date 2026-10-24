// Real Linux FD/maps and system SDK, independent DMA_SYNC protocol peer.
#ifdef NDEBUG
#undef NDEBUG
#endif
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "zig_camera_allocator_bridge.h"
#include "../native/capture_buffers.hpp"
#include <libcamera/framebuffer.h>
#include <libcamera/base/shared_fd.h>
#include <libcamera/base/unique_fd.h>
#include <linux/dma-buf.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdarg>
#include <cerrno>
#include <cassert>
#include <cstring>
#include <cstdio>
#include <vector>
static std::vector<ino_t> known;
static unsigned starts,ends;
static int fault;
extern "C" int ioctl(int fd,unsigned long command,...) noexcept {
    va_list args;va_start(args,command);void *argument=va_arg(args,void *);va_end(args);
    if(command!=DMA_BUF_IOCTL_SYNC)return static_cast<int>(syscall(SYS_ioctl,fd,command,argument));
    struct stat st{};if(fstat(fd,&st)<0)return -1;
    bool found=false;for(auto inode:known)if(inode==st.st_ino)found=true;
    if(!found){errno=ENOTTY;return -1;}
    const auto flags=static_cast<dma_buf_sync*>(argument)->flags;
    assert(flags==DMA_BUF_SYNC_READ || flags==(DMA_BUF_SYNC_READ|DMA_BUF_SYNC_END));
    if(flags&DMA_BUF_SYNC_END){ends++;if(fault==2){errno=EIO;return -1;}}
    else {starts++;if(fault==1){errno=EIO;return -1;}}
    return 0;
}
static int file(bool supported=true) {
    const int fd=memfd_create("dma-import-peer",MFD_CLOEXEC|MFD_ALLOW_SEALING);assert(fd>=0);
    assert(!ftruncate(fd,8192));struct stat st{};assert(!fstat(fd,&st));if(supported)known.push_back(st.st_ino);
    const uint8_t byte=0x5a;assert(pwrite(fd,&byte,1,4093)==1);return fd;
}
static zc_capture_allocator_state state(zc_capture_allocator *p){zc_capture_allocator_state s{};assert(!zc_capture_allocator_state_get(p,&s));return s;}
static void planar_objects() {
    static_assert(sizeof(zci_allocation_frame)==168,"private plane ABI");
    static_assert(sizeof(zc_capture_import_frame)==104,"public frame ABI");
    for(int scenario=0;scenario<4;scenario++) {
        known.clear();starts=ends=0;fault=scenario<3?scenario:0;
        zc_capture_import_stream stream{};stream.width=8;stream.height=4;stream.stride=8;stream.buffer_count=2;stream.frame_bytes=48;std::memcpy(stream.format,"YUV420",6);
        std::vector<int> originals{file(scenario!=3),file(),file(),file(),file()};
        const int alias=fcntl(originals[1],F_DUPFD_CLOEXEC,0);assert(alias>=0);originals.push_back(alias);
        zc_capture_import_frame frames[2]{};
        for(auto &frame:frames){frame.struct_size=sizeof(frame);frame.plane_count=3;}
        frames[0].planes[0]={originals[0],0,4093,32};frames[0].planes[1]={originals[1],0,128,8};frames[0].planes[2]={alias,0,160,8};
        frames[1].planes[0]={originals[2],0,4093,32};frames[1].planes[1]={originals[3],0,128,8};frames[1].planes[2]={originals[4],0,160,8};
        zc_capture_allocator_config config{};zc_default_capture_allocator_config(&config);config.max_bytes=8192*5;config.max_entries=2;
        zc_capture_allocator *pool=nullptr;assert(!zc_capture_allocator_open_imported(&config,&pool));
        const int result=zc_capture_allocator_import_frames(pool,reinterpret_cast<const uint8_t*>("planar"),6,&stream,1,frames,2);
        if(scenario) {
            assert(result==ZC_IO && !state(pool).entries && !state(pool).used_bytes);
            if(scenario==1)assert(starts==1 && !ends);
            if(scenario==2)assert(starts==1 && ends==1);
            if(scenario==3)assert(!starts && !ends);
        } else {
            assert(result==ZC_OK && starts==5 && ends==5 && state(pool).allocations==5 && state(pool).used_bytes==8192*5);
            for(int fd:originals)assert(!close(fd));originals.clear();
            uint64_t loan=0;assert(!zci_capture_allocator_acquire(pool,reinterpret_cast<const uint8_t*>("planar"),6,&stream,1,&loan));
            for(unsigned i=0;i<2;i++) {
                zci_allocation_frame read{},write{};assert(!zci_capture_allocator_frame(pool,loan,0,i,0,&read));
                assert(read.plane_count==3 && read.planes[0].data[0]==0x5a);
                assert((read.planes[1].fd==read.planes[2].fd)==(i==0));
                assert(!zci_capture_allocator_frame(pool,loan,0,i,1,&write));
                assert(write.plane_count==3 && write.planes[0].data!=read.planes[0].data);
                const_cast<uint8_t*>(write.planes[1].data)[0]=0x37;const_cast<uint8_t*>(write.planes[2].data)[0]=0x73;
                assert(read.planes[1].data[0]==0x37 && read.planes[2].data[0]==0x73);
                std::unique_ptr<libcamera::FrameBuffer> sdk;
                assert(!zc_sdk::importFrame(read,sdk));
                zc_stream bound{};std::array<int,ZC_MAX_PLANES*3> fds{};size_t count=0;
                assert(!zc_sdk::bindFrame(*sdk,read,bound,fds,count));
                assert(count==(i==0?2:3) && bound.plane_count==3 && bound.planes[1].offset==128 && bound.planes[2].offset==160);
                assert((bound.planes[1].fd==bound.planes[2].fd)==(i==0));
                assert(bound.planes[0].fd!=read.planes[0].fd && (fcntl(bound.planes[0].fd,F_GETFD)&FD_CLOEXEC));
                auto wrong=read;wrong.planes[2].offset++;
                const auto before=bound;const auto prior=fds;const auto prior_count=count;
                assert(zc_sdk::bindFrame(*sdk,wrong,bound,fds,count)==ZC_STATE);
                assert(!std::memcmp(&before,&bound,sizeof(bound)) && prior==fds && count==prior_count);
                const int imported=bound.planes[0].fd;sdk.reset();assert(fcntl(imported,F_GETFD)==-1 && errno==EBADF);
                assert(fcntl(read.planes[0].fd,F_GETFD)>=0);
            }
            assert(state(pool).writable_maps==5);zci_capture_allocator_release(pool,loan);
        }
        for(int fd:originals)assert(!close(fd));
        assert(!zc_capture_allocator_close(pool));
    }
    std::puts("multi-object imports: per-object charge/probes/maps, aliased SDK descriptors, exact plane windows, atomic binding and retained lifetimes passed");
}
int main() {
    for(int scenario=0;scenario<4;scenario++) {
        known.clear();starts=ends=0;fault=scenario<3?scenario:0;
        zc_capture_import_buffer inputs[]={{file(scenario!=3),0,4093},{file(),0,4093}};
        zc_capture_import_stream stream{};stream.width=8;stream.height=4;stream.stride=32;stream.buffer_count=2;stream.frame_bytes=128;std::memcpy(stream.format,"BGR888",6);
        zc_capture_allocator_config config{};zc_default_capture_allocator_config(&config);assert(config.backend==ZC_LIBCAMERA);config.max_bytes=16384;config.max_entries=2;
        zc_capture_allocator *p=nullptr;assert(!zc_capture_allocator_open_imported(&config,&p));
        const int result=zc_capture_allocator_import(p,reinterpret_cast<const uint8_t*>("camera"),6,&stream,1,inputs,2);
        if(scenario) {
            assert(result==ZC_IO && !state(p).entries && !state(p).used_bytes);
            if(scenario==1)assert(starts==1 && ends==0);
            if(scenario==2)assert(starts==1 && ends==1);
            if(scenario==3)assert(starts==0 && ends==0);
        } else {
            assert(result==ZC_OK && starts==2 && ends==2 && state(p).used_bytes==16384);
            assert(!close(inputs[0].fd) && !close(inputs[1].fd));inputs[0].fd=inputs[1].fd=-1;
            uint64_t loan=0;assert(!zci_capture_allocator_acquire(p,reinterpret_cast<const uint8_t*>("camera"),6,&stream,1,&loan));
            zci_allocation_buffer read{};assert(!zci_capture_allocator_buffer(p,loan,0,0,0,&read));
            assert(read.offset==4093 && read.length==128 && read.data[0]==0x5a && (fcntl(read.fd,F_GETFD)&FD_CLOEXEC));
            {
                libcamera::UniqueFD copy(fcntl(read.fd,F_DUPFD_CLOEXEC,0));assert(copy.isValid());
                libcamera::FrameBuffer::Plane plane;plane.fd=libcamera::SharedFD(std::move(copy));plane.offset=read.offset;plane.length=read.frame_bytes;
                const std::vector<libcamera::FrameBuffer::Plane> planes{plane};libcamera::FrameBuffer buffer(planes);
                assert(buffer.planes()[0].offset==4093 && buffer.planes()[0].length==128 && buffer.planes()[0].fd.get()!=read.fd);
            }
            assert(fcntl(read.fd,F_GETFD)>=0);zci_capture_allocator_release(p,loan);
        }
        for(auto input:inputs)if(input.fd>=0)assert(!close(input.fd));
        assert(!zc_capture_allocator_close(p));
    }
    planar_objects();
    std::puts("DMA-BUF imports: SDK offset/duplicate lifetime and START/END/unsupported failures passed");
}
