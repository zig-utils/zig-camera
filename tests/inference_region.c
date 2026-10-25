#include "zig_camera.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
_Static_assert(sizeof(zc_inference_geometry)==64,"geometry ABI");
_Static_assert(sizeof(zc_cnn_kpi_info)==32,"KPI ABI");
int main(void){
    zc_inference_geometry p={0};p.struct_size=sizeof(p);
    p.full_sensor=(zc_inference_size){4056,3040};p.sensor_output=(zc_inference_size){2028,1520};p.isp_output=(zc_inference_size){640,480};
    p.scaler_crop=(zc_inference_rect){100,200,2000,1600};p.roi=(zc_inference_rect){200,300,1200,900};p.flags=1;
    struct{uint64_t before;zc_inference_rect rect;uint64_t after;} guard={0x12345678,{0},0xfedcba98};
    assert(zc_inference_roi(&p,&guard.rect)==ZC_OK);
    assert(guard.rect.x==32&&guard.rect.y==30&&guard.rect.width==384&&guard.rect.height==270);
    const zc_inference_rect old=guard.rect;p.flags=2;
    assert(zc_inference_roi(&p,&guard.rect)==ZC_INVALID&&!memcmp(&old,&guard.rect,sizeof(old)));
    p.flags=1;const double bad[4]={0,NAN,1,1};assert(zc_inference_convert(&p,bad,&guard.rect)==ZC_INVALID&&!memcmp(&old,&guard.rect,sizeof(old)));
    assert(guard.before==0x12345678&&guard.after==0xfedcba98);
    const uint8_t big[8]={0x80,0,0,0,0x7f,0xff,0xff,0xff};
    zc_cnn_kpi_info kpi;assert(zc_decode_cnn_kpi(big,8,1,&kpi)==ZC_OK);
    assert(kpi.present&&kpi.dnn_raw==INT32_MIN&&kpi.dsp_raw==INT32_MAX);
    assert(kpi.picamera_dnn_ms==(double)INT32_MIN/1000&&kpi.picamera_dsp_ms==(double)INT32_MAX/1000);
    const zc_cnn_kpi_info saved=kpi;assert(zc_decode_cnn_kpi(big,7,1,&kpi)==ZC_INVALID&&!memcmp(&saved,&kpi,sizeof(kpi)));
    zc_config cfg;zc_default_config(&cfg);cfg.width=16;cfg.height=16;
    zc_camera *camera=NULL;assert(zc_open(&cfg,&camera)==ZC_OK&&zc_start(camera)==ZC_OK);
    zc_frame frame;assert(zc_acquire(camera,0,&frame)==ZC_OK);
    assert(zc_frame_cnn_kpi(camera,frame.token,&kpi)==ZC_OK&&!kpi.present);
    assert(zc_release(camera,frame.token)==ZC_OK);const zc_cnn_kpi_info empty=kpi;
    assert(zc_frame_cnn_kpi(camera,frame.token,&kpi)==ZC_STALE&&!memcmp(&empty,&kpi,sizeof(kpi)));
    assert(zc_stop(camera)==ZC_OK&&zc_close(camera)==ZC_OK);
    puts("inference C ABI: staged geometry, guards, signed KPI, absent/stale request passed");
}
