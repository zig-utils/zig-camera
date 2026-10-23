//! Exact source-camera properties in the request's existing owned metadata.
const std = @import("std");
const c = @import("abi.zig").c;
const envelope = @import("home/catalog_envelope.zig");
pub const spec: envelope.Spec = .{ .group = 0x5a440000, .id = 1, .name = "Properties.Catalog", .vendor = "zig-camera", .inner_kind = c.ZC_CATALOG_PROPERTIES, .max_bytes = @import("catalog.zig").limit };
pub fn append(writer: *@import("home/typed_catalog.zig").Writer, properties: []const u8) !void {
    try envelope.append(writer, spec, properties);
}
pub fn copy(bytes: []const u8, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    if (capacity > std.math.maxInt(usize) or (data == null and capacity != 0)) return c.ZC_INVALID;
    const payload = (envelope.find(bytes, c.ZC_CATALOG_METADATA, spec) catch return c.ZC_INVALID) orelse return c.ZC_UNSUPPORTED;
    length.* = payload.len;
    if (data) |out| _ = envelope.copy(bytes, c.ZC_CATALOG_METADATA, spec, out[0..@intCast(capacity)]) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
test "property extraction distinguishes legacy absence and never writes malformed short or overlapping output" {
    const t = std.testing;
    var w = try @import("home/typed_catalog.zig").Writer.init(t.allocator, c.ZC_CATALOG_METADATA, 4096);
    defer w.deinit();
    var out: [128]u8 = @splat(73);
    var length: u64 = 999;
    try t.expectEqual(c.ZC_UNSUPPORTED, copy(try w.finish(), &out, out.len, &length));
    try t.expectEqual(@as(u64, 0), length);
    const inner = "HCAT\x01\x00\x00\x00\x02\x00\x00\x00\x00\x00\x00\x00";
    try append(&w, inner);
    try t.expectEqual(c.ZC_OK, copy(try w.finish(), null, 0, &length));
    try t.expectEqual(@as(u64, 16), length);
    try t.expectEqual(c.ZC_INVALID, copy(try w.finish(), &out, 15, &length));
    try t.expect(std.mem.allEqual(u8, &out, 73));
    try t.expectEqual(c.ZC_INVALID, copy(try w.finish(), w.bytes.items.ptr, w.bytes.items.len, &length));
    try t.expectEqual(c.ZC_OK, copy(try w.finish(), &out, out.len, &length));
    try t.expectEqualSlices(u8, inner, out[0..16]);
    @memset(&out, 73);
    w.bytes.items[w.bytes.items.len - inner.len + 4] = 2;
    try t.expectEqual(c.ZC_INVALID, copy(try w.finish(), &out, out.len, &length));
    try t.expectEqual(@as(u64, 0), length);
    try t.expect(std.mem.allEqual(u8, &out, 73));
}
