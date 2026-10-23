//! Pointer-free, request-owned configuration records inside full HCAT metadata.
const std = @import("std");
const c = @import("abi.zig").c;
const wire = @import("home/typed_catalog.zig");
const projection = @import("home/catalog_projection.zig");
pub const base: u32 = 0x5a430000;
pub const limit: usize = 64 * 1024;
pub const vendor = "zig-camera";
pub const Stream = struct { description: c.zc_stream, color: c.zc_color_space };
pub const Snapshot = struct {
    config: c.zc_config,
    pipeline: c.zc_pipeline_options,
    processed: c.zc_processed_options,
    orientation: c.zc_orientation_info,
    strict_orientation: bool,
    id: []const u8,
    backend: u32,
    buffers: u32,
    sensor_width: u32,
    sensor_height: u32,
    sensor_bit_depth: u32,
    streams: [3]?Stream,
};
fn scalar(w: *wire.Writer, group: u32, id: u32, comptime name: []const u8, value: anytype) !void {
    const T = @TypeOf(value);
    const kind: wire.Kind = if (T == bool) .boolean else if (T == f32) .f32 else if (T == i64) .i64 else if (T == u32) .u32 else @compileError("configuration scalar type");
    var bytes: [@sizeOf(T)]u8 = undefined;
    if (T == bool) bytes[0] = @intFromBool(value) else if (T == f32) std.mem.writeInt(u32, &bytes, @bitCast(value), .little) else std.mem.writeInt(T, &bytes, value, .little);
    try w.begin(.{ .group = group, .id = id, .name = "Config." ++ name, .vendor = vendor, .kind = kind, .flags = 2 | 8 | 16 | 32 });
    try w.append(.{ .kind = kind, .data = &bytes });
    try w.end();
}
fn text(w: *wire.Writer, group: u32, id: u32, comptime name: []const u8, value: []const u8) !void {
    try w.begin(.{ .group = group, .id = id, .name = "Config." ++ name, .vendor = vendor, .kind = .string, .extent = @intCast(value.len), .flags = 2 | 4 | 8 | 16 | 32 });
    try w.append(.{ .kind = .string, .flags = 3, .count = @intCast(value.len), .data = value });
    try w.end();
}
pub fn append(w: *wire.Writer, value: Snapshot) !void {
    const before = w.bytes.items.len;
    try scalar(w, base, 1, "SchemaVersion", @as(u32, 1));
    try text(w, base, 2, "CameraId", value.id);
    inline for (.{ .{ "Backend", value.backend }, .{ "BufferCount", value.buffers }, .{ "QueuePolicy", value.config.policy }, .{ "RequestedOrientation", value.orientation.requested }, .{ "Orientation", value.orientation.actual }, .{ "OrientationAdjusted", value.orientation.adjusted != 0 }, .{ "StrictOrientation", value.strict_orientation }, .{ "SensorWidth", value.sensor_width }, .{ "SensorHeight", value.sensor_height }, .{ "SensorBitDepth", value.sensor_bit_depth } }, 3..) |field, id| try scalar(w, base, id, field[0], field[1]);
    const cfg = value.config;
    const p = value.pipeline;
    const color = value.processed;
    inline for (.{ .{ "Width", cfg.width }, .{ "Height", cfg.height }, .{ "BufferCount", cfg.buffer_count }, .{ "CameraIndex", cfg.camera_index }, .{ "QueuePolicy", cfg.policy }, .{ "ExposureTime", cfg.exposure_us }, .{ "FrameDuration", cfg.frame_duration_us }, .{ "AnalogueGain", cfg.analogue_gain }, .{ "LensPosition", cfg.lens_position }, .{ "Raw", cfg.raw != 0 } }, 1..) |field, id| try scalar(w, base + 1, id, field[0], field[1]);
    try text(w, base + 1, 11, "RawFormat", std.mem.sliceTo(&cfg.raw_format, 0));
    inline for (.{ .{ "Role", p.capture.role }, .{ "UnpackedRaw", p.capture.unpacked_raw != 0 }, .{ "NoiseReduction", p.capture.noise_reduction }, .{ "SensorWidth", p.sensor_width }, .{ "SensorHeight", p.sensor_height }, .{ "SensorBitDepth", p.sensor_bit_depth }, .{ "LoresWidth", p.lores_width }, .{ "LoresHeight", p.lores_height }, .{ "LoresFormat", p.lores_format }, .{ "MainFormat", color.main_format }, .{ "ColorPresent", color.color_space.present != 0 }, .{ "Primaries", color.color_space.primaries }, .{ "Transfer", color.color_space.transfer }, .{ "YCbCrEncoding", color.color_space.ycbcr_encoding }, .{ "Range", color.color_space.range }, .{ "StrictColor", color.strict_color != 0 } }, 12..) |field, id| try scalar(w, base + 1, id, field[0], field[1]);
    for (value.streams, 0..) |maybe, index| if (maybe) |stream| {
        const group = base + 10 + @as(u32, @intCast(index));
        const s = stream.description;
        if (s.plane_count == 0 or s.plane_count > c.ZC_MAX_PLANES or s.width == 0 or s.height == 0 or s.stride == 0) return error.InvalidConfiguration;
        inline for (.{ .{ "Width", s.width }, .{ "Height", s.height }, .{ "Stride", s.stride }, .{ "PlaneCount", s.plane_count } }, 1..) |field, id| try scalar(w, group, id, field[0], field[1]);
        try text(w, group, 5, "Format", std.mem.sliceTo(&s.format, 0));
        var size: u64 = 0;
        for (s.planes[0..s.plane_count]) |plane| size = try std.math.add(u64, size, plane.length);
        if (size > std.math.maxInt(i64)) return error.InvalidConfiguration;
        try scalar(w, group, 6, "FrameSize", @as(i64, @intCast(size)));
        const space = stream.color;
        inline for (.{ .{ "ColorPresent", space.present != 0 }, .{ "Primaries", space.primaries }, .{ "Transfer", space.transfer }, .{ "YCbCrEncoding", space.ycbcr_encoding }, .{ "Range", space.range } }, 7..) |field, id| try scalar(w, group, id, field[0], field[1]);
    };
    if (w.bytes.items.len - before + wire.header_size > limit) return error.CatalogFull;
}
/// Extract only the configuration namespace; callers own valid disjoint output.
pub fn copy(bytes: []const u8, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    if (capacity > std.math.maxInt(usize) or (data == null and capacity != 0)) return c.ZC_INVALID;
    const reader = wire.Reader.init(bytes) catch return c.ZC_INVALID;
    if (reader.catalog_kind != c.ZC_CATALOG_METADATA and reader.catalog_kind != c.ZC_CATALOG_CONFIGURATION) return c.ZC_INVALID;
    const selection = projection.Selection{ .first_group = base, .last_group = base + 12, .vendor = vendor };
    const size = projection.plan(reader, selection) catch return c.ZC_INVALID;
    if (size.count == 0) return c.ZC_UNSUPPORTED;
    if (size.bytes > limit) return c.ZC_INVALID;
    length.* = size.bytes;
    if (data) |out| _ = projection.copy(reader, selection, c.ZC_CATALOG_CONFIGURATION, out[0..@intCast(capacity)]) catch return c.ZC_INVALID;
    return c.ZC_OK;
}

test "configuration projection bounds copies and distinguishes legacy absence without changing output" {
    const t = std.testing;
    var w = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, limit * 2);
    defer w.deinit();
    try scalar(&w, 0, 1, "Foreign", @as(u32, 9));
    const empty = try w.finish();
    var length: u64 = 999;
    var out: [2048]u8 = @splat(42);
    try t.expectEqual(c.ZC_UNSUPPORTED, copy(empty, &out, out.len, &length));
    try t.expectEqual(@as(u64, 0), length);
    try t.expect(std.mem.allEqual(u8, &out, 42));
    try scalar(&w, base, 1, "SchemaVersion", @as(u32, 1));
    try text(&w, base, 2, "CameraId", "Cam/owned");
    try scalar(&w, base + 13, 1, "Unselected", @as(u32, 100));
    const bytes = try w.finish();
    try t.expectEqual(c.ZC_OK, copy(bytes, null, 0, &length));
    const expected = length;
    try t.expectEqual(c.ZC_INVALID, copy(bytes, &out, expected - 1, &length));
    try t.expectEqual(expected, length);
    try t.expect(std.mem.allEqual(u8, &out, 42));
    try t.expectEqual(c.ZC_INVALID, copy(bytes, null, 1, &length));
    try t.expectEqual(@as(u64, 0), length);
    try t.expectEqual(c.ZC_INVALID, copy(bytes, w.bytes.items.ptr, w.bytes.items.len, &length));
    try t.expectEqual(c.ZC_OK, copy(bytes, &out, out.len, &length));
    try t.expectEqual(expected, length);
    const reader = try wire.Reader.init(out[0..@intCast(length)]);
    try t.expectEqual(@as(u32, c.ZC_CATALOG_CONFIGURATION), reader.catalog_kind);
    try t.expectEqual(@as(u32, 2), reader.count);
    try t.expectEqual(@as(u8, 42), out[@intCast(length)]);
}
