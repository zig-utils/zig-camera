/* Independent KMS plane/event peer used only by the isolated Linux test. */
#include <poll.h>
#include <time.h>
#include <stdio.h>
static int preview_fault;
static uint64_t plane_values[15];
static uint32_t fbs[8],fb_count,next_fb,imports,gem_closes,commits,test_commits,detaches,event_reads;
static int event_writer=-1,retired_proof,image_ever;
static struct drm_event_vblank held_event;
static int held_valid;
static void peer_bad(const char *operation,int line){
    unexpected++;
    fprintf(stderr,"KMS peer rejected %s at line %d (fb=%llu, resources=%u, fault=%d)\n",operation,line,(unsigned long long)plane_values[0],fb_count,preview_fault);
}
static const char *property_names[]={"FB_ID","CRTC_ID","SRC_X","SRC_Y","SRC_W","SRC_H","CRTC_X","CRTC_Y","CRTC_W","CRTC_H","rotation","COLOR_ENCODING","COLOR_RANGE","type","alpha"};
static void preview_reset(void){
    memset(plane_values,0,sizeof(plane_values));plane_values[10]=1;plane_values[12]=1;plane_values[14]=32768;
    memset(fbs,0,sizeof(fbs));fb_count=0;next_fb=600;imports=gem_closes=commits=test_commits=detaches=event_reads=0;
    retired_proof=image_ever=preview_fault=held_valid=0;
}
void zkms_test_fault(int value){
    pthread_mutex_lock(&peer_mutex);
    preview_fault=value;
    if(!value&&held_valid){
        if(syscall(SYS_write,event_writer,&held_event,sizeof(held_event))!=(ssize_t)sizeof(held_event))peer_bad(__func__,__LINE__);
        else{held_valid=0;event_reads++;}
    }
    pthread_mutex_unlock(&peer_mutex);
}
void zkms_test_preview_counts(uint32_t *out){pthread_mutex_lock(&peer_mutex);out[0]=imports;out[1]=gem_closes;out[2]=commits;out[3]=test_commits;out[4]=detaches;out[5]=event_reads;out[6]=fb_count;out[7]=plane_values[0];pthread_mutex_unlock(&peer_mutex);}
void zkms_test_properties(uint64_t *out){pthread_mutex_lock(&peer_mutex);memcpy(out,plane_values,sizeof(plane_values));pthread_mutex_unlock(&peer_mutex);}
static int preview_ioctl(unsigned long request,void *arg){
    if(scenario<10)return -2;
    if(request==DRM_IOCTL_SET_MASTER)return 0;
    if(request==DRM_IOCTL_MODE_GETPLANE){
        struct drm_mode_get_plane *v=arg;
        const uint32_t formats[]={0x34324742,0x34324752,0x34324258,0x34325258,0x32315559,0x32315659,0x3231564e,0x3132564e,0x56595559,0x55595659,0x59565955,0x59555956};
        v->possible_crtcs=1;v->fb_id=v->plane_id==40?plane_values[0]:0;v->crtc_id=v->fb_id?10:0;
        return ids(v->format_type_ptr,v->count_format_types,&v->count_format_types,formats,12);
    }
    if(request==DRM_IOCTL_MODE_OBJ_GETPROPERTIES){
        struct drm_mode_obj_get_properties *v=arg;uint32_t values[15];for(unsigned i=0;i<15;i++)values[i]=100+i;
        if(v->count_props>=15)memcpy((void *)(uintptr_t)v->prop_values_ptr,plane_values,sizeof(plane_values));
        return ids(v->props_ptr,v->count_props,&v->count_props,values,15);
    }
    if(request==DRM_IOCTL_MODE_GETPROPERTY){
        struct drm_mode_get_property *v=arg;if(v->prop_id<100 || v->prop_id>=115){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
        const unsigned i=v->prop_id-100;strncpy(v->name,property_names[i],sizeof(v->name)-1);v->name[sizeof(v->name)-1]=0;
        const uint32_t cap=v->count_enum_blobs,range_cap=v->count_values;v->count_values=0;v->count_enum_blobs=0;
        if(i==13){v->flags=DRM_MODE_PROP_ENUM|DRM_MODE_PROP_IMMUTABLE;return 0;}
        if(i==10||i==11||i==12){
            static const char *rotation[]={"rotate-0","rotate-90","rotate-180","rotate-270","reflect-x","reflect-y"};
            static const char *encoding[]={"ITU-R BT.601 YCbCr","ITU-R BT.709 YCbCr","ITU-R BT.2020 YCbCr"};
            static const char *range[]={"YCbCr limited range","YCbCr full range"};
            const char **names=i==10?rotation:i==11?encoding:range;
            const unsigned count=i==10?6:i==11?3:2;v->count_enum_blobs=count;v->flags=i==10?DRM_MODE_PROP_BITMASK:DRM_MODE_PROP_ENUM;
            if(cap>=count){struct drm_mode_property_enum *out=(void *)(uintptr_t)v->enum_blob_ptr;memset(out,0,count*sizeof(*out));for(unsigned j=0;j<count;j++){out[j].value=j;strncpy(out[j].name,names[j],sizeof(out[j].name)-1);}}
            return 0;
        }
        v->flags=DRM_MODE_PROP_RANGE;v->count_values=2;
        if(range_cap>=2){uint64_t *range=(void *)(uintptr_t)v->values_ptr;range[0]=0;range[1]=i==14?65535:UINT32_MAX;}
        return 0;
    }
    if(request==DRM_IOCTL_PRIME_FD_TO_HANDLE){
        struct drm_prime_handle *v=arg;if(v->fd<0){peer_bad(__func__,__LINE__);errno=EBADF;return -1;}
        imports++;v->handle=500;return 0; /* Deliberately aliases across imports. */
    }
    if(request==DRM_IOCTL_MODE_ADDFB2){
        struct drm_mode_fb_cmd2 *v=arg;if(!v->width||!v->height||v->handles[0]!=500||fb_count>=8){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
        v->fb_id=++next_fb;fbs[fb_count++]=v->fb_id;return 0;
    }
    if(request==DRM_IOCTL_MODE_RMFB){
        const uint32_t id=*(uint32_t *)arg;
        if(preview_fault==15){preview_fault=0;errno=EIO;return -1;}
        if(id==plane_values[0]){peer_bad(__func__,__LINE__);errno=EBUSY;return -1;}
        for(unsigned i=0;i<fb_count;i++)if(fbs[i]==id){fbs[i]=fbs[--fb_count];return 0;}
        peer_bad(__func__,__LINE__);errno=ENOENT;return -1;
    }
    if(request==DRM_IOCTL_GEM_CLOSE){
        struct drm_gem_close *v=arg;if(v->handle!=500||fb_count){peer_bad(__func__,__LINE__);errno=EBUSY;return -1;}
        gem_closes++;return 0;
    }
    if(request==DRM_IOCTL_MODE_ATOMIC){
        struct drm_mode_atomic *v=arg;
        if(v->count_objs!=1 || *(uint32_t *)(uintptr_t)v->objs_ptr!=40){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
        uint64_t next[15];memcpy(next,plane_values,sizeof(next));
        const uint32_t count=*(uint32_t *)(uintptr_t)v->count_props_ptr,*properties=(void *)(uintptr_t)v->props_ptr;
        const uint64_t *values=(void *)(uintptr_t)v->prop_values_ptr;
        if(count>16){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
        for(unsigned i=0;i<count;i++){if(properties[i]<100||properties[i]>=115){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}next[properties[i]-100]=values[i];}
        if(v->flags&DRM_MODE_ATOMIC_TEST_ONLY){
            test_commits++;if(preview_fault==13&&next[0]){preview_fault=0;errno=EINVAL;return -1;}return 0;
        }
        if(v->flags!=(DRM_MODE_ATOMIC_NONBLOCK|DRM_MODE_PAGE_FLIP_EVENT) || !v->user_data){peer_bad(__func__,__LINE__);errno=EINVAL;return -1;}
        commits++;memcpy(plane_values,next,sizeof(next));
        const int detach=next[0]==0;
        if(detach){
            detaches++;uint64_t original[15]={0};original[10]=1;original[12]=1;original[14]=32768;
            if(memcmp(next,original,sizeof(next))){peer_bad(__func__,__LINE__);for(unsigned i=0;i<15;i++)fprintf(stderr," %u:%llu/%llu",i,(unsigned long long)next[i],(unsigned long long)original[i]);fputc(10,stderr);errno=EINVAL;return -1;}
        }else{image_ever=1;retired_proof=0;}
        if(preview_fault==14&&!detach){preview_fault=0;errno=EINTR;return -1;}
        if(preview_fault==12 || (preview_fault==11&&!detach))return 0;
        struct drm_event_vblank event;memset(&event,0,sizeof(event));
        event.base.type=DRM_EVENT_FLIP_COMPLETE;event.base.length=sizeof(event);event.user_data=v->user_data;event.crtc_id=10;
        if(preview_fault==17&&!detach){
            if(held_valid){peer_bad(__func__,__LINE__);errno=EOVERFLOW;return -1;}
            held_event=event;held_valid=1;return 0;
        }
        if(syscall(SYS_write,event_writer,&event,sizeof(event))!=(ssize_t)sizeof(event)){peer_bad(__func__,__LINE__);errno=EIO;return -1;}
        event_reads++; /* Events emitted to the real FD, rather than intercepted reads. */
        if(detach)retired_proof=1;
        return 0;
    }
    return -2;
}
