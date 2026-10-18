//! Geometry/shape and range checks shared by real and synthetic control batches.
const std = @import("std");
const c = @import("abi.zig").c;
pub fn valid(v: *const c.zc_control, info: *const c.zc_control_info) bool {
    if (v.reserved != 0 or v.id != info.id or v.type != info.type or v.count < info.min_count or v.count > info.max_count or v.count > 16 or v.count == 0) return false;
    for (v.values[0..v.count]) |n| {
        if (!std.math.isFinite(n)) return false;
    }
    if (v.type == c.ZC_RECT) {
        if (v.count % 4 != 0) return false;
        var i: usize = 0;
        while (i < v.count) : (i += 4) {
            const r = v.values[i..][0..4];
            for (r) |n| {
                if (@floor(n) != n or n < 0 or n > std.math.maxInt(i32)) return false;
            }
            if (r[2] <= 0 or r[3] <= 0 or r[0] < info.max[0] or r[1] < info.max[1] or r[0] + r[2] > info.max[0] + info.max[2] or r[1] + r[3] > info.max[1] + info.max[3]) return false;
            if (r[2] < info.min[2] or r[3] < info.min[3]) return false;
        }
    } else {
        for (v.values[0..v.count], 0..) |n, i| {
            if (n < info.min[i] or n > info.max[i]) return false;
            if (v.type != c.ZC_FLOAT and @floor(n) != n) return false;
            if (v.type == c.ZC_INT and @abs(n) > 9007199254740991) return false;
            if (info.enum_mask != 0 and (n < 0 or n > 63 or info.enum_mask & (@as(u64, 1) << @as(u6, @intFromFloat(n))) == 0)) return false;
        }
    }
    if (v.id == c.ZC_FRAME_DURATION_LIMITS and v.values[0] > v.values[1]) return false;
    return true;
}
