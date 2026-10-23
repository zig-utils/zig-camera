#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
/* Independent exec'd process and SCM_RIGHTS integration. Test transport only;
 * production child supervision/ACK routing is a separate layer. */
#include "zig_camera.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
_Static_assert(sizeof(zc_export_info)==736 && offsetof(zc_export_info,planes)==352,"pointer-free export ABI");
_Static_assert(sizeof(zc_export_plane)==32 && sizeof(zc_export_stream)==56,"export entries ABI");
typedef struct {zc_export_info info;uint64_t hashes[ZC_MAX_EXPORT_PLANES];uint32_t truncate;} packet;
static void write_all(int fd,const void *p,size_t size){const char *s=p;while(size){ssize_t n=write(fd,s,size);if(n<0&&errno==EINTR)continue;assert(n>0);s+=n;size-=(size_t)n;}}
static void read_all(int fd,void *p,size_t size){char *s=p;while(size){ssize_t n=read(fd,s,size);if(n<0&&errno==EINTR)continue;assert(n>0);s+=n;size-=(size_t)n;}}
static uint64_t hash(const uint8_t *p,size_t n){uint64_t h=UINT64_C(1469598103934665603);for(size_t i=0;i<n;i++)h=(h^p[i])*UINT64_C(1099511628211);return h;}
static void send_packet(int fd,const packet *p){
    union {struct cmsghdr alignment;char bytes[CMSG_SPACE(sizeof(int)*ZC_MAX_EXPORT_PLANES)];} control;
    memset(&control,0,sizeof(control));
    struct iovec iov={(void *)p,1};struct msghdr msg;memset(&msg,0,sizeof(msg));
    msg.msg_iov=&iov;msg.msg_iovlen=1;msg.msg_control=control.bytes;msg.msg_controllen=CMSG_SPACE(sizeof(int)*p->info.plane_count);
    struct cmsghdr *rights=CMSG_FIRSTHDR(&msg);rights->cmsg_level=SOL_SOCKET;rights->cmsg_type=SCM_RIGHTS;rights->cmsg_len=CMSG_LEN(sizeof(int)*p->info.plane_count);
    int *fds=(int *)(void *)CMSG_DATA(rights);
    for(uint32_t i=0;i<p->info.plane_count;i++){fds[i]=p->info.planes[i].fd;assert(fcntl(fds[i],F_GETFD)&FD_CLOEXEC);}
    ssize_t n;do{n=sendmsg(fd,&msg,0);}while(n<0&&errno==EINTR);assert(n==1);
    write_all(fd,(const char *)p+1,sizeof(*p)-1);
}
static int child(void){
    packet p;memset(&p,0,sizeof(p));
    union {struct cmsghdr alignment;char bytes[CMSG_SPACE(sizeof(int)*ZC_MAX_EXPORT_PLANES)];} control;
    struct iovec iov={&p,1};struct msghdr msg;memset(&msg,0,sizeof(msg));
    msg.msg_iov=&iov;msg.msg_iovlen=1;msg.msg_control=control.bytes;msg.msg_controllen=sizeof(control);
    ssize_t n;do{n=recvmsg(STDIN_FILENO,&msg,0);}while(n<0&&errno==EINTR);assert(n==1 && !(msg.msg_flags&MSG_CTRUNC));
    read_all(STDIN_FILENO,(char *)&p+1,sizeof(p)-1);
    assert(p.info.struct_size==sizeof(p.info) && p.info.stream_count==3 && p.info.plane_count<=ZC_MAX_EXPORT_PLANES);
    struct cmsghdr *rights=CMSG_FIRSTHDR(&msg);assert(rights && rights->cmsg_level==SOL_SOCKET && rights->cmsg_type==SCM_RIGHTS && rights->cmsg_len==CMSG_LEN(sizeof(int)*p.info.plane_count));
    const int *fds=(const int *)(const void *)CMSG_DATA(rights);
    const long page=sysconf(_SC_PAGESIZE);assert(page>0);
    int truncated=0;
    for(uint32_t i=0;i<p.info.plane_count;i++){
        const zc_export_plane *plane=&p.info.planes[i];
        assert(plane->length>0 && plane->length<=256*1024*1024 && plane->bytes_used<=plane->length);
        assert(fcntl(fds[i],F_SETFD,FD_CLOEXEC)==0);
        const uint64_t offset=plane->offset/(uint64_t)page*(uint64_t)page;
        const size_t delta=(size_t)(plane->offset-offset),size=delta+(size_t)plane->length;
        const int writable=!!(p.info.flags&ZC_EXPORT_WRITABLE);
        void *base=mmap(NULL,size,PROT_READ|(writable?PROT_WRITE:0),MAP_SHARED,fds[i],(off_t)offset);assert(base!=MAP_FAILED);
        uint8_t *bytes=(uint8_t *)base+delta;
        assert(hash(bytes,(size_t)plane->bytes_used)==p.hashes[i]);
        if(writable && plane->bytes_used)bytes[0]^=0x5a;
        assert(munmap(base,size)==0);
        if(p.truncate && i+1==p.info.plane_count)truncated=ftruncate(fds[i],0)==0;
        assert(close(fds[i])==0);
    }
#ifdef __linux__
    if(p.truncate)assert(truncated); /* Linux must exercise failed writeback. */
#endif
    write_all(STDIN_FILENO,truncated?"T":"A",1);
    return 0;
}
static void run(const char *exe,int writable){
    zc_config cfg;zc_default_config(&cfg);cfg.width=18;cfg.height=10;cfg.raw=1;strcpy(cfg.raw_format,"SRGGB12");
    zc_pipeline_options pipeline;zc_default_pipeline_options(&pipeline);pipeline.lores_width=10;pipeline.lores_height=6;
    zc_camera *camera=NULL;assert(zc_open_pipeline(&cfg,&pipeline,&camera)==ZC_OK);
    if(writable)assert(zc_enable_writable(camera)==ZC_OK);
    assert(zc_start(camera)==ZC_OK);
    zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
    zc_stream streams[3];packet p;memset(&p,0,sizeof(p));p.truncate=writable==2;uint32_t count=0;
    uint8_t first[ZC_MAX_EXPORT_PLANES];
    for(uint32_t s=0;s<3;s++){
        assert(zc_get_stream(camera,frame.token,s,&streams[s])==ZC_OK);
        for(uint32_t j=0;j<streams[s].plane_count;j++){
            const zc_plane *plane=&streams[s].planes[j];
            p.hashes[count]=hash(plane->data,(size_t)plane->bytes_used);first[count]=plane->data[0];count++;
        }
    }
    zc_frame_export *loan=NULL;assert(zc_frame_export_open(camera,frame.token,7,writable?ZC_EXPORT_WRITABLE:0,&loan)==ZC_OK);
    assert(zc_frame_export_info(loan,&p.info)==ZC_OK);
    assert(p.info.plane_count==count && p.info.metadata.sequence==frame.sequence && (p.info.flags&ZC_EXPORT_STAGED));
    uint64_t size=0;assert(zc_frame_export_catalog_copy(loan,NULL,0,&size)==ZC_OK && size>32);
    uint8_t *catalog=malloc((size_t)size);assert(catalog);
    assert(zc_frame_export_catalog_copy(loan,catalog,size,&size)==ZC_OK);
    if(!writable){assert(zc_release(camera,frame.token)==ZC_OK);assert(zc_stop(camera)==ZC_OK);assert(zc_close(camera)==ZC_BUSY);}
    else{uint8_t out[540];assert(zc_copy_frame_rgb(camera,frame.token,out,sizeof(out))==ZC_BUSY);}
    int socket[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,socket)==0);
    assert(fcntl(socket[0],F_SETFD,FD_CLOEXEC)==0 && fcntl(socket[1],F_SETFD,FD_CLOEXEC)==0);
    const pid_t pid=fork();assert(pid>=0);
    if(pid==0){assert(dup2(socket[1],STDIN_FILENO)>=0);assert(fcntl(STDIN_FILENO,F_SETFD,0)==0);close(socket[0]);if(socket[1]!=STDIN_FILENO)close(socket[1]);execl(exe,exe,"--child",(char *)NULL);_exit(127);}
    close(socket[1]);send_packet(socket[0],&p);
    char ack=0;read_all(socket[0],&ack,1);assert(ack=='A'||ack=='T');
    int status=0;assert(waitpid(pid,&status,0)==pid && WIFEXITED(status) && WEXITSTATUS(status)==0);close(socket[0]);
    uint8_t *again=malloc((size_t)size);assert(again);assert(zc_frame_export_catalog_copy(loan,again,size,&size)==ZC_OK && !memcmp(catalog,again,(size_t)size));free(again);
    assert(zc_frame_export_close(loan)==(ack=='T'?ZC_IO:ZC_OK));
    for(uint32_t i=0;i<count;i++)assert(fcntl(p.info.planes[i].fd,F_GETFD)<0);
    if(writable){uint32_t at=0;for(uint32_t s=0;s<3;s++)for(uint32_t j=0;j<streams[s].plane_count;j++){assert(streams[s].planes[j].data[0]==(uint8_t)(first[at]^(ack=='T'?0:0x5a)));at++;}assert(zc_release(camera,frame.token)==ZC_OK);assert(zc_stop(camera)==ZC_OK);}
    assert(zc_close(camera)==ZC_OK);free(catalog);
}
int main(int argc,char **argv){if(argc==2 && !strcmp(argv[1],"--child"))return child();run(argv[0],0);run(argv[0],1);run(argv[0],2);puts("independent exec/SCM_RIGHTS read/write/truncation exports preserve metadata and retire after child acknowledgement/exit");return 0;}
