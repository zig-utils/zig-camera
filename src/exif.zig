//! Capture policy and public ABI ownership around Home's Exif primitives.
const std = @import("std");
const c = @import("abi.zig").c;
const home = @import("home/metadata/exif.zig");
const still = @import("still.zig");
const allocator = std.heap.c_allocator;
pub const maximum = home.layout.max_bytes;
pub fn enabled(value: ?*const c.zc_image_exif) bool {
    return if (value) |v| v.flags != 0 or v.data != null else false;
}
pub fn bytes(value: ?*const c.zc_image_exif) ?[]const u8 {
    const v = value orelse return null;
    return if (v.data != null) v.data[0..@intCast(v.length)] else null;
}
pub fn check(options: *const c.zc_image_options, value: ?*const c.zc_image_exif) !void {
    const v = value orelse return;
    if (v.struct_size != @sizeOf(c.zc_image_exif) or v.flags & ~@as(u32, 1) != 0 or v.length > maximum or ((v.data == null) != (v.length == 0))) return error.InvalidOptions;
    if (!enabled(v)) return;
    const format: @import("home/metadata_embed.zig").Format = switch (options.format) {
        c.ZC_IMAGE_JPEG => .jpeg,
        c.ZC_IMAGE_PNG => .png,
        c.ZC_IMAGE_TIFF => .tiff,
        else => return error.UnsupportedFormat,
    };
    if (bytes(v)) |raw| _ = try @import("home/metadata_embed.zig").check(format, .{ .exif = raw });
}
pub export fn zc_default_image_exif(out: *c.zc_image_exif) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_image_exif), .flags = c.ZC_IMAGE_EXIF_CAPTURE, .data = null, .length = 0 };
}
pub export fn zc_exif_build(fields: ?[*]const c.zc_exif_field, count: u32, thumbnail: ?[*]const u8, thumbnail_length: u64, out: *?*c.zc_image_blob) c_int {
    out.* = null;
    if (count > home.layout.max_entries - 6 or (count != 0 and fields == null) or thumbnail_length > maximum or ((thumbnail == null) != (thumbnail_length == 0))) return c.ZC_INVALID;
    var writer = home.Builder.init(allocator);
    defer writer.deinit();
    for (0..count) |i| {
        const field = fields.?[i];
        if (field.reserved_a != 0 or field.reserved_b != 0 or field.length > maximum or (field.data == null and field.length != 0)) return c.ZC_INVALID;
        const group = std.enums.fromInt(home.serialization.Group, field.group) orelse return c.ZC_INVALID;
        const data: []const u8 = if (field.length == 0) &.{} else field.data[0..@intCast(field.length)];
        appendField(&writer, group, field.tag, field.field_type, field.count, data) catch |err| return still.status(err);
    }
    var gps = false;
    for (writer.fields.items) |field| if (field.group == .gps) {
        gps = true;
    };
    if (gps) home.ensureGpsVersion(&writer) catch |err| return still.status(err);
    const encoded = writer.finish(.{ .thumbnail = if (thumbnail) |p| p[0..@intCast(thumbnail_length)] else null }) catch |err| return still.status(err);
    const blob = allocator.create(still.Blob) catch {
        allocator.free(encoded);
        return c.ZC_NOMEM;
    };
    blob.* = .{ .bytes = encoded };
    out.* = @ptrCast(blob);
    return c.ZC_OK;
}
fn appendField(writer: *home.Builder, group: home.serialization.Group, tag: u16, field_type: u16, count: u32, data: []const u8) !void {
    if (field_type == c.ZC_EXIF_GPS_DECIMAL) {
        if (group != .gps or count != 1 or data.len != 8 or (tag != 2 and tag != 4 and tag != 6)) return error.InvalidOptions;
        const value: f64 = @bitCast(std.mem.readInt(u64, data[0..8], .little));
        if (tag == 6) try home.appendGpsAltitude(writer, value) else try home.appendGpsDecimal(writer, value, tag == 2);
    } else if (field_type == c.ZC_EXIF_ISO) {
        if (group != .exif or tag != 0x8833 or count != 1 or data.len != 4) return error.InvalidOptions;
        try home.appendIso(writer, std.mem.readInt(u32, data[0..4], .little));
    } else try writer.bytes(group, tag, field_type, count, data);
}
pub const Capture = struct {
    width: u32,
    height: u32,
    model: []const u8,
    exposure_us: ?u32 = null,
    analogue_gain: ?f32 = null,
    digital_gain: ?f32 = null,
    saved_utc_ns: i128,
    captured_utc_ns: ?i128 = null,
};
fn customHas(view: ?home.layout.View, photo: bool, tag: u16) bool {
    const v = view orelse return false;
    for (v.directories[0..v.count]) |dir| {
        if (!dir.primary or dir.kind != (if (photo) home.layout.Kind.exif else .image)) continue;
        if (v.find(dir, tag) != null) return true;
    }
    return false;
}
fn ascii(value: []const u8) bool {
    for (value) |byte| if (byte == 0 or byte > 127) return false;
    return true;
}
pub fn formatUtc(value: i128, out: *[19]u8) bool {
    if (value < 0) return false;
    const seconds = @divFloor(value, std.time.ns_per_s);
    if (seconds >= 253402300800) return false; // Exif uses exactly four year digits.
    const epoch: std.time.epoch.EpochSeconds = .{ .secs = @intCast(seconds) };
    const year = epoch.getEpochDay().calculateYearDay();
    const date = year.calculateMonthDay();
    const time = epoch.getDaySeconds();
    _ = std.fmt.bufPrint(out, "{d:0>4}:{d:0>2}:{d:0>2} {d:0>2}:{d:0>2}:{d:0>2}", .{ year.year, date.month.numeric(), date.day_index + @as(u8, 1), time.getHoursIntoDay(), time.getMinutesIntoHour(), time.getSecondsIntoMinute() }) catch return false;
    return true;
}
fn addTime(writer: *home.Builder, value: i128, original: bool) !void {
    var date: [19]u8 = undefined;
    if (!formatUtc(value, &date)) return;
    try writer.ascii(if (original) .exif else .image, if (original) 0x9003 else 0x0132, &date);
    try writer.ascii(.exif, if (original) 0x9011 else 0x9010, "+00:00");
    var fraction: [9]u8 = undefined;
    _ = try std.fmt.bufPrint(&fraction, "{d:0>9}", .{@as(u32, @intCast(@mod(value, std.time.ns_per_s)))});
    try writer.ascii(.exif, if (original) 0x9291 else 0x9290, &fraction);
}
/// Host correlation is only used for a known capture-clock domain. Backward
/// realtime jumps during sampling and future/overflowed sensor stamps reject.
pub fn correlateUtc(before: i128, capture_now: u64, after: i128, frame_stamp: u64) ?i128 {
    if (before < 0 or after < before or after - before > std.time.ns_per_ms * 100 or frame_stamp > capture_now) return null;
    const age = @as(i128, capture_now - frame_stamp);
    const center = before + @divFloor(after - before, 2);
    if (age > center) return null;
    return center - age;
}
pub fn generate(alloc: std.mem.Allocator, value: ?*const c.zc_image_exif, capture: Capture) !?[]u8 {
    if (!enabled(value)) return null;
    const raw = bytes(value);
    if (value.?.flags & c.ZC_IMAGE_EXIF_CAPTURE == 0) return try alloc.dupe(u8, raw.?);
    const custom = if (raw) |input| try home.layout.validate(input) else null;
    var writer = home.Builder.init(alloc);
    defer writer.deinit();
    if (!customHas(custom, false, 0x0110) and capture.model.len != 0 and ascii(capture.model)) try writer.ascii(.image, 0x0110, capture.model);
    try writer.ascii(.image, 0x0131, "zig-camera");
    try writer.short(.image, 0x0112, 1); // Encoded pixels already carry actual orientation.
    try writer.bytes(.exif, 0x9000, 7, 4, "0232");
    try writer.long(.exif, 0xa002, capture.width);
    try writer.long(.exif, 0xa003, capture.height);
    if (capture.exposure_us) |exposure| try writer.rational(.exif, 0x829a, exposure, 1_000_000);
    var iso_override = false;
    for ([_]u16{ 0x8827, 0x8830, 0x8831, 0x8832, 0x8833 }) |tag| if (customHas(custom, true, tag)) {
        iso_override = true;
    };
    if (!iso_override) if (capture.analogue_gain) |analogue| if (capture.digital_gain) |digital| {
        if (std.math.isFinite(analogue) and std.math.isFinite(digital) and analogue > 0 and digital > 0) {
            const iso = @floor(@as(f64, analogue) * @as(f64, digital) * 100);
            if (std.math.isFinite(iso) and iso >= 1 and iso <= std.math.maxInt(u32)) try home.appendIso(&writer, @intFromFloat(iso));
        }
    };
    const saved_override = customHas(custom, false, 0x0132) or customHas(custom, true, 0x9010) or customHas(custom, true, 0x9290);
    const original_override = customHas(custom, true, 0x9003) or customHas(custom, true, 0x9011) or customHas(custom, true, 0x9291);
    if (!saved_override) try addTime(&writer, capture.saved_utc_ns, false);
    if (!original_override) if (capture.captured_utc_ns) |stamp| try addTime(&writer, stamp, true);
    return try home.withDefaults(alloc, raw, writer.fields.items);
}

test "Exif ABI remains additive with strict field geometry and no output on invalid input" {
    try std.testing.expectEqual(@as(usize, 24), @sizeOf(c.zc_image_exif));
    try std.testing.expectEqual(@as(usize, 32), @sizeOf(c.zc_exif_field));
    var out: ?*c.zc_image_blob = @ptrFromInt(1);
    try std.testing.expectEqual(c.ZC_INVALID, zc_exif_build(null, 1, null, 0, &out));
    try std.testing.expectEqual(null, out);
}
test "request defaults use actual selected dimensions exposure ISO UTC and preserve explicit overrides" {
    const t = std.testing;
    var descriptor: c.zc_image_exif = undefined;
    zc_default_image_exif(&descriptor);
    const source: Capture = .{ .width = 640, .height = 480, .model = "Virtual model", .exposure_us = 12345, .analogue_gain = 2, .digital_gain = 1.5, .saved_utc_ns = 1_700_000_000_123456789, .captured_utc_ns = 1_699_999_999_987654321 };
    const generated = (try generate(t.allocator, &descriptor, source)).?;
    defer t.allocator.free(generated);
    var parsed = try home.parse(t.allocator, generated);
    defer parsed.deinit();
    try t.expectEqual(@as(u32, 640), parsed.width);
    try t.expectEqual(@as(u32, 300), parsed.iso_speed);
    try t.expectEqual(@as(u32, 12345), parsed.exposure_time.?.numerator);
    try t.expectEqualStrings("2023:11:14 22:13:20", parsed.date_time.?);
    try t.expectEqualStrings("2023:11:14 22:13:19", parsed.date_time_original.?);
    var custom = home.Builder.init(t.allocator);
    defer custom.deinit();
    try custom.ascii(.image, 0x0110, "Custom");
    try custom.ascii(.exif, 0x9003, "2001:02:03 04:05:06");
    try custom.short(.exif, 0x8827, 42);
    const raw = try custom.finish(.{});
    defer t.allocator.free(raw);
    descriptor.data = raw.ptr;
    descriptor.length = raw.len;
    const merged = (try generate(t.allocator, &descriptor, source)).?;
    defer t.allocator.free(merged);
    var result = try home.parse(t.allocator, merged);
    defer result.deinit();
    try t.expectEqualStrings("Custom", result.model.?);
    try t.expectEqualStrings("2001:02:03 04:05:06", result.date_time_original.?);
    try t.expectEqual(@as(u32, 42), result.iso_speed);
    const view = try home.layout.validate(merged);
    for (view.directories[0..view.count]) |dir| if (dir.kind == .exif and dir.primary) {
        try t.expect(view.find(dir, 0x9011) == null); // No invented zone for a user date.
        try t.expect(view.find(dir, 0x8833) == null); // No conflicting derived ISO.
    };
}
test "clock correlation UTC limits and absent invalid auto metadata omit unsupported fields" {
    const t = std.testing;
    try t.expectEqual(@as(?i128, 900), correlateUtc(1000, 500, 1000, 400));
    try t.expectEqual(@as(?i128, null), correlateUtc(1000, 500, 999, 400));
    try t.expectEqual(@as(?i128, null), correlateUtc(1000, 500, 1000, 501));
    var date: [19]u8 = undefined;
    try t.expect(formatUtc(0, &date));
    try t.expectEqualStrings("1970:01:01 00:00:00", &date);
    try t.expect(!formatUtc(-1, &date));
    try t.expect(!formatUtc(253402300800 * std.time.ns_per_s, &date));
    var descriptor: c.zc_image_exif = undefined;
    zc_default_image_exif(&descriptor);
    const data = (try generate(t.allocator, &descriptor, .{ .width = 1, .height = 1, .model = "\xc3\xa9", .saved_utc_ns = -1, .analogue_gain = std.math.nan(f32), .digital_gain = 1 })).?;
    defer t.allocator.free(data);
    var parsed = try home.parse(t.allocator, data);
    defer parsed.deinit();
    try t.expectEqual(@as(u32, 0), parsed.iso_speed);
    try t.expectEqual(null, parsed.model);
    try t.expectEqual(null, parsed.date_time);
    try t.expectEqual(null, parsed.date_time_original);
}

fn allocationCase(alloc: std.mem.Allocator) !void {
    var descriptor: c.zc_image_exif = undefined;
    zc_default_image_exif(&descriptor);
    const source: Capture = .{ .width = 18, .height = 10, .model = "Virtual camera", .exposure_us = 1000, .analogue_gain = 2, .digital_gain = 1, .saved_utc_ns = 1_700_000_000_123456789, .captured_utc_ns = 1_700_000_000_123456789 };
    var custom = home.Builder.init(alloc);
    defer custom.deinit();
    try custom.ascii(.image, 0x013b, "Chris");
    const raw = try custom.finish(.{});
    defer alloc.free(raw);
    descriptor.data = raw.ptr;
    descriptor.length = raw.len;
    const bytes_owned = (try generate(alloc, &descriptor, source)).?;
    defer alloc.free(bytes_owned);
    var parsed = try home.parse(alloc, bytes_owned);
    defer parsed.deinit();
    try std.testing.expectEqualStrings("Chris", parsed.artist.?);
    try std.testing.expectEqual(@as(u32, 200), parsed.iso_speed);
}
test "capture defaults unwind every construction merge and parse allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationCase, .{});
}
test "explicit timezone-only override and negative gains never invent conflicting capture values" {
    const t = std.testing;
    var writer = home.Builder.init(t.allocator);
    defer writer.deinit();
    try writer.ascii(.exif, 0x9011, "+05:30");
    const raw = try writer.finish(.{});
    defer t.allocator.free(raw);
    var descriptor: c.zc_image_exif = undefined;
    zc_default_image_exif(&descriptor);
    descriptor.data = raw.ptr;
    descriptor.length = raw.len;
    const generated = (try generate(t.allocator, &descriptor, .{ .width = 1, .height = 1, .model = "Virtual", .analogue_gain = -2, .digital_gain = -3, .saved_utc_ns = 1_700_000_000, .captured_utc_ns = 1_700_000_000 })).?;
    defer t.allocator.free(generated);
    var parsed = try home.parse(t.allocator, generated);
    defer parsed.deinit();
    try t.expectEqual(null, parsed.date_time_original);
    try t.expectEqual(@as(u32, 0), parsed.iso_speed);
}

test "explicit Model bypasses oversized automatic text while non-ASCII automatic Model remains absent" {
    const t = std.testing;
    var descriptor: c.zc_image_exif = undefined;
    zc_default_image_exif(&descriptor);
    var custom = home.Builder.init(t.allocator);
    defer custom.deinit();
    try custom.ascii(.image, 0x0110, "Explicit source model");
    const input = try custom.finish(.{});
    defer t.allocator.free(input);
    descriptor.data = input.ptr;
    descriptor.length = input.len;
    // This source would exceed Home's Exif size limit if generated first.
    const huge = try t.allocator.alloc(u8, home.layout.max_bytes + 1);
    defer t.allocator.free(huge);
    @memset(huge, 'A');
    var capture = Capture{ .width = 2, .height = 1, .model = huge, .saved_utc_ns = 0 };
    const overridden = (try generate(t.allocator, &descriptor, capture)).?;
    defer t.allocator.free(overridden);
    var parsed = try home.parse(t.allocator, overridden);
    defer parsed.deinit();
    try t.expectEqualStrings("Explicit source model", parsed.model.?);
    descriptor.data = null;
    descriptor.length = 0;
    capture.model = "Camera 光";
    const omitted = (try generate(t.allocator, &descriptor, capture)).?;
    defer t.allocator.free(omitted);
    var without = try home.parse(t.allocator, omitted);
    defer without.deinit();
    try t.expectEqual(null, without.model);
}
