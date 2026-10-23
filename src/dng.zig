//! Streaming uncompressed Bayer DNG, with a bounded TIFF directory and row scratch.
//! TIFF entry representation/Bayer conventions adapted from Home (MIT; NOTICE).
const std = @import("std");
const c = @import("abi.zig").c;
const raw = @import("raw.zig");
const Entry = struct { tag: u16, field_type: u16, count: u32, value_offset: u32 };
const count = 30;
const Directory = struct {
    bytes: [4096]u8 = @splat(0),
    n: usize = 0,
    end: usize = 0,
    target: u16 = count,
    fn init(entries: u16) Directory {
        var d: Directory = .{ .end = 8 + 2 + @as(usize, entries) * 12 + 4, .target = entries };
        d.bytes[0..4].* = .{ 0x49, 0x49, 42, 0 };
        std.mem.writeInt(u32, d.bytes[4..8], 8, .little);
        std.mem.writeInt(u16, d.bytes[8..10], entries, .little);
        return d;
    }
    fn append(self: *Directory, bytes: []const u8) u32 {
        self.end = std.mem.alignForward(usize, self.end, 4);
        const offset = self.end;
        std.debug.assert(offset + bytes.len <= self.bytes.len);
        @memcpy(self.bytes[offset..][0..bytes.len], bytes);
        self.end += bytes.len;
        return @intCast(offset);
    }
    fn tag(self: *Directory, id: u16, typ: u16, n: u32, bytes: []const u8) void {
        std.debug.assert(self.n < self.target);
        const off = 10 + self.n * 12;
        self.n += 1;
        const entry = Entry{ .tag = id, .field_type = typ, .count = n, .value_offset = 0 };
        std.mem.writeInt(u16, self.bytes[off..][0..2], entry.tag, .little);
        std.mem.writeInt(u16, self.bytes[off + 2 ..][0..2], entry.field_type, .little);
        std.mem.writeInt(u32, self.bytes[off + 4 ..][0..4], entry.count, .little);
        if (bytes.len <= 4) @memcpy(self.bytes[off + 8 ..][0..bytes.len], bytes) else std.mem.writeInt(u32, self.bytes[off + 8 ..][0..4], self.append(bytes), .little);
    }
    fn short(self: *Directory, id: u16, v: u16) void {
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, v, .little);
        self.tag(id, 3, 1, &b);
    }
    fn long(self: *Directory, id: u16, v: u32) void {
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, v, .little);
        self.tag(id, 4, 1, &b);
    }
    fn text(self: *Directory, id: u16, v: []const u8) void {
        var b: [256]u8 = @splat(0);
        const n = @min(v.len, 254);
        @memcpy(b[0..n], v[0..n]);
        self.tag(id, 2, @intCast(n + 1), b[0 .. n + 1]);
    }
};
fn inverse(m: [9]f64) ![9]f64 {
    const a = m[0];
    const b = m[1];
    const d = m[3];
    const e = m[4];
    const f = m[5];
    const g = m[6];
    const h = m[7];
    const i = m[8];
    const cc = m[2];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + cc * (d * h - e * g);
    if (!std.math.isFinite(det) or @abs(det) < 1e-10) return error.InvalidCalibration;
    var result = [9]f64{ e * i - f * h, cc * h - b * i, b * f - cc * e, f * g - d * i, a * i - cc * g, cc * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d };
    for (&result) |*v| v.* /= det;
    return result;
}
pub fn colorMatrix(ccm: [9]f32, red: f32, blue: f32) ![9]f64 {
    if (!std.math.isFinite(red) or !std.math.isFinite(blue) or red <= 0 or blue <= 0) return error.InvalidCalibration;
    const rgb_to_xyz = [9]f64{ 0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041 };
    const wb = [3]f64{ red, 1, blue };
    var m: [9]f64 = @splat(0);
    for (ccm) |v| if (!std.math.isFinite(v) or @abs(v) > 100) return error.InvalidCalibration;
    for (0..3) |r| for (0..3) |col| {
        for (0..3) |k| m[r * 3 + col] += rgb_to_xyz[r * 3 + k] * ccm[k * 3 + col] * wb[col];
    };
    return inverse(m);
}
fn rational(out: *[8]u8, v: f64, den: u32, signed: bool) !void {
    if (!std.math.isFinite(v)) return error.InvalidCalibration;
    const scaled = @round(v * @as(f64, @floatFromInt(den)));
    if (signed) {
        if (scaled < std.math.minInt(i32) or scaled > std.math.maxInt(i32)) return error.InvalidCalibration;
        std.mem.writeInt(i32, out[0..4], @intFromFloat(scaled), .little);
    } else {
        if (scaled < 0 or scaled > std.math.maxInt(u32)) return error.InvalidCalibration;
        std.mem.writeInt(u32, out[0..4], @intFromFloat(scaled), .little);
    }
    std.mem.writeInt(u32, out[4..8], den, .little);
}
pub fn save(allocator: std.mem.Allocator, frame: *const c.zc_frame, meta: *const c.zc_raw_metadata, path: []const u8) !void {
    var atom = try std.fs.cwd().atomicFile(path, .{ .write_buffer = &.{} });
    defer atom.deinit();
    try write(allocator, frame, meta, atom.file_writer.file);
    try atom.finish();
}
pub fn write(allocator: std.mem.Allocator, frame: *const c.zc_frame, meta: *const c.zc_raw_metadata, sink: anytype) !void {
    const stream = frame.raw;
    if (stream.plane_count != 1) return error.UnsupportedFormat;
    const format = try raw.Format.parse(std.mem.sliceTo(&stream.format, 0));
    const mono = format.pattern == .mono;
    const required: u32 = if (mono) 1 else 7;
    if (meta.valid & required != required) return error.MissingCalibration;
    if (stream.planes[0].data == null or stream.planes[0].bytes_used > stream.planes[0].length or stream.planes[0].bytes_used > std.math.maxInt(usize)) return error.BufferTooSmall;
    const view = try raw.View.init(stream.planes[0].data[0..@intCast(stream.planes[0].bytes_used)], stream.width, stream.height, stream.stride, format);
    const pixels = try std.math.mul(u64, stream.width, stream.height);
    const size = std.math.mul(u64, pixels, 2) catch return error.FileTooLarge;
    if (size > std.math.maxInt(u32) - 4096) return error.FileTooLarge;
    const matrix = if (mono) [9]f64{ 1, 0, 0, 0, 1, 0, 0, 0, 1 } else try colorMatrix(meta.camera_to_srgb, frame.red_gain, frame.blue_gain);
    var cm: [72]u8 = undefined;
    for (matrix, 0..) |v, i| try rational(cm[i * 8 ..][0..8], v, 1_000_000, true);
    var black: [32]u8 = undefined;
    for (format.pattern.positions(), 0..) |p, i| {
        const level = @as(f64, meta.black_levels[p]) * @as(f64, @floatFromInt(@as(u32, 1) << format.bits)) / 65536.0;
        if (level < 0 or level >= @as(f64, @floatFromInt(format.white()))) return error.InvalidCalibration;
        try rational(black[i * 8 ..][0..8], level, 1024, false);
    }
    var neutral: [24]u8 = undefined;
    if (!mono) for ([3]f64{ 1.0 / frame.red_gain, 1, 1.0 / frame.blue_gain }, 0..) |v, i| try rational(neutral[i * 8 ..][0..8], v, 1_000_000, false);
    var dir = Directory.init(if (mono) 23 else count);
    dir.long(254, 0);
    dir.long(256, stream.width);
    dir.long(257, stream.height);
    dir.short(258, 16);
    dir.short(259, 1);
    dir.short(262, if (mono) 34892 else 32803);
    dir.text(271, "zig-camera/libcamera");
    dir.text(272, std.mem.sliceTo(&meta.model, 0));
    const strip_entry = dir.n;
    dir.long(273, 0);
    dir.short(274, 1);
    dir.short(277, 1);
    dir.long(278, stream.height);
    dir.long(279, @intCast(size));
    dir.short(284, 1);
    dir.text(305, "zig-camera");
    if (!mono) {
        dir.tag(33421, 3, 2, &.{ 2, 0, 2, 0 });
        dir.tag(33422, 1, 4, &format.pattern.cfa());
    }
    var exif: [26]u8 = @splat(0);
    std.mem.writeInt(u16, exif[0..2], 1, .little);
    std.mem.writeInt(u16, exif[2..4], 33434, .little);
    std.mem.writeInt(u16, exif[4..6], 5, .little);
    std.mem.writeInt(u32, exif[6..10], 1, .little);
    const exif_offset = dir.append(&exif);
    std.mem.writeInt(u32, dir.bytes[exif_offset + 10 ..][0..4], exif_offset + 18, .little);
    std.mem.writeInt(u32, dir.bytes[exif_offset + 18 ..][0..4], frame.exposure_us, .little);
    std.mem.writeInt(u32, dir.bytes[exif_offset + 22 ..][0..4], 1_000_000, .little);
    dir.long(34665, exif_offset);
    dir.tag(50706, 1, 4, &.{ 1, 4, 0, 0 });
    dir.tag(50707, 1, 4, &.{ 1, 1, 0, 0 });
    dir.text(50708, std.mem.sliceTo(&meta.model, 0));
    if (!mono) {
        dir.tag(50710, 1, 3, &.{ 0, 1, 2 });
        dir.short(50711, 1);
    }
    dir.tag(50713, 3, 2, if (mono) &.{ 1, 0, 1, 0 } else &.{ 2, 0, 2, 0 });
    dir.tag(50714, 5, if (mono) 1 else 4, if (mono) black[0..8] else &black);
    dir.long(50717, format.white());
    if (!mono) {
        dir.tag(50721, 10, 9, &cm);
        dir.tag(50728, 5, 3, &neutral);
        dir.short(50778, 21);
    }
    var active: [16]u8 = @splat(0);
    std.mem.writeInt(u32, active[8..12], stream.height, .little);
    std.mem.writeInt(u32, active[12..16], stream.width, .little);
    dir.tag(50829, 4, 4, &active);
    std.debug.assert(dir.n == dir.target);
    dir.end = std.mem.alignForward(usize, dir.end, 4);
    std.mem.writeInt(u32, dir.bytes[10 + strip_entry * 12 + 8 ..][0..4], @intCast(dir.end), .little);
    const scratch = try allocator.alloc(u8, @as(usize, stream.width) * 2);
    defer allocator.free(scratch);
    try sink.writeAll(dir.bytes[0..dir.end]);
    for (0..stream.height) |y| {
        try view.row(y, scratch);
        try sink.writeAll(scratch);
    }
}
test "colour calibration rejects singular and invalid transforms" {
    try std.testing.expectError(error.InvalidCalibration, colorMatrix(@splat(0), 1, 1));
    try std.testing.expectError(error.InvalidCalibration, colorMatrix(.{ 1, 0, 0, 0, 1, 0, 0, 0, 1 }, 0, 1));
    const m = try colorMatrix(.{ 1, 0, 0, 0, 1, 0, 0, 0, 1 }, 2, 1.5);
    try std.testing.expectApproxEqAbs(@as(f64, 3.2404548 / 2.0), m[0], 0.00001);
}
test "monochrome DNG needs scalar black calibration and emits no invented CFA or color matrices" {
    const t = std.testing;
    const Sink = struct {
        bytes: std.ArrayList(u8) = .empty,
        pub fn writeAll(self: *@This(), data: []const u8) !void {
            try self.bytes.appendSlice(t.allocator, data);
        }
    };
    var sink: Sink = .{};
    defer sink.bytes.deinit(t.allocator);
    const pixels = [_]u8{ 1, 2, 255, 0, 0, 0, 0, 0, 0, 7, 8, 9 };
    var frame = std.mem.zeroes(c.zc_frame);
    frame.raw.width = 3;
    frame.raw.height = 2;
    frame.raw.stride = 9;
    frame.raw.plane_count = 1;
    @memcpy(frame.raw.format[0..2], "R8");
    frame.raw.planes[0] = .{ .data = &pixels, .bytes_used = pixels.len, .length = pixels.len };
    var meta = std.mem.zeroes(c.zc_raw_metadata);
    meta.valid = 1;
    try write(t.allocator, &frame, &meta, &sink);
    const bytes = sink.bytes.items;
    try t.expectEqual(@as(u16, 23), std.mem.readInt(u16, bytes[8..10], .little));
    var strip: usize = 0;
    for (0..23) |i| {
        const p = 10 + i * 12;
        const tag = std.mem.readInt(u16, bytes[p..][0..2], .little);
        try t.expect(tag != 33421 and tag != 33422 and tag != 50710 and tag != 50711 and tag != 50721 and tag != 50728 and tag != 50778);
        if (tag == 262) try t.expectEqual(@as(u16, 34892), std.mem.readInt(u16, bytes[p + 8 ..][0..2], .little));
        if (tag == 273) strip = std.mem.readInt(u32, bytes[p + 8 ..][0..4], .little);
    }
    try t.expectEqualSlices(u8, &.{ 1, 0, 2, 0, 255, 0, 7, 0, 8, 0, 9, 0 }, bytes[strip..]);
    const old_len = sink.bytes.items.len;
    meta.valid = 0;
    try t.expectError(error.MissingCalibration, write(t.allocator, &frame, &meta, &sink));
    try t.expectEqual(old_len, sink.bytes.items.len);
    meta.valid = 1;
    @memcpy(frame.raw.format[0..6], "SRGGB8");
    try t.expectError(error.MissingCalibration, write(t.allocator, &frame, &meta, &sink));
}
