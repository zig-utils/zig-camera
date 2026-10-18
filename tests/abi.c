#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
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
    assert(zc_video_close(recorder)==ZC_OK);
    zc_recording_options recording;zc_default_recording_options(&recording);
    recording.sample_rate=48000;recording.buffer_frames=48;recording.max_blocks=2;
    assert(zc_video_open_circular_av(&video,&history,&recording,0,&recorder)==ZC_OK);
    for(uint64_t i=0;i<4;i++) assert(zc_video_write_audio(recorder,pcm,sizeof(pcm),i*1000000)==ZC_OK);
    zc_audio_buffer_stats audio_stats;
    assert(zc_video_audio_buffer_stats(recorder,&audio_stats)==ZC_OK);
    assert(audio_stats.frames==48 && audio_stats.bytes==96 && audio_stats.evicted_frames==144);
    assert(audio_stats.first_ns==3000000 && audio_stats.last_ns==4000000);
    assert(zc_video_close(recorder)==ZC_OK);
    assert(zc_close(camera)==ZC_OK);
    return 0;
}
