//! Validation and compact ownership for recorder inputs. Format/color checks are
//! admission checks, before any PCM write, encoder mutation or output callback.
const std = @import("std");
const c = @import("abi.zig").c;
const streams = @import("stream_rgb.zig");
pub fn validateColor(space: c.zc_color_space, yuv: bool) !void {
    return validateColorFor(space, yuv, @import("recording_color.zig").legacy());
}
pub fn validateColorFor(space: c.zc_color_space, yuv: bool, target: c.zc_color_space) !void {
    if (space.struct_size != @sizeOf(c.zc_color_space) or space.present != 1) return error.Unsupported;
    _ = try @import("recording_color.zig").description(target);
    // Matrix/range remapping cannot transform transfer functions or primaries.
    if (space.primaries != target.primaries or space.transfer != target.transfer) return error.Unsupported;
    if (yuv) {
        _ = streams.conversion(space) catch return error.Unsupported;
    } else if (space.ycbcr_encoding != c.ZC_YCBCR_NONE or space.range != c.ZC_RANGE_FULL) return error.Unsupported;
}
pub fn validate(stream: c.zc_stream, color: ?c.zc_color_space) !bool {
    return validateFor(stream, color, @import("recording_color.zig").legacy());
}
pub fn validateFor(stream: c.zc_stream, color: ?c.zc_color_space, target: c.zc_color_space) !bool {
    const yuv = std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "YUV420");
    if (color) |space| try validateColorFor(space, yuv, target) else {
        if (yuv) return error.Unsupported;
        var assumed = @import("recording_color.zig").legacy();
        assumed.ycbcr_encoding = c.ZC_YCBCR_NONE;
        assumed.range = c.ZC_RANGE_FULL;
        try validateColorFor(assumed, false, target);
    }
    if (yuv) {
        _ = try streams.i420View(stream);
    } else {
        _ = try streams.packedView(stream);
    }
    return yuv;
}
pub fn packedSize(stream: c.zc_stream, yuv: bool) usize {
    const pixels = @as(usize, stream.width) * stream.height;
    return if (yuv) pixels + pixels / 2 else pixels * @import("processed_format.zig").layout(std.mem.sliceTo(&stream.format, 0)).?.bytes();
}
pub fn copy(stream: c.zc_stream, yuv: bool, out: []u8) !void {
    if (yuv) {
        const source = try streams.i420View(stream);
        try @import("home/plane_pack.zig").packI420(source.planes, .{ source.strides[0], source.strides[1], source.strides[2] }, stream.width, stream.height, out);
    } else {
        const source = try streams.packedView(stream);
        try @import("home/plane_pack.zig").rows(source.data, source.stride, @as(usize, stream.width) * source.layout.bytes(), stream.height, out);
    }
}
pub fn remap(space: c.zc_color_space) !@import("home/yuv_remap.zig").Remap {
    return remapFor(space, @import("recording_color.zig").legacy());
}
pub fn remapFor(space: c.zc_color_space, target: c.zc_color_space) !@import("home/yuv_remap.zig").Remap {
    try validateColorFor(space, true, target);
    const matrix: @import("home/yuv_rgb.zig").Matrix = switch (space.ycbcr_encoding) {
        c.ZC_YCBCR_REC601 => .bt601,
        c.ZC_YCBCR_REC709 => .bt709,
        c.ZC_YCBCR_REC2020 => .bt2020,
        else => return error.Unsupported,
    };
    const profile = @import("recording_color.zig");
    return @import("home/yuv_remap.zig").Remap.init(matrix, if (space.range == c.ZC_RANGE_FULL) .full else .limited, try profile.matrix(target), try profile.range(target));
}
