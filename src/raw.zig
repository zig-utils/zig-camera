//! Borrowed Bayer planes, adapted from Home's BayerPattern model (see NOTICE).
const std = @import("std");
pub const Pattern = enum {
    rggb,
    bggr,
    grbg,
    gbrg,
    pub fn positions(self: Pattern) [4]u8 {
        return switch (self) {
            .rggb => .{ 0, 1, 2, 3 },
            .bggr => .{ 3, 2, 1, 0 },
            .grbg => .{ 1, 0, 3, 2 },
            .gbrg => .{ 2, 3, 0, 1 },
        };
    }
    pub fn cfa(self: Pattern) [4]u8 {
        const colors = [4]u8{ 0, 1, 1, 2 };
        var result: [4]u8 = undefined;
        for (self.positions(), 0..) |p, i| result[i] = colors[p];
        return result;
    }
};
pub const Format = struct {
    bits: u5,
    csi2_packed: bool,
    pattern: Pattern,
    pub fn parse(name: []const u8) !Format {
        if (name.len < 6 or name[0] != 'S') return error.UnsupportedFormat;
        const pattern: Pattern = if (std.mem.eql(u8, name[1..5], "RGGB")) .rggb else if (std.mem.eql(u8, name[1..5], "BGGR")) .bggr else if (std.mem.eql(u8, name[1..5], "GRBG")) .grbg else if (std.mem.eql(u8, name[1..5], "GBRG")) .gbrg else return error.UnsupportedFormat;
        const csi2_packed = std.mem.endsWith(u8, name, "_CSI2P");
        const depth = name[5..if (csi2_packed) name.len - 6 else name.len];
        const bits = std.fmt.parseInt(u5, depth, 10) catch return error.UnsupportedFormat;
        if (bits != 8 and bits != 10 and bits != 12 and bits != 14 and bits != 16) return error.UnsupportedFormat;
        if (csi2_packed and (bits == 8 or bits == 16)) return error.UnsupportedFormat;
        return .{ .bits = bits, .csi2_packed = csi2_packed, .pattern = pattern };
    }
    pub fn rowBytes(self: Format, width: usize) !usize {
        if (!self.csi2_packed) return std.math.mul(usize, width, if (self.bits == 8) 1 else 2) catch error.InvalidGeometry;
        const group: usize = if (self.bits == 12) 2 else 4;
        const size: usize = if (self.bits == 10) 5 else if (self.bits == 12) 3 else 7;
        return std.math.mul(usize, (std.math.add(usize, width, group - 1) catch return error.InvalidGeometry) / group, size) catch error.InvalidGeometry;
    }
    pub fn white(self: Format) u32 {
        return (@as(u32, 1) << self.bits) - 1;
    }
};
pub const View = struct {
    data: []const u8,
    width: usize,
    height: usize,
    stride: usize,
    format: Format,
    pub fn init(data: []const u8, width: usize, height: usize, stride: usize, format: Format) !View {
        if (width == 0 or height == 0) return error.InvalidGeometry;
        const row_bytes = try format.rowBytes(width);
        if (stride < row_bytes) return error.InvalidGeometry;
        const needed = std.math.add(usize, std.math.mul(usize, height - 1, stride) catch return error.InvalidGeometry, row_bytes) catch return error.InvalidGeometry;
        if (data.len < needed) return error.BufferTooSmall;
        return .{ .data = data, .width = width, .height = height, .stride = stride, .format = format };
    }
    /// Unpack one row directly into little-endian TIFF 16-bit output bytes.
    pub fn row(self: View, y: usize, out: []u8) !void {
        if (y >= self.height or out.len < self.width * 2) return error.BufferTooSmall;
        const src = self.data[y * self.stride ..];
        for (0..self.width) |x| {
            var value: u16 = 0;
            if (!self.format.csi2_packed) {
                value = if (self.format.bits == 8) src[x] else std.mem.readInt(u16, src[x * 2 ..][0..2], .little);
            } else {
                const group: usize = if (self.format.bits == 12) 2 else 4;
                const size: usize = if (self.format.bits == 10) 5 else if (self.format.bits == 12) 3 else 7;
                const p = x % group;
                const base = (x / group) * size;
                const low_bits: usize = self.format.bits - 8;
                const shift = p * low_bits;
                const byte = base + group + shift / 8;
                var low: u16 = src[byte];
                if (shift % 8 + low_bits > 8) low |= @as(u16, src[byte + 1]) << 8;
                value = (@as(u16, src[base + p]) << @intCast(low_bits)) | ((low >> @intCast(shift % 8)) & @as(u16, @intCast((@as(u32, 1) << @intCast(low_bits)) - 1)));
            }
            if (value > self.format.white()) return error.InvalidSample;
            std.mem.writeInt(u16, out[x * 2 ..][0..2], value, .little);
        }
    }
};
test "CSI-2 csi2_packed Bayer round trips all depths and partial groups" {
    for ([_]u5{ 10, 12, 14 }) |bits| {
        for (1..12) |width| {
            const f = Format{ .bits = bits, .csi2_packed = true, .pattern = .rggb };
            var encoded: [64]u8 = @splat(0);
            var expected: [16]u16 = undefined;
            var out: [32]u8 = undefined;
            const group: usize = if (bits == 12) 2 else 4;
            const size: usize = if (bits == 10) 5 else if (bits == 12) 3 else 7;
            for (0..width) |x| {
                const v: u16 = @intCast((x * 431 + 17) & f.white());
                expected[x] = v;
                const p = x % group;
                const base = x / group * size;
                const low_bits: usize = bits - 8;
                const shift = p * low_bits;
                encoded[base + p] = @intCast(v >> @intCast(low_bits));
                const low: u16 = (v & @as(u16, @intCast((@as(u32, 1) << @intCast(low_bits)) - 1))) << @intCast(shift % 8);
                encoded[base + group + shift / 8] |= @truncate(low);
                if (shift % 8 + low_bits > 8) encoded[base + group + shift / 8 + 1] |= @intCast(low >> 8);
            }
            const stride = try f.rowBytes(width);
            const v = try View.init(encoded[0..stride], width, 1, stride, f);
            try v.row(0, &out);
            for (0..width) |x| try std.testing.expectEqual(expected[x], std.mem.readInt(u16, out[x * 2 ..][0..2], .little));
        }
    }
}
test "raw format and geometry checks reject compressed/truncated data" {
    try std.testing.expectError(error.UnsupportedFormat, Format.parse("RGGB_PISP_COMP1"));
    try std.testing.expectError(error.UnsupportedFormat, Format.parse("SRGGB16_PISP_COMP1"));
    const f = try Format.parse("SBGGR12");
    try std.testing.expectEqual([4]u8{ 2, 1, 1, 0 }, f.pattern.cfa());
    try std.testing.expectError(error.BufferTooSmall, View.init(&.{0}, 2, 1, 4, f));
    try std.testing.expectError(error.InvalidGeometry, View.init(&.{}, std.math.maxInt(usize), 2, 0, f));
}
