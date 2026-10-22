//! Checked stream conversion; source planes remain protected by the caller's lease.
const std = @import("std");
const c = @import("abi.zig").c;
const home = @import("home/yuv_rgb.zig");
const raster = @import("home/raster_encoder.zig");
pub fn conversion(space: c.zc_color_space) !home.Conversion {
    if (space.present != 1) return error.UnsupportedFormat;
    const matrix: home.Matrix = switch (space.ycbcr_encoding) {
        c.ZC_YCBCR_REC601 => .bt601,
        c.ZC_YCBCR_REC709 => .bt709,
        c.ZC_YCBCR_REC2020 => .bt2020,
        else => return error.UnsupportedFormat,
    };
    const range: home.Range = switch (space.range) {
        c.ZC_RANGE_FULL => .full,
        c.ZC_RANGE_LIMITED => .limited,
        else => return error.UnsupportedFormat,
    };
    return home.Conversion.init(matrix, range);
}
fn plane(p: c.zc_plane) ![]const u8 {
    if (p.data == null or p.bytes_used > p.length or p.bytes_used > std.math.maxInt(usize)) return error.BufferTooSmall;
    return p.data[0..@intCast(p.bytes_used)];
}
pub fn size(stream: c.zc_stream) !usize {
    if (stream.width == 0 or stream.height == 0 or stream.width > 16384 or stream.height > 16384) return error.InvalidGeometry;
    return @as(usize, stream.width) * stream.height * 3;
}
pub fn packedView(stream: c.zc_stream) !@import("home/packed_rgb.zig").View {
    _ = try size(stream);
    if (stream.plane_count != 1) return error.UnsupportedFormat;
    const layout = @import("processed_format.zig").layout(std.mem.sliceTo(&stream.format, 0)) orelse return error.UnsupportedFormat;
    return @import("home/packed_rgb.zig").View.init(try plane(stream.planes[0]), stream.width, stream.height, stream.stride, layout);
}
pub fn rgbView(stream: c.zc_stream) !raster.View {
    _ = try size(stream);
    if (stream.plane_count != 1 or !std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR888")) return error.UnsupportedFormat;
    const view = raster.View{ .width = stream.width, .height = stream.height, .stride = stream.stride, .data = try plane(stream.planes[0]) };
    _ = try view.validate();
    return view;
}
pub fn packed422View(stream: c.zc_stream) !@import("home/packed_yuv422.zig").View {
    _ = try size(stream);
    if (stream.plane_count != 1) return error.UnsupportedFormat;
    const layout = @import("processed_format.zig").layout422(std.mem.sliceTo(&stream.format, 0)) orelse return error.UnsupportedFormat;
    return @import("home/packed_yuv422.zig").View.init(try plane(stream.planes[0]), stream.width, stream.height, stream.stride, layout);
}
pub fn i420View(stream: c.zc_stream) !home.I420 {
    _ = try size(stream);
    const format = @import("processed_format.zig").code(std.mem.sliceTo(&stream.format, 0)) orelse return error.UnsupportedFormat;
    if (!@import("processed_format.zig").yuv420(format)) return error.UnsupportedFormat;
    if ((stream.stride | stream.width | stream.height) & 1 != 0) return error.InvalidGeometry;
    if (@import("processed_format.zig").semi(format)) {
        var planes: [2][]const u8 = undefined;
        if (stream.plane_count == 2) {
            for (0..2) |i| planes[i] = try plane(stream.planes[i]);
        } else if (stream.plane_count == 1) {
            const data = try plane(stream.planes[0]);
            const ysize = @as(usize, stream.stride) * stream.height;
            if (data.len < ysize) return error.BufferTooSmall;
            planes = .{ data[0..ysize], data[ysize..] };
        } else return error.UnsupportedFormat;
        return home.I420.semiPlanar(stream.width, stream.height, planes[0], stream.stride, planes[1], stream.stride, format == c.ZC_NV21);
    }
    var planes: [3][]const u8 = undefined;
    if (stream.plane_count == 3) {
        for (0..3) |i| planes[i] = try plane(stream.planes[i]);
    } else if (stream.plane_count == 1) {
        const data = try plane(stream.planes[0]);
        const ysize = @as(usize, stream.stride) * stream.height;
        if (data.len < ysize + ysize / 4) return error.BufferTooSmall;
        planes = .{ data[0..ysize], data[ysize..][0 .. ysize / 4], data[ysize + ysize / 4 ..] };
    } else return error.UnsupportedFormat;
    if (format == c.ZC_YVU420) std.mem.swap([]const u8, &planes[1], &planes[2]);
    const view = home.I420{ .width = stream.width, .height = stream.height, .planes = planes, .strides = .{ stream.stride, stream.stride / 2, stream.stride / 2 } };
    try view.validate();
    return view;
}
pub fn copy(stream: c.zc_stream, space: c.zc_color_space, out: []u8) !void {
    const required = try size(stream);
    if (out.len < required) return error.BufferTooSmall;
    if (@import("processed_format.zig").layout(std.mem.sliceTo(&stream.format, 0)) != null) {
        const view = try packedView(stream);
        try view.convert(out, @as(usize, stream.width) * 3, .rgb);
    } else if (@import("processed_format.zig").is422(std.mem.sliceTo(&stream.format, 0))) try (try packed422View(stream)).decodeRgb(try conversion(space), out, stream.width * 3) else try home.decode420(try i420View(stream), try conversion(space), out, stream.width * 3);
}
/// Borrow canonical RGB rows directly; other layouts own one RGB conversion buffer.
pub const Selected = struct {
    frame: c.zc_frame,
    owned: ?[]u8 = null,
    pub fn init(allocator: std.mem.Allocator, source: c.zc_frame, stream: c.zc_stream, space: c.zc_color_space) !Selected {
        var result = Selected{ .frame = source };
        result.frame.main = stream;
        if (std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR888")) {
            _ = try rgbView(stream);
        } else {
            if (@import("processed_format.zig").layout(std.mem.sliceTo(&stream.format, 0)) != null) {
                _ = try packedView(stream);
            } else {
                if (@import("processed_format.zig").is422(std.mem.sliceTo(&stream.format, 0))) {
                    _ = try packed422View(stream);
                } else {
                    _ = try i420View(stream);
                }
                _ = try conversion(space);
            }
            const data = try allocator.alloc(u8, try size(stream));
            errdefer allocator.free(data);
            try copy(stream, space, data);
            result.owned = data;
            result.frame.main.stride = stream.width * 3;
            result.frame.main.plane_count = 1;
            @memset(&result.frame.main.format, 0);
            @memcpy(result.frame.main.format[0..6], "BGR888");
            result.frame.main.planes = @splat(std.mem.zeroes(c.zc_plane));
            result.frame.main.planes[0] = .{ .data = data.ptr, .length = data.len, .bytes_used = data.len, .offset = 0, .fd = -1, .reserved = 0 };
        }
        return result;
    }
    pub fn deinit(self: Selected, allocator: std.mem.Allocator) void {
        if (self.owned) |bytes| allocator.free(bytes);
    }
};

fn testPlane(bytes: []const u8) c.zc_plane {
    return .{ .data = bytes.ptr, .length = bytes.len, .bytes_used = bytes.len, .offset = 0, .fd = -1, .reserved = 0 };
}
fn testStream() c.zc_stream {
    var stream = std.mem.zeroes(c.zc_stream);
    stream.width = 4;
    stream.height = 2;
    stream.stride = 8;
    stream.plane_count = 3;
    @memcpy(stream.format[0..6], "YUV420");
    stream.planes[0] = testPlane(&.{ 81, 81, 81, 81, 9, 9, 9, 9, 81, 81, 81, 81 });
    stream.planes[1] = testPlane(&.{ 90, 90 });
    stream.planes[2] = testPlane(&.{ 240, 240 });
    return stream;
}
fn testColor() c.zc_color_space {
    return .{ .struct_size = @sizeOf(c.zc_color_space), .present = 1, .primaries = c.ZC_PRIMARIES_SMPTE170M, .transfer = c.ZC_TRANSFER_REC709, .ycbcr_encoding = c.ZC_YCBCR_REC601, .range = c.ZC_RANGE_LIMITED };
}
test "split and contiguous I420 validate complete source before copying or converting" {
    const t = std.testing;
    var stream = testStream();
    var output: [24]u8 = @splat(77);
    const color = testColor();
    try copy(stream, color, &output);
    const expected = [_]u8{ 254, 0, 0 } ** 8;
    try t.expectEqualSlices(u8, &expected, &output);
    stream.plane_count = 1;
    stream.planes[0] = testPlane(&.{ 81, 81, 81, 81, 9, 9, 9, 9, 81, 81, 81, 81, 9, 9, 9, 9, 90, 90, 9, 9, 240, 240 });
    @memset(&output, 77);
    try copy(stream, color, &output);
    try t.expectEqualSlices(u8, &expected, &output);
    @memset(&output, 77);
    stream.planes[0].bytes_used -= 1;
    try t.expectError(error.BufferTooSmall, copy(stream, color, &output));
    try t.expectEqualSlices(u8, &@as([24]u8, @splat(77)), &output);
    stream = testStream();
    var bad_color = color;
    bad_color.range = 0;
    try t.expectError(error.UnsupportedFormat, copy(stream, bad_color, &output));
    try t.expectEqualSlices(u8, &@as([24]u8, @splat(77)), &output);
    bad_color = color;
    bad_color.ycbcr_encoding = c.ZC_YCBCR_NONE;
    try t.expectError(error.UnsupportedFormat, copy(stream, bad_color, &output));
    bad_color = color;
    bad_color.present = 0;
    try t.expectError(error.UnsupportedFormat, copy(stream, bad_color, &output));
    stream.planes[2].bytes_used = 3;
    try t.expectError(error.BufferTooSmall, copy(stream, color, &output));
    try t.expectEqualSlices(u8, &@as([24]u8, @splat(77)), &output);
}
fn selectedAllocation(allocator: std.mem.Allocator) !void {
    const source = std.mem.zeroes(c.zc_frame);
    const selected = try Selected.init(allocator, source, testStream(), testColor());
    defer selected.deinit(allocator);
    try std.testing.expect(selected.owned != null);
    try std.testing.expectEqual(@as(u8, 254), selected.frame.main.planes[0].data[0]);
}
test "RGB selection borrows rows while I420 selection owns one explicit conversion buffer" {
    const t = std.testing;
    try t.checkAllAllocationFailures(t.allocator, selectedAllocation, .{});
    var stream = std.mem.zeroes(c.zc_stream);
    stream.width = 1;
    stream.height = 2;
    stream.stride = 4;
    stream.plane_count = 1;
    @memcpy(stream.format[0..6], "BGR888");
    stream.planes[0] = testPlane(&.{ 1, 2, 3, 99, 4, 5, 6 });
    const selected = try Selected.init(t.allocator, std.mem.zeroes(c.zc_frame), stream, std.mem.zeroes(c.zc_color_space));
    defer selected.deinit(t.allocator);
    try t.expectEqual(null, selected.owned);
    try t.expectEqual(stream.planes[0].data, selected.frame.main.planes[0].data);
    var out: [6]u8 = undefined;
    try copy(stream, std.mem.zeroes(c.zc_color_space), &out);
    try t.expectEqualSlices(u8, &.{ 1, 2, 3, 4, 5, 6 }, &out);
}

test "packed RGB conversion validates before allocation and normalizes unused X without alpha" {
    const t = std.testing;
    for ([_][]const u8{ "RGB888", "XBGR8888", "XRGB8888" }) |name| {
        var stream = std.mem.zeroes(c.zc_stream);
        stream.width = 2;
        stream.height = 2;
        const layout = @import("processed_format.zig").layout(name).?;
        stream.stride = @intCast(2 * layout.bytes() + 3);
        stream.plane_count = 1;
        @memcpy(stream.format[0..name.len], name);
        var bytes: [32]u8 = @splat(0);
        for (0..2) |y| for (0..2) |x| layout.write(bytes[y * stream.stride + x * layout.bytes() ..], .{ @intCast(1 + x), @intCast(3 + y), 5, 0 });
        if (layout.bytes() == 4) for (0..2) |y| for (0..2) |x| {
            bytes[y * stream.stride + x * 4 + 3] = 0;
        };
        stream.planes[0] = testPlane(bytes[0 .. stream.stride + 2 * layout.bytes()]);
        var out: [14]u8 = @splat(79);
        try copy(stream, std.mem.zeroes(c.zc_color_space), &out);
        try t.expectEqualSlices(u8, &.{ 1, 3, 5, 2, 3, 5, 1, 4, 5, 2, 4, 5, 79, 79 }, &out);
        const selected = try Selected.init(t.allocator, std.mem.zeroes(c.zc_frame), stream, std.mem.zeroes(c.zc_color_space));
        defer selected.deinit(t.allocator);
        try t.expect(selected.owned != null);
        try t.expectEqualStrings("BGR888", std.mem.sliceTo(&selected.frame.main.format, 0));
        stream.planes[0].bytes_used -= 1;
        @memset(&out, 79);
        try t.expectError(error.BufferTooSmall, copy(stream, std.mem.zeroes(c.zc_color_space), &out));
        try t.expectEqualSlices(u8, &@as([14]u8, @splat(79)), &out);
    }
}

test "planar VU and split or contiguous NV chroma support absent last padding and reject truncated tails atomically" {
    const t = std.testing;
    for ([_]u32{ c.ZC_YVU420, c.ZC_NV12, c.ZC_NV21 }) |format| for ([_]bool{ false, true }) |contiguous| {
        const pf = @import("processed_format.zig");
        var bytes: [48]u8 = @splat(99);
        for (0..4) |y| @memset(bytes[y * 8 ..][0..4], 81);
        const name = pf.name(format);
        var stream = std.mem.zeroes(c.zc_stream);
        stream.width = 4;
        stream.height = 4;
        stream.stride = 8;
        stream.plane_count = if (contiguous) 1 else pf.planes(format);
        @memcpy(stream.format[0..name.len], name);
        var length: usize = 0;
        if (pf.semi(format)) {
            for (0..2) |y| for (0..2) |x| {
                bytes[32 + y * 8 + x * 2] = if (format == c.ZC_NV12) 90 else 240;
                bytes[32 + y * 8 + x * 2 + 1] = if (format == c.ZC_NV12) 240 else 90;
            };
            length = 44;
            stream.planes[0] = testPlane(bytes[0..28]);
            stream.planes[1] = testPlane(bytes[32..44]);
        } else {
            for (0..2) |y| {
                @memset(bytes[32 + y * 4 ..][0..2], 240);
                @memset(bytes[40 + y * 4 ..][0..2], 90);
            }
            length = 46;
            stream.planes[0] = testPlane(bytes[0..28]);
            stream.planes[1] = testPlane(bytes[32..38]);
            stream.planes[2] = testPlane(bytes[40..46]);
        }
        if (contiguous) stream.planes[0] = testPlane(bytes[0..length]);
        var out: [48]u8 = @splat(79);
        try copy(stream, testColor(), &out);
        try t.expectEqualSlices(u8, &([_]u8{ 254, 0, 0 } ** 16), &out);
        const source = try i420View(stream);
        var packed_out: [24]u8 = undefined;
        try source.copyI420(&packed_out);
        try t.expectEqualSlices(u8, &([_]u8{81} ** 16 ++ [_]u8{90} ** 4 ++ [_]u8{240} ** 4), &packed_out);
        const last = stream.plane_count - 1;
        stream.planes[last].bytes_used -= 1;
        @memset(&out, 79);
        try t.expectError(error.BufferTooSmall, copy(stream, testColor(), &out));
        try t.expectEqualSlices(u8, &@as([48]u8, @splat(79)), &out);
        stream.planes[last].bytes_used += 1;
        stream.planes[last].length = 0;
        try t.expectError(error.BufferTooSmall, copy(stream, testColor(), &out));
    };
}
