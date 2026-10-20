//! Immutable owned snapshots. All backend pointers are copied before returning.
const std = @import("std");
const c = @import("abi.zig").c;
pub const wire = @import("home/typed_catalog.zig");
pub const bridge = @cImport({
    @cInclude("zig_camera_catalog_bridge.h");
});
pub const Sink = bridge.zcd_catalog_sink;
const alloc = std.heap.c_allocator;
pub const limit = 4 * 1024 * 1024;
pub const Catalog = struct {
    writer: wire.Writer,
    pub fn create(kind: u32) !*Catalog {
        const p = try alloc.create(Catalog);
        errdefer alloc.destroy(p);
        p.* = .{ .writer = try wire.Writer.init(alloc, kind, limit) };
        return p;
    }
    pub fn destroy(p: *Catalog) void {
        p.writer.deinit();
        alloc.destroy(p);
    }
    pub fn sink(p: *Catalog) Sink {
        return .{ .context = p, .begin = begin, .value = value, .end = end };
    }
    pub fn ptr(p: *Catalog) *c.zc_catalog {
        return @ptrCast(p);
    }
};
fn owner(p: ?*anyopaque) *Catalog {
    return @ptrCast(@alignCast(p.?));
}
pub fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.CatalogFull => c.ZC_BUSY,
        else => c.ZC_INVALID,
    };
}
fn slice(comptime T: type, data: [*c]const T, len: usize) ![]const T {
    if (len == 0) return &.{};
    if (data == null or len > limit) return error.InvalidCatalog;
    return data[0..len];
}
fn begin(ctx: ?*anyopaque, r: [*c]const bridge.zcd_catalog_record) callconv(.c) c_int {
    const name = slice(u8, @ptrCast(r.*.name), r.*.name_length) catch |e| return status(e);
    const vendor = slice(u8, @ptrCast(r.*.vendor), r.*.vendor_length) catch |e| return status(e);
    const kind = std.enums.fromInt(wire.Kind, r.*.kind) orelse return c.ZC_INVALID;
    owner(ctx).writer.begin(.{ .group = r.*.group, .id = r.*.id, .app_id = r.*.app_id, .native_type = r.*.native_type, .flags = r.*.flags, .extent = r.*.extent, .kind = kind, .name = name, .vendor = vendor }) catch |e| return status(e);
    return c.ZC_OK;
}
fn value(ctx: ?*anyopaque, v: [*c]const bridge.zcd_catalog_value) callconv(.c) c_int {
    const data = slice(u8, v.*.data, v.*.length) catch |e| return status(e);
    const label = slice(u8, @ptrCast(v.*.label), v.*.label_length) catch |e| return status(e);
    const kind = std.enums.fromInt(wire.Kind, v.*.kind) orelse return c.ZC_INVALID;
    owner(ctx).writer.append(.{ .role = v.*.role, .kind = kind, .native_type = v.*.native_type, .flags = v.*.flags, .count = v.*.count, .label = label, .data = data }) catch |e| return status(e);
    return c.ZC_OK;
}
fn end(ctx: ?*anyopaque) callconv(.c) c_int {
    owner(ctx).writer.end() catch |e| return status(e);
    return c.ZC_OK;
}
pub export fn zc_catalog_copy(p: *const c.zc_catalog, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const catalog: *const Catalog = @ptrCast(@alignCast(p));
    const bytes = catalog.writer.finish() catch |e| return status(e);
    length.* = bytes.len;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < bytes.len) return c.ZC_INVALID;
    @memcpy(data.?[0..bytes.len], bytes);
    return c.ZC_OK;
}
pub export fn zc_catalog_close(p: ?*c.zc_catalog) void {
    if (p) |ptr| {
        const catalog: *Catalog = @ptrCast(@alignCast(ptr));
        catalog.destroy();
    }
}
