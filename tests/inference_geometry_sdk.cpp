// Compare the public projection against actual distribution libcamera geometry.
#include "zig_camera.h"
#include <libcamera/geometry.h>
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
using libcamera::Rectangle;
using libcamera::Size;
static Rectangle rect(zc_inference_rect r){return {r.x,r.y,r.width,r.height};}
static Size size(zc_inference_size s){return {s.width,s.height};}
static void same(zc_inference_rect got,const Rectangle &expected){
    assert(got.x==expected.x&&got.y==expected.y&&got.width==expected.width&&got.height==expected.height);
}
static Rectangle reference(const zc_inference_geometry &g,Rectangle object){
    const Rectangle full(0,0,g.full_sensor.width,g.full_sensor.height);
    if((g.flags&1)&&rect(g.roi)!=Rectangle(0,0,0,0))object=object.boundedTo(rect(g.roi).boundedTo(full));
    const auto crop=rect(g.scaler_crop).scaledBy(size(g.sensor_output),size(g.full_sensor));
    return object.scaledBy(size(g.sensor_output),size(g.full_sensor)).boundedTo(crop).translatedBy(-crop.topLeft()).scaledBy(size(g.isp_output),crop.size());
}
static uint32_t state=0x43524f50;
static uint32_t random32(){state=state*1664525u+1013904223u;return state;}
int main(){
    static_assert(sizeof(zc_inference_geometry)==64,"projection ABI");
    size_t cases=0;
    for(unsigned i=0;i<12000;i++){
        zc_inference_geometry g{};g.struct_size=sizeof(g);
        g.full_sensor={4+random32()%8192,4+random32()%8192};
        g.sensor_output={4+random32()%8192,4+random32()%8192};
        g.isp_output={1+random32()%2048,1+random32()%2048};
        g.scaler_crop={int32_t(g.full_sensor.width/4),int32_t(g.full_sensor.height/4),g.full_sensor.width/2,g.full_sensor.height/2};
        g.flags=i%3?1:0;
        if(i%4)g.roi={int32_t(g.full_sensor.width/8),int32_t(g.full_sensor.height/8),g.full_sensor.width/2,g.full_sensor.height/2};
        const zc_inference_rect object{int32_t(random32()%(2*g.full_sensor.width))-int32_t(g.full_sensor.width/2),int32_t(random32()%(2*g.full_sensor.height))-int32_t(g.full_sensor.height/2),random32()%(2*g.full_sensor.width),random32()%(2*g.full_sensor.height)};
        zc_inference_rect out{};
        assert(zc_inference_project(&g,&object,&out)==ZC_OK);same(out,reference(g,rect(object)));cases++;
        assert(zc_inference_roi(&g,&out)==ZC_OK);same(out,reference(g,{0,0,g.full_sensor.width,g.full_sensor.height}));cases++;
        const double coordinates[4]={double(int32_t(random32()%32)-8)/16,double(int32_t(random32()%32)-8)/16,double(int32_t(random32()%32)-8)/16,double(int32_t(random32()%32)-8)/16};
        const Rectangle normalized(int32_t(std::max(coordinates[1]*g.full_sensor.width,0.0)),int32_t(std::max(coordinates[0]*g.full_sensor.height,0.0)),uint32_t(std::max((coordinates[3]-coordinates[1])*g.full_sensor.width,0.0)),uint32_t(std::max((coordinates[2]-coordinates[0])*g.full_sensor.height,0.0)));
        assert(zc_inference_convert(&g,coordinates,&out)==ZC_OK);same(out,reference(g,normalized));cases++;
        const zc_inference_size aspect{1+random32()%64,1+random32()%64};
        const auto bounded=size(g.full_sensor).boundedToAspectRatio(size(aspect));
        if(bounded.width&&bounded.height){
            const Rectangle full(0,0,g.full_sensor.width,g.full_sensor.height);
            assert(zc_inference_aspect(&g.full_sensor,&aspect,&out)==ZC_OK);same(out,bounded.centeredTo(full.center()).enclosedIn(full));cases++;
        }
    }
    std::printf("inference projection matches system libcamera: %zu cases\n",cases);
}
