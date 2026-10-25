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
        return createWithLimit(kind, limit);
    }
    pub fn createWithLimit(kind: u32, max_bytes: usize) !*Catalog {
        const p = try alloc.create(Catalog);
        errdefer alloc.destroy(p);
        p.* = .{ .writer = try wire.Writer.init(alloc, kind, max_bytes) };
        return p;
    }
    pub fn destroy(p: *Catalog) void {
        p.writer.deinit();
        alloc.destroy(p);
    }
    pub fn copyOf(bytes: []const u8) !*Catalog {
        if (bytes.len > limit) return error.CatalogFull;
        const reader = try wire.Reader.init(bytes);
        const p = try create(reader.catalog_kind);
        errdefer p.destroy();
        p.writer.bytes.clearRetainingCapacity();
        try p.writer.bytes.appendSlice(alloc, bytes);
        p.writer.count = reader.count;
        return p;
    }
    pub fn sink(p: *Catalog) Sink {
        return .{ .context = p, .begin = begin, .value = value, .end = end, .select = null, .max_value_bytes = 0 };
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
    return boundedSlice(T, data, len, limit);
}
fn boundedSlice(comptime T: type, data: [*c]const T, len: usize, max_bytes: usize) ![]const T {
    if (len == 0) return &.{};
    if (data == null or len > max_bytes) return error.InvalidCatalog;
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
    const data = boundedSlice(u8, v.*.data, v.*.length, owner(ctx).writer.limit) catch |e| return status(e);
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

/// The filter applies in Zig for all backends. The optional native preselection
/// additionally avoids visiting/copying unrelated large system ControlValues.
pub const NameFilter = struct {
    catalog: *Catalog,
    names: []const []const u8,
    max_value_bytes: u64,
    value_limits: ?[]const u64 = null,
    selected_limit: u64 = 0,
    kinds: ?[]const wire.Kind = null,
    forbidden_flags: u32 = 0,
    open: bool = false,
    selected: bool = false,
    pub fn sink(self: *NameFilter) Sink {
        return .{ .context = self, .begin = filterBegin, .value = filterValue, .end = filterEnd, .select = accept, .max_value_bytes = self.max_value_bytes };
    }
    fn state(ctx: ?*anyopaque) *NameFilter {
        return @ptrCast(@alignCast(ctx.?));
    }
    fn accept(ctx: ?*anyopaque, record: [*c]const bridge.zcd_catalog_record) callconv(.c) c_int {
        if (record == null) return c.ZC_INVALID;
        const self = state(ctx);
        if (self.open) return c.ZC_INVALID;
        if (self.kinds) |kinds| if (kinds.len != self.names.len) return c.ZC_INVALID;
        if (self.value_limits) |limits| if (limits.len != self.names.len) return c.ZC_INVALID;
        for (self.names, 0..) |name, i| {
            if (record.*.name_length != name.len) continue;
            if (record.*.name == null and name.len != 0) return c.ZC_INVALID;
            const bytes: []const u8 = if (name.len == 0) &.{} else @as([*]const u8, @ptrCast(record.*.name))[0..name.len];
            if (!std.mem.eql(u8, bytes, name)) continue;
            if (record.*.flags & self.forbidden_flags != 0) return c.ZC_INVALID;
            if (self.kinds) |kinds| if (record.*.kind != @intFromEnum(kinds[i])) return c.ZC_INVALID;
            self.selected_limit = if (self.value_limits) |limits| limits[i] else self.max_value_bytes;
            return 1;
        }
        return 0;
    }
    fn filterBegin(ctx: ?*anyopaque, record: [*c]const bridge.zcd_catalog_record) callconv(.c) c_int {
        const self = state(ctx);
        if (self.open) return c.ZC_INVALID;
        const selected = accept(ctx, record);
        if (selected < 0) return selected;
        self.open = true;
        self.selected = selected == 1;
        return if (self.selected) begin(self.catalog, record) else c.ZC_OK;
    }
    fn filterValue(ctx: ?*anyopaque, field: [*c]const bridge.zcd_catalog_value) callconv(.c) c_int {
        const self = state(ctx);
        if (!self.open) return c.ZC_INVALID;
        if (self.selected and (field == null or field.*.length > self.selected_limit)) return c.ZC_BUSY;
        return if (self.selected) value(self.catalog, field) else c.ZC_OK;
    }
    fn filterEnd(ctx: ?*anyopaque) callconv(.c) c_int {
        const self = state(ctx);
        if (!self.open) return c.ZC_INVALID;
        self.open = false;
        return if (self.selected) end(self.catalog) else c.ZC_OK;
    }
    pub fn finish(self: *const NameFilter) ![]const u8 {
        if (self.open) return error.InvalidCatalog;
        return self.catalog.writer.finish();
    }
};

test "selective metadata sinks validate protocol and kinds before retaining only chosen large values" {
    const t = std.testing;
    const selected = try Catalog.createWithLimit(4, 8 * 1024 * 1024);
    defer selected.destroy();
    var filter: NameFilter = .{ .catalog = selected, .names = &.{"Tensor"}, .kinds = &.{.f32}, .forbidden_flags = 1, .max_value_bytes = 8 * 1024 * 1024 };
    const sink = filter.sink();
    var record = std.mem.zeroes(bridge.zcd_catalog_record);
    record.name = "Other";
    record.name_length = 5;
    record.kind = 5;
    try t.expectEqual(c.ZC_OK, sink.begin.?(sink.context, &record));
    try t.expectError(error.InvalidCatalog, filter.finish());
    try t.expectEqual(c.ZC_INVALID, sink.begin.?(sink.context, &record));
    // Skipped records do not dereference values. The backend's borrowed span
    // must not be copied merely to discover that its name was not selected.
    try t.expectEqual(c.ZC_OK, sink.value.?(sink.context, null));
    try t.expectEqual(c.ZC_OK, sink.end.?(sink.context));
    try t.expectEqual(c.ZC_INVALID, sink.end.?(sink.context));
    record.name = "Tensor";
    record.name_length = 6;
    record.kind = 2;
    try t.expectEqual(c.ZC_INVALID, sink.select.?(sink.context, &record));
    record.kind = 5;
    record.flags = 1;
    try t.expectEqual(c.ZC_INVALID, sink.select.?(sink.context, &record));
    record.flags = 2;
    const data = try t.allocator.alloc(u8, 5 * 1024 * 1024);
    defer t.allocator.free(data);
    @memset(data, 0);
    var field = std.mem.zeroes(bridge.zcd_catalog_value);
    field.kind = 5;
    field.flags = 3;
    field.count = @intCast(data.len / 4);
    field.data = data.ptr;
    field.length = data.len;
    try t.expectEqual(@as(c_int, 1), sink.select.?(sink.context, &record));
    try t.expectEqual(c.ZC_OK, sink.begin.?(sink.context, &record));
    try t.expectEqual(c.ZC_OK, sink.value.?(sink.context, &field));
    try t.expectEqual(c.ZC_OK, sink.end.?(sink.context));
    const bytes = try filter.finish();
    const reader = try wire.Reader.init(bytes);
    try t.expectEqual(@as(u32, 1), reader.count);
    const result = (try reader.findValue(.f32, .{ .name = "Tensor", .vendors = &.{""} })).?;
    try t.expectEqual(data.len, result.data.len);
    try t.expectEqual(@as(u32, @intCast(data.len / 4)), result.count);
    // The bridge's common ceiling allows shape metadata, while this selected
    // record has a stricter payload ceiling. Reject before appending its bytes.
    filter.value_limits = &.{data.len - 4};
    try t.expectEqual(c.ZC_OK, sink.begin.?(sink.context, &record));
    const before = selected.writer.bytes.items.len;
    try t.expectEqual(c.ZC_BUSY, sink.value.?(sink.context, &field));
    try t.expectEqual(before, selected.writer.bytes.items.len);
}
