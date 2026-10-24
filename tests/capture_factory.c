#define _GNU_SOURCE
#ifdef NDEBUG
#undef NDEBUG
#endif
#include "zig_camera.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#ifdef __linux__
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
static _Atomic uint64_t notice;
static void notify(void *context,uint64_t ticket){assert(context==(void *)&notice);assert(ticket);atomic_store(&notice,ticket);}
struct worker { zc_capture_open_scope scope; int result; };
static void *open_camera(void *raw){
    struct worker *w=raw;assert(!zc_capture_open_scope_attach(w->scope));
    zc_config config;zc_default_config(&config);config.width=32;config.height=24;config.buffer_count=2;
    zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);zc_processed_options processed;zc_default_processed_options(&processed);
    zc_camera *camera=0;w->result=zc_open_allocated_scoped_pipeline(w->scope,&config,&pipeline,&processed,ZC_ROTATE0,0,0,0,0,&camera);
    assert((w->result==ZC_OK)==(camera!=0));
    /* Deliberately rely on the OS-thread TLS destructor, not explicit detach. */
    return 0;
}
static void pause_briefly(void){struct timespec delay={0,1000000};nanosleep(&delay,0);}
static uint64_t ticket(void){for(unsigned i=0;i<5000;i++){uint64_t t=atomic_load(&notice);if(t)return t;pause_briefly();}assert(!"factory notification deadline");return 0;}
static int file(uint64_t bytes){int fd=memfd_create("capture-factory-c",MFD_CLOEXEC|MFD_ALLOW_SEALING);assert(fd>=0 && !ftruncate(fd,(off_t)bytes));assert(!fcntl(fd,F_ADD_SEALS,F_SEAL_GROW|F_SEAL_SHRINK));return fd;}
static zc_capture_open_scope_state state(zc_capture_open_scope scope){zc_capture_open_scope_state out;assert(!zc_capture_open_scope_state_get(scope,&out));return out;}
#endif
int main(void){
    _Static_assert(sizeof(zc_capture_open_scope_state)==40,"scope ABI");
    _Static_assert(sizeof(zc_capture_factory_request_state)==24,"request ABI");
    zc_capture_allocator_config config;zc_default_capture_allocator_config(&config);config.max_entries=2;
    zc_capture_allocator *pool=0;assert(!zc_capture_allocator_open(&config,0,0,&pool));
    zc_capture_open_scope scope;assert(!zc_capture_open_scope_open(pool,0,0,UINT32_MAX,&scope));
    assert(zc_capture_allocator_close(pool)==ZC_BUSY);
    zc_camera *camera=(void *)(uintptr_t)1;uint32_t started=8;
    assert(!zc_capture_open_scope_take(scope,&camera,&started) && !camera && !started);
    assert(!zc_capture_open_scope_close(scope));assert(zc_capture_open_scope_cancel(scope,1)==ZC_STALE);
    assert(!zc_capture_allocator_close(pool));
#ifdef __linux__
    for(unsigned scenario=0;scenario<5;scenario++){
        atomic_store(&notice,0);pool=0;assert(!zc_capture_allocator_open_imported(&config,&pool));
        assert(!zc_capture_allocator_factory_set(pool,notify,&notice));
        assert(!zc_capture_open_scope_open(pool,0,0,UINT32_MAX,&scope));
        assert(zc_capture_allocator_factory_set(pool,0,0)==ZC_BUSY);
        struct worker work={scope,ZC_STATE};pthread_t thread;assert(!pthread_create(&thread,0,open_camera,&work));
        const uint64_t id=ticket();assert(state(scope).pending_factories==1);
        zc_capture_import_layout layout;zc_capture_factory_request_state request;
        if(scenario==1){
            assert(!zc_capture_open_scope_cancel(scope,0));assert(!pthread_join(thread,0));assert(work.result==ZC_CANCELLED);
            assert(state(scope).threads==0 && state(scope).pending_factories==1);
            assert(zc_capture_open_scope_take(scope,&camera,&started)==ZC_BUSY);
        }
        assert(!zc_capture_allocator_factory_begin(pool,id,&layout,&request));
        assert(request.scope==scope && request.accepting==(scenario!=1));
        assert(layout.stream_count==1 && layout.streams[0].width==32 && layout.streams[0].height==24);
        assert(zc_capture_allocator_factory_begin(pool,id,&layout,&request)==ZC_BUSY);
        if(scenario!=1 && scenario!=3){
            /* begin zeroes its out arguments on the duplicate failure above. */
            zc_capture_import_buffer inputs[2]={{file(8192),0,4093},{file(8192),0,4095}};
            assert(!zc_capture_allocator_factory_supply(pool,id,inputs,2));
            assert(zc_capture_allocator_factory_supply(pool,id,inputs,2)==ZC_STATE);
            assert(!close(inputs[0].fd) && !close(inputs[1].fd));
            assert(!state(scope).camera); /* supplied != published */
        }
        if(scenario==2){assert(!zc_capture_open_scope_cancel(scope,0));assert(!pthread_join(thread,0));assert(work.result==ZC_CANCELLED);}
        const int finish=scenario==3?ZC_TIMEOUT:scenario==4?ZC_IO:ZC_OK;
        assert(!zc_capture_allocator_factory_finish(pool,id,finish));
        if(scenario!=1 && scenario!=2)assert(!pthread_join(thread,0));
        assert(work.result==(scenario==0?ZC_OK:scenario==3?ZC_TIMEOUT:scenario==4?ZC_IO:ZC_CANCELLED));
        assert(state(scope).threads==0 && !state(scope).pending_factories);
        assert(zc_capture_allocator_factory_finish(pool,id,finish)==ZC_STALE);
        if(scenario==0){
            assert(!zc_capture_open_scope_take(scope,&camera,&started) && camera && !started);
            assert(!zc_start(camera));zc_frame frame;assert(!zc_acquire(camera,1000,&frame));assert(frame.main.planes[0].fd>=0 && frame.main.planes[0].offset>=4093);
            assert(!zc_release(camera,frame.token));assert(!zc_close(camera));
        }
        assert(!zc_capture_open_scope_close(scope));assert(!zc_capture_allocator_trim(pool));assert(!zc_capture_allocator_close(pool));
    }
    puts("capture factories: cross-thread notifications, unpublished reservations, late cancellation, timeout status and joined ownership passed");
#endif
}
