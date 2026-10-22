//! C/libcamera names differ from byte order on little-endian libcamera hosts.
const std = @import("std");
const c = @import("abi.zig").c;
pub const rgb = @import("home/packed_rgb.zig");
pub fn valid(value: u32) bool {
    return value <= c.ZC_VYUY;
}
pub fn name(value: u32) []const u8 {
    return switch (value) {
        c.ZC_YUYV => "YUYV",
        c.ZC_YVYU => "YVYU",
        c.ZC_UYVY => "UYVY",
        c.ZC_VYUY => "VYUY",
        c.ZC_YUV420 => "YUV420",
        c.ZC_YVU420 => "YVU420",
        c.ZC_NV12 => "NV12",
        c.ZC_NV21 => "NV21",
        c.ZC_RGB24 => "BGR888",
        c.ZC_BGR24 => "RGB888",
        c.ZC_RGBX32 => "XBGR8888",
        c.ZC_BGRX32 => "XRGB8888",
        else => unreachable,
    };
}
pub fn code(value: []const u8) ?u32 {
    for (0..c.ZC_VYUY + 1) |i| if (std.mem.eql(u8, value, name(@intCast(i)))) return @intCast(i);
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
        c.ZC_YUV420, c.ZC_YVU420, c.ZC_NV12, c.ZC_NV21 => 1,
        c.ZC_YUYV, c.ZC_YVYU, c.ZC_UYVY, c.ZC_VYUY => 2,
        c.ZC_RGB24, c.ZC_BGR24 => 3,
        c.ZC_RGBX32, c.ZC_BGRX32 => 4,
        else => unreachable,
    };
}

pub fn yuv420(value: u32) bool {
    return value == c.ZC_YUV420 or value == c.ZC_YVU420 or value == c.ZC_NV12 or value == c.ZC_NV21;
}
pub fn isYuv(value: []const u8) bool {
    return yuv(code(value) orelse return false);
}
pub fn semi(value: u32) bool {
    return value == c.ZC_NV12 or value == c.ZC_NV21;
}
pub fn planes(value: u32) u32 {
    return if (semi(value)) 2 else if (yuv420(value)) 3 else 1;
}
pub fn alignment(value: u32) @import("home/stream_alignment.zig").Layout {
    return if (value == c.ZC_YUV420 or value == c.ZC_YVU420) .planar420 else if (bytes(value) == 4) .wide else .packed_pixels;
}
pub fn suffix(value: u32) []const u8 {
    return switch (value) {
        c.ZC_YUV420 => "i420",
        c.ZC_YVU420 => "yv12",
        c.ZC_NV12 => "nv12",
        c.ZC_NV21 => "nv21",
        c.ZC_YUYV => "yuyv",
        c.ZC_YVYU => "yvyu",
        c.ZC_UYVY => "uyvy",
        c.ZC_VYUY => "vyuy",
        else => @tagName(layout(name(value)).?),
    };
}

pub fn packed422(value: u32) bool {
    return value >= c.ZC_YUYV and value <= c.ZC_VYUY;
}
pub fn yuv(value: u32) bool {
    return yuv420(value) or packed422(value);
}
pub fn is422(value: []const u8) bool {
    return packed422(code(value) orelse return false);
}
pub fn layout422(value: []const u8) ?@import("home/packed_yuv422.zig").Layout {
    return switch (code(value) orelse return null) {
        c.ZC_YUYV => .yuyv,
        c.ZC_YVYU => .yvyu,
        c.ZC_UYVY => .uyvy,
        c.ZC_VYUY => .vyuy,
        else => null,
    };
}
pub fn geometry(value: u32, width: u32, height: u32) bool {
    return if (packed422(value)) width & 1 == 0 else if (yuv420(value)) (width | height) & 1 == 0 else true;
}
