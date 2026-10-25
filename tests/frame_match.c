#include "zig_camera.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
_Static_assert(sizeof(zc_frame_match) == 32, "frame match ABI");
static uint64_t next(uint64_t *state) {
    *state ^= *state << 13; *state ^= *state >> 7; *state ^= *state << 17;
    return *state;
}
int main(void) {
    zc_frame_match out, before;
    memset(&out, 0xa5, sizeof out); before = out;
    uint64_t stamps[9] = {0, UINT64_MAX};
    assert(zc_match_frame_timestamps(NULL, 2, 0, &out) == ZC_INVALID);
    assert(memcmp(&out, &before, sizeof out) == 0);
    assert(zc_match_frame_timestamps(stamps, 1, 0, &out) == ZC_INVALID);
    assert(memcmp(&out, &before, sizeof out) == 0);
    assert(zc_match_frame_timestamps(stamps, 9, 0, &out) == ZC_INVALID);
    assert(memcmp(&out, &before, sizeof out) == 0);
    assert(zc_match_frame_timestamps(stamps, 2, 0, NULL) == ZC_INVALID);
    uint64_t state = 0x16349217abcdefULL;
    for (unsigned count = 2; count <= 8; ++count) {
        for (unsigned row = 0; row < 4096; ++row) {
            for (unsigned i = 0; i < count; ++i) stamps[i] = row < 4 ? (i == 0 ? 0 : UINT64_MAX) : next(&state);
            uint64_t tolerance = row == 0 ? UINT64_MAX : row == 1 ? UINT64_MAX - 1 : row == 2 ? 0 : next(&state);
            unsigned mask = 0;
            uint64_t lo = UINT64_MAX, hi = 0;
            for (unsigned i = 0; i < count; ++i) {
                if (stamps[i] < lo) lo = stamps[i];
                if (stamps[i] > hi) hi = stamps[i];
                for (unsigned j = 0; j < count; ++j)
                    if ((__int128)stamps[j] - (__int128)stamps[i] > (__int128)tolerance) mask |= 1u << i;
            }
            assert(zc_match_frame_timestamps(stamps, count, tolerance, &out) == ZC_OK);
            assert(out.struct_size == sizeof out && out.replace_mask == mask);
            assert(out.earliest_ns == lo && out.latest_ns == hi && out.skew_ns == hi - lo);
        }
    }
    puts("independent widened C reference validated 28672 timestamp tuples and guarded ABI rejection");
}
