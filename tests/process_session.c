#define _POSIX_C_SOURCE 200809L
#include "zig_camera.h"
#include <assert.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
_Static_assert(sizeof(zc_process_state)==56 && sizeof(zc_process_worker_state)==32,"process state ABI");
static void ready(int fd){struct pollfd p={fd,POLLIN,0};assert(poll(&p,1,10000)==1 && (p.revents&POLLIN));}
static int fd_count(void){int n=0;for(int fd=0;fd<1024;fd++)if(fcntl(fd,F_GETFD)>=0)n++;return n;}
static int child(int abrupt){
    ready(STDIN_FILENO);zc_remote_frame *frame=NULL;uint64_t cookie=0;
    assert(zc_frame_channel_receive(STDIN_FILENO,&frame,&cookie)==ZC_OK);
    zc_stream stream;assert(zc_remote_frame_stream(frame,ZC_MAIN,&stream)==ZC_OK);
    ((uint8_t *)(void *)stream.planes[0].data)[0]=83;
    assert(signal(SIGTERM,SIG_IGN)!=SIG_ERR);
    assert(write(STDOUT_FILENO,"R",1)==1);
    if(abrupt)for(;;)pause();
    assert(zc_remote_frame_close(frame)==ZC_OK);
    assert(zc_frame_channel_ack(STDIN_FILENO,cookie)==ZC_OK);
    return 0;
}
static void run(const char *exe,int abrupt){
    const int before=fd_count();
    zc_config cfg;zc_default_config(&cfg);cfg.width=4;cfg.height=2;
    zc_camera *camera=NULL;assert(zc_open(&cfg,&camera)==ZC_OK && zc_enable_writable(camera)==ZC_OK && zc_start(camera)==ZC_OK);
    zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
    zc_frame_export *loan=NULL;assert(zc_frame_export_open(camera,frame.token,1,ZC_EXPORT_WRITABLE,&loan)==ZC_OK);
    zc_process_session *session=NULL;assert(zc_process_open(1,1,8,&session)==ZC_OK);
    assert(zc_process_can_submit(session,4,0)==ZC_OK && zc_process_can_submit(session,4,8)==ZC_INVALID);
    uint64_t cookie=1,generation=1;uint32_t worker=1;
    assert(zc_process_submit(session,loan,(const uint8_t *)"123456789",9,0,&cookie,&worker,&generation)==ZC_INVALID && cookie==0);
    zc_export_info info;assert(zc_frame_export_info(loan,&info)==ZC_OK);
    uint8_t args[4]={'d','a','t','a'};assert(zc_process_submit(session,loan,args,4,0,&cookie,&worker,&generation)==ZC_OK && cookie==1 && worker==0 && generation==1);loan=NULL;args[0]='X';
    assert(zc_process_can_submit(session,0,0)==ZC_BUSY);
    uint64_t length=0;uint8_t copied[4]={99,99,99,99};assert(zc_process_payload_copy(session,cookie,copied,1,&length)==ZC_INVALID && copied[0]==99);
    assert(zc_process_payload_copy(session,cookie,copied,4,&length)==ZC_OK && length==4 && !memcmp(copied,"data",4));
    int32_t ends[2];assert(zc_frame_channel_pair(ends)==ZC_OK);int notification[2];assert(pipe(notification)==0);
    assert(fcntl(notification[0],F_SETFD,FD_CLOEXEC)==0 && fcntl(notification[1],F_SETFD,FD_CLOEXEC)==0);
    const pid_t pid=fork();assert(pid>=0);
    if(pid==0){assert(dup2(ends[1],STDIN_FILENO)>=0 && dup2(notification[1],STDOUT_FILENO)>=0);close(ends[0]);close(ends[1]);close(notification[0]);close(notification[1]);execl(exe,exe,abrupt?"--abrupt":"--ack",(char *)NULL);_exit(127);}
    assert(zc_frame_channel_close(ends[1])==ZC_OK && close(notification[1])==0);
    assert(zc_process_send(session,cookie,ends[0])==ZC_OK);
    ready(notification[0]);char byte=0;assert(read(notification[0],&byte,1)==1 && byte=='R');close(notification[0]);
    assert(zc_process_retire(session,cookie)==ZC_BUSY && zc_process_release(session,cookie)==ZC_INVALID);
    assert(zc_process_stop_worker(session,0,1)==ZC_OK && zc_process_retire(session,cookie)==ZC_BUSY);
    uint8_t rgb[24];assert(zc_copy_frame_rgb(camera,frame.token,rgb,sizeof(rgb))==ZC_BUSY);
    int status=0;
    if(abrupt){
        assert(kill(pid,SIGTERM)==0 && zc_process_retire(session,cookie)==ZC_BUSY);
        assert(kill(pid,SIGKILL)==0 && waitpid(pid,&status,0)==pid && WIFSIGNALED(status));
        assert(zc_process_worker_joined(session,0,1)==ZC_OK);
    }else{
        ready(ends[0]);uint64_t ack=0;assert(zc_process_receive_ack(session,0,1,ends[0],&ack)==ZC_OK && ack==cookie);
        assert(waitpid(pid,&status,0)==pid && WIFEXITED(status) && WEXITSTATUS(status)==0);
    }
    assert(zc_process_retire(session,cookie)==ZC_OK && zc_copy_frame_rgb(camera,frame.token,rgb,sizeof(rgb))==ZC_OK && rgb[0]==83);
    uint32_t pending=0;assert(zc_process_pending_through(session,cookie,&pending)==ZC_OK && pending==1);
    zc_process_state state;assert(zc_process_get_state(session,&state)==ZC_OK && state.pending==1 && state.retired==1 && state.bytes==4);
    assert(zc_process_close(session)==ZC_BUSY && zc_process_release(session,cookie)==ZC_OK);
    assert(zc_process_pending_through(session,cookie,&pending)==ZC_OK && pending==0);
    if(!abrupt)assert(zc_process_worker_joined(session,0,1)==ZC_OK);
    uint64_t next=0;assert(zc_process_restart_worker(session,0,1,&next)==ZC_OK && next==2);
    assert(zc_process_worker_joined(session,0,1)==ZC_STALE && zc_process_worker_joined(session,0,2)==ZC_OK);
    assert(zc_process_close(session)==ZC_OK && zc_frame_channel_close(ends[0])==ZC_OK);
    assert(zc_release(camera,frame.token)==ZC_OK && zc_stop(camera)==ZC_OK && zc_close(camera)==ZC_OK);
    assert(fd_count()==before);
}
int main(int argc,char **argv){if(argc==2)return child(!strcmp(argv[1],"--abrupt"));run(argv[0],0);run(argv[0],1);puts("native process tasks retain camera ownership until ACK or verified exec peer exit and callback release");return 0;}
