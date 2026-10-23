//! One checked tight-copy plan for local and received request streams.
const std = @import("std");
const c = @import("abi.zig").c;
const pack = @import("home/plane_pack.zig");
pub fn validate(ids: []const u32) !void {
    if (ids.len == 0 or ids.len > 3) return error.InvalidGeometry;
    var seen: u32 = 0;
    for (ids) |id| {
        if (id > c.ZC_LORES) return error.InvalidGeometry;
        const bit = @as(u32, 1) << @as(u5, @intCast(id));
        if (seen & bit != 0) return error.InvalidGeometry;
        seen |= bit;
    }
}
pub const Plan = struct {
    planes: [9]pack.Plane = undefined,
    plane_count: usize = 0,
    layouts: [3]c.zc_packed_stream = undefined,
    count: usize,
    size: usize = 0,
    pub fn init(ids: []const u32, sources: []const c.zc_stream) !Plan {
        try validate(ids);
        if (sources.len != ids.len) return error.InvalidGeometry;
        var result = Plan{ .count = ids.len };
        for (ids, sources, 0..) |id, source, i| {
            var selected: [3]pack.Plane = undefined;
            const n = try @import("stream_copy.zig").plan(&source, &selected);
            const length = try pack.packedSize(selected[0..n]);
            result.layouts[i] = .{ .stream = id, .width = source.width, .height = source.height, .row_bytes = @intCast(selected[0].row_bytes), .format = source.format, .offset = result.size, .length = length };
            result.size = try std.math.add(usize, result.size, length);
            @memcpy(result.planes[result.plane_count..][0..n], selected[0..n]);
            result.plane_count += n;
        }
        return result;
    }
    pub fn copy(self: *const Plan, data: []u8) !void {
        _ = try pack.pack(self.planes[0..self.plane_count], data);
    }
};
