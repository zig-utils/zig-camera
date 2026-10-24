#include "zig_camera.h"
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
_Static_assert(sizeof(zc_rtp_config)==32,"RTP config ABI");
_Static_assert(sizeof(zc_rtp_state)==24,"RTP state ABI");
_Static_assert(sizeof(zc_rtcp_report)==32,"RTCP report ABI");
_Static_assert(offsetof(zc_rtcp_report,unix_ns)==24,"RTCP Unix clock ABI");
_Static_assert(sizeof(zc_rtp_hevc_profile_info)==32,"HEVC profile ABI");
int main(void){
 zc_rtp_config config;zc_default_rtp_config(&config);config.sequence=65535;
 uint8_t input[]={0,0,1,0x65,0x80};zc_rtp_packetizer *cursor=NULL;assert(zc_rtp_packetizer_open(&config,input,sizeof input,&cursor)==0);memset(input,0,sizeof input);
 uint32_t count=0;assert(zc_rtp_packetizer_next(cursor,NULL,0,&count)==0&&count==14);uint8_t bytes[300];memset(bytes,0xa5,sizeof bytes);assert(zc_rtp_packetizer_next(cursor,bytes,13,&count)==ZC_INVALID);for(unsigned i=0;i<sizeof bytes;i++)assert(bytes[i]==0xa5);
 assert(zc_rtp_packetizer_next(cursor,bytes,sizeof bytes,&count)==0);const uint8_t golden[]={0x80,0xe0,0xff,0xff,0,0,0,0,0,0,0,1,0x65,0x80};assert(count==sizeof golden&&!memcmp(bytes,golden,count));
 zc_rtp_state state;assert(zc_rtp_packetizer_state(cursor,&state)==0&&state.total==1&&state.emitted==1&&state.next_sequence==0&&state.next_bytes==0);assert(zc_rtp_packetizer_close(cursor)==0);
 assert(zc_rtp_timestamp(1000000000,90000,0,&count)==0&&count==90000);assert(zc_rtp_timestamp_signed(-42666666,48000,0,&count)==0&&count==0xfffff800u);
 zc_rtcp_report report={.struct_size=sizeof report,.ssrc=123,.rtp_timestamp=99,.packets=4,.octets=22,.bye=1,.unix_ns=1500000000};assert(zc_rtcp_sender_report(&report,(const uint8_t*)"trail",5,NULL,0,&count)==0&&count==52);assert(zc_rtcp_sender_report(&report,(const uint8_t*)"trail",5,bytes,sizeof bytes,&count)==0&&bytes[1]==200&&bytes[29]==202&&bytes[45]==203);
 const uint8_t sps[]={0x42,1,1,0xa2,0,0,3,0,1,0x12,0x34,0x56,0x78,0x9a,0xbc,156};zc_rtp_hevc_profile_info profile;assert(zc_rtp_hevc_profile(sps,sizeof sps,&profile)==0&&profile.space==2&&profile.tier==1&&profile.profile_id==2&&profile.compatibility==1&&profile.constraints==UINT64_C(0x123456789abc)&&profile.level==156);
 return 0;
}
