//! Borrowed source identity from exact properties; never borrow past the owner.
const std = @import("std");
const c = @import("abi.zig").c;
const wire = @import("home/typed_catalog.zig");
const configuration = @import("frame_configuration.zig");
pub fn properties(bytes: []const u8, fallback: []const u8) ![]const u8 {
    const reader = try wire.Reader.init(bytes);
    if (reader.catalog_kind != c.ZC_CATALOG_PROPERTIES) return error.InvalidCatalog;
    // Older libcamera property IDs have neither vendor nor direction flags.
    // The checked properties catalog kind supplies the read-only namespace.
    const model = try reader.findString(.{ .name = "Model", .vendors = &.{ "libcamera", "synthetic", "" } });
    return checked(if (model != null and model.?.len != 0) model.? else fallback);
}
pub fn snapshot(bytes: []const u8, raw: *const c.zc_raw_metadata) ![]const u8 {
    const legacy = std.mem.sliceTo(&raw.model, 0);
    if (bytes.len == 0) return checked(legacy);
    const reader = try wire.Reader.init(bytes);
    if (reader.catalog_kind != c.ZC_CATALOG_METADATA) return error.InvalidCatalog;
    const nested = try @import("home/catalog_envelope.zig").find(bytes, c.ZC_CATALOG_METADATA, @import("frame_properties.zig").spec);
    if (nested) |inner| {
        const model = try properties(inner, "");
        if (model.len != 0) return model;
    }
    if (legacy.len != 0) return checked(legacy);
    const identity = try reader.findString(.{ .group = configuration.base, .name = "Config.CameraId", .vendors = &.{configuration.vendor}, .required_flags = c.ZC_CATALOG_OUTPUT });
    return checked(identity orelse "");
}
fn checked(value: []const u8) ![]const u8 {
    if (!std.unicode.utf8ValidateSlice(value) or std.mem.indexOfScalar(u8, value, 0) != null) return error.InvalidModel;
    return value;
}
fn fixture(w: *wire.Writer, vendor: []const u8, model: []const u8) !void {
    try w.begin(.{ .name = "Model", .vendor = vendor, .kind = .string, .flags = c.ZC_CATALOG_OUTPUT | c.ZC_CATALOG_ARRAY });
    try w.append(.{ .kind = .string, .flags = 3, .count = @intCast(model.len), .data = model });
    try w.end();
}
test "full model selection uses accepted properties before legacy raw and configuration identity" {
    const t = std.testing;
    var inner = try wire.Writer.init(t.allocator, c.ZC_CATALOG_PROPERTIES, 4096);
    defer inner.deinit();
    const model = "model/" ** 100;
    try fixture(&inner, "foreign", "wrong");
    try fixture(&inner, "libcamera", model);
    var outer = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 8192);
    defer outer.deinit();
    try @import("frame_properties.zig").append(&outer, try inner.finish());
    var raw = std.mem.zeroes(c.zc_raw_metadata);
    @memcpy(raw.model[0..6], "legacy");
    try t.expectEqualStrings(model, try snapshot(try outer.finish(), &raw));
    try t.expectEqualStrings("legacy", try snapshot(&.{}, &raw));
    outer.deinit();
    outer = try wire.Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 4096);
    try outer.begin(.{ .group = configuration.base, .name = "Config.CameraId", .vendor = configuration.vendor, .kind = .string, .flags = c.ZC_CATALOG_OUTPUT });
    try outer.append(.{ .kind = .string, .count = 8, .data = "full/id/" });
    try outer.end();
    try t.expectEqualStrings("legacy", try snapshot(try outer.finish(), &raw));
    @memset(&raw.model, 0);
    try t.expectEqualStrings("full/id/", try snapshot(try outer.finish(), &raw));
}
test "invalid or duplicate advertised model never silently falls back to legacy" {
    const t = std.testing;
    for ([_][]const u8{ "", "光", "bad\x00tail", "\xff" }) |model| {
        var w = try wire.Writer.init(t.allocator, c.ZC_CATALOG_PROPERTIES, 1024);
        defer w.deinit();
        try fixture(&w, "libcamera", model);
        if (std.mem.indexOfScalar(u8, model, 0) != null) {
            try t.expectError(error.InvalidModel, properties(try w.finish(), "fallback"));
        } else if (!std.unicode.utf8ValidateSlice(model)) {
            try t.expectError(error.InvalidString, properties(try w.finish(), "fallback"));
        } else try t.expectEqualStrings(if (model.len == 0) "fallback" else model, try properties(try w.finish(), "fallback"));
        try fixture(&w, "", "duplicate");
        try t.expectError(if (!std.unicode.utf8ValidateSlice(model)) error.InvalidString else error.AmbiguousString, properties(try w.finish(), "fallback"));
    }
}
