// Real Linux FD/maps and system SDK, independent DMA_SYNC protocol peer.
#ifdef NDEBUG
#undef NDEBUG
#endif
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "zig_camera_allocator_bridge.h"
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
    std::puts("DMA-BUF imports: SDK offset/duplicate lifetime and START/END/unsupported failures passed");
}
