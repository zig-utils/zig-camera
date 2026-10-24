#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
_Static_assert(sizeof(zc_sensor_hdr_state)==32,"sensor HDR state ABI");
_Static_assert(offsetof(zc_sensor_hdr_state,manager_generation)==16,"sensor generation ABI");
int main(void){
 zc_imx708 *sensor=NULL;zc_sensor_hdr_state state;uint32_t count=99;
 assert(zc_imx708_open(ZC_SYNTHETIC,UINT32_MAX,NULL,0,&sensor)==ZC_OK);
 uint64_t length=0;assert(zc_imx708_camera_id(sensor,NULL,0,&length)==ZC_OK&&length==9);
 uint8_t id[9];assert(zc_imx708_camera_id(sensor,id,sizeof id,&length)==ZC_OK&&!memcmp(id,"synthetic",9));
 assert(zc_imx708_set_hdr_mode(sensor,0,&state)==ZC_OK);
 assert(zc_imx708_set_hdr_mode(sensor,1,&state)==ZC_OK&&state.enabled==1&&state.previous_enabled==0);
 assert((state.flags&63)==63);
 assert(zc_imx708_set_hdr_mode(sensor,1,&state)==ZC_OK&&(state.flags&63)==3);
 zc_config cfg;zc_default_config(&cfg);cfg.width=32;cfg.height=24;zc_camera *cam=NULL;
 assert(zc_open(&cfg,&cam)==ZC_OK);
 assert(zc_sensor_layout_users_get(ZC_SYNTHETIC,&count)==ZC_OK&&count==1);
 assert(zc_imx708_set_hdr_mode(sensor,0,&state)==ZC_BUSY&&!(state.flags&ZC_SENSOR_HDR_CURRENT));
 assert(zc_get_sensor_modes(cam,NULL,0,&count)==ZC_OK&&count==1);
 zc_control_info info;assert(zc_get_control_info(cam,ZC_HDR_MODE,&info)==ZC_OK);
 assert(zc_close(cam)==ZC_OK);
 zc_sensor_layout_scope *scope=NULL;
 assert(zc_sensor_layout_scope_open(ZC_SYNTHETIC,&scope)==ZC_OK);
 zc_tuning_state tuning;assert(zc_get_tuning_state(ZC_SYNTHETIC,&tuning)==ZC_OK&&tuning.manager_users==0);
 assert(zc_imx708_set_hdr_mode(sensor,0,&state)==ZC_BUSY);
 assert(zc_sensor_layout_scope_close(scope)==ZC_OK);
 assert(zc_imx708_set_hdr_mode(sensor,0,&state)==ZC_OK&&state.enabled==0);
 assert(zc_open(&cfg,&cam)==ZC_OK);assert(zc_get_sensor_modes(cam,NULL,0,&count)==ZC_OK&&count==3);assert(zc_close(cam)==ZC_OK);
 assert(zc_imx708_close(sensor)==ZC_OK);
 assert(zc_sensor_layout_users_get(ZC_SYNTHETIC,&count)==ZC_OK&&count==0);
 return 0;
}
