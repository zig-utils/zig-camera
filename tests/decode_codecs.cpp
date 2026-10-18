/* Independent OpenH264/libde265 validation. No FFmpeg/Libav. */
#include <wels/codec_api.h>
#include <libde265/de265.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <fstream>
#include <cstdint>
#include <cmath>
static void require(bool ok,const char *why) { if(!ok){std::fprintf(stderr,"%s\n",why);std::exit(1);} }
static void picture(const uint8_t *y,int stride,int width,int height,int &count) {
    require(width==128 && height==96,"decoded dimensions differ");
    const int blue=(count%4)*37;
    const int expected=((66*60+129*25+25*blue+128)>>8)+16;
    require(std::abs((int)y[25*stride+60]-expected)<=4,"decoded pixel/order differs");
    count++;
}
int main(int argc,char **argv) {
    require(argc==3,"usage: decode-codecs h264|hevc file.aus");
    std::ifstream f(argv[2],std::ios::binary);require(f.good(),"open AUs");
    ISVCDecoder *avc=nullptr;de265_decoder_context *hevc=nullptr;
    if(!std::strcmp(argv[1],"h264")) {
        require(WelsCreateDecoder(&avc)==0,"create OpenH264");
        SDecodingParam p{};p.sVideoProperty.eVideoBsType=VIDEO_BITSTREAM_AVC;p.eEcActiveIdc=ERROR_CON_DISABLE;
        require(avc->Initialize(&p)==0,"initialize OpenH264");
    } else {hevc=de265_new_decoder();require(hevc!=nullptr,"create libde265");}
    int count=0;
    auto drain=[&](){
        while(const de265_image *image=de265_get_next_picture(hevc)) {
            int stride=0;const uint8_t *y=de265_get_image_plane(image,0,&stride);
            picture(y,stride,de265_get_image_width(image,0),de265_get_image_height(image,0),count);
        }
    };
    auto decode_hevc=[&](){
        int more=1;
        for(int i=0;more && i<10000;i++) {
            de265_error error=de265_decode(hevc,&more);
            require(de265_isOK(error) || error==DE265_ERROR_WAITING_FOR_INPUT_DATA,"libde265 decode failure");
            drain();
        }
        require(!more,"libde265 did not finish");
    };
    while(true) {
        uint8_t length[4];f.read((char*)length,4);if(f.eof())break;require(f.good(),"AU header");
        uint32_t n=(uint32_t)length[0]<<24|(uint32_t)length[1]<<16|(uint32_t)length[2]<<8|length[3];
        require(n && n<10000000,"AU size");std::vector<uint8_t> bytes(n);f.read((char*)bytes.data(),n);require(f.good(),"AU data");
        if(avc) {
            unsigned char *planes[3]{};SBufferInfo info{};
            require(avc->DecodeFrameNoDelay(bytes.data(),(int)n,planes,&info)==dsErrorFree,"OpenH264 decode failure");
            if(info.iBufferStatus==1) picture(planes[0],info.UsrData.sSystemBuffer.iStride[0],info.UsrData.sSystemBuffer.iWidth,info.UsrData.sSystemBuffer.iHeight,count);
        } else {
            require(de265_isOK(de265_push_data(hevc,bytes.data(),(int)n,0,nullptr)),"libde265 push failure");
            de265_push_end_of_frame(hevc);decode_hevc();
        }
    }
    if(avc) {
        int remaining=0;avc->GetOption(DECODER_OPTION_NUM_OF_FRAMES_REMAINING_IN_BUFFER,&remaining);
        while(remaining-->0){unsigned char *planes[3]{};SBufferInfo info{};require(avc->FlushFrame(planes,&info)==dsErrorFree,"OpenH264 flush");if(info.iBufferStatus==1)picture(planes[0],info.UsrData.sSystemBuffer.iStride[0],info.UsrData.sSystemBuffer.iWidth,info.UsrData.sSystemBuffer.iHeight,count);}
        avc->Uninitialize();WelsDestroyDecoder(avc);
    } else {require(de265_isOK(de265_flush_data(hevc)),"libde265 flush");decode_hevc();drain();de265_free_decoder(hevc);}
    require(count==12,"missing decoded frames");
    std::printf("%s: independently decoded all %d frames with expected luma/order\n",argv[1],count);
}
