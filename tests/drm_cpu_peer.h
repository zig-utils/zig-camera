/* Independent CPU-scanout peer. Actual memfd mappings carry pixel data;
 * only the driver allocation/export/sync lifecycle is virtualized. */
struct cpu_buffer {uint32_t handle,width,height,pitch;uint64_t size;int backing,exported,alive,access;uint32_t writes;};
static struct cpu_buffer cpu_buffers[8];
static uint32_t cpu_fb_handles[8],cpu_created,cpu_destroyed,cpu_exports,cpu_closes,cpu_starts,cpu_ends,cpu_next;
struct cpu_sync {uint64_t flags;};
#define CPU_SYNC_IOCTL _IOW('b',0,struct cpu_sync)
static int cpu_index(uint32_t handle){for(unsigned i=0;i<8;i++)if(cpu_buffers[i].handle==handle)return (int)i;return -1;}
static int cpu_fd_index(int fd){for(unsigned i=0;i<8;i++)if(cpu_buffers[i].handle&&cpu_buffers[i].exported==fd)return (int)i;return -1;}
static void cpu_maybe_free(unsigned i){struct cpu_buffer *b=&cpu_buffers[i];if(!b->alive&&b->exported<0){(void)syscall(SYS_close,b->backing);memset(b,0,sizeof(*b));b->backing=b->exported=-1;}}
static void cpu_reset(void){
    for(unsigned i=0;i<8;i++){assert(!cpu_buffers[i].handle);cpu_buffers[i].backing=cpu_buffers[i].exported=-1;}
    memset(cpu_fb_handles,0,sizeof(cpu_fb_handles));cpu_created=cpu_destroyed=cpu_exports=cpu_closes=cpu_starts=cpu_ends=cpu_next=0;
}
static int cpu_close(int fd,int *handled){
    const int i=cpu_fd_index(fd);if(i<0){*handled=0;return 0;}*handled=1;
    struct cpu_buffer *b=&cpu_buffers[i];
    if(b->access)peer_bad(__func__,__LINE__);
    b->exported=-1;cpu_closes++;const int code=(int)syscall(SYS_close,fd);cpu_maybe_free((unsigned)i);
    if(preview_fault==26){preview_fault=0;errno=EIO;return -1;}return code;
}
static void cpu_card_closed(void){
    for(unsigned i=0;i<8;i++)if(cpu_buffers[i].handle&&cpu_buffers[i].alive){cpu_buffers[i].alive=0;cpu_destroyed++;cpu_maybe_free(i);}
    memset(fbs,0,sizeof(fbs));memset(cpu_fb_handles,0,sizeof(cpu_fb_handles));fb_count=0;
}
static int cpu_ioctl(int fd,unsigned long request,void *arg,int *handled){
    const int i=cpu_fd_index(fd);if(i<0){*handled=0;return 0;}*handled=1;
    struct cpu_buffer *b=&cpu_buffers[i];struct cpu_sync *v=arg;
    if(request!=CPU_SYNC_IOCTL||!v||(v->flags!=2&&v->flags!=6)){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
    if(v->flags==2){
        if(preview_fault==24){preview_fault=0;errno=EIO;return -1;}
        if(b->access){peer_bad(__func__,__LINE__);errno=EBUSY;return -1;}b->access=1;cpu_starts++;
    }else{
        if(preview_fault==25||preview_fault==30){if(preview_fault==25)preview_fault=0;errno=EIO;return -1;}
        if(!b->access){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}b->access=0;b->writes++;cpu_ends++;
    }
    return 0;
}
static int cpu_driver_ioctl(unsigned long request,void *arg){
    if(request==DRM_IOCTL_GET_CAP){struct drm_get_cap *v=arg;if(v->capability==DRM_CAP_DUMB_BUFFER){v->value=preview_fault==20?0:1;return 0;}if(v->capability==DRM_CAP_PRIME){v->value=preview_fault==31?0:DRM_PRIME_CAP_EXPORT;return 0;}peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
    if(request==DRM_IOCTL_MODE_CREATE_DUMB){
        struct drm_mode_create_dumb *v=arg;
        if(preview_fault==29){preview_fault=0;errno=ENOMEM;return -1;}
        if(!v->width||!v->height||v->bpp!=32||v->flags){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
        unsigned i;for(i=0;i<8;i++)if(!cpu_buffers[i].handle)break;
        if(i==8){errno=ENOMEM;return -1;}
        const int fd=(int)syscall(SYS_memfd_create,"kms-cpu-peer",1U);if(fd<0)return -1;
        const uint32_t pitch=(v->width*4+63)&~63U;const uint64_t size=(uint64_t)pitch*v->height;
        if(syscall(SYS_ftruncate,fd,size)<0){(void)syscall(SYS_close,fd);return -1;}
        uint8_t seed[64];memset(seed,0xa7,sizeof(seed));for(uint64_t at=0;at<size;at+=sizeof(seed))if(syscall(SYS_pwrite64,fd,seed,sizeof(seed),at)!=(ssize_t)sizeof(seed)){(void)syscall(SYS_close,fd);errno=EIO;return -1;}
        cpu_buffers[i]=(struct cpu_buffer){.handle=1000+(++cpu_next),.width=v->width,.height=v->height,.pitch=pitch,.size=size,.backing=fd,.exported=-1,.alive=1};
        cpu_created++;v->handle=cpu_buffers[i].handle;v->pitch=pitch;v->size=size;
        if(preview_fault==21){preview_fault=0;v->pitch=1;}if(preview_fault==22){preview_fault=0;v->size=1;}
        return 0;
    }
    if(request==DRM_IOCTL_PRIME_HANDLE_TO_FD){
        struct drm_prime_handle *v=arg;const int i=cpu_index(v->handle);
        if(preview_fault==23){preview_fault=0;errno=EIO;return -1;}
        if(i<0||!cpu_buffers[i].alive||v->flags!=(DRM_CLOEXEC|DRM_RDWR)||cpu_buffers[i].exported>=0){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
        const int fd=preview_fault==32?(int)syscall(SYS_openat,AT_FDCWD,"/dev/null",O_PATH|O_CLOEXEC,0):(int)syscall(SYS_fcntl,cpu_buffers[i].backing,F_DUPFD_CLOEXEC,0);if(fd<0)return -1;
        cpu_buffers[i].exported=fd;v->fd=fd;cpu_exports++;return 0;
    }
    if(request==DRM_IOCTL_MODE_DESTROY_DUMB){
        const uint32_t handle=((struct drm_mode_destroy_dumb *)arg)->handle;const int i=cpu_index(handle);
        if(preview_fault==27){preview_fault=0;errno=EIO;return -1;}
        if(i<0||!cpu_buffers[i].alive||cpu_buffers[i].exported>=0||cpu_buffers[i].access){peer_bad(__func__,__LINE__);errno=EBUSY;return -1;}
        for(unsigned f=0;f<fb_count;f++)if(cpu_fb_handles[f]==handle){peer_bad(__func__,__LINE__);errno=EBUSY;return -1;}
        cpu_buffers[i].alive=0;cpu_destroyed++;cpu_maybe_free((unsigned)i);return 0;
    }
    return -2;
}
void zkms_test_cpu_counts(uint32_t *out){
 pthread_mutex_lock(&peer_mutex);out[0]=cpu_created;out[1]=cpu_destroyed;out[2]=cpu_exports;out[3]=cpu_closes;out[4]=cpu_starts;out[5]=cpu_ends;out[6]=out[7]=0;
 for(unsigned i=0;i<8;i++){out[6]+=!!cpu_buffers[i].handle;out[7]+=!!cpu_buffers[i].access;}pthread_mutex_unlock(&peer_mutex);
}
/* Returns current scanout dimensions/pitch and actual shared-map bytes. */
int zkms_test_cpu_snapshot(uint8_t *out,uint32_t capacity,uint32_t *info){
 pthread_mutex_lock(&peer_mutex);int index=-1;
 for(unsigned f=0;f<fb_count;f++)if(fbs[f]==plane_values[0])index=cpu_index(cpu_fb_handles[f]);
 if(index<0){pthread_mutex_unlock(&peer_mutex);return -1;}const struct cpu_buffer *b=&cpu_buffers[index];
 info[0]=b->width;info[1]=b->height;info[2]=b->pitch;info[3]=(uint32_t)b->size;
 if(capacity<b->size){pthread_mutex_unlock(&peer_mutex);return -1;}
 const int ok=syscall(SYS_pread64,b->backing,out,b->size,0)==(ssize_t)b->size;
 pthread_mutex_unlock(&peer_mutex);return ok?0:-1;
}
