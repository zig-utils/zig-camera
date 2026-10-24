/* Independent POSIX peer: real mappings/fds, narrowly armed cleanup failures. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <sys/mman.h>
#ifdef __APPLE__
#define PEER_MUNMAP zc_unmap_peer_munmap
#define PEER_MMAP zc_unmap_peer_mmap
#define PEER_CLOSE zc_unmap_peer_close
extern int close_nocancel(int) __asm("_close$NOCANCEL");
#else
#include <sys/syscall.h>
#define PEER_MUNMAP munmap
#define PEER_MMAP mmap
#define PEER_CLOSE close
#endif
#include <unistd.h>
static pthread_mutex_t lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition=PTHREAD_COND_INITIALIZER;
static int failures, close_fd=-1, block_next, entered, resume, map_fault, skip;
static uint64_t attempts;
static void *last_address;
static size_t last_length;
void zc_unmap_peer_arm(int count) {
    pthread_mutex_lock(&lock);failures=count;attempts=0;last_address=0;last_length=0;skip=0;pthread_mutex_unlock(&lock);
}
void zc_unmap_peer_map_fault(int nth) { pthread_mutex_lock(&lock);map_fault=nth;pthread_mutex_unlock(&lock); }
void zc_unmap_peer_skip(int count) { pthread_mutex_lock(&lock);skip=count;pthread_mutex_unlock(&lock); }
void zc_unmap_peer_close_fault(int fd) { pthread_mutex_lock(&lock);close_fd=fd;pthread_mutex_unlock(&lock); }
void zc_unmap_peer_block(void) { pthread_mutex_lock(&lock);block_next=1;entered=resume=0;pthread_mutex_unlock(&lock); }
void zc_unmap_peer_entered(void) { pthread_mutex_lock(&lock);while(!entered)pthread_cond_wait(&condition,&lock);pthread_mutex_unlock(&lock); }
void zc_unmap_peer_resume(void) { pthread_mutex_lock(&lock);resume=1;pthread_cond_broadcast(&condition);pthread_mutex_unlock(&lock); }
uint64_t zc_unmap_peer_attempts(void) { pthread_mutex_lock(&lock);uint64_t value=attempts;pthread_mutex_unlock(&lock);return value; }
void *zc_unmap_peer_address(size_t *length) { pthread_mutex_lock(&lock);void *value=last_address;*length=last_length;pthread_mutex_unlock(&lock);return value; }
int PEER_MUNMAP(void *address,size_t length) {
    pthread_mutex_lock(&lock);
    attempts++;
    if(block_next){block_next=0;entered=1;pthread_cond_broadcast(&condition);while(!resume)pthread_cond_wait(&condition,&lock);}
    if(skip)skip--;
    else if(failures){if(failures>0)failures--;last_address=address;last_length=length;pthread_mutex_unlock(&lock);errno=EIO;return -1;}
    pthread_mutex_unlock(&lock);
#ifdef __APPLE__
    return munmap(address,length);
#else
    return (int)syscall(SYS_munmap,address,length);
#endif
}
void *PEER_MMAP(void *address,size_t length,int protection,int flags,int fd,off_t offset) {
    pthread_mutex_lock(&lock);
    const int fail=(flags&MAP_SHARED) && map_fault>0 && --map_fault==0;
    pthread_mutex_unlock(&lock);
    if(fail){errno=ENOMEM;return MAP_FAILED;}
#ifdef __APPLE__
    return mmap(address,length,protection,flags,fd,offset);
#else
    return (void *)syscall(SYS_mmap,address,length,protection,flags,fd,offset);
#endif
}
int PEER_CLOSE(int fd) {
    pthread_mutex_lock(&lock);const int fail=fd>=0 && fd==close_fd;if(fail)close_fd=-1;pthread_mutex_unlock(&lock);
#ifdef __APPLE__
    const int result=close(fd);
#else
    const int result=(int)syscall(SYS_close,fd);
#endif
    if(fail){assert(result==0);errno=EIO;return -1;}
    return result;
}
#ifdef __APPLE__
__attribute__((used)) static const struct { const void *replacement,*original; }
interpose[] __attribute__((section("__DATA,__interpose")))={
    {(const void *)&PEER_MUNMAP,(const void *)&munmap},
    {(const void *)&PEER_MMAP,(const void *)&mmap},
    {(const void *)&PEER_CLOSE,(const void *)&close},
    {(const void *)&PEER_CLOSE,(const void *)&close_nocancel},
};
#endif
