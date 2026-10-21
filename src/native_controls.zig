//! Typed control framing and exact compatibility projections. Ownership stays in
//! the core; bridge entries borrow a validated immutable call buffer.
const std = @import("std");
pub const api = @import("catalog.zig");
pub const wire = api.wire;
const c = @import("abi.zig").c;
pub const max_controls = 256;
pub const transient = 128;
pub const update_kind = 6;
pub const state_kind = 5;
pub const Input = api.bridge.zcd_control_input;
pub fn input(r: wire.Record) !Input {
    if (r.info.group != 0 or r.info.id == 0 or r.count != 1) return error.InvalidCatalog;
    var values = r.values();
    const value = (try values.next()).?;
    if (value.flags & ~@as(u32, 3) != 0 or value.role != 0 or value.label.len != 0 or value.kind == .none or value.kind == .unknown) return error.InvalidCatalog;
    return .{ .record = .{ .group = 0, .id = r.info.id, .app_id = 0, .native_type = r.info.native_type, .flags = r.info.flags, .extent = r.info.extent, .kind = @intFromEnum(value.kind), .name = r.info.name.ptr, .name_length = r.info.name.len, .vendor = r.info.vendor.ptr, .vendor_length = r.info.vendor.len }, .value = .{ .role = 0, .kind = @intFromEnum(value.kind), .native_type = value.native_type, .flags = value.flags, .count = value.count, .data = value.data.ptr, .length = value.data.len, .label = null, .label_length = 0 } };
}
pub fn emit(sink: *const api.Sink, record: wire.Record) c_int {
    const r: api.bridge.zcd_catalog_record = .{ .group = record.info.group, .id = record.info.id, .app_id = record.info.app_id, .native_type = record.info.native_type, .flags = record.info.flags, .extent = record.info.extent, .kind = @intFromEnum(record.info.kind), .name = record.info.name.ptr, .name_length = record.info.name.len, .vendor = record.info.vendor.ptr, .vendor_length = record.info.vendor.len };
    var rc = sink.begin.?(sink.context, &r);
    if (rc != 0) return rc;
    var it = record.values();
    while (it.next() catch return c.ZC_INVALID) |v| {
        const value: api.bridge.zcd_catalog_value = .{ .role = v.role, .kind = @intFromEnum(v.kind), .native_type = v.native_type, .flags = v.flags, .count = v.count, .data = v.data.ptr, .length = v.data.len, .label = v.label.ptr, .label_length = v.label.len };
        rc = sink.value.?(sink.context, &value);
        if (rc != 0) return rc;
    }
    return sink.end.?(sink.context);
}
pub fn reader(bytes: []const u8, expected: u32) !wire.Reader {
    if (bytes.len > api.limit) return error.CatalogFull;
    const r = try wire.Reader.init(bytes);
    if (r.catalog_kind != expected or r.count > max_controls) return error.InvalidCatalog;
    return r;
}
pub fn valueOf(r: wire.Record) !wire.Value {
    var it = r.values();
    return (try it.next()) orelse error.InvalidCatalog;
}
pub fn integer(comptime T: type, value: wire.Value, i: usize) T {
    const width = @sizeOf(T);
    return std.mem.readInt(T, value.data[i * width ..][0..width], if (value.flags & wire.little_endian != 0) .little else .big);
}
/// Null means the exact native request cannot be represented by ABI v1's
/// sixteen doubles. Never round large integers or silently truncate arrays.
pub fn legacy(r: wire.Record) ?c.zc_control {
    if (r.info.app_id == 0) return null;
    const v = valueOf(r) catch return null;
    var result = std.mem.zeroes(c.zc_control);
    result.id = r.info.app_id;
    result.type = switch (v.kind) {
        .boolean => c.ZC_BOOL,
        .i32, .i64 => c.ZC_INT,
        .f32 => c.ZC_FLOAT,
        .rectangle => c.ZC_RECT,
        else => return null,
    };
    const count: u64 = @as(u64, v.count) * @as(u64, if (v.kind == .rectangle) 4 else 1);
    if (count == 0 or count > 16) return null;
    result.count = @intCast(count);
    for (0..result.count) |i| {
        result.values[i] = switch (v.kind) {
            .boolean => @floatFromInt(v.data[i]),
            .i32 => @floatFromInt(integer(i32, v, i)),
            .i64 => blk: {
                const number = integer(i64, v, i);
                if (number < -9007199254740991 or number > 9007199254740991) return null;
                break :blk @floatFromInt(number);
            },
            .f32 => @as(f32, @bitCast(integer(u32, v, i))),
            .rectangle => if (i % 4 < 2) @floatFromInt(integer(i32, v, i)) else @floatFromInt(integer(u32, v, i)),
            else => unreachable,
        };
    }
    return result;
}
pub fn persistent(r: wire.Record) bool {
    return r.info.flags & transient == 0 and r.info.app_id != c.ZC_AF_TRIGGER and r.info.app_id != c.ZC_AF_PAUSE;
}
