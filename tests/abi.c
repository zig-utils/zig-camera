#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
#include <string.h>
_Static_assert(sizeof(zc_output_packet)==32,"output packet ABI");
_Static_assert(sizeof(zc_output_state)==24,"output state ABI");
_Static_assert(sizeof(zc_output_result)==32,"output close result ABI");
_Static_assert(sizeof(zc_output_stats)==48,"output stats ABI");
_Static_assert(sizeof(zc_output_callbacks)==56,"output callbacks ABI");
_Static_assert(sizeof(zc_buffer_config)==24,"buffer config ABI");
_Static_assert(sizeof(zc_buffer_stats)==64,"buffer stats ABI");
_Static_assert(sizeof(zc_pipeline_options)==44,"pipeline options ABI");
_Static_assert(sizeof(zc_pipeline_info)==224,"pipeline info ABI");
_Static_assert(sizeof(zc_sensor_mode)==44,"sensor mode ABI");
_Static_assert(sizeof(zc_control)==144,"control ABI");
_Static_assert(sizeof(zc_control_info)==120,"control info ABI");
_Static_assert(sizeof(zc_metadata)==96,"extended metadata ABI");
_Static_assert(sizeof(zc_capture_options) == 16, "capture options ABI");
_Static_assert(sizeof(zc_raw_metadata) == 184, "raw metadata ABI");
_Static_assert(sizeof(zc_video_config) == 32, "video config ABI");
_Static_assert(sizeof(zc_config) == 72, "config ABI");
_Static_assert(sizeof(zc_plane) == 40, "plane ABI");
_Static_assert(sizeof(zc_stream) == 208, "stream ABI");
_Static_assert(sizeof(zc_frame) == 456, "frame ABI");
_Static_assert(sizeof(zc_info) == 680, "info ABI");
_Static_assert(offsetof(zc_frame, main) == 40, "frame alignment");
_Static_assert(sizeof(zc_audio_config)==32,"audio config ABI");
_Static_assert(sizeof(zc_audio_block)==24,"audio block ABI");
_Static_assert(sizeof(zc_recording_options)==24,"recording options ABI");
_Static_assert(sizeof(zc_recording_stats)==72,"recording stats ABI");
_Static_assert(sizeof(zc_audio_buffer_stats)==40,"audio history ABI");
static int packet_sink(void *context,const zc_output_packet *packet) {
    unsigned *count=context;
    assert(packet->codec==ZC_MJPEG && packet->flags==1 && packet->length>2);
    assert(packet->data[0]==255 && packet->data[1]==216);
    assert(packet->timestamp_ns==*count*40000000ULL);
    (*count)++;return ZC_OK;
}
static int failing_packet_sink(void *context,const zc_output_packet *packet) {
    unsigned *calls=context;assert(packet->length>0);(*calls)++;return ZC_IO;
}
int main(void) {
    zc_audio_config audio_config;zc_default_audio_config(&audio_config);
    audio_config.backend=ZC_AUDIO_SYNTHETIC;audio_config.block_frames=48;
    zc_audio *audio=NULL;assert(zc_audio_open(&audio_config,"",&audio)==ZC_OK);
    uint8_t pcm[96];zc_audio_block block;
    assert(zc_audio_read(audio,pcm,sizeof(pcm),0,&block)==ZC_OK);
    assert(block.frames==48 && block.timestamp_ns==0);
    assert(zc_audio_read(audio,pcm,sizeof(pcm),0,&block)==ZC_OK);
    assert(block.timestamp_ns==1000000);
    assert(zc_audio_close(audio)==ZC_OK);
    assert(zc_abi_version() == ZC_ABI_VERSION);
    uint8_t pts[32];uint32_t pts_length=0;
    assert(zc_format_pts(41666,pts,sizeof(pts),&pts_length)==ZC_OK);
    assert(pts_length==7 && memcmp(pts,"41.666\n",7)==0);
    zc_video_config aac_video;zc_default_video_config(&aac_video);
    zc_recording_options aac_options;zc_default_recording_options(&aac_options);
    zc_recorder *invalid_aac=NULL;
    int aac_status=zc_video_open_aac("not-created.mp4",&aac_video,&aac_options,128000,&invalid_aac);
    assert((aac_status==ZC_INVALID || aac_status==ZC_UNSUPPORTED) && !invalid_aac);
    zc_config config;
    zc_default_config(&config);
    assert(config.buffer_count == 4);
    config.width = 1; /* deliberately mismatched geometry */
    zc_camera *camera = NULL;
    assert(zc_open(&config, &camera) == ZC_INVALID);
    assert(!camera);
    zc_pipeline_options options;
    zc_default_pipeline_options(&options);
    assert(options.struct_size==sizeof(options));
    assert(options.capture.struct_size==sizeof(options.capture));
    config.width=0;
    options.lores_width=17;options.lores_height=10;
    assert(zc_open_pipeline(&config,&options,&camera)==ZC_INVALID);
    assert(!camera);
    config.width=16;config.height=16;
    assert(zc_open(&config,&camera)==ZC_OK);
    assert(zc_start(camera)==ZC_OK);
    zc_video_config video;
    zc_default_video_config(&video);video.width=16;video.height=16;
    zc_buffer_config history;
    zc_default_buffer_config(&history);history.max_frames=2;history.max_bytes=100000;
    zc_recorder *recorder=NULL;
    assert(zc_video_open_circular(&video,&history,&recorder)==ZC_OK);
    for(uint64_t i=0;i<4;i++) {
        zc_frame frame;
        assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
    }
    zc_buffer_stats stats;
    assert(zc_video_buffer_stats(recorder,&stats)==ZC_OK);
    assert(stats.frames==2 && stats.bytes<=100000 && stats.evicted==2 && !stats.output_open);
    zc_snapshot *frozen=NULL,*cancelled=NULL,*overflow=NULL;
    assert(zc_video_freeze_buffer(recorder,"zig-out/abi-frozen.mkv",&frozen)==ZC_OK);
    assert(zc_video_freeze_buffer(recorder,"zig-out/abi-cancelled.mkv",&cancelled)==ZC_OK);
    assert(zc_video_freeze_buffer(recorder,"zig-out/abi-full.mkv",&overflow)==ZC_BUSY && !overflow);
    assert(zc_video_open_output(recorder,"zig-out/abi-frozen.mkv")==ZC_BUSY);
    assert(zc_video_close(recorder)==ZC_OK);
    assert(zc_snapshot_write(frozen)==ZC_OK);
    assert(zc_snapshot_write(frozen)==ZC_STATE);
    zc_snapshot_close(frozen);zc_snapshot_close(cancelled);
    zc_recording_options recording;zc_default_recording_options(&recording);
    recording.sample_rate=48000;recording.buffer_frames=48;recording.max_blocks=2;
    assert(zc_video_open_circular_av(&video,&history,&recording,0,&recorder)==ZC_OK);
    for(uint64_t i=0;i<4;i++) assert(zc_video_write_audio(recorder,pcm,sizeof(pcm),i*1000000)==ZC_OK);
    zc_audio_buffer_stats audio_stats;
    assert(zc_video_audio_buffer_stats(recorder,&audio_stats)==ZC_OK);
    assert(audio_stats.frames==48 && audio_stats.bytes==96 && audio_stats.evicted_frames==144);
    assert(audio_stats.first_ns==3000000 && audio_stats.last_ns==4000000);
    assert(zc_video_close(recorder)==ZC_OK);
    history.max_frames=8;
    assert(zc_video_open_circular(&video,&history,&recorder)==ZC_OK);
    assert(zc_video_set_delay(recorder,40000000)==ZC_OK);
    unsigned delivered=0;
    zc_output_callbacks callbacks={0};callbacks.struct_size=sizeof(callbacks);
    callbacks.format=ZC_OUTPUT_PACKETS;callbacks.context=&delivered;callbacks.packet=packet_sink;
    callbacks.file_fd=callbacks.pts_fd=callbacks.secondary_pts_fd=-1;
    assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
    for(uint64_t i=0;i<4;i++) {
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
    }
    assert(delivered==3);
    assert(zc_video_close(recorder)==ZC_OK && delivered==4);
    zc_default_recording_options(&recording);
    assert(zc_video_create(&video,&recording,0,&recorder)==ZC_OK);
    delivered=0;unsigned second_delivered=0;
    assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
    for(uint64_t i=0;i<6;i++) {
        if(i==2) {
            zc_output_callbacks next=callbacks;next.context=&second_delivered;
            assert(zc_video_split_callbacks(recorder,&next)==ZC_OK);
            assert(zc_video_split_callbacks(recorder,&next)==ZC_BUSY);
            assert(zc_video_cancel_split(recorder)==ZC_OK);
            assert(zc_video_split_callbacks(recorder,&next)==ZC_OK);
        }
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
    }
    assert(delivered==2 && second_delivered==4);
    assert(zc_video_buffer_stats(recorder,&stats)==ZC_OK && stats.segments==2 && !stats.split_pending && !stats.frames);
    assert(zc_video_close(recorder)==ZC_OK);
    assert(zc_video_create(&video,&recording,0,&recorder)==ZC_OK);
    delivered=0;second_delivered=0;
    assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
    uint64_t extra_id=0,path_id=0;
    zc_output_stats output_stats;
    for(uint64_t i=0;i<6;i++) {
        if(i==2) {
            zc_output_callbacks extra=callbacks;extra.context=&second_delivered;
            assert(zc_video_add_callbacks(recorder,&extra,&extra_id)==ZC_OK && extra_id>0);
            assert(zc_video_add_output(recorder,"zig-out/abi-parallel.mkv",&path_id)==ZC_OK && path_id!=extra_id);
        }
        if(i==4) {
            assert(zc_video_remove_output(recorder,0)==ZC_OK);
            assert(zc_video_output_stats(recorder,0,&output_stats)==ZC_STATE);
        }
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
    }
    assert(delivered==4 && second_delivered==4);
    assert(zc_video_output_stats(recorder,extra_id,&output_stats)==ZC_OK);
    assert(output_stats.frames==4 && !output_stats.waiting_key && output_stats.first_ns==80000000);
    assert(zc_video_remove_output(recorder,extra_id)==ZC_OK);
    assert(zc_video_remove_output(recorder,extra_id)==ZC_STATE);
    assert(zc_video_output_stats(recorder,path_id,&output_stats)==ZC_OK && output_stats.frames==4);
    assert(zc_video_close(recorder)==ZC_OK);
    assert(zc_video_create(&video,&recording,0,&recorder)==ZC_OK);
    delivered=0;second_delivered=0;unsigned third_delivered=0;
    assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
    zc_output_callbacks extra=callbacks;extra.context=&second_delivered;
    assert(zc_video_add_callbacks(recorder,&extra,&extra_id)==ZC_OK);
    for(uint64_t i=0;i<6;i++) {
        if(i==3) {
            zc_output_callbacks replacement=callbacks;replacement.context=&third_delivered;
            assert(zc_video_split_output(recorder,extra_id,NULL,&replacement)==ZC_OK);
            assert(zc_video_split_output(recorder,extra_id,NULL,&replacement)==ZC_BUSY);
            assert(zc_video_cancel_output_split(recorder,extra_id)==ZC_OK);
            assert(zc_video_split_output(recorder,extra_id,NULL,&replacement)==ZC_OK);
        }
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
    }
    zc_output_state state;
    assert(zc_video_output_state(recorder,extra_id,&state)==ZC_OK && state.generation==1 && state.split_state==ZC_SPLIT_COMMITTED && !state.pending);
    assert(delivered==6 && second_delivered==3 && third_delivered==3);
    assert(zc_video_close(recorder)==ZC_OK);
    assert(zc_video_create(&video,&recording,0,&recorder)==ZC_OK);
    assert(zc_video_set_failure_isolation(recorder,1)==ZC_OK);
    unsigned failed_calls=0;delivered=0;
    zc_output_callbacks failing=callbacks;failing.context=&failed_calls;failing.packet=failing_packet_sink;
    assert(zc_video_open_callbacks(recorder,&failing)==ZC_OK);
    assert(zc_video_add_callbacks(recorder,&callbacks,&extra_id)==ZC_OK);
    for(uint64_t i=0;i<4;i++) {
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
    }
    assert(failed_calls==1 && delivered==4);
    assert(zc_video_output_state(recorder,0,&state)==ZC_OK && state.error_code==ZC_IO);
    assert(zc_video_set_failure_isolation(recorder,0)==ZC_STATE);
    zc_output_result results[8];uint32_t result_count=0;
    assert(zc_video_close_outputs(recorder,results,1,&result_count)==ZC_INVALID);
    assert(zc_video_output_state(recorder,extra_id,&state)==ZC_OK && state.error_code==ZC_OK);
    assert(zc_video_close_outputs(recorder,results,8,&result_count)==ZC_OK && result_count==2);
    assert(results[0].id==0 && results[0].state.error_code==ZC_IO);
    assert(results[1].id==extra_id && results[1].state.error_code==ZC_OK);
    assert(zc_close(camera)==ZC_OK);
    return 0;
}
