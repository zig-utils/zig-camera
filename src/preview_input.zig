//! Selected borrowed preview streams. Pixels stay leased through the SDL copy.
const std = @import("std");
const c = @import("abi.zig").c;
const streams = @import("stream_rgb.zig");
const home = @import("home/yuv_rgb.zig");
pub export fn zc_preview_check_color(format: u32, color: ?*const c.zc_color_space) c_int {
    if (@import("processed_format.zig").valid(format) and !@import("processed_format.zig").yuv(format)) return c.ZC_OK;
    if (!@import("processed_format.zig").yuv(format)) return c.ZC_UNSUPPORTED;
    const value = color orelse return c.ZC_UNSUPPORTED;
    if (value.struct_size != @sizeOf(c.zc_color_space)) return c.ZC_INVALID;
    _ = streams.conversion(value.*) catch return c.ZC_UNSUPPORTED;
    return c.ZC_OK;
}
const Input = struct { stream: c.zc_stream, yuv: ?home.I420 = null, conversion: ?home.Conversion = null, packed_rgb: ?@import("home/packed_rgb.zig").View = null, packed422: ?@import("home/packed_yuv422.zig").View = null, wide: ?@import("home/rgb16_view.zig").View = null };
fn prepare(frame: *const c.zc_frame, color: ?*const c.zc_color_space) !Input {
    if (frame.token == 0) return error.InvalidGeometry;
    const selected = frame.main;
    if (std.mem.eql(u8, std.mem.sliceTo(&selected.format, 0), "BGR888")) {
        _ = try streams.rgbView(selected);
        return .{ .stream = selected };
    }
    if (@import("processed_format.zig").layout(std.mem.sliceTo(&selected.format, 0)) != null) return .{ .stream = selected, .packed_rgb = try streams.packedView(selected) };
    if (@import("processed_format.zig").isWide(std.mem.sliceTo(&selected.format, 0))) return .{ .stream = selected, .wide = try streams.wideView(selected) };
    const value = color orelse return error.UnsupportedFormat;
    const checked = zc_preview_check_color(c.ZC_YUV420, value);
    if (checked == c.ZC_INVALID) return error.InvalidGeometry;
    if (checked != c.ZC_OK) return error.UnsupportedFormat;
    if (@import("processed_format.zig").is422(std.mem.sliceTo(&selected.format, 0))) return .{ .stream = selected, .packed422 = try streams.packed422View(selected), .conversion = try streams.conversion(value.*) };
    return .{ .stream = selected, .yuv = try streams.i420View(selected), .conversion = try streams.conversion(value.*) };
}
extern fn zcm_preview_extent(*c.zc_preview, *u32, *u32) c_int;
extern fn zcm_preview_show(*c.zc_preview, *const c.zc_frame) c_int;
extern fn zcm_preview_rgb_begin(*c.zc_preview, *?[*]u8, *u64, *u32) c_int;
extern fn zcm_preview_rgb_end(*c.zc_preview, u32) c_int;
extern fn zcm_preview_background(*c.zc_preview) c_int;
pub export fn zc_preview_show_input(p: *c.zc_preview, frame: *const c.zc_frame, color: ?*const c.zc_color_space) c_int {
    if (@import("drm_preview.zig").owns(p)) return c.ZC_UNSUPPORTED;
    if (!@import("options").preview) return c.ZC_UNSUPPORTED;
    const input = prepare(frame, color) catch |err| return switch (err) {
        error.UnsupportedFormat => c.ZC_UNSUPPORTED,
        else => c.ZC_INVALID,
    };
    var width: u32 = 0;
    var height: u32 = 0;
    const dimensions = zcm_preview_extent(p, &width, &height);
    if (dimensions != c.ZC_OK) return dimensions;
    if (input.stream.width != width or input.stream.height != height) return c.ZC_INVALID;
    if (input.yuv != null or input.packed_rgb != null or input.packed422 != null or input.wide != null) {
        var pixels: ?[*]u8 = null;
        var length: u64 = 0;
        var stride: u32 = 0;
        const locked = zcm_preview_rgb_begin(p, &pixels, &length, &stride);
        if (locked != c.ZC_OK) return locked;
        var ended = false;
        defer if (!ended) {
            _ = zcm_preview_rgb_end(p, 0);
        };
        if (pixels == null or length > std.math.maxInt(usize)) return c.ZC_IO;
        if (input.yuv) |source| {
            home.decode420(source, input.conversion.?, pixels.?[0..@intCast(length)], stride) catch return c.ZC_IO;
        } else if (input.packed422) |source| {
            source.decodeRgb(input.conversion.?, pixels.?[0..@intCast(length)], stride) catch return c.ZC_IO;
        } else if (input.wide) |source| {
            source.toRgb8(pixels.?[0..@intCast(length)], stride) catch return c.ZC_IO;
        } else input.packed_rgb.?.convert(pixels.?[0..@intCast(length)], stride, .rgb) catch return c.ZC_IO;
        ended = true;
        return zcm_preview_rgb_end(p, 1);
    }
    var chosen = frame.*;
    chosen.main = input.stream;
    return zcm_preview_show(p, &chosen);
}
pub export fn zc_preview_show_background(p: *c.zc_preview) c_int {
    if (@import("drm_preview.zig").owns(p)) return @import("drm_preview.zig").background(p);
    if (!@import("options").preview) return c.ZC_UNSUPPORTED;
    return zcm_preview_background(p);
}
test "preview stream validation accepts padded I420 and rejects unknown color and truncated planes before any SDL call" {
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 1;
    frame.main.width = 2;
    frame.main.height = 2;
    frame.main.stride = 4;
    frame.main.plane_count = 3;
    @memcpy(frame.main.format[0..6], "YUV420");
    const ys = [_]u8{ 16, 235, 77, 77, 80, 120 };
    const us = [_]u8{128};
    const vs = [_]u8{128};
    for ([_][]const u8{ &ys, &us, &vs }, 0..) |plane, i| frame.main.planes[i] = .{ .data = plane.ptr, .length = plane.len, .bytes_used = plane.len, .fd = -1, .offset = 0, .reserved = 0 };
    var color = c.zc_color_space{ .struct_size = @sizeOf(c.zc_color_space), .present = 1, .primaries = c.ZC_PRIMARIES_REC709, .transfer = c.ZC_TRANSFER_SRGB, .ycbcr_encoding = c.ZC_YCBCR_REC709, .range = c.ZC_RANGE_LIMITED };
    const valid = try prepare(&frame, &color);
    try std.testing.expectEqual(@as(u32, 2), valid.yuv.?.width);
    try std.testing.expectError(error.UnsupportedFormat, prepare(&frame, null));
    color.ycbcr_encoding = 0;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_preview_check_color(c.ZC_YUV420, &color));
    color.ycbcr_encoding = c.ZC_YCBCR_REC709;
    frame.main.planes[2].bytes_used = 0;
    try std.testing.expectError(error.BufferTooSmall, prepare(&frame, &color));
    try std.testing.expectEqual(c.ZC_OK, zc_preview_check_color(c.ZC_RGB24, null));
}

pub export fn zc_preview_show_stream(p: *c.zc_preview, camera: *c.zc_camera, token: u64, which: u32) c_int {
    if (@import("drm_preview.zig").owns(p)) return @import("drm_preview.zig").show(p, camera, token, which);
    if (!@import("options").preview) return c.ZC_UNSUPPORTED;
    if (which != c.ZC_MAIN and which != c.ZC_LORES) return c.ZC_UNSUPPORTED;
    const core = @import("core.zig");
    var borrowed: core.ProcessedRead = undefined;
    const rc = core.beginProcessedRead(camera, token, which, &borrowed);
    if (rc != c.ZC_OK) return rc;
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = token;
    frame.main = borrowed.stream;
    const result = zc_preview_show_input(p, &frame, &borrowed.color);
    const cleanup = borrowed.finish();
    return if (cleanup != c.ZC_OK) cleanup else result;
}
