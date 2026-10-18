/* Independent FAAD2 raw AAC-LC decoding. No FFmpeg/Libav. */
#include <neaacdec.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
static void require(int ok,const char *why) {if(!ok){fprintf(stderr,"%s\n",why);exit(1);}}
static uint32_t length(FILE *file) {
    uint8_t b[4];require(fread(b,1,4,file)==4,"truncated AAC unit length");
    return (uint32_t)b[0]<<24|(uint32_t)b[1]<<16|(uint32_t)b[2]<<8|b[3];
}
int main(int argc,char **argv) {
    require(argc==3,"usage: decode-aac units.aacraw output.pcm");
    FILE *input=fopen(argv[1],"rb"),*output=fopen(argv[2],"wb");require(input && output,"open AAC fixture");
    uint32_t n=length(input);require(n==2,"AAC-LC config size");unsigned char config[2];require(fread(config,1,2,input)==2,"read ASC");
    NeAACDecHandle decoder=NeAACDecOpen();require(decoder!=NULL,"open FAAD");
    NeAACDecConfigurationPtr settings=NeAACDecGetCurrentConfiguration(decoder);settings->outputFormat=FAAD_FMT_16BIT;
    require(NeAACDecSetConfiguration(decoder,settings)==1,"configure FAAD output");
    unsigned long rate=0;unsigned char channels=0;
    require(NeAACDecInit2(decoder,config,2,&rate,&channels)==0,"parse AAC configuration");
    /* Expose the initial synthesis frame as well, so MP4's edit list is the
       only place decoder priming is removed. FAAD otherwise suppresses it. */
    NeAACDecPostSeekReset(decoder,1);
    unsigned packets=0;
    while(1) {
        int first=fgetc(input);if(first==EOF)break;require(ungetc(first,input)!=EOF,"AAC stream seek");
        n=length(input);require(n>0 && n<=8192,"AAC unit size");unsigned char bytes[8192];require(fread(bytes,1,n,input)==n,"AAC unit payload");
        NeAACDecFrameInfo info={0};void *pcm=NeAACDecDecode(decoder,&info,bytes,n);
        if(info.error){fprintf(stderr,"FAAD: %s\n",NeAACDecGetErrorMessage(info.error));return 1;}
        require(pcm && info.channels==channels && info.samplerate==rate && info.samples==1024u*channels,"AAC decoded shape/count");
        const int16_t *samples=(const int16_t*)pcm;
        for(unsigned long i=0;i<info.samples;i++) {uint16_t value=(uint16_t)samples[i];uint8_t b[2]={(uint8_t)value,(uint8_t)(value>>8)};require(fwrite(b,1,2,output)==2,"write decoded PCM");}
        packets++;
    }
    require(packets>0,"no AAC packets");NeAACDecClose(decoder);require(fclose(output)==0,"close decoded PCM");fclose(input);
    printf("FAAD: %u independently decoded AAC-LC packets, %lu Hz, %u channels\n",packets,rate,channels);return 0;
}
