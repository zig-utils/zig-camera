//! Request-derived Exif over the remote owner's immutable HCAT/scalar snapshots.
const std = @import("std");
const c = @import("abi.zig").c;
const wire = @import("home/typed_catalog.zig");
const exif = @import("exif.zig");
const Photo = struct { digital_gain: ?f32, wallclock_ns: ?i64 };
fn query(name: []const u8) wire.ScalarQuery {
    return .{ .name = name, .vendors = &.{ "libcamera", "synthetic", "" }, .required_flags = c.ZC_CATALOG_OUTPUT, .forbidden_flags = c.ZC_CATALOG_ARRAY };
}
fn photoValues(bytes: []const u8) !Photo {
    const reader = try wire.Reader.init(bytes);
    if (reader.catalog_kind != c.ZC_CATALOG_METADATA) return error.InvalidCatalog;
    return .{
        .digital_gain = try reader.findScalar(f32, query("DigitalGain")),
        .wallclock_ns = try reader.findScalar(i64, query("FrameWallClock")),
    };
}
pub fn generate(allocator: std.mem.Allocator, meta: c.zc_metadata, raw: c.zc_raw_metadata, selected: c.zc_stream, catalog: []const u8, descriptor: ?*const c.zc_image_exif) !?[]u8 {
    if (!exif.enabled(descriptor) or descriptor.?.flags & c.ZC_IMAGE_EXIF_CAPTURE == 0) return null;
    if (meta.struct_size != @sizeOf(c.zc_metadata)) return error.InvalidCatalog;
    const photo = try photoValues(catalog);
    const before = std.time.nanoTimestamp();
    const now = @import("capture_filter.zig").clockNs() catch null;
    const after = std.time.nanoTimestamp();
    const wall: ?i128 = if (photo.wallclock_ns) |stamp| (if (stamp > 0) @as(i128, stamp) else null) else null;
    const stamp = wall orelse if (meta.valid & 16 != 0 and now != null) exif.correlateUtc(before, now.?, after, meta.timestamp_ns) else null;
    return exif.generate(allocator, descriptor, .{
        .width = selected.width,
        .height = selected.height,
        .model = try @import("source_model.zig").snapshot(catalog, &raw),
        .exposure_us = if (meta.valid & 64 != 0) meta.exposure_us else null,
        .analogue_gain = meta.analogue_gain,
        .digital_gain = photo.digital_gain,
        .saved_utc_ns = after,
        .captured_utc_ns = stamp,
    });
}
fn fixture(w: *wire.Writer, name: []const u8, vendor: []const u8, group: u32, flags: u32, value: wire.Value) !void {
    try w.begin(.{ .name = name, .vendor = vendor, .group = group, .flags = flags, .kind = value.kind });
    try w.append(value);
    try w.end();
}
test "remote photo fields use exact scalar order role group and accepted standard or legacy provenance" {
    const t = std.testing;
    var w = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 4096);
    defer w.deinit();
    try fixture(&w, "DigitalGain", "foreign", 0, 2, .{ .kind = .f32, .data = &.{ 0, 0, 0, 0 } });
    try fixture(&w, "DigitalGain", "libcamera", 1, 2, .{ .kind = .f32, .data = &.{ 0, 0, 0, 0 } });
    try fixture(&w, "DigitalGain", "libcamera", 0, 2, .{ .kind = .f32, .flags = 0, .data = &.{ 0x3f, 0xc0, 0, 0 } });
    var stamp: [8]u8 = undefined;
    std.mem.writeInt(i64, &stamp, 1_700_000_000_123456789, .big);
    try fixture(&w, "FrameWallClock", "", 0, 2, .{ .kind = .i64, .flags = 0, .data = &stamp });
    const found = try photoValues(try w.finish());
    try t.expectEqual(@as(?f32, 1.5), found.digital_gain);
    try t.expectEqual(@as(?i64, 1_700_000_000_123456789), found.wallclock_ns);
    try fixture(&w, "DigitalGain", "synthetic", 0, 2, .{ .kind = .f32, .data = &.{ 0, 0, 128, 63 } });
    try t.expectError(error.AmbiguousScalar, photoValues(try w.finish()));
}
test "missing and advertised array photo fields remain unavailable while invalid scalar shapes reject" {
    const t = std.testing;
    var w = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 4096);
    defer w.deinit();
    try fixture(&w, "DigitalGain", "libcamera", 0, 2 | 4, .{ .kind = .f32, .flags = 3, .data = &.{ 0, 0, 128, 63 } });
    const missing = try photoValues(try w.finish());
    try t.expectEqual(@as(?f32, null), missing.digital_gain);
    try t.expectEqual(@as(?i64, null), missing.wallclock_ns);
    try fixture(&w, "FrameWallClock", "libcamera", 0, 2, .{ .kind = .i64, .flags = 3, .data = &@as([8]u8, @splat(0)) });
    try t.expectError(error.InvalidScalar, photoValues(try w.finish()));
}
test "remote Exif uses request wall time and gains while missing invalid and non-finite fields stay absent" {
    const t = std.testing;
    const home = @import("home/metadata/exif.zig");
    var w = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 4096);
    defer w.deinit();
    try fixture(&w, "DigitalGain", "libcamera", 0, 2, .{ .kind = .f32, .data = &.{ 0, 0, 192, 63 } });
    var stamp: [8]u8 = undefined;
    std.mem.writeInt(i64, &stamp, 1_700_000_000_123456789, .little);
    try fixture(&w, "FrameWallClock", "libcamera", 0, 2, .{ .kind = .i64, .data = &stamp });
    var descriptor: c.zc_image_exif = undefined;
    exif.zc_default_image_exif(&descriptor);
    var meta = std.mem.zeroes(c.zc_metadata);
    meta.struct_size = @sizeOf(c.zc_metadata);
    meta.valid = 64;
    meta.exposure_us = 12345;
    meta.analogue_gain = 2;
    var raw = std.mem.zeroes(c.zc_raw_metadata);
    @memcpy(raw.model[0..6], "Remote");
    var selected = std.mem.zeroes(c.zc_stream);
    selected.width = 320;
    selected.height = 240;
    const bytes = (try generate(t.allocator, meta, raw, selected, try w.finish(), &descriptor)).?;
    defer t.allocator.free(bytes);
    var parsed = try home.parse(t.allocator, bytes);
    defer parsed.deinit();
    try t.expectEqualStrings("Remote", parsed.model.?);
    try t.expectEqualStrings("2023:11:14 22:13:20", parsed.date_time_original.?);
    try t.expectEqual(@as(u32, 300), parsed.iso_speed);
    const view = try home.layout.validate(bytes);
    for (view.directories[0..view.count]) |dir| if (dir.primary and dir.kind == .exif) {
        try t.expectEqual(@as(u32, 320), std.mem.readInt(u32, view.find(dir, 0xa002).?.bytes[0..4], view.endian));
        try t.expectEqual(@as(u32, 240), std.mem.readInt(u32, view.find(dir, 0xa003).?.bytes[0..4], view.endian));
        try t.expectEqualStrings("123456789", std.mem.sliceTo(view.find(dir, 0x9291).?.bytes, 0));
    };
    w.deinit();
    w = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 4096);
    var unavailable = std.mem.zeroes(c.zc_metadata);
    try t.expectError(error.InvalidCatalog, generate(t.allocator, unavailable, raw, selected, try w.finish(), &descriptor));
    unavailable.struct_size = @sizeOf(c.zc_metadata);
    const empty = (try generate(t.allocator, unavailable, raw, selected, try w.finish(), &descriptor)).?;
    defer t.allocator.free(empty);
    var absent = try home.parse(t.allocator, empty);
    defer absent.deinit();
    try t.expectEqual(@as(u32, 0), absent.iso_speed);
    try t.expectEqual(null, absent.date_time_original);
    try fixture(&w, "DigitalGain", "libcamera", 0, 2, .{ .kind = .f32, .data = &.{ 0, 0, 192, 127 } });
    const nan = (try generate(t.allocator, meta, raw, selected, try w.finish(), &descriptor)).?;
    defer t.allocator.free(nan);
    var invalid_gain = try home.parse(t.allocator, nan);
    defer invalid_gain.deinit();
    try t.expectEqual(@as(u32, 0), invalid_gain.iso_speed);
}

test "remote Exif retains full properties without raw and honors explicit Model beyond JPEG limits" {
    const t = std.testing;
    const home = @import("home/metadata/exif.zig");
    var inner = try wire.Writer.init(t.allocator, c.ZC_CATALOG_PROPERTIES, 256 * 1024);
    defer inner.deinit();
    const model = "source-property/model/" ** 4000;
    try fixture(&inner, "Model", "libcamera", 0, 0, .{ .kind = .string, .count = model.len, .data = model });
    var outer = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 256 * 1024);
    defer outer.deinit();
    try @import("frame_properties.zig").append(&outer, try inner.finish());
    var meta = std.mem.zeroes(c.zc_metadata);
    meta.struct_size = @sizeOf(c.zc_metadata);
    var selected = std.mem.zeroes(c.zc_stream);
    selected.width = 2;
    selected.height = 1;
    var descriptor: c.zc_image_exif = undefined;
    exif.zc_default_image_exif(&descriptor);
    const bytes = (try generate(t.allocator, meta, std.mem.zeroes(c.zc_raw_metadata), selected, try outer.finish(), &descriptor)).?;
    defer t.allocator.free(bytes);
    var parsed = try home.parse(t.allocator, bytes);
    defer parsed.deinit();
    try t.expectEqualStrings(model, parsed.model.?);
    try t.expectError(error.MetadataTooLarge, @import("home/metadata_embed.zig").check(.jpeg, .{ .exif = bytes }));
    var custom = home.Builder.init(t.allocator);
    defer custom.deinit();
    try custom.ascii(.image, 0x0110, "Explicit model");
    const input = try custom.finish(.{});
    defer t.allocator.free(input);
    descriptor.data = input.ptr;
    descriptor.length = input.len;
    const overridden = (try generate(t.allocator, meta, std.mem.zeroes(c.zc_raw_metadata), selected, try outer.finish(), &descriptor)).?;
    defer t.allocator.free(overridden);
    _ = try @import("home/metadata_embed.zig").check(.jpeg, .{ .exif = overridden });
    var result = try home.parse(t.allocator, overridden);
    defer result.deinit();
    try t.expectEqualStrings("Explicit model", result.model.?);
}
