// System-header V4L2 ABI, separated from camera ownership for deterministic IO tests.
#pragma once
#include "zig_camera.h"
#include <linux/videodev2.h>
#include <sys/ioctl.h>
#include <cerrno>
#include <cstdint>
namespace zc_sensor {
using Ioctl = int (*)(int,unsigned long,void *);
inline int systemIoctl(int fd,unsigned long request,void *value){return ::ioctl(fd,request,value);}
inline int status(int error){switch(error){case EBUSY:return ZC_BUSY;case EINVAL:case ENOTTY:return ZC_UNSUPPORTED;case ENODEV:case ENXIO:return ZC_DISCONNECTED;default:return ZC_IO;}}
inline int control(int fd,uint32_t operation,uint32_t *out,int32_t *system_error,Ioctl call=systemIoctl){
    *out=0;*system_error=0;
    static_assert(V4L2_CID_WIDE_DYNAMIC_RANGE==0x009a0915,"IMX708 HDR control ABI");
    int rc;
    if(operation==0){
        v4l2_queryctrl query{};query.id=V4L2_CID_WIDE_DYNAMIC_RANGE;
        do{rc=call(fd,VIDIOC_QUERYCTRL,&query);}while(rc<0&&errno==EINTR);
        if(rc<0){*system_error=errno;return status(errno);}
        if(query.id!=V4L2_CID_WIDE_DYNAMIC_RANGE||query.type!=V4L2_CTRL_TYPE_BOOLEAN||query.minimum!=0||query.maximum!=1||query.step!=1||query.default_value<0||query.default_value>1||(query.flags&(V4L2_CTRL_FLAG_DISABLED|V4L2_CTRL_FLAG_READ_ONLY|V4L2_CTRL_FLAG_WRITE_ONLY)))return ZC_UNSUPPORTED;
        *out=query.flags;return ZC_OK;
    }
    if(operation>3)return ZC_INVALID;
    v4l2_control value{};value.id=V4L2_CID_WIDE_DYNAMIC_RANGE;
    const auto request=operation==1?VIDIOC_G_CTRL:VIDIOC_S_CTRL;
    if(operation!=1)value.value=operation==3?1:0;
    do{rc=call(fd,request,&value);}while(rc<0&&errno==EINTR);
    if(rc<0){*system_error=errno;return status(errno);}
    if(value.value!=0&&value.value!=1)return ZC_DEVICE;
    *out=static_cast<uint32_t>(value.value);return ZC_OK;
}
}
