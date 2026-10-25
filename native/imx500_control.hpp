// Narrow system V4L2 ABI only. Zig owns descriptors, policy and observations.
#pragma once
#include "zig_camera.h"
#include <linux/videodev2.h>
#include <sys/ioctl.h>
#include <cerrno>
#include <cstdint>
#include <cstring>
namespace zc_imx500_io {
constexpr uint32_t roi_id=0x00982900,device_id=0x00982902;
#ifdef V4L2_CID_USER_IMX500_BASE
static_assert(V4L2_CID_USER_IMX500_BASE==roi_id,"IMX500 control ABI");
#endif
using Ioctl=int(*)(int,unsigned long,void *);
inline int systemIoctl(int fd,unsigned long op,void *value){return ::ioctl(fd,op,value);}
inline int status(int error){switch(error){case EBUSY:return ZC_BUSY;case EINVAL:case ENOTTY:case ERANGE:return ZC_UNSUPPORTED;case ENODEV:case ENXIO:return ZC_DISCONNECTED;default:return ZC_IO;}}
// Only observation calls retry EINTR, with a bounded retry count. A write is
// issued exactly once, including an interrupted or partially applied write.
inline int observe(Ioctl call,int fd,unsigned long op,void *value){int rc;unsigned attempts=0;do{rc=call(fd,op,value);}while(rc<0&&errno==EINTR&&++attempts<8);return rc;}
inline int query(int fd,uint32_t id,zc_imx500_control_info *out,int32_t *error,Ioctl call=systemIoctl){
    *error=0;v4l2_query_ext_ctrl q{};q.id=id;
    if(observe(call,fd,VIDIOC_QUERY_EXT_CTRL,&q)<0){*error=errno;return status(errno);}
    const bool is_roi=id==roi_id;
    if((!is_roi&&id!=device_id)||q.id!=id||q.type!=V4L2_CTRL_TYPE_U32||q.elem_size!=4||q.elems!=4||q.nr_of_dims!=1||q.dims[0]!=4||q.dims[1]||q.dims[2]||q.dims[3]||q.minimum<0||q.maximum<q.minimum||uint64_t(q.maximum)>UINT32_MAX||!q.step||q.step>UINT32_MAX||q.default_value<q.minimum||q.default_value>q.maximum||
       (q.flags&(V4L2_CTRL_FLAG_DISABLED|V4L2_CTRL_FLAG_WRITE_ONLY|V4L2_CTRL_FLAG_DYNAMIC_ARRAY))||(is_roi&&(q.flags&V4L2_CTRL_FLAG_READ_ONLY)))return ZC_UNSUPPORTED;
    *out={sizeof(*out),q.flags,q.minimum,q.maximum,q.step,q.default_value};return ZC_OK;
}
inline int transfer(int fd,uint32_t id,bool write,const uint32_t *input,uint32_t *output,int32_t *error,Ioctl call=systemIoctl){
    *error=0;if((id!=roi_id&&id!=device_id)||(write&&(id!=roi_id||!input))||(!write&&!output))return ZC_INVALID;
    uint32_t payload[4]{};if(write)std::memcpy(payload,input,sizeof(payload));
    v4l2_ext_control value{};value.id=id;value.size=sizeof(payload);value.p_u32=payload;
    v4l2_ext_controls controls{};controls.which=V4L2_CTRL_WHICH_CUR_VAL;controls.count=1;controls.controls=&value;
    const int rc=write?call(fd,VIDIOC_S_EXT_CTRLS,&controls):observe(call,fd,VIDIOC_G_EXT_CTRLS,&controls);
    if(rc<0){*error=errno;return status(errno);}
    if(controls.count!=1||controls.controls!=&value||value.id!=id||value.size!=sizeof(payload)||value.p_u32!=payload)return ZC_DEVICE;
    if(!write)std::memcpy(output,payload,sizeof(payload));
    return ZC_OK;
}
}
