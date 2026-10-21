#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
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
int main(void) {
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
