//! Owned read-only Home KMS catalogs. Every temporary device FD retires before
//! this public snapshot can be observed; no camera or display ownership retained.
const std = @import("std");
const c = @import("abi.zig").c;
const host = @import("home/kms_discovery_host.zig");
const Registry = @import("home/owned_admission.zig").Registry(4);
const formats = @import("processed_format.zig");
const A = std.heap.c_allocator;
var registry: Registry = .{ .max_items = 4, .max_bytes = 8 * 1024 * 1024 };
var mutex: std.Thread.Mutex = .{};
const Owner = struct { result: host.core.Result, ticket: Registry.Ticket };
fn owner(p: *c.zc_drm_discovery) *Owner {
    return @ptrCast(@alignCast(p));
}
fn retire(ticket: Registry.Ticket) void {
    mutex.lock();
    defer mutex.unlock();
    registry.release(ticket) catch unreachable;
}
pub export fn zc_drm_discover(card: ?[*:0]const u8, out: *?*c.zc_drm_discovery) c_int {
    out.* = null;
    var path: ?[]const u8 = null;
    if (card) |bytes| {
        var length: usize = 0;
        while (length < 64 and bytes[length] != 0) : (length += 1) {}
        if (length == 0 or length >= 64) return c.ZC_INVALID;
        path = bytes[0..length];
    }
    if (!host.available) return c.ZC_UNSUPPORTED;
    mutex.lock();
    const ticket = registry.reserve(@sizeOf(Owner)) catch {
        mutex.unlock();
        return c.ZC_BUSY;
    };
    mutex.unlock();
    var success = false;
    defer if (!success) retire(ticket);
    const self = A.create(Owner) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(self);
    self.* = .{ .result = .{}, .ticket = ticket };
    host.scan(&self.result, path) catch |err| return if (err == error.Unsupported) c.ZC_UNSUPPORTED else c.ZC_INVALID;
    out.* = @ptrCast(self);
    success = true;
    return c.ZC_OK;
}
pub export fn zc_drm_discovery_info_get(p: *c.zc_drm_discovery, out: *c.zc_drm_discovery_info) c_int {
    const value = &owner(p).result;
    out.* = std.mem.zeroes(c.zc_drm_discovery_info);
    out.struct_size = @sizeOf(c.zc_drm_discovery_info);
    out.display_count = @intCast(value.display_count);
    out.issue_count = @intCast(value.issue_count);
    out.cards_tried = value.cards_tried;
    out.cards_opened = value.cards_opened;
    return c.ZC_OK;
}
pub export fn zc_drm_discovery_display_get(p: *c.zc_drm_discovery, index: u32, out: *c.zc_drm_display_info) c_int {
    out.* = std.mem.zeroes(c.zc_drm_display_info);
    const result = &owner(p).result;
    if (index >= result.display_count) return c.ZC_INVALID;
    const value = &result.displays[index];
    out.struct_size = @sizeOf(c.zc_drm_display_info);
    out.connector_id = value.connector;
    out.connector_type = value.kind;
    out.connector_type_id = value.number;
    out.status = value.status;
    out.current_crtc_id = value.current_crtc;
    out.active_width = value.active.width;
    out.active_height = value.active.height;
    out.default_width = value.preferred.width;
    out.default_height = value.preferred.height;
    out.physical_width_mm = value.width_mm;
    out.physical_height_mm = value.height_mm;
    out.flags = @as(u32, @intFromBool(value.capabilities.atomic)) | @as(u32, @intFromBool(value.capabilities.universal)) << 1;
    out.crtc_count = @intCast(value.crtc_count);
    out.format_count = @intCast(value.formats.count);
    @memcpy(&out.card, &value.card);
    @memcpy(&out.name, &value.name);
    @memcpy(out.crtcs[0..value.crtc_count], value.crtcs[0..value.crtc_count]);
    for (value.formats.slice(), 0..) |code, i| {
        out.formats[i] = code;
        out.processed_formats[i] = if (host.core.catalog.processedFormat(code)) |name| formats.code(name) orelse std.math.maxInt(u32) else std.math.maxInt(u32);
    }
    return c.ZC_OK;
}
pub export fn zc_drm_discovery_issue_get(p: *c.zc_drm_discovery, index: u32, out: *c.zc_drm_discovery_issue) c_int {
    out.* = std.mem.zeroes(c.zc_drm_discovery_issue);
    const result = &owner(p).result;
    if (index >= result.issue_count) return c.ZC_INVALID;
    const value = &result.issues[index];
    out.struct_size = @sizeOf(c.zc_drm_discovery_issue);
    out.stage = @intFromEnum(value.stage);
    out.reason = @intFromEnum(value.reason);
    out.error_number = value.errno_value;
    @memcpy(&out.card, &value.card);
    return c.ZC_OK;
}
pub export fn zc_drm_discovery_close(p: ?*c.zc_drm_discovery) void {
    const self = owner(p orelse return);
    const ticket = self.ticket;
    A.destroy(self);
    retire(ticket);
}
test "DRM catalog ABI fields and platform failures leave no public owner" {
    const t = std.testing;
    try t.expectEqual(@as(usize, 2336), @sizeOf(c.zc_drm_display_info));
    try t.expectEqual(@as(usize, 80), @sizeOf(c.zc_drm_discovery_issue));
    var out: ?*c.zc_drm_discovery = undefined;
    try t.expectEqual(c.ZC_INVALID, zc_drm_discover("", &out));
    try t.expectEqual(null, out);
    if (!host.available) {
        try t.expectEqual(c.ZC_UNSUPPORTED, zc_drm_discover(null, &out));
        try t.expectEqual(null, out);
    }
    zc_drm_discovery_close(null);
}
