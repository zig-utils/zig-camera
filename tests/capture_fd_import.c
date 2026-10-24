#define _GNU_SOURCE
#ifdef NDEBUG
#undef NDEBUG
#endif
#include "zig_camera_allocator_bridge.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#ifdef __linux__
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
void zc_unmap_peer_arm(int);
void zc_unmap_peer_map_fault(int);
void zc_unmap_peer_close_fault(int);
static int file(uint64_t size,int sealed){const int fd=memfd_create("capture-fd-import",MFD_CLOEXEC|MFD_ALLOW_SEALING);assert(fd>=0 && !ftruncate(fd,(off_t)size));if(sealed)assert(!fcntl(fd,F_ADD_SEALS,F_SEAL_SHRINK|F_SEAL_GROW));return fd;}
static zc_capture_allocator_state state(zc_capture_allocator *p){zc_capture_allocator_state s;assert(!zc_capture_allocator_state_get(p,&s));return s;}
static zc_capture_allocator *allocator(uint64_t bytes){zc_capture_allocator_config c;zc_default_capture_allocator_config(&c);c.max_entries=2;c.max_bytes=bytes;zc_capture_allocator *p=0;assert(!zc_capture_allocator_open_imported(&c,&p));return p;}
static int provision(zc_capture_allocator *p,const zc_capture_import_layout *l,const zc_capture_import_buffer *b){uint32_t n=0;for(uint32_t i=0;i<l->stream_count;i++)n+=l->streams[i].buffer_count;return zc_capture_allocator_import(p,l->camera_id,l->id_length,l->streams,l->stream_count,b,n);}
static uint64_t borrow(zc_capture_allocator *p,const zc_capture_import_layout *l){uint64_t loan=0;assert(!zci_capture_allocator_acquire(p,l->camera_id,l->id_length,l->streams,l->stream_count,&loan));return loan;}
#endif
int main(void){
    _Static_assert(sizeof(zc_capture_import_layout)==4304,"layout ABI");
    _Static_assert(sizeof(zc_capture_import_buffer)==16,"input ABI");
    _Static_assert(sizeof(zci_allocation_buffer)==40,"private offset ABI");
    zc_config config;zc_default_config(&config);config.width=16;config.height=8;config.buffer_count=2;
    zc_camera *c=0;assert(!zc_open(&config,&c));zc_capture_import_layout layout;assert(!zc_camera_capture_layout_get(c,&layout));assert(layout.struct_size==sizeof(layout) && layout.stream_count==1 && layout.id_length==9 && !memcmp(layout.camera_id,"synthetic",9));assert(layout.streams[0].frame_bytes==512 && layout.streams[0].buffer_count==2);assert(!zc_close(c));
#ifndef __linux__
    zc_capture_allocator_config unsupported;zc_default_capture_allocator_config(&unsupported);zc_capture_allocator *p=(void *)(uintptr_t)1;
    assert(zc_capture_allocator_open_imported(&unsupported,&p)==ZC_UNSUPPORTED && !p);
#else
    const uint64_t size=8192;zc_capture_import_buffer buffers[2]={{file(size,1),0,4093},{file(size,1),0,4095}};
    zc_capture_allocator *p=allocator(size*2);
    zc_capture_import_buffer alias[2]={buffers[0],buffers[0]};assert(provision(p,&layout,alias)==ZC_INVALID && !state(p).entries);
    zc_capture_import_buffer invalid[2]={buffers[0],{file(size,0),0,0}};assert(provision(p,&layout,invalid)==ZC_INVALID && !state(p).entries);assert(!close(invalid[1].fd));
    zc_capture_import_layout wrong=layout;wrong.streams[0].buffer_count=1;assert(provision(p,&wrong,buffers)==ZC_INVALID);
    buffers[0].offset=UINT32_MAX;assert(provision(p,&layout,buffers)==ZC_INVALID);buffers[0].offset=4093;
    zc_capture_allocator *small=allocator(size*2-1);assert(provision(small,&layout,buffers)==ZC_INVALID);assert(!state(small).entries);assert(!zc_capture_allocator_close(small));
    /* Partial preparation + failed cleanup stays charged and owns its duplicate. */
    zc_unmap_peer_arm(-1);zc_unmap_peer_map_fault(2);assert(provision(p,&layout,buffers)==ZC_IO);
    assert(state(p).retiring==1 && state(p).used_bytes==size*2 && !state(p).borrowed);
    assert(provision(p,&layout,buffers)==ZC_INVALID);zc_unmap_peer_arm(0);assert(!zc_capture_allocator_trim(p));assert(!state(p).entries);
    assert(!provision(p,&layout,buffers));assert(state(p).used_bytes==size*2);assert(provision(p,&layout,buffers)==ZC_INVALID);
    assert(!close(buffers[0].fd) && !close(buffers[1].fd));
    const uint64_t loan=borrow(p,&layout);zci_allocation_buffer ro,rw;assert(!zci_capture_allocator_buffer(p,loan,0,0,0,&ro));assert(ro.offset==4093 && ro.length==512 && ro.frame_bytes==512 && ro.fd>=0 && (fcntl(ro.fd,F_GETFD)&FD_CLOEXEC));
    assert(!zci_capture_allocator_buffer(p,loan,0,0,1,&rw));assert(rw.data!=ro.data && rw.offset==ro.offset);((uint8_t *)(uintptr_t)rw.data)[0]=211;assert(ro.data[0]==211);
    zci_capture_allocator_release(p,loan);
    /* Imported source fd propagates through capture, export and mapped offset. */
    zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);zc_processed_options processed;zc_default_processed_options(&processed);
    zc_unmap_peer_map_fault(1);c=(void *)(uintptr_t)1;assert(zc_open_allocated_pipeline(&config,&pipeline,&processed,0,0,0,0,p,&c)==ZC_IO && !c);assert(!state(p).borrowed);
    assert(!zc_open_allocated_pipeline(&config,&pipeline,&processed,0,0,0,0,p,&c));assert(!zc_start(c));zc_frame frame;assert(!zc_acquire(c,1000,&frame));assert(frame.main.planes[0].fd>=0 && frame.main.planes[0].offset>=4093);
    zc_frame_export *exported=0;assert(!zc_frame_export_open(c,frame.token,1,0,&exported));zc_export_info info;assert(!zc_frame_export_info(exported,&info));assert(!(info.flags&ZC_EXPORT_STAGED));assert(!zc_release(c,frame.token));assert(!zc_frame_export_close(exported));assert(!zc_close(c));
    /* FD close error consumes its number once; retry cannot close its reuse. */
    const uint64_t again=borrow(p,&layout);assert(!zci_capture_allocator_buffer(p,again,0,0,0,&ro));zci_capture_allocator_release(p,again);const int old=ro.fd;
    zc_unmap_peer_close_fault(old);assert(zc_capture_allocator_close(p)==ZC_IO);assert(state(p).closing && state(p).used_bytes==size*2);
    int reused=open("/dev/null",O_RDONLY|O_CLOEXEC);assert(reused>=0);if(reused!=old){assert(dup2(reused,old)==old);assert(!close(reused));reused=old;}
    assert(!zc_capture_allocator_close(p));assert(fcntl(reused,F_GETFD)>=0);assert(!close(reused));
    /* Discard never invents replacement caller storage. */
    p=allocator(size*2);buffers[0].fd=file(size,1);buffers[1].fd=file(size,1);assert(!provision(p,&layout,buffers));assert(!close(buffers[0].fd) && !close(buffers[1].fd));
    zci_capture_allocator_discard(p,borrow(p,&layout));uint64_t absent=91;assert(zci_capture_allocator_acquire(p,layout.camera_id,layout.id_length,layout.streams,1,&absent)==ZC_BUSY && !absent);assert(!zc_capture_allocator_trim(p));assert(zci_capture_allocator_acquire(p,layout.camera_id,layout.id_length,layout.streams,1,&absent)==ZC_UNSUPPORTED && !absent);assert(!zc_capture_allocator_close(p));
    puts("capture FD imports: exact layout, aliases, extent budgets, partial cleanup, offset exports and recycled descriptor checks passed");
#endif
}
