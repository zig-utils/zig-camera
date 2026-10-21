//! Borrowed, stride-aware RGB views. Integer luma coefficients adapted from
//! home-lang/home packages/image/src/simd.zig (MIT; see NOTICE).
const std = @import("std");
pub const Histogram = struct { r: [256]u64 = @splat(0), g: [256]u64 = @splat(0), b: [256]u64 = @splat(0) };
pub const RgbView = struct {
    data: []const u8,
    width: usize,
    height: usize,
    stride: usize,
    pub const Error = error{ InvalidGeometry, BufferTooSmall, ReleasedFrame, BusyFrame };
    pub fn init(data: []const u8, width: usize, height: usize, stride: usize) Error!RgbView {
        const row_bytes = std.math.mul(usize, width, 3) catch return error.InvalidGeometry;
        if (width == 0 or height == 0 or stride < row_bytes) return error.InvalidGeometry;
        const before_last = std.math.mul(usize, height - 1, stride) catch return error.InvalidGeometry;
        const needed = std.math.add(usize, before_last, row_bytes) catch return error.InvalidGeometry;
        if (data.len < needed) return error.BufferTooSmall;
        return .{ .data = data, .width = width, .height = height, .stride = stride };
    }
    pub fn row(self: RgbView, y: usize) []const u8 {
        std.debug.assert(y < self.height);
        return self.data[y * self.stride ..][0 .. self.width * 3];
    }
    pub fn histogram(self: RgbView) Histogram {
        var result: Histogram = .{};
        for (0..self.height) |y| {
            const bytes = self.row(y);
            var x: usize = 0;
            while (x < bytes.len) : (x += 3) {
                result.r[bytes[x]] += 1;
                result.g[bytes[x + 1]] += 1;
                result.b[bytes[x + 2]] += 1;
            }
        }
        return result;
    }
    /// BT.601 integer luma approximation. Caller owns output; no allocations.
    /// Operates on 16 pixels at a time with portable Zig vectors plus scalar tail.
    pub fn grayscale(self: RgbView, output: []u8, output_stride: usize) Error!void {
        if (output_stride < self.width) return error.InvalidGeometry;
        const before_last = std.math.mul(usize, self.height - 1, output_stride) catch return error.InvalidGeometry;
        const needed = std.math.add(usize, before_last, self.width) catch return error.InvalidGeometry;
        if (output.len < needed) return error.BufferTooSmall;
        const V = @Vector(16, u16);
        for (0..self.height) |y| {
            const src = self.row(y);
            const dst = output[y * output_stride ..][0..self.width];
            var x: usize = 0;
            while (self.width - x >= 16) : (x += 16) {
                var r: V = undefined;
                var g: V = undefined;
                var b: V = undefined;
                inline for (0..16) |p| {
                    r[p] = src[(x + p) * 3];
                    g[p] = src[(x + p) * 3 + 1];
                    b[p] = src[(x + p) * 3 + 2];
                }
                const result: @Vector(16, u8) = @intCast((r * @as(V, @splat(77)) + g * @as(V, @splat(150)) + b * @as(V, @splat(29))) >> @as(V, @splat(8)));
                dst[x..][0..16].* = result;
            }
            while (x < self.width) : (x += 1) {
                dst[x] = @intCast((@as(u16, src[x * 3]) * 77 + @as(u16, src[x * 3 + 1]) * 150 + @as(u16, src[x * 3 + 2]) * 29) >> 8);
            }
        }
    }
    /// Lossless RGB output; row padding is deliberately excluded.
    pub fn savePpm(self: RgbView, file: std.fs.File) !void {
        var header: [96]u8 = undefined;
        try file.writeAll(try std.fmt.bufPrint(&header, "P6\n{d} {d}\n255\n", .{ self.width, self.height }));
        for (0..self.height) |y| try file.writeAll(self.row(y));
    }
};
test "RGB views reject invalid geometry and overflow" {
    try std.testing.expectError(error.InvalidGeometry, RgbView.init(&.{}, 0, 1, 0));
    try std.testing.expectError(error.InvalidGeometry, RgbView.init(&.{}, std.math.maxInt(usize), 1, 8));
    try std.testing.expectError(error.InvalidGeometry, RgbView.init(&.{}, 1, std.math.maxInt(usize), 8));
    try std.testing.expectError(error.BufferTooSmall, RgbView.init(&.{ 0, 0 }, 1, 1, 3));
}
test "vector luma matches scalar for every tail with padded and unaligned rows" {
    var rng = std.Random.DefaultPrng.init(0x43414d455241);
    var input: [4096]u8 = undefined;
    rng.random().bytes(&input);
    var output: [1024]u8 = undefined;
    for (1..66) |width| {
        @memset(&output, 0xee);
        const stride = width * 3 + 7;
        const view = try RgbView.init(input[1..], width, 5, stride);
        try view.grayscale(&output, width + 3);
        for (0..5) |y| {
            for (0..width) |x| {
                const off = 1 + y * stride + x * 3;
                const expected: u8 = @intCast((@as(u16, input[off]) * 77 + @as(u16, input[off + 1]) * 150 + @as(u16, input[off + 2]) * 29) >> 8);
                try std.testing.expectEqual(expected, output[y * (width + 3) + x]);
            }
            try std.testing.expectEqual(@as(u8, 0xee), output[y * (width + 3) + width]);
        }
    }
}
test "histogram ignores padding and accepts absent final row padding" {
    const data = [_]u8{ 255, 0, 0, 17, 18, 19, 0, 255, 0 };
    const view = try RgbView.init(&data, 1, 2, 6);
    const h = view.histogram();
    try std.testing.expectEqual(@as(u64, 1), h.r[255]);
    try std.testing.expectEqual(@as(u64, 1), h.r[0]);
    try std.testing.expectEqual(@as(u64, 0), h.r[17]);
}
