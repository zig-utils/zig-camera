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
    const yuv = @import("processed_format.zig").isYuv(std.mem.sliceTo(&stream.format, 0));
    if (color) |space| try validateColorFor(space, yuv, target) else {
        if (yuv) return error.Unsupported;
        var assumed = @import("recording_color.zig").legacy();
        assumed.ycbcr_encoding = c.ZC_YCBCR_NONE;
        assumed.range = c.ZC_RANGE_FULL;
        try validateColorFor(assumed, false, target);
    }
    if (yuv) {
        if (@import("processed_format.zig").is422(std.mem.sliceTo(&stream.format, 0))) {
            _ = try streams.packed422View(stream);
        } else {
            _ = try streams.i420View(stream);
        }
    } else {
        if (@import("processed_format.zig").isWide(std.mem.sliceTo(&stream.format, 0))) {
            _ = try streams.wideView(stream);
        } else {
            _ = try streams.packedView(stream);
        }
    }
    return yuv;
}
pub fn packedSize(stream: c.zc_stream, yuv: bool) usize {
    const pixels = @as(usize, stream.width) * stream.height;
    return if (@import("processed_format.zig").isWide(std.mem.sliceTo(&stream.format, 0))) pixels * 6 else if (@import("processed_format.zig").is422(std.mem.sliceTo(&stream.format, 0))) pixels * 2 else if (yuv) pixels + pixels / 2 else pixels * @import("processed_format.zig").layout(std.mem.sliceTo(&stream.format, 0)).?.bytes();
}
/// Preserve the actual physical layout; workers consume logical chroma views.
pub fn copy(stream: c.zc_stream, yuv: bool, out: []u8) !void {
    if (yuv != @import("processed_format.zig").isYuv(std.mem.sliceTo(&stream.format, 0))) return error.Unsupported;
    try @import("stream_copy.zig").copy(&stream, out);
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
