#include "zig_camera.h"
#include <assert.h>
#include <stdio.h>
_Static_assert(sizeof(zc_capture_allocator_config)==24,"allocator config ABI");
_Static_assert(sizeof(zc_capture_allocator_state)==112,"allocator state ABI");
int main(void) {
    zc_capture_allocator_config options;zc_default_capture_allocator_config(&options);
    assert(options.backend==ZC_SYNTHETIC);options.max_bytes=65536;options.max_entries=2;
    zc_capture_allocator *allocator=NULL;assert(zc_capture_allocator_open(&options,NULL,0,&allocator)==ZC_OK);
    uint64_t pin=0;assert(zc_capture_allocator_pin(allocator,&pin)==ZC_OK);
    assert(zc_capture_allocator_close(allocator)==ZC_BUSY);
    assert(zc_capture_allocator_unpin(allocator,pin)==ZC_OK);
    assert(zc_capture_allocator_unpin(allocator,pin)==ZC_STALE);
    zc_config cfg;zc_default_config(&cfg);cfg.width=32;cfg.height=24;cfg.buffer_count=2;
    zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);
    zc_processed_options processed;zc_default_processed_options(&processed);
    zc_camera *camera=NULL;
    assert(zc_open_allocated_pipeline(&cfg,&pipeline,&processed,1,0,NULL,0,allocator,&camera)==ZC_OK);
    zc_capture_allocator *borrowed=NULL;assert(zc_camera_capture_allocator_get(camera,&borrowed)==ZC_OK&&borrowed==allocator);
    assert(zc_start(camera)==ZC_OK);zc_frame frame;assert(zc_acquire(camera,1000,&frame)==ZC_OK);
    zc_frame_map *map=NULL;assert(zc_frame_map_open(camera,frame.token,ZC_MAIN,0,&map)==ZC_OK);
    zc_frame_export *exported=NULL;assert(zc_frame_export_open(camera,frame.token,1u<<ZC_MAIN,0,&exported)==ZC_OK);
    assert(zc_release(camera,frame.token)==ZC_OK);
    assert(zc_close(camera)==ZC_BUSY);assert(zc_capture_allocator_close(allocator)==ZC_BUSY);
    assert(zc_capture_allocator_trim(allocator)==ZC_OK);
    zc_capture_allocator_state state;assert(zc_capture_allocator_state_get(allocator,&state)==ZC_OK&&state.borrowed==1&&state.allocations==2);
    assert(zc_frame_map_close(map)==ZC_OK);assert(zc_close(camera)==ZC_BUSY);
    assert(zc_capture_allocator_close(allocator)==ZC_BUSY);
    assert(zc_frame_export_close(exported)==ZC_OK);assert(zc_close(camera)==ZC_OK);
    assert(zc_open_allocated_pipeline(&cfg,&pipeline,&processed,1,0,NULL,0,allocator,&camera)==ZC_OK);
    assert(zc_capture_allocator_state_get(allocator,&state)==ZC_OK&&state.reuses==1&&state.allocations==2);
    assert(zc_close(camera)==ZC_OK);assert(zc_capture_allocator_trim(allocator)==ZC_OK);
    assert(zc_capture_allocator_state_get(allocator,&state)==ZC_OK&&state.entries==0&&state.used_bytes==0);
    assert(zc_capture_allocator_close(allocator)==ZC_OK);
    options.max_entries=17;allocator=(zc_capture_allocator*)1;
    assert(zc_capture_allocator_open(&options,NULL,0,&allocator)==ZC_INVALID&&allocator==NULL);
    puts("persistent capture allocator C ABI passed");return 0;
}
