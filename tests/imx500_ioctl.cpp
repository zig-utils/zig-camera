#include "../native/imx500_control.hpp"
#include <array>
#include <cassert>
#include <cstdio>
using namespace zc_imx500_io;
namespace {
std::array<uint32_t,4> cached{0,0,0,0},registers{0,0,0,0};
unsigned calls=0,writes=0,interrupts=0,query_case=0,malformed=0;
int fault=0;bool powered=false,partial=false;
void applyCached(){registers=(cached[2]==0||cached[3]==0)?std::array<uint32_t,4>{0,0,4056,3040}:cached;}
int fake(int fd,unsigned long op,void *ptr){
    assert(fd==0);++calls;
    if(interrupts){--interrupts;errno=EINTR;return -1;}
    if(op==VIDIOC_QUERY_EXT_CTRL){
        auto &q=*static_cast<v4l2_query_ext_ctrl *>(ptr);assert(q.id==roi_id||q.id==device_id);
        q.type=V4L2_CTRL_TYPE_U32;q.elem_size=4;q.elems=4;q.nr_of_dims=1;q.dims[0]=4;q.minimum=0;q.maximum=q.id==roi_id?4032:UINT32_MAX;q.step=1;q.default_value=0;
        q.flags=V4L2_CTRL_FLAG_HAS_PAYLOAD|(q.id==roi_id?V4L2_CTRL_FLAG_EXECUTE_ON_WRITE:V4L2_CTRL_FLAG_READ_ONLY|V4L2_CTRL_FLAG_VOLATILE|V4L2_CTRL_FLAG_INACTIVE);
        switch(query_case){case 1:q.type=V4L2_CTRL_TYPE_INTEGER;break;case 2:q.elems=5;break;case 3:q.elem_size=8;break;case 4:q.nr_of_dims=2;break;case 5:q.dims[1]=1;break;case 6:q.minimum=-1;break;case 7:q.maximum=INT64_MAX;break;case 8:q.step=0;break;case 9:q.flags|=V4L2_CTRL_FLAG_WRITE_ONLY;break;case 10:q.flags|=V4L2_CTRL_FLAG_READ_ONLY;break;case 11:q.flags|=V4L2_CTRL_FLAG_DYNAMIC_ARRAY;break;case 12:q.flags|=V4L2_CTRL_FLAG_DISABLED;break;case 13:q.default_value=q.maximum+1;break;default:break;}
        if(fault){errno=fault;return -1;}return 0;
    }
    assert(op==VIDIOC_G_EXT_CTRLS||op==VIDIOC_S_EXT_CTRLS);
    auto &controls=*static_cast<v4l2_ext_controls *>(ptr);assert(controls.which==V4L2_CTRL_WHICH_CUR_VAL&&controls.count==1&&controls.controls);
    auto &v=*controls.controls;assert(v.size==16&&v.p_u32&&(v.id==roi_id||v.id==device_id));
    if(op==VIDIOC_S_EXT_CTRLS){assert(v.id==roi_id);++writes;if(!fault||partial){for(unsigned i=0;i<4;i++)cached[i]=v.p_u32[i];if(powered)applyCached();}}
    if(fault){errno=fault;return -1;}
    if(op==VIDIOC_G_EXT_CTRLS){const auto data=v.id==roi_id?cached:std::array<uint32_t,4>{0x01234567,0x89abcdef,0xffffffff,0};for(unsigned i=0;i<4;i++)v.p_u32[i]=data[i];}
    if(malformed==1)v.size=12;
    if(malformed==2)controls.count=2;
    if(malformed==3)v.id=7;
    if(malformed==4)v.p_u32=nullptr;
    return 0;
}
}
int main(){
    zc_imx500_control_info info{};int32_t error=99;
    assert(query(0,roi_id,&info,&error,fake)==ZC_OK&&error==0&&info.struct_size==40&&info.maximum==4032);
    for(query_case=1;query_case<=13;query_case++)assert(query(0,roi_id,&info,&error,fake)==ZC_UNSUPPORTED);
    query_case=0;assert(query(0,device_id,&info,&error,fake)==ZC_OK&&info.maximum==UINT32_MAX);
    std::array<uint32_t,4> out{},requested{508,0,3040,3040};
    assert(transfer(0,roi_id,true,requested.data(),nullptr,&error,fake)==ZC_OK&&writes==1);
    assert(registers[2]==0); // Powered-down writes update the control cache only.
    assert(transfer(0,roi_id,false,nullptr,out.data(),&error,fake)==ZC_OK&&out==requested);
    powered=true;applyCached();assert(registers==requested);
    powered=false;registers={0,0,0,0}; // A stream restart runs handler_setup.
    powered=true;applyCached();assert(registers==requested&&cached==requested);
    const std::array<uint32_t,4> full{0,0,0,0};
    assert(transfer(0,roi_id,true,full.data(),nullptr,&error,fake)==ZC_OK&&registers[2]==4056&&registers[3]==3040);
    interrupts=1;unsigned before=calls;assert(query(0,roi_id,&info,&error,fake)==ZC_OK&&calls==before+2);
    interrupts=1;before=calls;assert(transfer(0,roi_id,false,nullptr,out.data(),&error,fake)==ZC_OK&&calls==before+2);
    interrupts=1;before=calls;assert(transfer(0,roi_id,true,requested.data(),nullptr,&error,fake)==ZC_IO&&error==EINTR&&calls==before+1);
    interrupts=20;before=calls;assert(query(0,roi_id,&info,&error,fake)==ZC_IO&&error==EINTR&&calls==before+8);interrupts=0;
    fault=EINTR;partial=true;before=calls;assert(transfer(0,roi_id,true,requested.data(),nullptr,&error,fake)==ZC_IO&&error==EINTR&&calls==before+1);fault=0;partial=false;
    assert(transfer(0,roi_id,false,nullptr,out.data(),&error,fake)==ZC_OK&&out==requested);
    for(malformed=1;malformed<=4;malformed++){out={17,18,19,20};const auto saved=out;assert(transfer(0,roi_id,false,nullptr,out.data(),&error,fake)==ZC_DEVICE&&out==saved);}malformed=0;
    assert(transfer(0,device_id,false,nullptr,out.data(),&error,fake)==ZC_OK&&out[1]==0x89abcdef&&out[2]==UINT32_MAX);
    for(const auto &item:std::array<std::pair<int,int>,5>{{{EBUSY,ZC_BUSY},{ENOTTY,ZC_UNSUPPORTED},{ENODEV,ZC_DISCONNECTED},{EIO,ZC_IO},{EACCES,ZC_IO}}}){fault=item.first;assert(query(0,roi_id,&info,&error,fake)==item.second&&error==fault);}fault=0;
    std::puts("IMX500 system V4L2 ABI: bounded query/read retries, single write, cached restart, sentinel, device ID and guarded failures passed");
}
