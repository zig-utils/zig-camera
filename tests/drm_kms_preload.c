/* Independent Linux UAPI peer. Only one exact fixture path is virtualized;
 * all other opens/closes/ioctls use real syscalls. No physical display needed. */
#define _GNU_SOURCE
#include <sys/syscall.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>
#include <assert.h>
#include <drm.h>
#include <drm_mode.h>
static _Atomic int owned=-1;
static int scenario;
static pthread_mutex_t peer_mutex=PTHREAD_MUTEX_INITIALIZER;
static uint32_t opened,closed,queries,unexpected,flag_errors,resource_calls;
static int ids(uint64_t,uint32_t,uint32_t *,const uint32_t *,uint32_t);
static int fixture_open(int,mode_t);
#include "drm_preview_peer.h"
void zkms_test_scenario(int value) { pthread_mutex_lock(&peer_mutex);assert(atomic_load(&owned)==-1);scenario=value;opened=closed=queries=unexpected=flag_errors=resource_calls=0;preview_reset();pthread_mutex_unlock(&peer_mutex); }
void zkms_test_counts(uint32_t *out) { pthread_mutex_lock(&peer_mutex);out[0]=opened;out[1]=closed;out[2]=queries;out[3]=unexpected;out[4]=flag_errors;pthread_mutex_unlock(&peer_mutex); }
int open(const char *path,int flags,...) {
    mode_t mode=0;
    if((flags&O_CREAT)||((flags&O_TMPFILE)==O_TMPFILE)){va_list ap;va_start(ap,flags);mode=va_arg(ap,mode_t);va_end(ap);}
    if(strcmp(path,"/dev/zig-camera-kms-fixture"))return (int)syscall(SYS_openat,AT_FDCWD,path,flags,mode);
    pthread_mutex_lock(&peer_mutex);
    const int fd=fixture_open(flags,mode);
    pthread_mutex_unlock(&peer_mutex);
    return fd;
}
static int fixture_open(int flags,mode_t mode) {
    if((flags&O_ACCMODE)!=(scenario>=10?O_RDWR:O_RDONLY) || !(flags&O_CLOEXEC) || !(flags&O_NONBLOCK)){flag_errors++;errno=EPERM;return -1;}
    /* Completion events travel through an actual readable FD. Some hosts bind
     * read/poll themselves, so interposing those functions is not a sound peer. */
    int pair[2]={-1,-1};
    if(scenario>=10 && syscall(SYS_socketpair,AF_UNIX,SOCK_SEQPACKET|SOCK_NONBLOCK|SOCK_CLOEXEC,0,pair)<0)return -1;
    const int fd=scenario>=10?pair[0]:(int)syscall(SYS_openat,AT_FDCWD,"/dev/null",flags,mode);
    if(fd<0)return fd;
    int expected=-1;
    if(!atomic_compare_exchange_strong(&owned,&expected,fd)){syscall(SYS_close,fd);if(pair[1]>=0)syscall(SYS_close,pair[1]);errno=EBUSY;return -1;}
    if(scenario>=10)event_writer=pair[1];
    opened++;return fd;
}
int close(int fd) {
    if(fd<0)return (int)syscall(SYS_close,fd);
    if(atomic_load(&owned)!=fd){pthread_mutex_lock(&peer_mutex);int handled=0;const int result=cpu_close(fd,&handled);pthread_mutex_unlock(&peer_mutex);return handled?result:(int)syscall(SYS_close,fd);}
    pthread_mutex_lock(&peer_mutex);
    int expected=fd;
    if(fd>=0 && atomic_compare_exchange_strong(&owned,&expected,-1)){
        closed++;
        if(scenario>=10){
            int pending=0;
            if(syscall(SYS_ioctl,fd,FIONREAD,&pending)<0 || pending || plane_values[0] || (image_ever&&!retired_proof))peer_bad(__func__,__LINE__);
            if(event_writer>=0){(void)syscall(SYS_close,event_writer);event_writer=-1;}
            cpu_card_closed();
            held_valid=0; /* A proved detach supersedes any withheld old event. */
        }
        if(preview_fault==16){preview_fault=0;(void)syscall(SYS_close,fd);pthread_mutex_unlock(&peer_mutex);errno=EIO;return -1;}
    }
    const int result=(int)syscall(SYS_close,fd);
    pthread_mutex_unlock(&peer_mutex);
    return result;
}
static int ids(uint64_t pointer,uint32_t capacity,uint32_t *count,const uint32_t *values,uint32_t length){
    *count=length;if(capacity<length)return 0;
    memcpy((void *)(uintptr_t)pointer,values,length*sizeof(*values));return 0;
}
static int fixture_ioctl(unsigned long request,void *arg) {
    queries++;
    const int preview=preview_ioctl(request,arg);if(preview!=-2)return preview;
    if(request==DRM_IOCTL_SET_CLIENT_CAP){
        struct drm_set_client_cap *v=arg;
        if(v->value!=1 || (v->capability!=DRM_CLIENT_CAP_ATOMIC && v->capability!=DRM_CLIENT_CAP_UNIVERSAL_PLANES)){unexpected++;errno=EPERM;return -1;}
        if(scenario==2 && v->capability==DRM_CLIENT_CAP_ATOMIC){errno=EOPNOTSUPP;return -1;}return 0;
    }
    if(request==DRM_IOCTL_MODE_GETRESOURCES){
        struct drm_mode_card_res *v=arg;resource_calls++;
        const uint32_t crtcs[]={10,11},connectors[]={20,(scenario==1 && resource_calls==2)?22:21},encoders[]={30,31};
        ids(v->crtc_id_ptr,v->count_crtcs,&v->count_crtcs,crtcs,2);
        ids(v->connector_id_ptr,v->count_connectors,&v->count_connectors,connectors,2);
        ids(v->encoder_id_ptr,v->count_encoders,&v->count_encoders,encoders,2);v->count_fbs=0;return 0;
    }
    if(request==DRM_IOCTL_MODE_GETENCODER){struct drm_mode_get_encoder *v=arg;v->crtc_id=v->encoder_id==30?10:0;v->possible_crtcs=v->encoder_id==30?1:2;return 0;}
    if(request==DRM_IOCTL_MODE_GETCRTC){struct drm_mode_crtc *v=arg;v->mode_valid=v->crtc_id==10;v->mode.hdisplay=1920;v->mode.vdisplay=1080;return 0;}
    if(request==DRM_IOCTL_MODE_GETPLANERESOURCES){struct drm_mode_get_plane_res *v=arg;const uint32_t values[]={40,41,42};return ids(v->plane_id_ptr,v->count_planes,&v->count_planes,values,3);}
    if(request==DRM_IOCTL_MODE_GETPLANE){
        struct drm_mode_get_plane *v=arg;
        if(scenario==4 && v->plane_id==41){errno=EIO;return -1;}
        const uint32_t a[]={0x34325258,0x3231564e},b[]={0x34324752},both[]={0x3231564e,0xdeadbeef};
        v->possible_crtcs=v->plane_id==40?1:v->plane_id==41?2:3;
        return ids(v->format_type_ptr,v->count_format_types,&v->count_format_types,v->plane_id==40?a:v->plane_id==41?b:both,v->plane_id==41?1:2);
    }
    if(request==DRM_IOCTL_MODE_GETCONNECTOR){
        struct drm_mode_get_connector *v=arg;const int first=v->connector_id==20;
        v->connector_type=DRM_MODE_CONNECTOR_HDMIA;v->connector_type_id=first?1:2;v->connection=first?1:2;v->encoder_id=first?30:0;v->mm_width=600;v->mm_height=340;
        const uint32_t encoder[]={first?30:(scenario==5?999:31)};
        ids(v->encoders_ptr,v->count_encoders,&v->count_encoders,encoder,1);
        const uint32_t capacity=v->count_modes;
        v->count_modes=(scenario==3 && !first)?129:2;
        if(capacity>=v->count_modes){struct drm_mode_modeinfo *modes=(void *)(uintptr_t)v->modes_ptr;memset(modes,0,2*sizeof(*modes));modes[0].hdisplay=800;modes[0].vdisplay=600;modes[1].hdisplay=1280;modes[1].vdisplay=720;modes[1].type=DRM_MODE_TYPE_PREFERRED;}
        return 0;
    }
    unexpected++;errno=EPERM;return -1;
}

int ioctl(int fd,unsigned long request,...) {
    void *arg=NULL;
    if(request!=FIOCLEX && request!=FIONCLEX){va_list ap;va_start(ap,request);arg=va_arg(ap,void *);va_end(ap);}
    pthread_mutex_lock(&peer_mutex);int cpu_handled=0;const int cpu_result=cpu_ioctl(fd,request,arg,&cpu_handled);pthread_mutex_unlock(&peer_mutex);if(cpu_handled)return cpu_result;
    const int current=atomic_load(&owned);
    if(current<0 || fd!=current)return (int)syscall(SYS_ioctl,fd,request,arg);
    pthread_mutex_lock(&peer_mutex);
    const int result=fixture_ioctl(request,arg);
    pthread_mutex_unlock(&peer_mutex);
    return result;
}
