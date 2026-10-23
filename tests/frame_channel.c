#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
/* Independent C wire/CMSG interoperability and exec/join ownership. */
#include "zig_camera.h"
#include <assert.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
enum { HEADER=32, LEGACY_PACKET=768, PACKET=952 };
static uint64_t get(const uint8_t *p,size_t n){uint64_t v=0;for(size_t i=0;i<n;i++)v|=(uint64_t)p[i]<<(8*i);return v;}
static void put(uint8_t *p,uint64_t v,size_t n){for(size_t i=0;i<n;i++)p[i]=(uint8_t)(v>>(8*i));}
static uint64_t hash(uint64_t h,const uint8_t *p,size_t n){for(size_t i=0;i<n;i++)h=(h^p[i])*UINT64_C(1099511628211);return h;}
static void ready(int fd){struct pollfd p={fd,POLLIN,0};assert(poll(&p,1,10000)==1);assert(p.revents&POLLIN);}
static int count_fds(void){int count=0;for(int i=0;i<1024;i++)if(fcntl(i,F_GETFD)>=0)count++;return count;}
static void send_c(int fd,const zc_export_info *info,uint64_t cookie,const uint8_t *catalog,uint64_t size,const zc_raw_metadata *calibration,int version){
    FILE *file=tmpfile();assert(file);assert(fcntl(fileno(file),F_SETFD,FD_CLOEXEC)==0);
    assert(fwrite(catalog,1,(size_t)size,file)==size && fflush(file)==0);
    uint8_t bytes[PACKET]={0};memcpy(bytes,"ZCFD",4);put(bytes+4,(uint64_t)version,2);put(bytes+6,1,2);put(bytes+8,sizeof(*info),4);put(bytes+12,info->plane_count+1,4);put(bytes+16,cookie,8);put(bytes+24,size,8);
    zc_export_info wire=*info;for(uint32_t i=0;i<ZC_MAX_EXPORT_PLANES;i++)wire.planes[i].fd=-1;memcpy(bytes+HEADER,&wire,sizeof(wire));if(version==2)memcpy(bytes+LEGACY_PACKET,calibration,sizeof(*calibration));
    union {struct cmsghdr align;char bytes[CMSG_SPACE(sizeof(int)*13)];} control;memset(&control,0,sizeof(control));
    const size_t packet_size=version==2?PACKET:LEGACY_PACKET;struct iovec iov={bytes,packet_size};struct msghdr message;memset(&message,0,sizeof(message));message.msg_iov=&iov;message.msg_iovlen=1;message.msg_control=control.bytes;message.msg_controllen=CMSG_SPACE(sizeof(int)*(info->plane_count+1));
    struct cmsghdr *rights=CMSG_FIRSTHDR(&message);rights->cmsg_level=SOL_SOCKET;rights->cmsg_type=SCM_RIGHTS;rights->cmsg_len=CMSG_LEN(sizeof(int)*(info->plane_count+1));
    int *fds=(int *)(void *)CMSG_DATA(rights);for(uint32_t i=0;i<info->plane_count;i++)fds[i]=info->planes[i].fd;fds[info->plane_count]=fileno(file);
    assert(sendmsg(fd,&message,0)==(ssize_t)packet_size);assert(fclose(file)==0);
}
static int raw_child(uint64_t expected){
    ready(STDIN_FILENO);
    uint8_t bytes[PACKET];union {struct cmsghdr align;char bytes[CMSG_SPACE(sizeof(int)*512)];} control;
    struct iovec iov={bytes,sizeof(bytes)};struct msghdr message;memset(&message,0,sizeof(message));message.msg_iov=&iov;message.msg_iovlen=1;message.msg_control=control.bytes;message.msg_controllen=sizeof(control.bytes);
    assert(recvmsg(STDIN_FILENO,&message,0)==PACKET && !(message.msg_flags&(MSG_TRUNC|MSG_CTRUNC)));
    assert(!memcmp(bytes,"ZCFD",4) && get(bytes+4,2)==2 && get(bytes+6,2)==1 && get(bytes+8,4)==sizeof(zc_export_info));
    zc_raw_metadata calibration;memcpy(&calibration,bytes+LEGACY_PACKET,sizeof(calibration));assert(calibration.valid==7 && memchr(calibration.model,0,sizeof(calibration.model)) && calibration.model[0]);
    zc_export_info info;memcpy(&info,bytes+HEADER,sizeof(info));assert(info.stream_count==3 && info.plane_count<=12);
    struct cmsghdr *rights=CMSG_FIRSTHDR(&message);assert(rights && rights->cmsg_level==SOL_SOCKET && rights->cmsg_type==SCM_RIGHTS && rights->cmsg_len==CMSG_LEN(sizeof(int)*(info.plane_count+1)));
    const int *fds=(const int *)(const void *)CMSG_DATA(rights);uint64_t actual=UINT64_C(1469598103934665603);
    const long page=sysconf(_SC_PAGESIZE);assert(page>0);
    for(uint32_t i=0;i<info.plane_count;i++){
        const zc_export_plane *plane=&info.planes[i];assert(plane->fd==-1 && plane->length && plane->length<=256*1024*1024 && plane->bytes_used<=plane->length);
        const uint64_t start=plane->offset/(uint64_t)page*(uint64_t)page;const size_t delta=(size_t)(plane->offset-start),size=delta+(size_t)plane->length;
        void *base=mmap(NULL,size,PROT_READ|((info.flags&ZC_EXPORT_WRITABLE)?PROT_WRITE:0),MAP_SHARED,fds[i],(off_t)start);assert(base!=MAP_FAILED);
        uint8_t *data=(uint8_t *)base+delta;actual=hash(actual,data,(size_t)plane->bytes_used);if(info.flags&ZC_EXPORT_WRITABLE)data[0]^=0x5a;
        assert(munmap(base,size)==0 && close(fds[i])==0);
    }
    assert(actual==expected);
    const size_t size=(size_t)get(bytes+24,8);assert(size>=16 && size<=4*1024*1024);
    void *metadata=mmap(NULL,size,PROT_READ,MAP_SHARED,fds[info.plane_count],0);assert(metadata!=MAP_FAILED && !memcmp(metadata,"HCAT",4) && get((const uint8_t *)metadata+8,4)==4);
    assert(munmap(metadata,size)==0 && close(fds[info.plane_count])==0);
    uint8_t ack[HEADER]={0};memcpy(ack,"ZCFD",4);put(ack+4,1,2);put(ack+6,2,2);put(ack+16,get(bytes+16,8),8);
    assert(send(STDIN_FILENO,ack,sizeof(ack),0)==HEADER);return 0;
}
static int native_child(uint64_t expected,int abrupt,int version){
    ready(STDIN_FILENO);zc_remote_frame *frame=NULL;uint64_t cookie=0;assert(zc_frame_channel_receive(STDIN_FILENO,&frame,&cookie)==ZC_OK);
    zc_export_info info;assert(zc_remote_frame_info(frame,&info)==ZC_OK && info.stream_count==3);
    uint64_t configuration_size=0;
    assert(zc_remote_frame_configuration_copy(frame,NULL,0,&configuration_size)==ZC_OK && configuration_size>16 && configuration_size<=65536);
    uint8_t *configuration=malloc((size_t)configuration_size);assert(configuration);memset(configuration,42,(size_t)configuration_size);
    uint64_t required=0;assert(zc_remote_frame_configuration_copy(frame,configuration,configuration_size-1,&required)==ZC_INVALID && required==configuration_size);
    for(uint64_t i=0;i<configuration_size;i++)assert(configuration[i]==42);
    assert(zc_remote_frame_configuration_copy(frame,configuration,configuration_size,&required)==ZC_OK && required==configuration_size && !memcmp(configuration,"HCAT",4) && get(configuration+8,4)==ZC_CATALOG_CONFIGURATION);free(configuration);
    zc_raw_metadata calibration;assert(zc_remote_frame_raw_metadata(frame,&calibration)==ZC_OK);assert(calibration.valid==(version==2?7u:0u));
    zc_image_blob *dng=NULL;assert(zc_remote_frame_encode_dng(frame,&dng)==(version==2?ZC_OK:ZC_UNSUPPORTED));if(dng)zc_image_blob_close(dng);else assert(version==1);
    zc_image_options opts;zc_default_image_options(&opts);zc_image_exif exif;zc_default_image_exif(&exif);
    zc_image_blob *image=NULL;assert(zc_remote_frame_encode_image_metadata(frame,ZC_MAIN,&opts,NULL,&exif,&image)==ZC_OK && image);
    uint64_t encoded_size=0;assert(zc_image_blob_copy(image,NULL,0,&encoded_size)==ZC_OK && encoded_size>3);uint8_t *encoded=malloc((size_t)encoded_size);assert(encoded);
    assert(zc_image_blob_copy(image,encoded,encoded_size,&encoded_size)==ZC_OK && encoded[0]==255 && encoded[1]==216);free(encoded);zc_image_blob_close(image);
    opts.quality=0;image=(zc_image_blob *)(uintptr_t)1;assert(zc_remote_frame_encode_image_metadata(frame,ZC_MAIN,&opts,NULL,&exif,&image)==ZC_INVALID && !image);
    uint64_t actual=UINT64_C(1469598103934665603);
    for(uint32_t i=0;i<info.stream_count;i++){
        zc_stream stream;assert(zc_remote_frame_stream(frame,info.streams[i].stream,&stream)==ZC_OK);
        for(uint32_t j=0;j<stream.plane_count;j++){
            const zc_plane *plane=&stream.planes[j];assert(fcntl(plane->fd,F_GETFD)&FD_CLOEXEC);
            actual=hash(actual,plane->data,(size_t)plane->bytes_used);if(info.flags&ZC_EXPORT_WRITABLE)((uint8_t *)(void *)plane->data)[0]^=0x5a;
        }
    }
    assert(actual==expected);
    uint64_t size=0;assert(zc_remote_frame_catalog_copy(frame,NULL,0,&size)==ZC_OK);uint8_t *catalog=malloc((size_t)size);assert(catalog);
    assert(zc_remote_frame_catalog_copy(frame,catalog,size,&size)==ZC_OK && !memcmp(catalog,"HCAT",4));
    zc_image_options async_options;zc_default_image_options(&async_options);async_options.format=ZC_IMAGE_PNG;
    zc_image_job *worker=NULL;assert(zc_remote_frame_encode_async(frame,ZC_MAIN,&async_options,NULL,NULL,NULL,NULL,&worker)==ZC_OK && worker);
    if(abrupt)_exit(0); /* OS retires live maps/fds; sender must waitpid first. */
    assert(zc_remote_frame_close(frame)==ZC_OK && !memcmp(catalog,"HCAT",4));free(catalog);
    assert(zc_frame_channel_ack(STDIN_FILENO,cookie)==ZC_OK);
    zc_image_job_state state;int complete=0;
    for(int attempt=0;attempt<10000;attempt++){assert(zc_image_job_state_get(worker,&state)==ZC_OK);if(state.finished){complete=1;break;}assert(poll(NULL,0,1)==0);}
    assert(complete && state.result==ZC_OK && state.input_bytes>0 && state.working_peak<=128*1024*1024);
    zc_image_blob *png=NULL;assert(zc_image_job_take_blob(worker,&png)==ZC_OK && png);
    uint64_t png_size=0;assert(zc_image_blob_copy(png,NULL,0,&png_size)==ZC_OK && png_size>8);
    uint8_t *png_bytes=malloc((size_t)png_size);assert(png_bytes);assert(zc_image_blob_copy(png,png_bytes,png_size,&png_size)==ZC_OK && !memcmp(png_bytes,"\x89PNG\r\n\x1a\n",8));
    free(png_bytes);zc_image_blob_close(png);assert(zc_image_job_close(worker)==ZC_OK);return 0;
}
static void run(const char *exe,int raw,int writable,int abrupt,int version){
    const int before=count_fds();zc_config cfg;zc_default_config(&cfg);cfg.width=18;cfg.height=10;cfg.raw=1;strcpy(cfg.raw_format,"SRGGB12");
    zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);pipeline.lores_width=10;pipeline.lores_height=6;zc_camera *camera=NULL;
    assert(zc_open_pipeline(&cfg,&pipeline,&camera)==ZC_OK);if(writable)assert(zc_enable_writable(camera)==ZC_OK);assert(zc_start(camera)==ZC_OK);
    zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);zc_stream source[3];uint64_t expected=UINT64_C(1469598103934665603);uint8_t first[12];uint32_t count=0;
    for(uint32_t i=0;i<3;i++){assert(zc_get_stream(camera,frame.token,i,&source[i])==ZC_OK);for(uint32_t j=0;j<source[i].plane_count;j++){const zc_plane *p=&source[i].planes[j];expected=hash(expected,p->data,(size_t)p->bytes_used);first[count++]=p->data[0];}}
    zc_frame_export *loan=NULL;assert(zc_frame_export_open(camera,frame.token,7,writable?1:0,&loan)==ZC_OK);zc_export_info info;assert(zc_frame_export_info(loan,&info)==ZC_OK);zc_raw_metadata calibration;assert(zc_frame_export_raw_metadata(loan,&calibration)==ZC_OK && calibration.valid==7);
    uint64_t size=0;assert(zc_frame_export_catalog_copy(loan,NULL,0,&size)==ZC_OK);uint8_t *catalog=malloc((size_t)size);assert(catalog);assert(zc_frame_export_catalog_copy(loan,catalog,size,&size)==ZC_OK);
    int32_t ends[2];assert(zc_frame_channel_pair(ends)==ZC_OK);char hash_string[32];assert(snprintf(hash_string,sizeof(hash_string),"%llu",(unsigned long long)expected)>0);
    const pid_t child=fork();assert(child>=0);if(child==0){assert(dup2(ends[1],STDIN_FILENO)>=0 && fcntl(STDIN_FILENO,F_SETFD,0)==0);close(ends[0]);if(ends[1]!=STDIN_FILENO)close(ends[1]);execl(exe,exe,raw?"--raw":abrupt?"--abrupt":version==2?"--native2":"--native",hash_string,(char *)NULL);_exit(127);}
    assert(zc_frame_channel_close(ends[1])==ZC_OK);const uint64_t cookie=UINT64_C(9007199254740993);
    if(raw)assert(zc_frame_channel_send(ends[0],loan,cookie)==ZC_OK);else send_c(ends[0],&info,cookie,catalog,size,&calibration,version);
    assert(zc_stop(camera)==ZC_OK && zc_close(camera)==ZC_BUSY);
    if(!abrupt){ready(ends[0]);uint64_t received=0;assert(zc_frame_channel_receive_ack(ends[0],&received)==ZC_OK && received==cookie);}
    int status=0;assert(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    assert(zc_frame_channel_close(ends[0])==ZC_OK && zc_frame_export_close(loan)==ZC_OK);
    count=0;for(uint32_t i=0;i<3;i++)for(uint32_t j=0;j<source[i].plane_count;j++){assert(source[i].planes[j].data[0]==(uint8_t)(first[count]^(writable?0x5a:0)));count++;}
    assert(zc_release(camera,frame.token)==ZC_OK && zc_close(camera)==ZC_OK);free(catalog);assert(count_fds()==before);
}
static void legacy_configuration_absent(void){
    const int before=count_fds();zc_config cfg;zc_default_config(&cfg);cfg.width=2;cfg.height=2;
    zc_camera *camera=NULL;assert(zc_open(&cfg,&camera)==ZC_OK && zc_start(camera)==ZC_OK);
    zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
    zc_frame_export *loan=NULL;assert(zc_frame_export_open(camera,frame.token,1,0,&loan)==ZC_OK);
    zc_export_info info;assert(zc_frame_export_info(loan,&info)==ZC_OK);
    uint8_t catalog[16]={0};memcpy(catalog,"HCAT",4);put(catalog+4,1,4);put(catalog+8,4,4);
    int32_t ends[2];assert(zc_frame_channel_pair(ends)==ZC_OK);
    send_c(ends[0],&info,99,catalog,sizeof(catalog),NULL,1);
    zc_remote_frame *remote=NULL;uint64_t cookie=0;assert(zc_frame_channel_receive(ends[1],&remote,&cookie)==ZC_OK && cookie==99);
    uint64_t size=999;uint8_t output[32];memset(output,42,sizeof(output));
    assert(zc_remote_frame_configuration_copy(remote,output,sizeof(output),&size)==ZC_UNSUPPORTED && size==0);
    for(size_t i=0;i<sizeof(output);i++)assert(output[i]==42);
    assert(zc_remote_frame_copy_rgb(remote,ZC_MAIN,8,NULL,0,&size)==ZC_OK && size==12);
    assert(zc_remote_frame_catalog_copy(remote,output,sizeof(output),&size)==ZC_OK && size==16 && !memcmp(output,catalog,16));
    assert(zc_remote_frame_close(remote)==ZC_OK && zc_frame_channel_ack(ends[1],99)==ZC_OK);
    assert(zc_frame_channel_receive_ack(ends[0],&cookie)==ZC_OK && cookie==99);
    assert(zc_frame_channel_close(ends[0])==ZC_OK && zc_frame_channel_close(ends[1])==ZC_OK);
    assert(zc_frame_export_close(loan)==ZC_OK && zc_release(camera,frame.token)==ZC_OK && zc_close(camera)==ZC_OK);
    assert(count_fds()==before);
}
int main(int argc,char **argv){
    _Static_assert(sizeof(zc_export_info)==736,"local wire ABI");
    _Static_assert(sizeof(zc_raw_metadata)==184,"calibration wire ABI");
    if(argc==3){const uint64_t expected=(uint64_t)strtoull(argv[2],NULL,10);if(!strcmp(argv[1],"--raw"))return raw_child(expected);return native_child(expected,!strcmp(argv[1],"--abrupt"),!strcmp(argv[1],"--native2")?2:1);}
    const int before=count_fds();int32_t output=123;
    int udp=socket(AF_INET,SOCK_DGRAM,0);assert(udp>=0);assert(zc_frame_channel_duplicate(udp,&output)==ZC_INVALID && output==-1 && fcntl(udp,F_GETFD)>=0);close(udp);
    int stream[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,stream)==0);assert(zc_frame_channel_duplicate(stream[0],&output)==ZC_INVALID && output==-1);close(stream[0]);close(stream[1]);assert(count_fds()==before);
    run(argv[0],1,0,0,2);run(argv[0],1,1,0,2);run(argv[0],0,0,0,1);run(argv[0],0,1,0,1);run(argv[0],0,0,0,2);run(argv[0],0,1,0,2);run(argv[0],0,1,1,1);
    legacy_configuration_absent();
    puts("C/Zig descriptor wire interoperates across exec, owns metadata/maps, and joins ACK or peer exit before export retirement");return 0;
}
