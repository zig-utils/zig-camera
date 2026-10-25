/* Independent C ABI/layout and scalar permutation reference, no camera needed. */
#include "zig_camera.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
struct tensor16 {uint32_t count,rank;uint16_t shape[16];};
struct info16 {char name[64];uint32_t count;struct tensor16 tensors[16];uint8_t frame;};
struct tensor8 {uint32_t count,rank;uint16_t shape[8];};
struct info8 {char name[64];uint32_t count;struct tensor8 tensors[8];uint8_t frame;};
_Static_assert(sizeof(struct info16)==712,"producer 16 profile");
_Static_assert(sizeof(struct info8)==264,"documented 8 profile");
_Static_assert(sizeof(zc_cnn_tensor)==208,"public tensor ABI");
_Static_assert(sizeof(zc_cnn_outputs_info)==3424,"public output ABI");
static void le32(uint8_t *p,uint32_t value){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(value>>(8*i));}
static void le16(uint8_t *p,uint16_t value){p[0]=(uint8_t)value;p[1]=(uint8_t)(value>>8);}
static void shape(uint8_t *info,unsigned profile,const uint16_t *dims,unsigned rank,unsigned count){
    memset(info,0,profile==16?712:264);memset(info,'n',64);le32(info+64,1);
    le32(info+68,count);le32(info+72,rank);
    for(unsigned i=0;i<rank;i++)le16(info+76+i*2,dims[i]);
    info[68+profile*(8+profile*2)]=255;
}
static size_t reference(size_t row,const uint16_t *dims,unsigned rank){
    size_t coord[16]={0},column=0,stride=1;
    for(unsigned i=rank;i>0;i--){coord[i-1]=row%dims[i-1];row/=dims[i-1];}
    for(unsigned i=0;i<rank;i++){column+=coord[i]*stride;stride*=dims[i];}
    return column;
}
int main(void){
    uint8_t info[712],raw[4*256];float output[257];zc_cnn_outputs_info header;
    size_t checked=0;
    for(unsigned profile=8;profile<=16;profile+=8)for(unsigned rank=0;rank<=4;rank++){
        unsigned cases=1;for(unsigned i=0;i<rank;i++)cases*=3;
        for(unsigned c=0;c<cases;c++){
            uint16_t dims[16]={0};unsigned v=c,count=1;
            for(unsigned i=0;i<rank;i++){dims[i]=(uint16_t)(1+v%3);v/=3;count*=dims[i];}
            shape(info,profile,dims,rank,count);
            for(unsigned big=0;big<2;big++){
                for(unsigned i=0;i<count;i++){
                    const uint32_t bits=i%3==0?0x7fc00000u+i:i%3==1?0x80000000u:i;
                    for(unsigned b=0;b<4;b++)raw[4*i+b]=(uint8_t)(bits>>(8*(big?3-b:b)));
                }
                memset(output,0x5a,sizeof(output));
                assert(zc_decode_cnn_outputs(info,profile==16?712:264,raw,count*4,big,ZC_CNN_ROW_MAJOR,1024,&header,output,256)==ZC_OK);
                assert(header.value_count==count && header.network_name_length==64 && header.frame_count==255);
                assert(header.tensors[0].rank==rank && header.tensors[0].offset==0);
                for(unsigned i=0;i<count;i++){
                    const size_t source=reference(i,dims,rank);
                    const uint32_t expected=source%3==0?0x7fc00000u+(uint32_t)source:source%3==1?0x80000000u:(uint32_t)source;
                    uint32_t actual;memcpy(&actual,output+i,4);assert(actual==expected);checked++;
                }
                assert(((const uint8_t *)(output+count))[0]==0x5a);
                const zc_cnn_outputs_info saved=header;float saved_output[257];memcpy(saved_output,output,sizeof(output));
                assert(zc_decode_cnn_outputs(info,profile==16?712:264,raw,count*4,big,1,1024,&header,output,count-1)==ZC_INVALID);
                assert(!memcmp(&saved,&header,sizeof(header))&&!memcmp(saved_output,output,sizeof(output)));
                assert(zc_decode_cnn_outputs(info,profile==16?712:264,raw,count*4,big,1,1024,&header,(float *)(void *)raw,count)==ZC_INVALID);
            }
        }
    }
    uint16_t full[16];for(unsigned i=0;i<16;i++)full[i]=1;
    shape(info,16,full,16,1);le32(raw,0x80000000);
    assert(zc_decode_cnn_outputs(info,712,raw,4,0,0,4,&header,output,1)==ZC_OK);
    assert(header.tensors[0].rank==16);
    full[0]=0;shape(info,16,full,16,0);
    assert(zc_decode_cnn_outputs(info,712,NULL,0,0,0,4,&header,NULL,0)==ZC_OK && header.present==1 && header.value_count==0);
    shape(info,16,full,16,0);le32(info+72,17);
    assert(zc_decode_cnn_outputs(info,712,NULL,0,0,0,4,&header,NULL,0)==ZC_INVALID);
    assert(zc_decode_cnn_outputs(info,711,NULL,0,0,0,4,&header,NULL,0)==ZC_UNSUPPORTED);
    printf("CNN independent column permutation: %zu bit-exact values\n",checked);
}
