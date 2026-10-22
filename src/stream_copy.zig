//! Borrowed tight-copy plans shared by request capture and producer admission.
const c = @import("abi.zig").c;
/// Tight owned-copy byte count. Does not dereference source plane pointers.
pub fn byteCount(m: *const c.zc_stream, out: *u64) c_int {
    const std = @import("std");
    if (m.width == 0 or m.height == 0 or m.width > 16384 or m.height > 16384) return c.ZC_INVALID;
    const name = std.mem.sliceTo(&m.format, 0);
    const pixels = @as(u64, m.width) * m.height;
    const size = if (@import("processed_format.zig").layout(name)) |layout| pixels * layout.bytes() else if (@import("processed_format.zig").is422(name)) blk: {
        if (m.width & 1 != 0) return c.ZC_INVALID;
        break :blk pixels * 2;
    } else if (@import("processed_format.zig").isYuv(name)) blk: {
        if ((m.width | m.height) & 1 != 0) return c.ZC_INVALID;
        break :blk pixels + pixels / 2;
    } else blk: {
        const format = @import("raw.zig").Format.parse(name) catch return c.ZC_UNSUPPORTED;
        const row = format.rowBytes(m.width) catch return c.ZC_INVALID;
        break :blk @as(u64, row) * m.height;
    };
    out.* = size;
    return c.ZC_OK;
}
/// Borrowed plane plan shared by single-stream and atomic bundle copies.
/// No pixel is read here. Caller retains the request and serializes CPU access.
pub fn plan(m: *const c.zc_stream, out: *[3]@import("home/plane_pack.zig").Plane) !usize {
    const std = @import("std");
    if (m.plane_count == 0 or m.plane_count > c.ZC_MAX_PLANES) return error.InvalidGeometry;
    var required: u64 = 0;
    const rc = byteCount(m, &required);
    if (rc != 0) return if (rc == c.ZC_UNSUPPORTED) error.UnsupportedFormat else error.InvalidGeometry;
    for (m.planes[0..m.plane_count]) |p| {
        if (p.data == null or p.bytes_used > p.length or p.bytes_used > std.math.maxInt(usize)) return error.InvalidGeometry;
    }
    const name = std.mem.sliceTo(&m.format, 0);
    if (@import("processed_format.zig").isYuv(name) and !@import("processed_format.zig").is422(name)) {
        if ((m.stride | m.width | m.height) & 1 != 0) return error.InvalidGeometry;
        if (@import("processed_format.zig").semi(@import("processed_format.zig").code(name).?)) {
            var planes: [2][]const u8 = undefined;
            if (m.plane_count == 2) {
                for (0..2) |i| planes[i] = m.planes[i].data[0..@intCast(m.planes[i].bytes_used)];
            } else if (m.plane_count == 1) {
                const ysize = std.math.mul(usize, m.stride, m.height) catch return error.InvalidGeometry;
                const data = m.planes[0].data[0..@intCast(m.planes[0].bytes_used)];
                if (data.len < ysize) return error.BufferTooSmall;
                planes = .{ data[0..ysize], data[ysize..] };
            } else return error.UnsupportedFormat;
            for (0..2) |i| out[i] = .{ .source = planes[i], .stride = m.stride, .row_bytes = m.width, .height = if (i == 0) m.height else m.height / 2 };
            return 2;
        }
        var planes: [3][]const u8 = undefined;
        if (m.plane_count == 3) {
            for (0..3) |i| planes[i] = m.planes[i].data[0..@intCast(m.planes[i].bytes_used)];
        } else if (m.plane_count == 1) {
            const ysize = std.math.mul(usize, m.stride, m.height) catch return error.InvalidGeometry;
            const data = m.planes[0].data[0..@intCast(m.planes[0].bytes_used)];
            const u_end = std.math.add(usize, ysize, ysize / 4) catch return error.InvalidGeometry;
            if (data.len < u_end) return error.InvalidGeometry;
            planes = .{ data[0..ysize], data[ysize..u_end], data[u_end..] };
        } else return error.UnsupportedFormat;
        for (0..3) |i| out[i] = .{ .source = planes[i], .stride = if (i == 0) m.stride else m.stride / 2, .row_bytes = if (i == 0) m.width else m.width / 2, .height = if (i == 0) m.height else m.height / 2 };
        return 3;
    }
    if (m.plane_count != 1) return error.InvalidGeometry;
    const row: usize = if (@import("processed_format.zig").is422(name)) @as(usize, m.width) * 2 else if (@import("processed_format.zig").layout(name)) |layout| @as(usize, m.width) * layout.bytes() else blk: {
        const format = @import("raw.zig").Format.parse(name) catch return error.UnsupportedFormat;
        break :blk format.rowBytes(m.width) catch return error.InvalidGeometry;
    };
    out[0] = .{ .source = m.planes[0].data[0..@intCast(m.planes[0].bytes_used)], .stride = m.stride, .row_bytes = row, .height = m.height };
    return 1;
}

pub fn copy(stream: *const c.zc_stream, output: []u8) !void {
    const pack = @import("home/plane_pack.zig");
    var descriptions: [3]pack.Plane = undefined;
    const count = try plan(stream, &descriptions);
    _ = try pack.pack(descriptions[0..count], output);
}
