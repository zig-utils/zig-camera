#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
#include <jpeglib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include "zig_camera.h"
struct zc_jpeg_error { struct jpeg_error_mgr base; jmp_buf jump; };
static void fail(j_common_ptr info) { longjmp(((struct zc_jpeg_error *)info->err)->jump, 1); }
int zcd_write_jpeg_fd_markers(const zc_frame *f, int fd, uint32_t quality, const uint8_t *markers, size_t marker_length) {
    if ((marker_length && !markers) || marker_length > 32u*1024u*1024u) return ZC_INVALID;
    for (size_t at=0; at<marker_length;) {
        if (marker_length-at<4 || markers[at]!=255 || (markers[at+1]!=0xe1 && markers[at+1]!=0xe2)) return ZC_INVALID;
        const size_t size=((size_t)markers[at+2]<<8)|markers[at+3];
        if (size<2 || size>marker_length-at-2) return ZC_INVALID;
        at+=size+2;
    }
    if (!f || fd < 0 || quality < 1 || quality > 100 || f->main.plane_count != 1) return ZC_INVALID;
    const zc_stream *s = &f->main;
    if (!s->planes[0].data || s->planes[0].bytes_used > s->planes[0].length || !s->width || !s->height || s->stride < (uint64_t)s->width * 3 ||
        s->planes[0].bytes_used < (uint64_t)(s->height-1)*s->stride + (uint64_t)s->width*3) return ZC_INVALID;
    /* Zig owns atomic replacement and the original descriptor. stdio owns only
     * this duplicate, including on codec failure and fclose/flush errors. */
    int owned;
    do { owned = fcntl(fd, F_DUPFD_CLOEXEC, 0); } while (owned < 0 && errno == EINTR);
    if (owned < 0) return ZC_IO;
    FILE *file = fdopen(owned, "wb");
    if (!file) { close(owned); return ZC_IO; }
    /* Heap allocation keeps state well-defined across the C setjmp/longjmp boundary. */
    struct jpeg_compress_struct *info = calloc(1, sizeof(*info));
    struct zc_jpeg_error *error = malloc(sizeof(*error));
    if (!info || !error) { free(info); free(error); fclose(file); return ZC_NOMEM; }
    info->err = jpeg_std_error(&error->base);
    error->base.error_exit = fail;
    if (setjmp(error->jump)) {
        jpeg_destroy_compress(info); free(info); free(error); fclose(file); return ZC_IO;
    }
    jpeg_create_compress(info);
    jpeg_stdio_dest(info, file);
    info->image_width = s->width; info->image_height = s->height;
    info->input_components = 3; info->in_color_space = JCS_RGB;
    jpeg_set_defaults(info);
    for (int i=0; i<3; ++i) { info->comp_info[i].h_samp_factor=1; info->comp_info[i].v_samp_factor=1; }
    jpeg_set_quality(info, (int)quality, TRUE);
    jpeg_start_compress(info, TRUE);
    for (size_t at=0; at<marker_length;) {
        const size_t size=((size_t)markers[at+2]<<8)|markers[at+3];
        jpeg_write_marker(info,markers[at+1],markers+at+4,(unsigned int)(size-2));
        at+=size+2;
    }
    while (info->next_scanline < info->image_height) {
        JSAMPROW row = (JSAMPROW)(s->planes[0].data + (uint64_t)info->next_scanline * s->stride);
        jpeg_write_scanlines(info, &row, 1);
    }
    jpeg_finish_compress(info);
    jpeg_destroy_compress(info); free(info); free(error);
    return fclose(file) == 0 ? ZC_OK : ZC_IO;
}

int zcd_write_jpeg_fd(const zc_frame *f, int fd, uint32_t quality) {
    return zcd_write_jpeg_fd_markers(f,fd,quality,NULL,0);
}
