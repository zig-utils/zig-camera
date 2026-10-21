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
#include <iterator>
static void require(bool ok,const char *why) { if(!ok){std::fprintf(stderr,"%s\n",why);std::exit(1);} }
static int first_index=0;
static unsigned reference_width=0,reference_height=0;
static std::vector<uint8_t> reference_i420;
static std::vector<uint64_t> expected_indices;
static void picture(const uint8_t *y,int stride,int width,int height,int &count) {
    require(width==128 && height==96,"decoded dimensions differ");
    require(expected_indices.empty() || (size_t)count<expected_indices.size(),"unexpected decoded frame");
    const uint64_t index=expected_indices.empty() ? (uint64_t)first_index+count : expected_indices[count];
    const int blue=(int)(index%4)*37;
    const int expected=((66*60+129*25+25*blue+128)>>8)+16;
    require(std::abs((int)y[25*stride+60]-expected)<=4,"decoded pixel/order differs");
    count++;
}
static void checkFrame(const uint8_t *const planes[3],const int strides[3],int width,int height,int &count) {
    if(reference_i420.empty()){picture(planes[0],strides[0],width,height,count);return;}
    require(width==(int)reference_width && height==(int)reference_height,"reference dimensions differ");
    const size_t pixels=(size_t)width*height,frame_size=pixels+pixels/2;
    require((size_t)(count+1)<=reference_i420.size()/frame_size,"unexpected reference frame");
    size_t offset=(size_t)count*frame_size;
    for(unsigned component=0;component<3;component++) {
        const unsigned w=component ? reference_width/2 : reference_width,h=component ? reference_height/2 : reference_height;
        require(planes[component] && strides[component]>=(int)w,"invalid decoded plane");
        uint64_t error=0;
        for(unsigned y=0;y<h;y++)for(unsigned x=0;x<w;x++)error+=(unsigned)std::abs((int)planes[component][(size_t)y*strides[component]+x]-(int)reference_i420[offset+(size_t)y*w+x]);
        require(error<=(uint64_t)w*h*4,"decoded I420 component differs from independent reference");
        offset+=(size_t)w*h;
    }
    count++;
}
int main(int argc,char **argv) {
    require((argc>=3 && argc<=6)||argc==8,"usage: decode-codecs h264|hevc file.aus [frames [first_index [sequence_file]]]");
    const int expected_count=argc>=4 ? std::atoi(argv[3]) : 12;
    const bool reference_mode=argc==8;
    first_index=!reference_mode && argc>=5 ? std::atoi(argv[4]) : 0;
    if(reference_mode) {
        require(!std::strcmp(argv[4],"--i420"),"invalid pixel reference mode");
        reference_width=(unsigned)std::strtoul(argv[5],nullptr,10);reference_height=(unsigned)std::strtoul(argv[6],nullptr,10);
        require(reference_width && reference_height && reference_width<=8192 && reference_height<=8192 && !((reference_width|reference_height)&1),"invalid reference geometry");
        std::ifstream reference(argv[7],std::ios::binary);require(reference.good(),"open pixel reference");
        reference_i420.assign(std::istreambuf_iterator<char>(reference),std::istreambuf_iterator<char>());
        require(reference.eof()||reference.good(),"read pixel reference");
        require(reference_i420.size()==(size_t)reference_width*reference_height*3/2*(size_t)expected_count,"invalid reference size");
    }
    require(expected_count>0 && first_index>=0,"invalid expected frame range");
    if(argc==6) {
        std::ifstream sequences(argv[5]);require(sequences.good(),"open expected sequences");
        uint64_t index;
        while(sequences>>index) {
            require(expected_indices.size()<(size_t)expected_count,"too many expected sequences");
            expected_indices.push_back(index);
        }
        require(sequences.eof() && expected_indices.size()==(size_t)expected_count,"invalid expected sequences");
    }
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
            int u_stride=0,v_stride=0;
            const uint8_t *planes[]={y,de265_get_image_plane(image,1,&u_stride),de265_get_image_plane(image,2,&v_stride)};
            const int strides[]={stride,u_stride,v_stride};
            checkFrame(planes,strides,de265_get_image_width(image,0),de265_get_image_height(image,0),count);
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
            if(info.iBufferStatus==1) {const uint8_t *decoded[]={planes[0],planes[1],planes[2]};const int strides[]={info.UsrData.sSystemBuffer.iStride[0],info.UsrData.sSystemBuffer.iStride[1],info.UsrData.sSystemBuffer.iStride[1]};checkFrame(decoded,strides,info.UsrData.sSystemBuffer.iWidth,info.UsrData.sSystemBuffer.iHeight,count);}
        } else {
            require(de265_isOK(de265_push_data(hevc,bytes.data(),(int)n,0,nullptr)),"libde265 push failure");
            de265_push_end_of_frame(hevc);decode_hevc();
        }
    }
    if(avc) {
        int remaining=0;avc->GetOption(DECODER_OPTION_NUM_OF_FRAMES_REMAINING_IN_BUFFER,&remaining);
        while(remaining-->0){unsigned char *planes[3]{};SBufferInfo info{};require(avc->FlushFrame(planes,&info)==dsErrorFree,"OpenH264 flush");if(info.iBufferStatus==1){const uint8_t *decoded[]={planes[0],planes[1],planes[2]};const int strides[]={info.UsrData.sSystemBuffer.iStride[0],info.UsrData.sSystemBuffer.iStride[1],info.UsrData.sSystemBuffer.iStride[1]};checkFrame(decoded,strides,info.UsrData.sSystemBuffer.iWidth,info.UsrData.sSystemBuffer.iHeight,count);}}
        avc->Uninitialize();WelsDestroyDecoder(avc);
    } else {require(de265_isOK(de265_flush_data(hevc)),"libde265 flush");decode_hevc();drain();de265_free_decoder(hevc);}
    require(count==expected_count,"missing decoded frames");
    std::printf("%s: independently decoded all %d frames with expected luma/order\n",argv[1],count);
}
