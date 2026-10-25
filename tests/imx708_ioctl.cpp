#include "imx708_control.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <utility>
#include <initializer_list>
namespace {
int calls=0,fault=0,interrupts=0,current=0,query_case=0;
unsigned long seen=0;
int fake(int fd,unsigned long request,void *arg){
    assert(fd==0);++calls;seen=request;
    if(interrupts){--interrupts;errno=EINTR;return -1;}
    if(fault){errno=fault;return -1;}
    if(request==VIDIOC_QUERYCTRL){
        auto &q=*static_cast<v4l2_queryctrl *>(arg);assert(q.id==V4L2_CID_WIDE_DYNAMIC_RANGE&&q.reserved[0]==0&&q.reserved[1]==0);
        q.type=V4L2_CTRL_TYPE_BOOLEAN;q.minimum=0;q.maximum=1;q.step=1;
        switch(query_case){case 1:q.type=V4L2_CTRL_TYPE_INTEGER;break;case 2:q.minimum=-1;break;case 3:q.maximum=2;break;case 4:q.step=2;break;case 5:q.flags=V4L2_CTRL_FLAG_DISABLED;break;case 6:q.flags=V4L2_CTRL_FLAG_READ_ONLY;break;case 7:q.default_value=2;break;case 8:q.flags=V4L2_CTRL_FLAG_WRITE_ONLY;break;case 9:q.id=V4L2_CID_EXPOSURE_AUTO;break;case 10:q.flags=V4L2_CTRL_FLAG_GRABBED;break;}
    }else{
        auto &q=*static_cast<v4l2_control *>(arg);assert(q.id==V4L2_CID_WIDE_DYNAMIC_RANGE);
        if(request==VIDIOC_G_CTRL){assert(q.value==0);q.value=current;}
        else{assert(request==VIDIOC_S_CTRL);assert(q.value==0||q.value==1);current=q.value;}
    }
    return 0;
}
}
int main(){
    uint32_t value=999;int32_t error=999;
    assert(zc_sensor::control(0,0,&value,&error,fake)==ZC_OK&&value==0&&error==0&&seen==VIDIOC_QUERYCTRL);
    for(query_case=1;query_case<=9;query_case++)assert(zc_sensor::control(0,0,&value,&error,fake)==ZC_UNSUPPORTED&&value==0&&error==0);
    query_case=10;assert(zc_sensor::control(0,0,&value,&error,fake)==ZC_OK&&value==V4L2_CTRL_FLAG_GRABBED);query_case=0;
    for(current=0;current<2;current++)assert(zc_sensor::control(0,1,&value,&error,fake)==ZC_OK&&value==static_cast<uint32_t>(current)&&seen==VIDIOC_G_CTRL);
    current=2;assert(zc_sensor::control(0,1,&value,&error,fake)==ZC_DEVICE);
    assert(zc_sensor::control(0,2,&value,&error,fake)==ZC_OK&&current==0&&value==0&&seen==VIDIOC_S_CTRL);
    assert(zc_sensor::control(0,3,&value,&error,fake)==ZC_OK&&current==1&&value==1);
    for(const auto &pair:{std::pair<int,int>{EBUSY,ZC_BUSY},{EINVAL,ZC_UNSUPPORTED},{ENOTTY,ZC_UNSUPPORTED},{ENODEV,ZC_DISCONNECTED},{ENXIO,ZC_DISCONNECTED},{EIO,ZC_IO}}){
        fault=pair.first;
        for(uint32_t op=0;op<4;op++)assert(zc_sensor::control(0,op,&value,&error,fake)==pair.second&&value==0&&error==fault);
    }
    fault=0;current=1;
    for(uint32_t op=0;op<4;op++){
        interrupts=1;const int before=calls;const int rc=zc_sensor::control(0,op,&value,&error,fake);
        if(op<2)assert(rc==ZC_OK&&calls==before+2&&error==0);
        else assert(rc==ZC_IO&&calls==before+1&&error==EINTR);
    }
    const int before=calls;assert(zc_sensor::control(0,4,&value,&error,fake)==ZC_INVALID&&calls==before);
    puts("IMX708 ioctl system ABI, fd zero, query validation, errno and EINTR handling passed");
}
