//! C ABI adapters around Home's portable color-description policy.
const std = @import("std");
const c = @import("abi.zig").c;
pub const home = @import("home/color_description.zig");
pub fn fromSpace(value: c.zc_color_space) ?home.Description {
    if (value.struct_size != @sizeOf(c.zc_color_space) or value.present != 1) return null;
    return home.Description.fromCodes(value.primaries, value.transfer, value.ycbcr_encoding, value.range) catch null;
}
pub fn toSpace(value: home.Description) c.zc_color_space {
    return .{ .struct_size = @sizeOf(c.zc_color_space), .present = 1, .primaries = @intFromEnum(value.primaries), .transfer = @intFromEnum(value.transfer), .ycbcr_encoding = @intFromEnum(value.matrix), .range = @intFromEnum(value.range) };
}
pub fn defaults() c.zc_processed_options {
    var result = std.mem.zeroes(c.zc_processed_options);
    result.struct_size = @sizeOf(c.zc_processed_options);
    result.main_format = c.ZC_RGB24;
    result.color_space.struct_size = @sizeOf(c.zc_color_space);
    return result;
}
pub export fn zc_default_processed_options(out: *c.zc_processed_options) void {
    out.* = defaults();
}
pub export fn zc_color_space_preset(value: u32, out: *c.zc_color_space) c_int {
    const preset = std.enums.fromInt(home.Preset, value) orelse return c.ZC_INVALID;
    out.* = toSpace(home.preset(preset));
    return c.ZC_OK;
}
pub export fn zc_check_processed_options(value: *const c.zc_processed_options, pipeline: *const c.zc_pipeline_options) c_int {
    if (value.struct_size != @sizeOf(c.zc_processed_options) or value.main_format > c.ZC_BGR48 or value.strict_color > 1 or pipeline.struct_size != @sizeOf(c.zc_pipeline_options) or pipeline.lores_format > c.ZC_BGR48) return c.ZC_INVALID;
    const space = value.color_space;
    if (space.struct_size != @sizeOf(c.zc_color_space) or space.present > 1) return c.ZC_INVALID;
    if (space.present == 0) {
        if (value.strict_color != 0 or space.primaries != 0 or space.transfer != 0 or space.ycbcr_encoding != 0 or space.range != 0) return c.ZC_INVALID;
        return c.ZC_OK;
    }
    const requested = fromSpace(space) orelse return c.ZC_INVALID;
    _ = requested.processed(@import("processed_format.zig").yuv(value.main_format)) catch return c.ZC_INVALID;
    if (pipeline.lores_width != 0) _ = requested.processed(@import("processed_format.zig").yuv(pipeline.lores_format)) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
/// Synthetic source setup shares the backend-default sYCC recipe. Real hardware
/// receives a request; its negotiated metadata is queried independently.
pub fn effective(requested: c.zc_color_space, format: u32) !c.zc_color_space {
    const color = if (requested.present == 0) home.preset(.sycc) else fromSpace(requested) orelse return error.InvalidColorSpace;
    return toSpace(try color.processed(@import("processed_format.zig").yuv(format)));
}
pub fn negotiation(value: c.zc_processed_options, actual: c.zc_color_space, format: u32, enforce: bool, out: *c.zc_color_negotiation) c_int {
    var result = std.mem.zeroes(c.zc_color_negotiation);
    result.struct_size = @sizeOf(c.zc_color_negotiation);
    result.format = format;
    result.requested = value.color_space;
    result.effective.struct_size = @sizeOf(c.zc_color_space);
    result.actual = actual;
    if (value.color_space.present == 1) {
        const requested = fromSpace(value.color_space) orelse return c.ZC_INVALID;
        const policy = home.negotiate(requested, fromSpace(actual), @import("processed_format.zig").yuv(format), enforce and value.strict_color != 0) catch |err| return if (err == error.ColorSpaceAdjusted) c.ZC_UNSUPPORTED else c.ZC_INVALID;
        result.effective = toSpace(policy.effective);
        result.flags = 1 | (value.strict_color << 1) | (@as(u32, @intFromBool(policy.normalized)) << 2) | (@as(u32, @intFromBool(policy.adjusted)) << 3);
    }
    out.* = result;
    return c.ZC_OK;
}
test "portable colors preserve ABI codes and strict unknown-result rejection" {
    const t = std.testing;
    try t.expectEqual(@as(usize, 36), @sizeOf(c.zc_processed_options));
    try t.expectEqual(@as(usize, 88), @sizeOf(c.zc_color_negotiation));
    try t.expectEqual(c.ZC_PRIMARIES_REC2020, @intFromEnum(home.Primaries.rec2020));
    try t.expectEqual(c.ZC_TRANSFER_REC709, @intFromEnum(home.Transfer.rec709));
    try t.expectEqual(c.ZC_YCBCR_REC2020, @intFromEnum(home.Matrix.rec2020));
    var options = defaults();
    try t.expectEqual(c.ZC_OK, zc_color_space_preset(c.ZC_COLOR_REC709, &options.color_space));
    options.strict_color = 1;
    const rgb = try effective(options.color_space, c.ZC_RGB24);
    var out: c.zc_color_negotiation = undefined;
    try t.expectEqual(c.ZC_OK, negotiation(options, rgb, c.ZC_RGB24, true, &out));
    try t.expectEqual(@as(u32, 7), out.flags);
    const missing = std.mem.zeroes(c.zc_color_space);
    try t.expectEqual(c.ZC_UNSUPPORTED, negotiation(options, missing, c.ZC_RGB24, true, &out));
    try t.expectEqual(c.ZC_OK, negotiation(options, missing, c.ZC_RGB24, false, &out));
    try t.expectEqual(@as(u32, 15), out.flags);
}
