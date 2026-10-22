//! C/libcamera names differ from byte order on little-endian libcamera hosts.
const std = @import("std");
const c = @import("abi.zig").c;
pub const rgb = @import("home/packed_rgb.zig");
pub fn valid(value: u32) bool {
    return value <= c.ZC_BGRX32;
}
pub fn name(value: u32) []const u8 {
    return switch (value) {
        c.ZC_YUV420 => "YUV420",
        c.ZC_RGB24 => "BGR888",
        c.ZC_BGR24 => "RGB888",
        c.ZC_RGBX32 => "XBGR8888",
        c.ZC_BGRX32 => "XRGB8888",
        else => unreachable,
    };
}
pub fn code(value: []const u8) ?u32 {
    for (0..c.ZC_BGRX32 + 1) |i| if (std.mem.eql(u8, value, name(@intCast(i)))) return @intCast(i);
    return null;
}
pub fn layout(value: []const u8) ?rgb.Layout {
    return switch (code(value) orelse return null) {
        c.ZC_RGB24 => .rgb,
        c.ZC_BGR24 => .bgr,
        c.ZC_RGBX32 => .rgbx,
        c.ZC_BGRX32 => .bgrx,
        else => null,
    };
}
pub fn bytes(value: u32) u32 {
    return switch (value) {
        c.ZC_YUV420 => 1,
        c.ZC_RGB24, c.ZC_BGR24 => 3,
        c.ZC_RGBX32, c.ZC_BGRX32 => 4,
        else => unreachable,
    };
}
