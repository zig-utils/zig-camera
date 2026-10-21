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
pub fn rgbView(stream: c.zc_stream) !raster.View {
    _ = try size(stream);
    if (stream.plane_count != 1 or !std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR888")) return error.UnsupportedFormat;
    const view = raster.View{ .width = stream.width, .height = stream.height, .stride = stream.stride, .data = try plane(stream.planes[0]) };
    _ = try view.validate();
    return view;
}
pub fn i420View(stream: c.zc_stream) !home.I420 {
    _ = try size(stream);
    if (!std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "YUV420")) return error.UnsupportedFormat;
    if ((stream.stride | stream.width | stream.height) & 1 != 0) return error.InvalidGeometry;
    var planes: [3][]const u8 = undefined;
    if (stream.plane_count == 3) {
        for (0..3) |i| planes[i] = try plane(stream.planes[i]);
    } else if (stream.plane_count == 1) {
        const data = try plane(stream.planes[0]);
        const ysize = @as(usize, stream.stride) * stream.height;
        if (data.len < ysize + ysize / 4) return error.BufferTooSmall;
        planes = .{ data[0..ysize], data[ysize..][0 .. ysize / 4], data[ysize + ysize / 4 ..] };
    } else return error.UnsupportedFormat;
    const view = home.I420{ .width = stream.width, .height = stream.height, .planes = planes, .strides = .{ stream.stride, stream.stride / 2, stream.stride / 2 } };
    try view.validate();
    return view;
}
pub fn copy(stream: c.zc_stream, space: c.zc_color_space, out: []u8) !void {
    const required = try size(stream);
    if (out.len < required) return error.BufferTooSmall;
    if (std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR888")) {
        const view = try rgbView(stream);
        try @import("home/plane_pack.zig").rows(view.data, view.stride, @as(usize, view.width) * 3, view.height, out);
    } else try home.decode420(try i420View(stream), try conversion(space), out, stream.width * 3);
}
/// Borrow RGB rows directly; only YUV conversion allocates an explicit temporary.
pub const Selected = struct {
    frame: c.zc_frame,
    owned: ?[]u8 = null,
    pub fn init(allocator: std.mem.Allocator, source: c.zc_frame, stream: c.zc_stream, space: c.zc_color_space) !Selected {
        var result = Selected{ .frame = source };
        result.frame.main = stream;
        if (std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR888")) {
            _ = try rgbView(stream);
        } else {
            const view = try i420View(stream);
            const matrix = try conversion(space);
            const data = try allocator.alloc(u8, try size(stream));
            errdefer allocator.free(data);
            try home.decode420(view, matrix, data, stream.width * 3);
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
