#define _GNU_SOURCE
#include "zig_camera.h"
#include <assert.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
void zc_unmap_peer_arm(int);
void zc_unmap_peer_map_fault(int);
void zc_unmap_peer_skip(int);
void zc_unmap_peer_close_fault(int);
void zc_unmap_peer_block(void);
void zc_unmap_peer_entered(void);
void zc_unmap_peer_resume(void);
uint64_t zc_unmap_peer_attempts(void);
void *zc_unmap_peer_address(size_t *);
static zc_shared_cleanup_state state(void){zc_shared_cleanup_state s;assert(zc_shared_cleanup_state_get(&s)==ZC_OK && s.struct_size==sizeof(s));return s;}
static zc_camera *camera(void){zc_config c;zc_default_config(&c);c.width=16;c.height=8;c.buffer_count=2;zc_camera *p=0;assert(zc_open(&c,&p)==ZC_OK);assert(zc_enable_writable(p)==ZC_OK);assert(zc_start(p)==ZC_OK);return p;}
static zc_camera *multi_camera(void){zc_config c;zc_default_config(&c);c.width=16;c.height=8;c.buffer_count=2;c.raw=1;strcpy(c.raw_format,"SRGGB12");zc_pipeline_options options;zc_default_pipeline_options(&options);options.lores_width=8;options.lores_height=4;zc_camera *p=0;assert(zc_open_pipeline(&c,&options,&p)==ZC_OK);assert(zc_start(p)==ZC_OK);return p;}
static zc_frame_export *loan(zc_camera *c){zc_frame f;zc_frame_export *p=0;assert(zc_acquire(c,1000,&f)==ZC_OK);assert(zc_frame_export_open(c,f.token,1,ZC_EXPORT_WRITABLE,&p)==ZC_OK);assert(zc_release(c,f.token)==ZC_OK);return p;}
static int replacement_fd(int old){const int fd=open("/dev/null",O_RDONLY|O_CLOEXEC);assert(fd>=0);if(fd!=old){assert(dup2(fd,old)==old);assert(close(fd)==0);}return old;}
static void empty(void){zc_shared_cleanup_state s=state();assert(!s.exports && !s.remote_frames && !s.busy && !s.retained_bytes);assert(zc_shared_cleanup_drain()==ZC_OK);}
static void *drain(void *unused){(void)unused;return (void *)(intptr_t)zc_shared_cleanup_drain();}
int main(void){
    _Static_assert(sizeof(zc_shared_cleanup_state)==24,"cleanup ABI");
    empty();
    /* Consumed writable export, retained exact map/budget, no repeated camera
     * writeback or stale fd close. Camera can disappear before physical retry. */
    zc_camera *c=camera();zc_frame_export *p=loan(c);zc_export_info info;assert(zc_frame_export_info(p,&info)==ZC_OK);
    const int old=info.planes[0].fd;assert(old>=0);
    zc_unmap_peer_close_fault(old);zc_unmap_peer_arm(-1);
    assert(zc_frame_export_close(p)==ZC_IO);p=0;
    zc_shared_cleanup_state s=state();assert(s.exports==1 && !s.remote_frames && s.retained_bytes>=info.planes[0].length);
    const uint64_t cost=s.retained_bytes;assert(fcntl(old,F_GETFD)==-1);
    size_t length=0;volatile uint8_t *bytes=zc_unmap_peer_address(&length);assert(bytes && length>=info.planes[0].length);bytes[0]=173;assert(bytes[0]==173);
    assert(zc_close(c)==ZC_OK);c=0;
    const int reused=replacement_fd(old);
    assert(zc_shared_cleanup_drain()==ZC_IO);assert(zc_unmap_peer_attempts()==2);assert(state().retained_bytes==cost && bytes[0]==173);
    zc_unmap_peer_arm(0);assert(zc_shared_cleanup_drain()==ZC_OK);assert(zc_unmap_peer_attempts()==1);assert(fcntl(reused,F_GETFD)>=0);assert(close(reused)==0);empty();
    /* Both transport catalog mapping and pixels remain owned on failure. */
    c=camera();p=loan(c);int pair[2];assert(zc_frame_channel_pair(pair)==ZC_OK);assert(zc_frame_channel_send(pair[0],p,71)==ZC_OK);
    zc_remote_frame *remote=0;uint64_t cookie=0;
    zc_unmap_peer_arm(-1);assert(zc_frame_channel_receive(pair[1],&remote,&cookie)==ZC_IO);assert(!remote && !cookie);
    s=state();assert(s.remote_frames==1 && !s.exports && s.retained_bytes>0);assert(zc_shared_cleanup_drain()==ZC_IO);
    zc_unmap_peer_arm(0);assert(zc_shared_cleanup_drain()==ZC_OK);empty();
    assert(zc_frame_channel_send(pair[0],p,72)==ZC_OK);assert(zc_frame_channel_receive(pair[1],&remote,&cookie)==ZC_OK && cookie==72);
    zc_stream stream;assert(zc_remote_frame_stream(remote,0,&stream)==ZC_OK);const uint8_t sample=stream.planes[0].data[0];
    zc_unmap_peer_arm(-1);assert(zc_remote_frame_close(remote)==ZC_IO);remote=0;
    assert(state().remote_frames==1);assert(stream.planes[0].data[0]==sample);
    /* Sender staging + cached catalog failure is independent of remote owner. */
    assert(zc_frame_export_close(p)==ZC_IO);p=0;s=state();assert(s.exports==1 && s.remote_frames==1);assert(zc_shared_cleanup_drain()==ZC_IO);
    assert(zc_close(c)==ZC_OK);assert(zc_frame_channel_close(pair[0])==ZC_OK);assert(zc_frame_channel_close(pair[1])==ZC_OK);
    zc_unmap_peer_arm(0);assert(zc_shared_cleanup_drain()==ZC_OK);empty();
    /* Partially prepared export and receiver failures retain all earlier maps,
     * while the catalog's successful unmap is not retried. */
    c=multi_camera();zc_frame partial;assert(zc_acquire(c,1000,&partial)==ZC_OK);
    zc_unmap_peer_arm(-1);zc_unmap_peer_map_fault(2);p=(void *)(uintptr_t)1;
    assert(zc_frame_export_open(c,partial.token,7,0,&p)==ZC_IO && !p);assert(state().exports==1);
    assert(zc_release(c,partial.token)==ZC_OK);zc_unmap_peer_arm(0);assert(zc_shared_cleanup_drain()==ZC_OK);empty();
    assert(zc_acquire(c,1000,&partial)==ZC_OK);assert(zc_frame_export_open(c,partial.token,7,0,&p)==ZC_OK);assert(zc_release(c,partial.token)==ZC_OK);
    assert(zc_frame_channel_pair(pair)==ZC_OK);assert(zc_frame_channel_send(pair[0],p,73)==ZC_OK);
    zc_unmap_peer_arm(-1);zc_unmap_peer_skip(1);zc_unmap_peer_map_fault(3);
    assert(zc_frame_channel_receive(pair[1],&remote,&cookie)==ZC_IO && !remote && !cookie);assert(state().remote_frames==1);
    assert(zc_unmap_peer_attempts()==2);zc_unmap_peer_arm(0);assert(zc_shared_cleanup_drain()==ZC_OK);assert(zc_unmap_peer_attempts()==1);empty();
    assert(zc_frame_export_close(p)==ZC_OK);assert(zc_close(c)==ZC_OK);assert(zc_frame_channel_close(pair[0])==ZC_OK);assert(zc_frame_channel_close(pair[1])==ZC_OK);
    /* No cleanup overcommit: original 32 slots stay charged while deferred. */
    c=camera();zc_unmap_peer_arm(-1);
    for(int i=0;i<32;i++){p=loan(c);assert(zc_frame_export_close(p)==ZC_IO);assert(state().exports==(uint32_t)i+1);}
    zc_frame f;assert(zc_acquire(c,1000,&f)==ZC_OK);p=(void *)(uintptr_t)1;assert(zc_frame_export_open(c,f.token,1,0,&p)==ZC_BUSY && !p);assert(zc_release(c,f.token)==ZC_OK);
    assert(zc_shared_cleanup_drain()==ZC_IO);assert(state().exports==32);
    zc_unmap_peer_arm(0);assert(zc_shared_cleanup_drain()==ZC_OK);assert(zc_unmap_peer_attempts()==32);empty();
    /* A blocked drain claims its owner; another drain cannot unmap it twice. */
    p=loan(c);zc_unmap_peer_arm(1);assert(zc_frame_export_close(p)==ZC_IO);
    zc_unmap_peer_arm(0);zc_unmap_peer_block();pthread_t thread;assert(!pthread_create(&thread,0,drain,0));zc_unmap_peer_entered();
    s=state();assert(s.exports==1 && s.busy==1);assert(zc_shared_cleanup_drain()==ZC_BUSY);assert(zc_unmap_peer_attempts()==1);
    zc_unmap_peer_resume();void *result;assert(!pthread_join(thread,&result));assert((intptr_t)result==ZC_OK);empty();
    p=loan(c);assert(zc_frame_export_close(p)==ZC_OK);assert(zc_close(c)==ZC_OK);empty();
    puts("shared cleanup: mapping, catalog, fd reuse, bounded budget and concurrent drain scenarios passed");
}
