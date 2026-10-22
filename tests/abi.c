#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
_Static_assert(sizeof(zc_packed_stream)==64,"packed stream ABI");
_Static_assert(offsetof(zc_packed_stream,offset)==48,"packed stream range ABI");
_Static_assert(sizeof(zc_processed_options)==36,"processed options ABI");
_Static_assert(sizeof(zc_stream_alignment)==20,"stream alignment ABI");
_Static_assert(sizeof(zc_tuning_state)==56,"tuning state ABI");
_Static_assert(offsetof(zc_tuning_state,generation)==40,"tuning generation ABI");
_Static_assert(sizeof(zc_color_negotiation)==88,"color negotiation ABI");
_Static_assert(sizeof(zc_preview_view)==48,"preview view ABI");
_Static_assert(sizeof(zc_pcm_span)==24,"shared PCM span ABI");
_Static_assert(sizeof(zc_pcm_batch)==32,"shared PCM batch ABI");
_Static_assert(sizeof(zc_pcm_consumer_state)==56,"shared PCM consumer ABI");
_Static_assert(sizeof(zc_pcm_fanout_stats)==96,"shared PCM stats ABI");
_Static_assert(sizeof(zc_audio_fanout_config)==16,"shared PCM config ABI");
_Static_assert(sizeof(zc_fanout_state)==72,"capture fanout ABI");
_Static_assert(sizeof(zc_producer_stats)==104,"producer stats ABI");
_Static_assert(sizeof(zc_session_state)==16,"session state ABI");
_Static_assert(sizeof(zc_producer_handoff)==16,"producer handoff ABI");
_Static_assert(sizeof(zc_producer_audio_input)==24,"producer PCM input ABI");
_Static_assert(sizeof(zc_output_event)==48,"output mailbox event ABI");
_Static_assert(sizeof(zc_output_mailbox_stats)==168,"host queue telemetry ABI");
_Static_assert(sizeof(zc_output_wait_state)==16,"host capacity wait ABI");
_Static_assert(offsetof(zc_output_mailbox_stats,error_code)==160,"host queue error ABI");
_Static_assert(sizeof(zc_pts_clock)==24,"shared PTS clock ABI");
_Static_assert(sizeof(zc_capture_filter)==32,"capture filter ABI");
_Static_assert(sizeof(zc_frame_sync_state)==24,"frame sync ABI");
_Static_assert(offsetof(zc_frame_sync_state,timer_us)==16,"frame sync timer ABI");
_Static_assert(sizeof(zc_capture_delay)==32,"capture delay ABI");
_Static_assert(offsetof(zc_capture_delay,armed)==24,"capture delay flag ABI");
_Static_assert(sizeof(zc_preparation_job_state)==32,"preparation job ABI");
_Static_assert(sizeof(zc_automatic_state)==16,"automatic state ABI");
_Static_assert(sizeof(zc_factory_config)==56,"factory config ABI");
_Static_assert(sizeof(zc_factory_state)==72,"factory state ABI");
_Static_assert(offsetof(zc_factory_state,retry_pending)==64,"factory retry flag ABI");
_Static_assert(sizeof(zc_output_delay)==40,"output delay ABI");
_Static_assert(sizeof(zc_output_recovery_state)==24,"output recovery ABI");
_Static_assert(sizeof(zc_output_io_stats)==88,"output I/O ABI");
_Static_assert(sizeof(zc_preparation_state)==8,"preparation gate ABI");
_Static_assert(sizeof(zc_output_packet)==32,"output packet ABI");
_Static_assert(sizeof(zc_output_state)==24,"output state ABI");
_Static_assert(sizeof(zc_output_result)==32,"output close result ABI");
_Static_assert(sizeof(zc_output_stats)==48,"output stats ABI");
_Static_assert(sizeof(zc_output_callbacks)==56,"output callbacks ABI");
_Static_assert(sizeof(zc_buffer_config)==24,"buffer config ABI");
_Static_assert(sizeof(zc_buffer_stats)==64,"buffer stats ABI");
_Static_assert(sizeof(zc_pipeline_options)==44,"pipeline options ABI");
_Static_assert(sizeof(zc_orientation_info)==16,"orientation ABI");
_Static_assert(sizeof(zc_image_options)==20,"image options ABI");
_Static_assert(sizeof(zc_image_profile)==24,"image profile ABI");
_Static_assert(sizeof(zc_image_exif)==24,"image Exif ABI");
_Static_assert(sizeof(zc_exif_field)==32,"typed Exif field ABI");
_Static_assert(offsetof(zc_exif_field,data)==16,"Exif field pointer ABI");
_Static_assert(offsetof(zc_image_exif,data)==8,"Exif bytes pointer ABI");
_Static_assert(sizeof(zc_image_file_state)==32,"staged file state ABI");
_Static_assert(offsetof(zc_image_profile,data)==8,"image profile pointer ABI");
_Static_assert(sizeof(zc_color_space)==24,"stream color ABI");
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
static void recording_color_contract(void) {
    zc_video_config cfg;zc_default_video_config(&cfg);
    zc_color_space legacy;zc_default_video_color(&legacy);
    assert(legacy.struct_size==24 && legacy.present==1 && legacy.primaries==ZC_PRIMARIES_REC709 && legacy.transfer==ZC_TRANSFER_SRGB && legacy.ycbcr_encoding==ZC_YCBCR_REC601 && legacy.range==ZC_RANGE_LIMITED);
    cfg.codec=ZC_MJPEG;assert(zc_video_check_color(&cfg,NULL)==ZC_OK);
    assert(zc_video_check_color(&cfg,&legacy)==ZC_UNSUPPORTED);
    cfg.codec=ZC_H264;
    zc_color_space target;assert(zc_color_space_preset(ZC_COLOR_REC2020,&target)==ZC_OK);
    assert(zc_video_check_color(&cfg,&target)==ZC_OK);
    zc_color_space rgb=target;rgb.ycbcr_encoding=ZC_YCBCR_NONE;rgb.range=ZC_RANGE_FULL;
    assert(zc_video_check_input_color_for(&rgb,ZC_RGB24,&target)==ZC_OK);
    assert(zc_video_check_input_color_for(&rgb,ZC_RGB24,NULL)==ZC_UNSUPPORTED);
    assert(zc_video_check_color(&cfg,&rgb)==ZC_INVALID);
    assert(zc_video_check_input_color_for(&rgb,99,&target)==ZC_INVALID);
}
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
static void typed_put32(uint8_t *p,uint32_t value){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(value>>(i*8));}
static uint32_t typed_get32(const uint8_t *p){uint32_t value=0;for(unsigned i=0;i<4;i++)value|=(uint32_t)p[i]<<(i*8);return value;}
static void formatted_main(void) {
    zc_config cfg;zc_default_config(&cfg);cfg.width=4;cfg.height=2;
    zc_pipeline_options pipe;zc_default_pipeline_options(&pipe);pipe.lores_width=2;pipe.lores_height=2;pipe.lores_format=ZC_RGB24;
    zc_camera *camera=NULL;
    assert(zc_open_formatted_pipeline(&cfg,&pipe,2,ZC_ROTATE0,0,&camera)==ZC_INVALID && !camera);
    cfg.width=3;assert(zc_open_formatted_pipeline(&cfg,&pipe,ZC_YUV420,ZC_ROTATE0,0,&camera)==ZC_INVALID && !camera);cfg.width=4;
    assert(zc_open_id_formatted_pipeline(&cfg,&pipe,ZC_YUV420,ZC_ROTATE0,0,(const uint8_t *)"synthetic",9,&camera)==ZC_OK);
    zc_info info;assert(zc_get_info(camera,&info)==ZC_OK);assert(!strcmp(info.main.format,"YUV420") && info.main.plane_count==3);
    zc_color_space color;assert(zc_get_stream_color_space(camera,ZC_MAIN,&color)==ZC_OK && color.ycbcr_encoding==ZC_YCBCR_REC601);
    assert(zc_get_stream_color_space(camera,ZC_LORES,&color)==ZC_OK && color.ycbcr_encoding==ZC_YCBCR_NONE);
    assert(zc_enable_writable(camera)==ZC_OK);assert(zc_start(camera)==ZC_OK);
    zc_frame frame;assert(zc_acquire(camera,1000,&frame)==ZC_OK);
    zc_frame_map *map=NULL;assert(zc_frame_map_open(camera,frame.token,ZC_MAIN,1,&map)==ZC_OK);
    zc_stream source;assert(zc_frame_map_stream(map,&source)==ZC_OK);
    memset((void *)source.planes[0].data,100,source.planes[0].bytes_used);
    memset((void *)source.planes[1].data,64,source.planes[1].bytes_used);
    memset((void *)source.planes[2].data,192,source.planes[2].bytes_used);
    uint8_t rgb[24];memset(rgb,99,sizeof(rgb));
    assert(zc_copy_frame_rgb(camera,frame.token,rgb,sizeof(rgb))==ZC_BUSY && rgb[0]==99);
    assert(zc_frame_map_close(map)==ZC_OK);
    assert(zc_copy_frame_rgb(camera,frame.token,rgb,sizeof(rgb))==ZC_OK);
    for(unsigned i=0;i<8;i++)assert(rgb[i*3]==190 && rgb[i*3+1]==76 && rgb[i*3+2]==0);
    uint8_t short_rgb[23];memset(short_rgb,99,sizeof(short_rgb));
    assert(zc_copy_frame_rgb(camera,frame.token,short_rgb,sizeof(short_rgb))==ZC_INVALID);
    for(unsigned i=0;i<sizeof(short_rgb);i++)assert(short_rgb[i]==99);
    assert(zc_release(camera,frame.token)==ZC_OK);
    assert(zc_copy_frame_rgb(camera,frame.token,rgb,sizeof(rgb))==ZC_STALE);
    assert(zc_close(camera)==ZC_OK);
}
static void color_requests(void) {
    zc_config cfg;zc_default_config(&cfg);cfg.width=16;cfg.height=16;
    zc_pipeline_options pipe;zc_default_pipeline_options(&pipe);pipe.lores_width=8;pipe.lores_height=8;
    zc_processed_options processed;zc_default_processed_options(&processed);
    assert(processed.struct_size==36 && processed.main_format==ZC_RGB24 && processed.color_space.struct_size==24 && !processed.color_space.present);
    assert(zc_check_processed_options(&processed,&pipe)==ZC_OK);
    processed.strict_color=1;assert(zc_check_processed_options(&processed,&pipe)==ZC_INVALID);processed.strict_color=0;
    assert(zc_color_space_preset(ZC_COLOR_SRGB,&processed.color_space)==ZC_OK);
    assert(zc_check_processed_options(&processed,&pipe)==ZC_INVALID); /* lores is YUV */
    zc_color_space canary;memset(&canary,90,sizeof(canary));const zc_color_space before=canary;
    assert(zc_color_space_preset(99,&canary)==ZC_INVALID && !memcmp(&canary,&before,sizeof(canary)));
    assert(zc_color_space_preset(ZC_COLOR_RAW,&processed.color_space)==ZC_OK);
    assert(zc_check_processed_options(&processed,&pipe)==ZC_INVALID);
    for(uint32_t format=ZC_YUV420;format<=ZC_RGB24;format++)for(uint32_t preset=ZC_COLOR_SYCC;preset<=ZC_COLOR_REC2020;preset++) {
        zc_default_processed_options(&processed);processed.main_format=format;processed.strict_color=1;
        pipe.lores_format=format==ZC_RGB24?ZC_YUV420:ZC_RGB24;
        assert(zc_color_space_preset(preset,&processed.color_space)==ZC_OK);
        zc_camera *camera=NULL;
        assert(zc_open_id_processed_pipeline(&cfg,&pipe,&processed,ZC_ROTATE0,0,(const uint8_t *)"synthetic",9,&camera)==ZC_OK);
        zc_color_negotiation main,lores;assert(zc_get_color_negotiation(camera,ZC_MAIN,&main)==ZC_OK);assert(zc_get_color_negotiation(camera,ZC_LORES,&lores)==ZC_OK);
        assert(main.struct_size==88 && (main.flags&3)==3 && !(main.flags&8) && main.format==format);
        assert(main.actual.primaries==processed.color_space.primaries && main.actual.transfer==processed.color_space.transfer);
        const zc_color_negotiation *rgb=format==ZC_RGB24?&main:&lores,*yuv=format==ZC_YUV420?&main:&lores;
        assert(rgb->actual.ycbcr_encoding==ZC_YCBCR_NONE && rgb->actual.range==ZC_RANGE_FULL && (rgb->flags&4));
        assert(yuv->actual.ycbcr_encoding==processed.color_space.ycbcr_encoding && yuv->actual.range==processed.color_space.range);
        const zc_color_negotiation old=main;
        assert(zc_get_color_negotiation(camera,ZC_RAW,&main)==ZC_UNSUPPORTED && !memcmp(&main,&old,sizeof(main)));
        assert(zc_start(camera)==ZC_OK);zc_frame frame;assert(zc_acquire(camera,1000,&frame)==ZC_OK);
        uint8_t rgb_copy[16*16*3];assert(zc_copy_frame_rgb(camera,frame.token,rgb_copy,sizeof(rgb_copy))==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);assert(zc_close(camera)==ZC_OK);
    }
}
int main(void) {
    {
        const uint8_t json[]="{\"one\":1}";
        zc_tuning_session *profile=NULL,*same=NULL,*conflict=NULL;
        assert(zc_tuning_session_open(json,sizeof(json)-1,ZC_SYNTHETIC,&profile)==ZC_OK && profile);
        assert(zc_tuning_session_open(json,sizeof(json)-1,ZC_SYNTHETIC,&same)==ZC_OK && same);
        assert(zc_tuning_session_open((const uint8_t*)"{\"one\":2}",9,ZC_SYNTHETIC,&conflict)==ZC_BUSY && !conflict);
        zc_tuning_state state={0};
        assert(zc_get_tuning_state(ZC_SYNTHETIC,&state)==ZC_OK);
        assert(state.struct_size==56 && state.custom==1 && state.session_users==2 && state.manager_users==0 && state.bytes==9);
        assert(zc_tuning_session_close(profile)==ZC_OK);
        assert(zc_tuning_session_close(same)==ZC_OK);
        assert(zc_get_tuning_state(ZC_SYNTHETIC,&state)==ZC_OK && state.custom==0 && state.session_users==0);
        assert(zc_tuning_cleanup(ZC_SYNTHETIC)==ZC_OK);
        assert(zc_get_tuning_state(99,&state)==ZC_INVALID && state.struct_size==0);
    }
    {
        uint8_t source[]="{\"version\":2,\"algorithms\":[{\"rpi.af\":9007199254740993}]}";
        zc_tuning_document *doc=NULL;
        assert(zc_tuning_document_open(source,sizeof(source)-1,&doc)==ZC_OK && doc);
        memset(source,0,sizeof(source));
        uint32_t version=0;
        assert(zc_tuning_document_version(doc,&version)==ZC_OK && version==2);
        uint64_t length=0;
        const uint8_t name[]="rpi.af";
        assert(zc_tuning_document_find(doc,name,sizeof(name)-1,NULL,0,&length)==ZC_OK && length==16);
        uint8_t value[80];memset(value,0x5a,sizeof(value));
        assert(zc_tuning_document_find(doc,name,sizeof(name)-1,value,1,&length)==ZC_INVALID);
        for(size_t i=0;i<sizeof(value);++i)assert(value[i]==0x5a);
        assert(zc_tuning_document_find(doc,name,sizeof(name)-1,value,sizeof(value),&length)==ZC_OK);
        assert(length==16 && memcmp(value,"9007199254740993",16)==0 && value[16]==0x5a);
        assert(zc_tuning_document_replace(doc,name,sizeof(name)-1,(const uint8_t*)"[",1)==ZC_INVALID);
        assert(zc_tuning_document_replace(doc,name,sizeof(name)-1,(const uint8_t*)"false",5)==ZC_OK);
        assert(zc_tuning_document_copy(doc,value,sizeof(value),&length)==ZC_OK);
        const char expected[]="{\"version\":2,\"algorithms\":[{\"rpi.af\":false}]}";
        assert(length==sizeof(expected)-1 && memcmp(value,expected,length)==0);
        assert(zc_tuning_document_find(doc,(const uint8_t*)"missing",7,NULL,0,&length)==ZC_UNSUPPORTED && length==0);
        zc_tuning_document_close(doc);zc_tuning_document_close(NULL);
        doc=NULL;
        assert(zc_tuning_document_open((const uint8_t*)"[",1,&doc)==ZC_INVALID && !doc);
    }
    {
        zc_stream_alignment plan={0};
        assert(zc_align_stream_geometry(1919,1081,ZC_ALIGN_PLANAR420,ZC_ALIGN_PISP,1,&plan)==ZC_OK);
        assert(plan.struct_size==20 && plan.width==1792 && plan.height==1080 && plan.width_alignment==128 && plan.height_alignment==2);
        zc_stream_alignment before=plan;
        assert(zc_align_stream_geometry(1,3,ZC_ALIGN_PACKED,ZC_ALIGN_PISP,1,&plan)==ZC_INVALID);
        assert(memcmp(&before,&plan,sizeof(plan))==0);
        zc_config cfg;zc_default_config(&cfg);cfg.width=1919;cfg.height=1081;
        zc_pipeline_options pipe;zc_default_pipeline_options(&pipe);pipe.lores_width=1;pipe.lores_height=3;
        zc_processed_options processed;zc_default_processed_options(&processed);
        zc_config cfg_before=cfg;zc_pipeline_options pipe_before=pipe;
        assert(zc_align_camera_configuration(&cfg,&pipe,&processed,ZC_ALIGN_PISP,1,&cfg,&pipe)==ZC_INVALID);
        assert(memcmp(&cfg_before,&cfg,sizeof(cfg))==0 && memcmp(&pipe_before,&pipe,sizeof(pipe))==0);
        pipe.lores_width=641;pipe.lores_height=481;
        assert(zc_align_camera_configuration(&cfg,&pipe,&processed,ZC_ALIGN_PISP,1,&cfg,&pipe)==ZC_OK);
        assert(cfg.width==1856 && cfg.height==1080 && pipe.lores_width==640 && pipe.lores_height==480);
    }
    {
        zc_config cfg;zc_default_config(&cfg);cfg.width=8;cfg.height=6;cfg.policy=ZC_FIFO;
        zc_camera *camera=NULL;assert(zc_open(&cfg,&camera)==ZC_OK && zc_start(camera)==ZC_OK);
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        zc_frame_sync_state state;memset(&state,42,sizeof(state));
        assert(zc_get_frame_sync_state(camera,frame.token,&state)==ZC_OK);
        assert(state.struct_size==sizeof(state) && state.valid==0 && state.ready==0 && state.timer_us==0);
        assert(zc_release(camera,frame.token)==ZC_OK);
        assert(zc_get_frame_sync_state(camera,frame.token,&state)==ZC_STALE);
        zc_frame_sync_state zero={0};assert(memcmp(&state,&zero,sizeof(state))==0);
        zc_capture_filter filter;assert(zc_capture_filter_init(&filter,0,ZC_CAPTURE_SYNC_READY,0)==ZC_OK);
        frame.token=42;
        assert(zc_acquire_filtered(camera,&filter,0,&frame)==ZC_TIMEOUT && frame.token==42);
        zc_stats stats;assert(zc_get_stats(camera,&stats)==ZC_OK && stats.leased==0);
        assert(zc_close(camera)==ZC_OK);
    }
    {
        zc_config cfg;zc_default_config(&cfg);
        zc_pipeline_options pipe;zc_default_pipeline_options(&pipe);
        zc_processed_options processed;zc_default_processed_options(&processed);
        assert(zc_check_camera_configuration(&cfg,&pipe,&processed,1,0)==ZC_OK);
        cfg.height=6;
        assert(zc_check_camera_configuration(&cfg,&pipe,&processed,1,0)==ZC_INVALID);
        cfg.width=8;
        assert(zc_check_camera_configuration(&cfg,&pipe,&processed,1,0)==ZC_OK);
        zc_capture_delay delay;zc_default_capture_delay(&delay);uint64_t remaining=42;
        assert(zc_capture_delay_remaining(&delay,0,&remaining)==ZC_STATE && remaining==0);
        assert(zc_capture_delay_arm(&delay,100,20)==ZC_OK);
        assert(zc_capture_delay_remaining(&delay,110,&remaining)==ZC_OK && remaining==10);
        zc_capture_delay before=delay;
        assert(zc_capture_delay_remaining(&delay,109,&remaining)==ZC_INVALID && remaining==0);
        assert(memcmp(&delay,&before,sizeof(delay))==0);
        assert(zc_capture_delay_remaining(&delay,120,&remaining)==ZC_OK && remaining==0);
    }
    {
        zc_config cfg;zc_default_config(&cfg);cfg.width=18;cfg.height=10;cfg.raw=1;
        zc_pipeline_options pipe;zc_default_pipeline_options(&pipe);pipe.capture.unpacked_raw=1;pipe.lores_width=8;pipe.lores_height=6;
        zc_camera *camera=NULL;assert(zc_open_pipeline(&cfg,&pipe,&camera)==ZC_OK && zc_start(camera)==ZC_OK);
        zc_frame frame;assert(zc_acquire_and_stop(camera,0,&frame)==ZC_OK);
        assert(zc_start(camera)==ZC_BUSY);
        const uint32_t ids[]={ZC_LORES,ZC_MAIN,ZC_RAW};zc_packed_stream layouts[3];zc_metadata metadata;uint64_t size=0;
        assert(zc_copy_frame_streams(camera,frame.token,ids,3,layouts,3,NULL,0,&size,&metadata)==ZC_OK && size==972);
        assert(metadata.sequence==frame.sequence && layouts[0].length==72 && layouts[1].offset==72 && layouts[2].offset==612);
        uint8_t bytes[974];memset(bytes,42,sizeof(bytes));
        assert(zc_copy_frame_streams(camera,frame.token,ids,3,layouts,3,bytes,sizeof(bytes),&size,&metadata)==ZC_OK && size==972);
        assert(bytes[972]==42 && bytes[973]==42);
        assert(zc_copy_frame_streams(camera,frame.token,ids,3,layouts,2,NULL,0,&size,&metadata)==ZC_INVALID && size==0);
        assert(zc_release(camera,frame.token)==ZC_OK);
        assert(zc_copy_frame_streams(camera,frame.token,ids,3,layouts,3,NULL,0,&size,&metadata)==ZC_STALE && size==0);
        assert(zc_stop(camera)==ZC_OK && zc_close(camera)==ZC_OK);
    }

    {
        const unsigned char model[]="ABI camera";
        const zc_exif_field field={ZC_EXIF_IMAGE,0x0110,2,0,sizeof(model),0,model,sizeof(model)};
        zc_image_blob *blob=(zc_image_blob *)1;
        assert(zc_exif_build(NULL,1,NULL,0,&blob)==ZC_INVALID && !blob);
        assert(zc_exif_build(&field,1,NULL,0,&blob)==ZC_OK && blob);
        uint64_t length=0; assert(zc_image_blob_copy(blob,NULL,0,&length)==ZC_OK && length>14);
        unsigned char *bytes=malloc((size_t)length);assert(bytes);
        assert(zc_image_blob_copy(blob,bytes,length,&length)==ZC_OK && !memcmp(bytes,"II",2));
        free(bytes);zc_image_blob_close(blob);
        zc_image_exif metadata; zc_default_image_exif(&metadata);
        assert(metadata.struct_size==24 && metadata.flags==ZC_IMAGE_EXIF_CAPTURE && !metadata.data && !metadata.length);
        zc_image_options options; zc_default_image_options(&options);
        assert(zc_check_image_metadata(&options,NULL,&metadata)==ZC_OK);
        metadata.flags=2;assert(zc_check_image_metadata(&options,NULL,&metadata)==ZC_INVALID);
    }
    {
        zc_image_file *file=NULL;
        assert(zc_image_file_create("/zig-camera-missing-directory/unused.png",&file)==ZC_OK && file);
        assert(zc_image_file_close(file)==ZC_BUSY);
        assert(zc_image_file_cancel(file)==1);
        assert(zc_image_file_finish(file,1)==ZC_STATE);
        assert(zc_image_file_finish(file,0)==ZC_OK);
        zc_image_file_state state;
        for(unsigned i=0;;i++) {
            assert(i<10000 && zc_image_file_state_get(file,&state)==ZC_OK && state.struct_size==32);
            if(state.finished)break;
            const struct timespec pause={0,1000000};nanosleep(&pause,NULL);
        }
        assert(state.phase==ZC_PREPARATION_CANCELLED && !state.committed && state.result==ZC_OK && state.cleanup_code==ZC_OK);
        assert(zc_image_file_close(file)==ZC_OK && zc_image_file_close(NULL)==ZC_OK);
    }
    recording_color_contract();
    color_requests();
    formatted_main();
    assert(zc_preview_check_color(ZC_RGB24,NULL)==ZC_OK);
    assert(zc_preview_check_color(ZC_YUV420,NULL)==ZC_UNSUPPORTED);
    zc_color_space display_color={.struct_size=sizeof(display_color),.present=1,.ycbcr_encoding=ZC_YCBCR_REC709,.range=ZC_RANGE_LIMITED};
    assert(zc_preview_check_color(ZC_YUV420,&display_color)==ZC_OK);
    display_color.range=0;assert(zc_preview_check_color(ZC_YUV420,&display_color)==ZC_UNSUPPORTED);
    display_color.struct_size=0;assert(zc_preview_check_color(ZC_YUV420,&display_color)==ZC_INVALID);

    zc_preview_view display;zc_default_preview_view(&display);
    assert(display.struct_size==48 && display.flags==1 && display.image_orientation==1 && display.overlay_orientation==1);
    assert(zc_preview_check_view(64,48,&display)==ZC_OK);
    display.flags|=8;display.overlay_x=63;display.overlay_width=UINT32_MAX;display.overlay_height=1;
    assert(zc_preview_check_view(64,48,&display)==ZC_INVALID);
    display.overlay_width=1;assert(zc_preview_check_view(64,48,&display)==ZC_OK);
    display.struct_size=0;assert(zc_preview_check_view(64,48,&display)==ZC_INVALID);

    zc_preview_overlay *overlay=NULL;
    uint8_t rgba[20]={0};
    assert(zc_preview_overlay_create(NULL,4,1,1,4,&overlay)==ZC_INVALID && !overlay);
    assert(zc_preview_overlay_create(rgba,19,2,2,12,&overlay)==ZC_INVALID && !overlay);
    assert(zc_preview_overlay_create(rgba,20,2,2,12,&overlay)==ZC_OK && overlay);
    memset(rgba,255,sizeof(rgba));
    zc_preview_overlay_close(overlay); zc_preview_overlay_close(NULL);

    {
        zc_producer_job *invalid[1]={NULL};
        assert(zc_producer_jobs_restart_publish(invalid,0)==ZC_INVALID);
        assert(zc_producer_jobs_restart_publish(invalid,1)==ZC_INVALID);
        assert(zc_producer_jobs_restart_publish(NULL,1)==ZC_INVALID);
        assert(zc_producer_jobs_restart_publish(invalid,9)==ZC_INVALID);
    }
    {
        zc_audio_config config;zc_default_audio_config(&config);config.backend=0;config.channels=2;config.block_frames=48;
        zc_audio *source=NULL;assert(zc_audio_open(&config,"",&source)==ZC_OK);
        zc_audio_fanout_config cfg={sizeof(cfg),192,8,0};zc_audio_fanout *shared=NULL,*duplicate=NULL;
        cfg.reserved=1;assert(zc_audio_fanout_open(source,&cfg,&shared)==ZC_INVALID && !shared);
        assert(zc_audio_can_share(source)==ZC_OK);cfg.reserved=0;
        assert(zc_audio_fanout_open(source,&cfg,&shared)==ZC_OK && shared);
        assert(zc_audio_can_share(source)==ZC_BUSY && zc_audio_fanout_open(source,&cfg,&duplicate)==ZC_BUSY && !duplicate);
        uint8_t untouched[192];memset(untouched,77,sizeof(untouched));zc_audio_block meta;
        assert(zc_audio_read(source,untouched,sizeof(untouched),0,&meta)==ZC_BUSY && untouched[0]==77);
        assert(zc_audio_close(source)==ZC_BUSY);
        uint64_t a,b;assert(zc_audio_fanout_add(shared,&a)==ZC_OK && zc_audio_fanout_add(shared,&b)==ZC_OK && a!=b);
        assert(zc_audio_fanout_close(shared)==ZC_BUSY);
        assert(zc_audio_fanout_fill(shared,2000000,256)==ZC_OK);
        zc_pcm_span spans[256];zc_pcm_batch batch;zc_pcm_consumer_state state;
        assert(zc_audio_fanout_prepare(shared,a,0,1000000,spans,0,&batch)==ZC_INVALID && !batch.ticket);
        assert(zc_audio_fanout_prepare(shared,a,0,1000000,spans,256,&batch)==ZC_OK && batch.frames==48 && batch.blocks==1);
        uint64_t ticket=batch.ticket;assert(spans[0].length==192 && spans[0].timestamp_ns==0);
        uint8_t original[192];memcpy(original,spans[0].data,sizeof(original));
        assert(zc_audio_fanout_fill(shared,3000000,256)==ZC_BUSY && memcmp(original,spans[0].data,sizeof(original))==0);
        assert(zc_audio_fanout_finish(shared,a,ticket+1,1,&state)==ZC_STALE);
        assert(zc_audio_fanout_finish(shared,a,ticket,2,&state)==ZC_INVALID);
        assert(zc_audio_fanout_finish(shared,a,ticket,0,&state)==ZC_OK && state.frames==0 && state.cancelled==1);
        assert(zc_audio_fanout_prepare(shared,a,0,1000000,spans,256,&batch)==ZC_OK && batch.frames==48 && batch.ticket!=ticket);
        assert(zc_audio_fanout_finish(shared,a,batch.ticket,1,&state)==ZC_OK && state.frames==48 && state.next_ns==1000000);
        assert(zc_audio_fanout_fill(shared,3000000,256)==ZC_OK);
        assert(zc_audio_fanout_prepare(shared,b,0,3000000,spans,256,&batch)==ZC_OK && batch.frames==144);
        assert(zc_audio_fanout_finish(shared,b,batch.ticket,1,&state)==ZC_OK && state.frames==144);
        zc_pcm_fanout_stats stats;assert(zc_audio_fanout_stats(shared,&stats)==ZC_OK && stats.reads==3 && stats.pushed_frames==144 && stats.max_frames==192 && stats.max_blocks==8 && stats.channels==2);
        assert(zc_audio_fanout_retire(shared,a,&state)==ZC_OK && !(state.flags&1));
        assert(zc_audio_fanout_state(shared,a,&state)==ZC_STALE);
        assert(zc_audio_fanout_check(shared,b)==ZC_OK);
        uint64_t hold;assert(zc_audio_fanout_hold(shared,&hold)==ZC_OK);
        assert(zc_audio_fanout_retire(shared,b,&state)==ZC_OK);
        assert(zc_audio_fanout_close(shared)==ZC_BUSY && zc_audio_close(source)==ZC_BUSY);
        assert(zc_audio_fanout_release_hold(shared,hold)==ZC_OK);
        assert(zc_audio_fanout_release_hold(shared,hold)==ZC_STALE);
        assert(zc_audio_fanout_close(shared)==ZC_OK && zc_audio_can_share(source)==ZC_OK);
        assert(zc_audio_read(source,untouched,sizeof(untouched),0,&meta)==ZC_OK && meta.timestamp_ns==3000000);
        assert(zc_audio_close(source)==ZC_OK);
    }

    {
        zc_fanout *fanout=NULL;assert(zc_fanout_open(&fanout)==ZC_OK && fanout);
        uint64_t ids[8],frame=0,ticket=0,other=0;zc_fanout_state state;
        assert(zc_fanout_add(fanout,2,&other)==ZC_INVALID);
        for(unsigned i=0;i<8;i++)assert(zc_fanout_add(fanout,i?1:0,&ids[i])==ZC_OK);
        assert(zc_fanout_add(fanout,0,&other)==ZC_BUSY);
        assert(zc_fanout_close(fanout)==ZC_BUSY);
        assert(zc_fanout_claim(fanout,ids[0],0,&ticket)==ZC_STALE);
        assert(zc_fanout_offer(fanout,&frame)==ZC_OK && frame==0);
        assert(zc_fanout_claim(fanout,ids[0],frame,&ticket)==ZC_OK && ticket);
        assert(!zc_fanout_ready(fanout));
        assert(zc_fanout_claim(fanout,ids[1],frame,&other)==ZC_OK && other!=ticket);
        assert(zc_fanout_finish(fanout,ids[0],ticket+2,0,&state)==ZC_STALE);
        assert(zc_fanout_finish(fanout,ids[0],ticket,3,&state)==ZC_INVALID);
        assert(zc_fanout_finish(fanout,ids[0],ticket,2,&state)==ZC_OK && state.cancelled==1 && state.flags==1);
        assert(zc_fanout_ready(fanout));
        assert(zc_fanout_offer(fanout,&frame)==ZC_OK && frame==1);
        assert(zc_fanout_claim(fanout,ids[1],frame,&ticket)==ZC_TIMEOUT && !ticket);
        assert(zc_fanout_state_get(fanout,ids[1],&state)==ZC_OK && state.skipped==1);
        assert(zc_fanout_retire(fanout,ids[1],&state)==ZC_OK && (state.flags&10)==10);
        assert(zc_fanout_add(fanout,0,&ticket)==ZC_BUSY);
        assert(zc_fanout_finish(fanout,ids[1],other,0,&state)==ZC_OK && state.completed==1 && !(state.flags&2));
        assert(zc_fanout_state_get(fanout,ids[1],&state)==ZC_STALE);
        assert(zc_fanout_add(fanout,0,&ticket)==ZC_OK && ticket>ids[7]);
        assert(zc_fanout_finish(fanout,ids[1],other,1,&state)==ZC_STALE);
        assert(zc_fanout_fail(fanout,ticket,&state)==ZC_OK && state.failures==1 && state.flags==4);
        assert(zc_fanout_retire(fanout,ticket,&state)==ZC_OK);
        for(unsigned i=0;i<8;i++)if(i!=1)assert(zc_fanout_retire(fanout,ids[i],&state)==ZC_OK);
        assert(zc_fanout_close(fanout)==ZC_OK);
    }

    {
        zc_config cfg;zc_default_config(&cfg);cfg.width=64;cfg.height=48;cfg.policy=ZC_FIFO;
        zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);pipeline.lores_width=18;pipeline.lores_height=10;
        zc_camera *camera=NULL;assert(zc_open_pipeline(&cfg,&pipeline,&camera)==ZC_OK);
        zc_color_space color;assert(zc_get_stream_color_space(camera,ZC_LORES,&color)==ZC_OK);
        assert(color.struct_size==sizeof(color) && color.present && color.ycbcr_encoding==ZC_YCBCR_REC601 && color.range==ZC_RANGE_FULL);
        assert(zc_get_stream_color_space(camera,ZC_RAW,&color)==ZC_UNSUPPORTED);
        assert(zc_get_stream_color_space(camera,99,&color)==ZC_INVALID);
        assert(zc_start(camera)==ZC_OK);zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        uint8_t rgb[18*10*3];memset(rgb,0xa7,sizeof(rgb));
        assert(zc_copy_stream_rgb(camera,frame.token,ZC_LORES,rgb,sizeof(rgb)-1)==ZC_INVALID && rgb[0]==0xa7);
        assert(zc_copy_stream_rgb(camera,frame.token,ZC_LORES,rgb,sizeof(rgb))==ZC_OK && rgb[0]==0);
        zc_image_options image;zc_default_image_options(&image);image.format=ZC_IMAGE_PPM;
        zc_image_blob *blob=NULL;assert(zc_encode_stream_image(camera,frame.token,ZC_LORES,&image,&blob)==ZC_OK && blob);zc_image_blob_close(blob);
        image.format=ZC_IMAGE_DNG;
        assert(zc_encode_stream_image(camera,frame.token,ZC_LORES,&image,&blob)==ZC_UNSUPPORTED && !blob);
        zc_frame selected=frame;assert(zc_get_stream(camera,frame.token,ZC_LORES,&selected.main)==ZC_OK);
        assert(zc_video_check_input_color(&color,ZC_YUV420)==ZC_OK);
        zc_video_config video;zc_default_video_config(&video);video.width=18;video.height=10;video.codec=ZC_MJPEG;
        zc_recording_options options;zc_default_recording_options(&options);
        zc_recorder *recorder=NULL;assert(zc_video_create(&video,&options,0,&recorder)==ZC_OK);
        unsigned count=0;zc_output_callbacks callbacks={0};callbacks.struct_size=sizeof(callbacks);callbacks.context=&count;callbacks.packet=packet_sink;callbacks.file_fd=callbacks.pts_fd=callbacks.secondary_pts_fd=-1;
        assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
        assert(zc_video_write_input(recorder,&selected,&color,0)==ZC_OK && count==1);
        zc_producer_job *job=NULL;assert(zc_video_producer_input_av(recorder,&selected,&color,40000000ULL,NULL,0,&job)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
        assert(zc_copy_stream_rgb(camera,frame.token,ZC_LORES,rgb,sizeof(rgb))==ZC_STALE);
        assert(zc_stop(camera)==ZC_OK && zc_close(camera)==ZC_OK);
        assert(zc_producer_job_start(job)==ZC_OK);
        int result=ZC_TIMEOUT;
        for(unsigned tries=0;zc_producer_job_finish(job,&result)==ZC_TIMEOUT;tries++){assert(tries<5000);struct timespec delay={0,1000000};nanosleep(&delay,NULL);}
        assert(result==ZC_OK && count==2);
        assert(zc_producer_job_close(job)==ZC_OK && zc_video_close(recorder)==ZC_OK);
    }
    {
        zc_config cfg;zc_default_config(&cfg);cfg.width=18;cfg.height=10;
        zc_camera *camera=NULL;assert(zc_open(&cfg,&camera)==ZC_OK && zc_start(camera)==ZC_OK);
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        zc_image_options options;zc_default_image_options(&options);options.format=ZC_IMAGE_PNG;
        zc_image_blob *blob=NULL;assert(zc_encode_image(camera,frame.token,&options,&blob)==ZC_OK && blob);
        zc_image_exif capture_exif;zc_default_image_exif(&capture_exif);
        zc_image_blob *with_exif=NULL;
        assert(zc_encode_stream_image_metadata(camera,frame.token,ZC_MAIN,&options,NULL,&capture_exif,&with_exif)==ZC_OK && with_exif);
        uint64_t exif_size=0;assert(zc_image_blob_copy(with_exif,NULL,0,&exif_size)==ZC_OK && exif_size>45);
        uint8_t *exif_bytes=malloc(exif_size);assert(exif_bytes);
        assert(zc_image_blob_copy(with_exif,exif_bytes,exif_size,&exif_size)==ZC_OK && !memcmp(exif_bytes+37,"eXIf",4));
        free(exif_bytes);zc_image_blob_close(with_exif);
        zc_image_profile profile={sizeof(profile),ZC_IMAGE_PROFILE_SRGB,NULL,0};
        assert(zc_check_image_profile(&options,&profile)==ZC_OK);
        zc_image_blob *tagged=NULL;
        assert(zc_encode_stream_image_profile(camera,frame.token,ZC_MAIN,&options,&profile,&tagged)==ZC_OK && tagged);
        uint64_t tagged_size=0;assert(zc_image_blob_copy(tagged,NULL,0,&tagged_size)==ZC_OK && tagged_size>45);
        uint8_t *tagged_bytes=malloc(tagged_size);assert(tagged_bytes);
        assert(zc_image_blob_copy(tagged,tagged_bytes,tagged_size,&tagged_size)==ZC_OK && !memcmp(tagged_bytes+37,"iCCP",4));
        free(tagged_bytes);zc_image_blob_close(tagged);
        profile.flags=2;tagged=(zc_image_blob *)1;
        assert(zc_encode_stream_image_profile(camera,frame.token,ZC_MAIN,&options,&profile,&tagged)==ZC_INVALID && !tagged);
        profile.flags=ZC_IMAGE_PROFILE_SRGB;profile.length=1;
        assert(zc_check_image_profile(&options,&profile)==ZC_INVALID);
        profile.length=0;options.format=ZC_IMAGE_BMP;
        assert(zc_check_image_profile(&options,&profile)==ZC_UNSUPPORTED);options.format=ZC_IMAGE_PNG;
        assert(zc_release(camera,frame.token)==ZC_OK && zc_stop(camera)==ZC_OK && zc_close(camera)==ZC_OK);
        uint64_t size=0;assert(zc_image_blob_copy(blob,NULL,0,&size)==ZC_OK && size>8);
        uint8_t *bytes=malloc(size);assert(bytes);memset(bytes,0xa7,size);
        assert(zc_image_blob_copy(blob,bytes,1,&size)==ZC_INVALID && bytes[0]==0xa7);
        assert(zc_image_blob_copy(blob,bytes,size,&size)==ZC_OK);
        assert(!memcmp(bytes,"\x89PNG\r\n\x1a\n",8));free(bytes);zc_image_blob_close(blob);
        zc_image_blob_close(NULL);
    }
    {
        zc_config cfg;zc_default_config(&cfg);cfg.width=18;cfg.height=10;
        zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);
        uint32_t orientation=99;
        assert(zc_orientation_from_transform(90,0,0,0,&orientation)==ZC_OK && orientation==ZC_ROTATE90);
        assert(zc_orientation_from_transform(45,0,0,0,&orientation)==ZC_INVALID && orientation==ZC_ROTATE90);
        zc_camera *camera=NULL;
        assert(zc_open_id_oriented_pipeline(&cfg,&pipeline,orientation,1,(const uint8_t *)"synthetic",9,&camera)==ZC_OK);
        zc_orientation_info actual;assert(zc_get_orientation(camera,&actual)==ZC_OK);
        assert(actual.struct_size==sizeof(actual) && actual.requested==orientation && actual.actual==orientation && !actual.adjusted);
        assert(zc_start(camera)==ZC_OK);
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(frame.main.planes[0].data[0]==0 && frame.main.planes[0].data[1]==17);
        assert(zc_release(camera,frame.token)==ZC_OK);
        assert(zc_stop(camera)==ZC_OK && zc_close(camera)==ZC_OK);
        assert(zc_open_oriented_pipeline(&cfg,&pipeline,9,0,&camera)==ZC_INVALID && !camera);
    }
    zc_config typed_cfg;zc_default_config(&typed_cfg);typed_cfg.width=16;typed_cfg.height=16;
    zc_camera *typed_camera=NULL;assert(zc_open(&typed_cfg,&typed_camera)==ZC_OK);
    uint8_t typed_packet[96]={0};memcpy(typed_packet,"HCAT",4);
    typed_put32(typed_packet+4,1);typed_put32(typed_packet+8,ZC_CATALOG_CONTROL_UPDATE);typed_put32(typed_packet+12,1);
    typed_put32(typed_packet+16,80);typed_put32(typed_packet+24,0x10001);typed_put32(typed_packet+44,4);typed_put32(typed_packet+56,1);
    typed_put32(typed_packet+60,36);typed_put32(typed_packet+68,4);typed_put32(typed_packet+76,2);typed_put32(typed_packet+80,1);
    const uint64_t exact_native=9007199254740993ULL;
    for(unsigned i=0;i<8;i++)typed_packet[88+i]=(uint8_t)(exact_native>>(i*8));
    uint64_t typed_revision=0;
    assert(zc_set_native_controls(typed_camera,typed_packet,sizeof(typed_packet),&typed_revision)==ZC_OK && typed_revision==1);
    zc_catalog *typed_state=NULL;
    assert(zc_get_native_controls(typed_camera,&typed_state,&typed_revision)==ZC_OK);
    assert(zc_close(typed_camera)==ZC_OK);
    uint64_t typed_length=0;assert(zc_catalog_copy(typed_state,NULL,0,&typed_length)==ZC_OK);
    uint8_t *typed_bytes=malloc(typed_length);assert(typed_bytes);
    assert(zc_catalog_copy(typed_state,typed_bytes,typed_length,&typed_length)==ZC_OK);
    assert(typed_get32(typed_bytes+8)==ZC_CATALOG_CONTROL_STATE && typed_get32(typed_bytes+12)==1);
    const uint32_t typed_value_offset=16+44+typed_get32(typed_bytes+48)+typed_get32(typed_bytes+52);
    assert(typed_value_offset+36<=typed_length && typed_get32(typed_bytes+typed_value_offset+8)==4);
    uint64_t typed_exact=0;for(unsigned i=0;i<8;i++)typed_exact|=(uint64_t)typed_bytes[typed_value_offset+28+i]<<(i*8);
    assert(typed_exact==exact_native);free(typed_bytes);zc_catalog_close(typed_state);

    zc_config identity_cfg;zc_default_config(&identity_cfg);
    identity_cfg.width=16;identity_cfg.height=16;
    zc_pipeline_options identity_pipeline;zc_default_pipeline_options(&identity_pipeline);
    const uint8_t device_id[]="synthetic";
    zc_camera *identity_camera=NULL;
    assert(zc_open_id_pipeline(&identity_cfg,&identity_pipeline,device_id,sizeof(device_id)-1,&identity_camera)==ZC_OK);
    uint32_t identity_length=0;
    assert(zc_get_camera_id(identity_camera,NULL,0,&identity_length)==ZC_OK && identity_length==9);
    uint8_t identity_copy[10];memset(identity_copy,0xaa,sizeof(identity_copy));
    assert(zc_get_camera_id(identity_camera,identity_copy,8,&identity_length)==ZC_INVALID);
    assert(identity_copy[0]==0xaa && identity_copy[8]==0xaa);
    assert(zc_get_camera_id(identity_camera,identity_copy,sizeof(identity_copy),&identity_length)==ZC_OK);
    assert(memcmp(identity_copy,device_id,identity_length)==0 && identity_copy[9]==0xaa);
    assert(zc_close(identity_camera)==ZC_OK);
    identity_camera=(zc_camera *)1;
    assert(zc_open_id_pipeline(&identity_cfg,&identity_pipeline,(const uint8_t *)"absent",6,&identity_camera)==ZC_DEVICE && !identity_camera);
    assert(zc_open_id_pipeline(&identity_cfg,&identity_pipeline,(const uint8_t *)"bad\0id",6,&identity_camera)==ZC_INVALID && !identity_camera);

    zc_catalog *catalog=NULL;
    assert(zc_discover(ZC_SYNTHETIC,&catalog)==ZC_OK && catalog);
    uint64_t catalog_size=0;
    assert(zc_catalog_copy(catalog,NULL,0,&catalog_size)==ZC_OK && catalog_size>=16);
    uint8_t *catalog_bytes=malloc(catalog_size);
    assert(catalog_bytes);
    memset(catalog_bytes,0xaa,catalog_size);
    assert(zc_catalog_copy(catalog,catalog_bytes,catalog_size-1,&catalog_size)==ZC_INVALID);
    assert(catalog_bytes[0]==0xaa);
    assert(zc_catalog_copy(catalog,catalog_bytes,catalog_size,&catalog_size)==ZC_OK);
    assert(memcmp(catalog_bytes,"HCAT",4)==0 && catalog_bytes[4]==1);
    zc_catalog_close(catalog);
    free(catalog_bytes);
    catalog=(zc_catalog *)1;
    assert(zc_discover(99,&catalog)==ZC_INVALID && catalog==NULL);
    zc_catalog_close(NULL);

    zc_output_mailbox *mailbox=NULL;
    assert(zc_output_mailbox_open(3,2,&mailbox)==ZC_OK);
    zc_output_callbacks mailbox_callbacks;
    assert(zc_output_mailbox_callbacks(mailbox,ZC_OUTPUT_PACKETS,&mailbox_callbacks)==ZC_OK);
    const uint8_t payload[3]={1,2,3};
    zc_output_packet mailbox_packet={payload,3,0,ZC_MJPEG,1};
    assert(mailbox_callbacks.packet(mailbox_callbacks.context,&mailbox_packet)==ZC_OK);
    uint64_t ticket=0;
    assert(zc_output_mailbox_wait_open(mailbox,3,1,0,&ticket)==ZC_OK && ticket);
    zc_output_wait_state wait_state;
    assert(zc_output_mailbox_wait_poll(mailbox,ticket,&wait_state)==ZC_OK);
    assert(wait_state.done && wait_state.code==ZC_TIMEOUT && !wait_state.remaining_ns);
    assert(zc_output_mailbox_wait_close(mailbox,ticket)==ZC_OK);
    assert(zc_output_mailbox_wait_close(mailbox,ticket)==ZC_STALE);
    zc_output_mailbox_stats host_stats;
    assert(zc_output_mailbox_stats_get(mailbox,&host_stats)==ZC_OK);
    assert(host_stats.queued_bytes==3 && host_stats.accepted_bytes==3 && !host_stats.completed_bytes);
    assert(host_stats.timed_out_waits==1 && !host_stats.pending_waits && !host_stats.error_code);
    assert(zc_output_mailbox_ack(mailbox,1)==ZC_OK);
    assert(zc_output_mailbox_wait_open(mailbox,3,2,0,&ticket)==ZC_OK);
    assert(zc_output_mailbox_fail(mailbox,ZC_IO)==ZC_OK);
    assert(zc_output_mailbox_wait_poll(mailbox,ticket,&wait_state)==ZC_OK && wait_state.done && wait_state.code==ZC_OK);
    assert(zc_output_mailbox_wait_close(mailbox,ticket)==ZC_OK);
    zc_output_mailbox_retire(mailbox);
    assert(zc_output_mailbox_wait_open(mailbox,0,1,0,&ticket)==ZC_STATE && !ticket);
    zc_output_mailbox_close(mailbox);
    zc_pts_clock pts_clock;
    zc_default_pts_clock(&pts_clock);
    uint64_t timestamp=123;
    assert(zc_pts_clock_accept(&pts_clock,9000000123ULL,&timestamp)==ZC_OK && timestamp==0);
    assert(zc_pts_clock_accept(&pts_clock,9040000123ULL,&timestamp)==ZC_OK && timestamp==40000);
    zc_pts_clock before=pts_clock;
    assert(zc_pts_clock_accept(&pts_clock,9040000999ULL,&timestamp)==ZC_INVALID && timestamp==40000);
    assert(memcmp(&before,&pts_clock,sizeof(pts_clock))==0);
    zc_preparation_state preparation;
    zc_default_preparation_state(&preparation);
    assert(preparation.phase==0 && !preparation.cancel_requested);
    assert(zc_preparation_step(&preparation,ZC_PREP_CLAIM)==1);
    assert(zc_preparation_step(&preparation,ZC_PREP_READY)==1);
    assert(zc_preparation_step(&preparation,ZC_PREP_CANCEL)==1);
    assert(zc_preparation_step(&preparation,ZC_PREP_PUBLISH)==0);
    assert(zc_preparation_step(&preparation,ZC_PREP_CLEANED)==1 && preparation.phase==ZC_PREPARATION_CANCELLED);
    assert(zc_preparation_step(&preparation,ZC_PREP_FAIL)==0);
    assert(zc_preparation_step(&preparation,99)==ZC_INVALID);
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
    zc_control desired={0};desired.id=ZC_EXPOSURE_TIME;desired.type=ZC_INT;desired.count=1;desired.values[0]=1700;
    uint64_t control_revision=0;uint32_t control_count=99;
    assert(zc_restore_controls(camera,&desired,1,40,&control_revision)==ZC_OK && control_revision==41);
    desired.values[0]=9999;
    assert(zc_get_controls(camera,NULL,0,&control_count,&control_revision)==ZC_OK && control_count==1 && control_revision==41);
    assert(zc_get_controls(camera,&desired,0,&control_count,&control_revision)==ZC_INVALID && desired.values[0]==9999);
    assert(zc_get_controls(camera,&desired,1,&control_count,&control_revision)==ZC_OK && desired.values[0]==1700);
    assert(zc_restore_controls(camera,NULL,0,0,&control_revision)==ZC_STATE);
    assert(zc_start(camera)==ZC_OK);
    zc_frame controlled;zc_metadata controlled_meta;
    assert(zc_acquire(camera,0,&controlled)==ZC_OK);
    assert(zc_get_frame_metadata(camera,controlled.token,&controlled_meta)==ZC_OK && controlled_meta.control_revision==41 && controlled_meta.exposure_us==1700);
    zc_frame retained_request;uint32_t request_references=0;
    assert(zc_retain(camera,controlled.token,&retained_request)==ZC_OK);
    assert(retained_request.token!=controlled.token && retained_request.sequence==controlled.sequence);
    assert(zc_frame_references(camera,retained_request.token,&request_references)==ZC_OK && request_references==2);
    assert(zc_release(camera,controlled.token)==ZC_OK);
    assert(zc_release(camera,controlled.token)==ZC_STALE);
    assert(zc_get_frame_metadata(camera,retained_request.token,&controlled_meta)==ZC_OK);
    assert(zc_frame_references(camera,retained_request.token,&request_references)==ZC_OK && request_references==1);
    zc_stream retained_stream;uint64_t retained_size=0;
    assert(zc_get_stream(camera,retained_request.token,ZC_MAIN,&retained_stream)==ZC_OK);
    assert(zc_stream_copy_size(&retained_stream,&retained_size)==ZC_OK && retained_size==16*16*3);
    assert(zc_release(camera,retained_request.token)==ZC_OK);
    zc_control caf={0};caf.id=ZC_AF_MODE;caf.type=ZC_INT;caf.count=1;caf.values[0]=2;
    assert(zc_set_controls(camera,&caf,1,&control_revision)==ZC_OK);
    uint64_t pause_job=0,restore_pause_job=0;uint32_t pause_state=0;
    assert(zc_autofocus_pause_start(camera,3,&pause_job)==ZC_INVALID);
    assert(zc_autofocus_pause_start(camera,1,&pause_job)==ZC_OK);
    for(unsigned i=0;i<32 && zc_autofocus_wait(camera,pause_job,0,&pause_state)==ZC_TIMEOUT;i++) {
        assert(zc_acquire(camera,0,&controlled)==ZC_OK);
        assert(zc_release(camera,controlled.token)==ZC_OK);
    }
    assert(zc_autofocus_wait(camera,pause_job,0,&pause_state)==ZC_OK && pause_state==ZC_AF_SUCCEEDED);
    assert(zc_acquire_focus_locked(camera,pause_job,1,100,&controlled)==ZC_OK);
    assert(zc_focus_locked_validate(camera,pause_job,controlled.token,1)==ZC_OK);
    assert(zc_get_frame_metadata(camera,controlled.token,&controlled_meta)==ZC_OK);
    assert((controlled_meta.valid&33)==33 && controlled_meta.af_state==2 && controlled_meta.af_pause_state==2);
    assert(zc_release(camera,controlled.token)==ZC_OK);
    assert(zc_autofocus_pause_restore(camera,pause_job,&restore_pause_job)==ZC_OK);
    assert(zc_autofocus_cancel(camera,pause_job)==ZC_STALE);
    for(unsigned i=0;i<32 && zc_autofocus_wait(camera,restore_pause_job,0,&pause_state)==ZC_TIMEOUT;i++) {
        assert(zc_acquire(camera,0,&controlled)==ZC_OK);
        assert(zc_release(camera,controlled.token)==ZC_OK);
    }
    assert(zc_autofocus_wait(camera,restore_pause_job,0,&pause_state)==ZC_OK && pause_state==ZC_AF_SUCCEEDED);

    zc_video_config video;
    zc_default_video_config(&video);video.width=16;video.height=16;
    zc_video_config negotiated=video;
    zc_recording_options negotiated_audio;zc_default_recording_options(&negotiated_audio);
    assert(zc_video_resolve_session_config(&negotiated,&negotiated_audio,0,32,24,1)==ZC_INVALID);
    assert(negotiated.width==16 && negotiated.height==16);
    assert(zc_video_resolve_session_config(&negotiated,&negotiated_audio,0,32,24,0)==ZC_OK);
    assert(negotiated.width==32 && negotiated.height==24 && negotiated.quality==video.quality);
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
    assert(zc_video_create(&video,&recording,0,&recorder)==ZC_OK);
    assert(zc_video_set_failure_isolation(recorder,1)==ZC_OK);
    delivered=0;second_delivered=0;failed_calls=0;
    assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
    assert(zc_video_add_callbacks(recorder,&failing,&extra_id)==ZC_OK);
    assert(zc_video_set_output_delay(recorder,0,80000000,32768,8)==ZC_OK);
    assert(zc_video_set_output_recovery(recorder,extra_id,2,40000000,80000000)==ZC_OK);
    for(uint64_t i=0;i<6;i++) {
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
        uint32_t due=0;
        assert(zc_video_output_retry_due(recorder,extra_id,&due)==ZC_OK);
        if(i==0) assert(!due);
        if(i==1) {
            assert(due);
            zc_output_callbacks fresh=callbacks;fresh.context=&second_delivered;
            assert(zc_video_recover_output(recorder,extra_id,NULL,&fresh)==ZC_OK);
            assert(zc_video_recover_output(recorder,extra_id,NULL,&fresh)==ZC_STATE);
        }
    }
    zc_output_delay delay_state;
    assert(zc_video_output_delay(recorder,0,&delay_state)==ZC_OK);
    assert(delay_state.delay_ns==80000000 && delay_state.queued_frames==2 && delay_state.queued_bytes>0);
    assert(zc_video_set_output_delay(recorder,0,0,65536,8)==ZC_BUSY);
    assert(zc_video_output_state(recorder,extra_id,&state)==ZC_OK && state.generation==1 && !state.error_code);
    zc_output_recovery_state recovery_state;
    assert(zc_video_output_recovery(recorder,extra_id,&recovery_state)==ZC_OK);
    assert(recovery_state.limit==2 && recovery_state.attempts==1 && !recovery_state.exhausted);
    assert(delivered==4 && second_delivered==4 && failed_calls==1);
    assert(zc_video_close(recorder)==ZC_OK && delivered==6);
    assert(zc_video_create(&video,&recording,0,&recorder)==ZC_OK);
    assert(zc_video_set_failure_isolation(recorder,1)==ZC_OK);
    delivered=0;second_delivered=0;third_delivered=0;
    assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
    extra=callbacks;extra.context=&second_delivered;
    assert(zc_video_add_callbacks(recorder,&extra,&extra_id)==ZC_OK);
    assert(zc_video_set_output_io(recorder,0,32768,8,0)==ZC_OK);
    assert(zc_video_set_output_io(recorder,extra_id,0,8,0)==ZC_INVALID);
    assert(zc_video_set_output_io(recorder,extra_id,32768,8,1000000000)==ZC_OK);
    for(uint64_t i=0;i<6;i++) {
        if(i==4) {
            zc_output_callbacks replacement=callbacks;replacement.context=&third_delivered;
            assert(zc_video_split_output(recorder,extra_id,NULL,&replacement)==ZC_OK);
        }
        zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
        assert(zc_video_write(recorder,&frame,i*40000000)==ZC_OK);
        assert(zc_release(camera,frame.token)==ZC_OK);
    }
    assert(zc_video_drain_output_io(recorder,0)==ZC_OK);
    assert(zc_video_drain_output_io(recorder,extra_id)==ZC_OK);
    assert(delivered==6 && second_delivered==4 && third_delivered==2);
    zc_output_io_stats io_stats;
    assert(zc_video_output_io_stats(recorder,extra_id,&io_stats)==ZC_OK);
    assert(io_stats.max_bytes==32768 && io_stats.max_ops==8 && !io_stats.queued_ops);
    assert(io_stats.accepted_ops==2 && io_stats.completed_ops==2 && !io_stats.rejected_ops);
    assert(zc_video_output_state(recorder,extra_id,&state)==ZC_OK && state.generation==1 && !state.pending);
    assert(zc_video_set_output_io(recorder,0,32768,8,0)==ZC_STATE);
    zc_output_job *drains[32],*output_overflow=(zc_output_job *)1;
    assert(zc_video_drain_output_async(recorder,999,&output_overflow)==ZC_STATE && output_overflow==NULL);
    for(unsigned i=0;i<32;i++) {
        assert(zc_video_drain_output_async(recorder,0,&drains[i])==ZC_OK);
        assert(zc_output_job_wait(drains[i],0)==ZC_OK);
    }
    assert(zc_video_drain_output_async(recorder,0,&output_overflow)==ZC_BUSY && output_overflow==NULL);
    zc_prepared_output *prepared=NULL,*duplicate=NULL;
    unsigned prepared_delivered=0;
    zc_output_callbacks prepared_callbacks=callbacks;prepared_callbacks.context=&prepared_delivered;
    assert(zc_video_prepare_split(recorder,0,NULL,&prepared_callbacks,&prepared)==ZC_OK);
    assert(zc_video_prepare_split(recorder,0,NULL,&prepared_callbacks,&duplicate)==ZC_BUSY && !duplicate);
    assert(zc_video_close(recorder)==ZC_BUSY); /* Does not consume recorder. */
    assert(zc_video_remove_output(recorder,0)==ZC_BUSY);
    assert(zc_video_set_output_io(recorder,0,32768,8,0)==ZC_BUSY);
    assert(zc_prepared_output_build(prepared)==ZC_OK);
    assert(zc_prepared_output_build(prepared)==ZC_STATE);
    zc_recorder *other_recorder=NULL;
    assert(zc_video_create(&video,&recording,0,&other_recorder)==ZC_OK);
    assert(zc_video_commit_split(other_recorder,prepared)==ZC_STATE);
    assert(zc_video_close(other_recorder)==ZC_OK);
    assert(zc_video_commit_split(recorder,prepared)==ZC_OK);
    assert(zc_video_commit_split(recorder,prepared)==ZC_STATE);
    zc_prepared_output_close(prepared);
    assert(zc_video_prepare_split(recorder,extra_id,"zig-out/abi-prepared.mkv",NULL,&prepared)==ZC_OK);
    assert(zc_prepared_output_build(prepared)==ZC_OK);
    zc_prepared_output_close(prepared); /* Cancels only the recipe. */
    zc_frame prepared_frame;assert(zc_acquire(camera,0,&prepared_frame)==ZC_OK);
    assert(zc_video_write(recorder,&prepared_frame,240000000)==ZC_OK);
    assert(zc_release(camera,prepared_frame.token)==ZC_OK);
    assert(zc_video_drain_output_io(recorder,0)==ZC_OK && prepared_delivered==1);
    zc_factory_config factory={sizeof(zc_factory_config),1,3,0,42,0,1,0,0};
    zc_factory_state factory_state;
    assert(zc_video_set_factory(recorder,0,&factory)==ZC_OK);
    assert(zc_video_factory_state(recorder,0,&factory_state)==ZC_OK);
    assert(factory_state.next_index==42 && !factory_state.pending);
    assert(zc_video_claim_factory(recorder,0,&factory_state)==ZC_OK);
    assert(factory_state.pending && factory_state.ticket && factory_state.index==42);
    assert(zc_video_close(recorder)==ZC_BUSY);
    assert(zc_video_finish_factory(recorder,0,factory_state.ticket+1,ZC_OK)==ZC_STALE);
    assert(zc_video_finish_factory(recorder,0,factory_state.ticket,ZC_IO)==ZC_OK);
    assert(zc_video_factory_state(recorder,0,&factory_state)==ZC_OK);
    assert(!factory_state.pending && factory_state.next_index==43 && factory_state.error_code==ZC_IO);
    assert(zc_video_set_factory(recorder,0,NULL)==ZC_OK);
    zc_frame producer_frame;assert(zc_acquire(camera,0,&producer_frame)==ZC_OK);
    zc_producer_job *producer=NULL;
    assert(zc_video_producer_frame(recorder,&producer_frame,280000000,&producer)==ZC_OK);
    zc_producer_drain *producer_drains[32],*producer_drain_overflow=(zc_producer_drain *)1;
    for(unsigned i=0;i<32;i++) {
        assert(zc_video_producer_drain(recorder,&producer_drains[i])==ZC_OK);
        assert(zc_producer_drain_poll(producer_drains[i])==ZC_TIMEOUT);
    }
    assert(zc_video_producer_drain(recorder,&producer_drain_overflow)==ZC_BUSY && producer_drain_overflow==NULL);
    assert(zc_release(camera,producer_frame.token)==ZC_OK);
    assert(zc_video_close(recorder)==ZC_BUSY);
    assert(zc_producer_job_start(producer)==ZC_OK);
    assert(zc_video_output_state(recorder,0,&state)==ZC_BUSY);
    assert(zc_producer_job_close(producer)==ZC_BUSY);
    int producer_result=ZC_TIMEOUT,producer_status=ZC_TIMEOUT;
    for(unsigned retry=0;retry<10000;retry++) {
        producer_status=zc_producer_job_finish(producer,&producer_result);
        if(producer_status!=ZC_TIMEOUT)break;
        struct timespec pause={0,1000000};nanosleep(&pause,NULL);
    }
    assert(producer_status==ZC_OK && producer_result==ZC_OK);
    assert(zc_producer_job_cancel(producer)==ZC_STATE);
    assert(zc_producer_drain_poll(producer_drains[0])==ZC_TIMEOUT);
    assert(zc_producer_job_close(producer)==ZC_OK);
    zc_producer_stats producer_stats;
    assert(zc_video_producer_stats(recorder,&producer_stats)==ZC_OK);
    assert(producer_stats.completed==1 && !producer_stats.owned_jobs && !producer_stats.running);
    for(unsigned flush=0;flush<3;flush++) {
        zc_producer_job *barrier=NULL;
        assert(zc_video_producer_barrier(recorder,flush?1:0,&barrier)==ZC_OK);
        assert(zc_producer_job_start(barrier)==ZC_OK);
        if(flush) assert(zc_producer_job_cancel(barrier)==ZC_STATE);
        for(unsigned retry=0;retry<10000;retry++) {
            producer_status=zc_producer_job_finish(barrier,&producer_result);
            if(producer_status!=ZC_TIMEOUT)break;
            struct timespec pause={0,1000000};nanosleep(&pause,NULL);
        }
        assert(producer_status==ZC_OK && producer_result==ZC_OK);
        for(unsigned retry=0;retry<10000;retry++) {
            producer_status=zc_producer_job_drain_outputs(barrier);
            if(producer_status!=ZC_TIMEOUT)break;
            struct timespec pause={0,1000000};nanosleep(&pause,NULL);
        }
        assert(producer_status==ZC_OK);
        assert(zc_video_close(recorder)==ZC_BUSY);
        assert(zc_producer_job_close(barrier)==ZC_OK);
    }
    assert(zc_video_producer_frame(recorder,&producer_frame,320000000,&producer)==ZC_STATE && producer==NULL);
    zc_session_state session_state;
    assert(zc_video_session_state(recorder,&session_state)==ZC_OK && session_state.session==0 && session_state.phase==2);
    zc_producer_job *restart=NULL;
    assert(zc_video_producer_restart(recorder,0,NULL,&restart)==ZC_OK);
    zc_video_config session_config=video;
    session_config.quality=65;session_config.fps_num=20;
    assert(zc_producer_job_restart_configure(restart,&session_config,&recording,0)==ZC_OK);
    session_config.width=0;
    assert(zc_producer_job_restart_configure(restart,&session_config,&recording,0)==ZC_INVALID);
    assert(zc_producer_job_start(restart)==ZC_OK);
    uint32_t restart_stage=0;
    for(unsigned retry=0;retry<10000;retry++) {
        assert(zc_producer_job_restart_stage(restart,&restart_stage)==ZC_OK);
        if(restart_stage==2)break;
        struct timespec pause={0,1000000};nanosleep(&pause,NULL);
    }
    assert(restart_stage==2 && zc_producer_job_restart_publish(restart)==ZC_OK);
    assert(zc_producer_job_cancel(restart)==ZC_STATE);
    for(unsigned retry=0;retry<10000;retry++) {
        producer_status=zc_producer_job_finish(restart,&producer_result);
        if(producer_status!=ZC_TIMEOUT)break;
        struct timespec pause={0,1000000};nanosleep(&pause,NULL);
    }
    assert(producer_status==ZC_OK && producer_result==ZC_OK);
    assert(zc_producer_job_close(restart)==ZC_OK);
    assert(zc_video_session_state(recorder,&session_state)==ZC_OK && session_state.session==1 && session_state.phase==0);
    uint32_t session_bitrate=99;
    zc_recording_options session_audio;
    assert(zc_video_session_config(recorder,&session_config,&session_audio,&session_bitrate)==ZC_OK);
    assert(session_config.width==video.width && session_config.fps_num==20 && session_config.quality==65 && session_bitrate==0);
    delivered=0;
    assert(zc_video_open_callbacks(recorder,&callbacks)==ZC_OK);
    assert(zc_acquire(camera,0,&producer_frame)==ZC_OK);
    assert(zc_video_write(recorder,&producer_frame,0)==ZC_OK);
    assert(zc_release(camera,producer_frame.token)==ZC_OK);
    assert(zc_video_close(recorder)==ZC_OK);
    for(unsigned i=0;i<32;i++) {
        assert(zc_producer_drain_poll(producer_drains[i])==ZC_OK);
        zc_producer_drain_close(producer_drains[i]);
    }
    for(unsigned i=0;i<32;i++) {
        assert(zc_output_job_wait(drains[i],0)==ZC_OK);
        zc_output_job_close(drains[i]);
    }
    zc_output_job_close(NULL);
    assert(zc_close(camera)==ZC_OK);
    config.policy=ZC_FIFO;
    assert(zc_open(&config,&camera)==ZC_OK);
    uint64_t capture_clock=0;
    assert(zc_capture_clock_ns(&capture_clock)==ZC_OK);
    assert(zc_start(camera)==ZC_OK);
    zc_capture_filter filter;
    assert(zc_capture_filter_init(&filter,2,0,0)==ZC_OK);
    assert(zc_acquire_filtered(camera,&filter,100,&producer_frame)==ZC_OK);
    assert(producer_frame.sequence==2 && producer_frame.timestamp_ns>=capture_clock);
    assert(zc_capture_filter_accept(camera,producer_frame.token,&filter)==ZC_OK);
    assert(zc_get_frame_metadata(camera,producer_frame.token,&controlled_meta)==ZC_OK);
    assert((controlled_meta.valid&80)==80);
    assert(zc_release(camera,producer_frame.token)==ZC_OK);
    assert(zc_capture_filter_accept(camera,producer_frame.token,&filter)==ZC_STALE);
    assert(zc_close(camera)==ZC_OK);
    assert(zc_open(&config,&camera)==ZC_OK);
    assert(zc_enable_writable(camera)==ZC_OK);
    assert(zc_start(camera)==ZC_OK);
    assert(zc_enable_writable(camera)==ZC_STATE);
    assert(zc_acquire(camera,0,&producer_frame)==ZC_OK);
    zc_frame_map *mapped=NULL;
    assert(zc_frame_map_open(camera,producer_frame.token,ZC_MAIN,1,&mapped)==ZC_OK && mapped);
    assert(zc_frame_readable(camera,producer_frame.token)==ZC_BUSY);
    zc_stream mapped_stream;
    assert(zc_frame_map_stream(mapped,&mapped_stream)==ZC_OK);
    ((uint8_t *)mapped_stream.planes[0].data)[0]=123;
    assert(zc_release(camera,producer_frame.token)==ZC_OK);
    assert(zc_stop(camera)==ZC_OK);
    assert(zc_close(camera)==ZC_BUSY);
    assert(mapped_stream.planes[0].data[0]==123);
    assert(zc_frame_map_close(mapped)==ZC_OK);
    assert(zc_frame_map_close(NULL)==ZC_OK);
    assert(zc_close(camera)==ZC_OK);
    return 0;
}
