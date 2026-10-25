#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
_Static_assert(sizeof(zc_imx500_control_info)==40,"IMX500 capability ABI");
_Static_assert(sizeof(zc_imx500_state)==160,"IMX500 state ABI");
_Static_assert(offsetof(zc_imx500_state,revision)==16,"revision ABI");
_Static_assert(offsetof(zc_imx500_state,control)==24,"control ABI");
_Static_assert(offsetof(zc_imx500_state,previous)==64,"raw ABI");
_Static_assert(offsetof(zc_imx500_state,current_roi)==128,"effective ROI ABI");
int main(void){
 zc_imx500 *sensor=NULL,*other=(zc_imx500 *)(uintptr_t)1;
 zc_imx500_state state;
 assert(zc_imx500_open(ZC_SYNTHETIC,UINT32_MAX,NULL,0,&sensor)==ZC_OK);
 assert(zc_imx500_open(ZC_SYNTHETIC,UINT32_MAX,NULL,0,&other)==ZC_BUSY&&other==NULL);
 uint64_t length=0;assert(zc_imx500_camera_id(sensor,NULL,0,&length)==ZC_OK&&length==9);
 uint8_t id[10];memset(id,0xa5,sizeof id);
 assert(zc_imx500_camera_id(sensor,id,8,&length)==ZC_INVALID&&id[0]==0xa5);
 assert(zc_imx500_camera_id(sensor,id,9,&length)==ZC_OK&&!memcmp(id,"synthetic",9)&&id[9]==0xa5);
 assert(zc_imx500_set_roi(sensor,0,0,0,0,&state)==ZC_OK);
 assert(state.current_roi[2]==4056&&state.current_roi[3]==3040&&state.current[2]==0);
 assert(zc_imx500_set_aspect(sensor,1,1,&state)==ZC_OK&&state.current[0]==508&&state.current[2]==3040);
 const uint64_t revision=state.revision;
 assert(zc_imx500_set_aspect(sensor,1,1,&state)==ZC_OK&&state.revision==revision&&!(state.flags&ZC_IMX500_WRITE_ATTEMPTED));
 assert(zc_imx500_restore_roi(sensor,&state)==ZC_OK&&state.revision==revision+1&&(state.flags&ZC_IMX500_WRITE_SUCCEEDED));
 assert(zc_imx500_set_roi(sensor,0,0,4056,100,&state)==ZC_UNSUPPORTED&&!(state.flags&ZC_IMX500_WRITE_ATTEMPTED)&&state.saved[0]==508);
 assert(zc_imx500_set_aspect(sensor,0,1,&state)==ZC_INVALID);
 struct {uint32_t before,words[4],after;} guarded={.before=17,.after=23};
 assert(zc_imx500_device_id(sensor,guarded.words)==ZC_OK&&guarded.words[0]==0x53594e54&&guarded.words[3]==0x35303000&&guarded.before==17&&guarded.after==23);
 assert(zc_imx500_close(sensor)==ZC_OK);
 assert(zc_imx500_open(ZC_SYNTHETIC,UINT32_MAX,(const uint8_t *)"synthetic",9,&sensor)==ZC_OK);
 assert(zc_imx500_get_roi(sensor,&state)==ZC_OK&&state.current[0]==508);
 assert(zc_imx500_set_roi(sensor,0,0,0,0,&state)==ZC_OK);
 assert(zc_imx500_close(sensor)==ZC_OK&&zc_imx500_close(NULL)==ZC_OK);
 return 0;
}
