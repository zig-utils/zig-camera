//! Virtual writable native controls and immutable request-local vendor metadata.
const std = @import("std");
const c = @import("abi.zig").c;
const ctl = @import("native_controls.zig");
const wire = ctl.wire;
const api = ctl.api;
const backend = @import("synthetic.zig");
const alloc = std.heap.c_allocator;
pub const Ref = struct {
    writer: wire.Writer,
    refs: usize = 1,
    pub fn retain(p: ?*Ref) ?*Ref {
        if (p) |r| r.refs += 1;
        return p;
    }
    pub fn release(p: ?*Ref) void {
        if (p) |r| {
            r.refs -= 1;
            if (r.refs == 0) {
                r.writer.deinit();
                alloc.destroy(r);
            }
        }
    }
    fn take(writer: wire.Writer) !*Ref {
        var owned = writer;
        errdefer owned.deinit();
        const result = try alloc.create(Ref);
        result.* = .{ .writer = owned };
        return result;
    }
};
pub const Prepared = struct {
    owner: *backend.Handle,
    version: u64,
    pending: [31]?c.zc_control,
    desired: [31]?c.zc_control,
    current: ?*Ref,
    saved: ?*Ref,
    committed: bool = false,
};
const Spec = struct { name: []const u8, kind: wire.Kind, array: bool = false, extent: u32 = 0, writable: bool = true };
pub const first_id = 0x10001;
pub const specs = [_]Spec{
    .{ .name = "SyntheticInt64", .kind = .i64 },
    .{ .name = "SyntheticText", .kind = .string },
    .{ .name = "SyntheticBytes", .kind = .byte, .array = true, .extent = std.math.maxInt(u32) },
    .{ .name = "SyntheticFloats", .kind = .f32, .array = true, .extent = std.math.maxInt(u32) },
    .{ .name = "SyntheticRectangles", .kind = .rectangle, .array = true, .extent = std.math.maxInt(u32) },
    .{ .name = "SyntheticUint16", .kind = .u16 },
    .{ .name = "SyntheticUint32", .kind = .u32 },
    .{ .name = "SyntheticPoint", .kind = .point },
    .{ .name = "SyntheticSize", .kind = .size },
    .{ .name = "SyntheticReadOnly", .kind = .i32, .writable = false },
};
fn specInfo(index: usize) wire.RecordInfo {
    const spec = specs[index];
    return .{ .id = @intCast(first_id + index), .kind = spec.kind, .native_type = @intFromEnum(spec.kind), .name = spec.name, .vendor = "synthetic", .flags = 8 | 16 | 32 | (if (spec.writable) @as(u32, 1) else 2) | (if (spec.array) @as(u32, 4) else 0), .extent = spec.extent };
}
fn knownInfo(h: *backend.Handle, id: u32) !wire.RecordInfo {
    var info: c.zc_control_info = undefined;
    if (backend.controlInfo(h, id, &info) != 0) return error.Unsupported;
    const kind: wire.Kind = if (info.type == c.ZC_BOOL) .boolean else if (info.type == c.ZC_FLOAT) .f32 else if (info.type == c.ZC_RECT) .rectangle else if (id == c.ZC_FRAME_DURATION_LIMITS) .i64 else .i32;
    const arr = id == c.ZC_COLOUR_GAINS or id == c.ZC_FRAME_DURATION_LIMITS or id == c.ZC_AF_WINDOWS;
    return .{ .id = id, .app_id = id, .kind = kind, .native_type = @intFromEnum(kind), .name = @import("synthetic_catalog.zig").names[id], .vendor = "synthetic", .flags = 1 | 8 | 16 | 32 | (if (arr) @as(u32, 4) else 0), .extent = if (id == c.ZC_AF_WINDOWS) std.math.maxInt(u32) else if (arr) 2 else 0 };
}
fn writeRecord(writer: *wire.Writer, info: wire.RecordInfo, value: wire.Value) !void {
    try writer.begin(info);
    try writer.append(value);
    try writer.end();
}
fn source(p: ?*Ref) !?wire.Reader {
    if (p) |r| return try wire.Reader.init(try r.writer.finish());
    return null;
}
fn merge(p: ?*Ref, updates: *const wire.Writer) !*Ref {
    const next = try @import("home/catalog_state.zig").updated(alloc, try source(p), try wire.Reader.init(try updates.finish()), &.{}, ctl.state_kind, ctl.max_controls, api.limit);
    return Ref.take(next);
}
fn validate(h: *backend.Handle, info: wire.RecordInfo, value: wire.Value) !?c.zc_control {
    const arr = value.flags & wire.array != 0;
    if (value.kind != info.kind or (info.kind != .string and arr != (info.flags & 4 != 0))) return error.InvalidCatalog;
    if (info.flags & 1 == 0) return error.Unsupported;
    if (info.app_id != 0) {
        var range: c.zc_control_info = undefined;
        _ = backend.controlInfo(h, info.app_id, &range);
        if (info.app_id == c.ZC_AF_WINDOWS) {
            if (value.count > 32) return error.InvalidCatalog;
            for (0..value.count) |i| {
                const single: wire.Value = .{ .kind = .rectangle, .flags = value.flags & ~@as(u32, wire.array), .count = 1, .data = value.data[i * 16 ..][0..16] };
                var writer = try wire.Writer.init(alloc, 6, 512);
                defer writer.deinit();
                try writeRecord(&writer, info, single);
                var records = (try wire.Reader.init(try writer.finish())).records();
                const one = ctl.legacy((try records.next()).?) orelse return error.InvalidCatalog;
                if (!@import("controls.zig").valid(&one, &range)) return error.InvalidCatalog;
            }
            if (value.count == 0 or value.count > 4) return null;
        } else if (arr and value.count != 2) return error.InvalidCatalog;
        var writer = try wire.Writer.init(alloc, 6, 1024);
        defer writer.deinit();
        try writeRecord(&writer, info, value);
        var records = (try wire.Reader.init(try writer.finish())).records();
        const legacy = ctl.legacy((try records.next()).?) orelse return error.InvalidCatalog;
        if (legacy.type == c.ZC_FLOAT) {
            for (0..4) |i| {
                range.min[i] = @as(f32, @floatCast(range.min[i]));
                range.max[i] = @as(f32, @floatCast(range.max[i]));
            }
        }
        if (!@import("controls.zig").valid(&legacy, &range)) return error.InvalidCatalog;
        return legacy;
    }
    switch (value.kind) {
        .string, .byte => if (value.data.len > 4096) return error.InvalidCatalog,
        .f32 => {
            if (value.count > 256) return error.InvalidCatalog;
            for (0..value.count) |i| {
                const v: f32 = @bitCast(ctl.integer(u32, value, i));
                if (!std.math.isFinite(v) or v < -16 or v > 16) return error.InvalidCatalog;
            }
        },
        .rectangle => {
            if (value.count > 32) return error.InvalidCatalog;
            for (0..value.count) |i| {
                const x = ctl.integer(i32, value, i * 4);
                const y = ctl.integer(i32, value, i * 4 + 1);
                const w = ctl.integer(u32, value, i * 4 + 2);
                const height = ctl.integer(u32, value, i * 4 + 3);
                if (x < 0 or y < 0 or w == 0 or height == 0 or @as(i64, x) + w > h.info.main.width or @as(i64, y) + height > h.info.main.height) return error.InvalidCatalog;
            }
        },
        .point => {
            const x = ctl.integer(i32, value, 0);
            const y = ctl.integer(i32, value, 1);
            if (x < -4096 or x > 4096 or y < -4096 or y > 4096) return error.InvalidCatalog;
        },
        .size => {
            const w = ctl.integer(u32, value, 0);
            const height = ctl.integer(u32, value, 1);
            if (w == 0 or height == 0 or w > 65535 or height > 65535) return error.InvalidCatalog;
        },
        .i64, .u16, .u32 => {},
        else => return error.Unsupported,
    }
    return null;
}
pub fn prepare(h: *backend.Handle, entries: [*]const ctl.Input, count: u32, sink: *const api.Sink, out: *?*Prepared) c_int {
    out.* = null;
    return prepareFallible(h, entries[0..count], sink, out) catch |err| return if (err == error.Unsupported) c.ZC_UNSUPPORTED else api.status(err);
}
fn prepareFallible(h: *backend.Handle, entries: []const ctl.Input, sink: *const api.Sink, out: *?*Prepared) !c_int {
    if (h.revision == std.math.maxInt(u64)) return c.ZC_STATE;
    const p = try alloc.create(Prepared);
    p.* = .{ .owner = h, .version = h.revision, .pending = h.pending, .desired = h.saved, .current = Ref.retain(h.vendor_current), .saved = Ref.retain(h.vendor_saved) };
    var published = false;
    defer if (!published) close(p);
    var vendors = try wire.Writer.init(alloc, 6, api.limit);
    defer vendors.deinit();
    var saved = try wire.Writer.init(alloc, 6, api.limit);
    defer saved.deinit();
    var aliases: [2]?c.zc_control = @splat(null);
    var alias_saved: [2]bool = @splat(false);
    var ae: ?c.zc_control = null;
    var ae_saved = false;
    for (entries, 0..) |entry, index| {
        for (entries[0..index]) |previous| if (previous.record.id == entry.record.id) return error.InvalidCatalog;
        var info = if (entry.record.id < 31 and entry.record.id > 0) try knownInfo(h, entry.record.id) else if (entry.record.id >= first_id and entry.record.id < first_id + specs.len) specInfo(entry.record.id - first_id) else return error.Unsupported;
        if (entry.record.name_length > 0 and !std.mem.eql(u8, entry.record.name[0..entry.record.name_length], info.name)) return error.Unsupported;
        if (entry.record.flags & 32 != 0 and !std.mem.eql(u8, entry.record.vendor[0..entry.record.vendor_length], info.vendor)) return error.Unsupported;
        const value: wire.Value = .{ .native_type = info.native_type, .kind = std.enums.fromInt(wire.Kind, entry.value.kind) orelse return error.InvalidCatalog, .flags = entry.value.flags, .count = entry.value.count, .data = entry.value.data[0..entry.value.length] };
        const legacy = try validate(h, info, value);
        const persistent = entry.record.flags & ctl.transient == 0 and info.app_id != c.ZC_AF_TRIGGER and info.app_id != c.ZC_AF_PAUSE;
        if (!persistent) info.flags |= ctl.transient;
        if (legacy) |converted| {
            p.pending[info.app_id] = converted;
            if (info.app_id == c.ZC_AE_ENABLE) {
                ae = converted;
                ae_saved = persistent;
            }
            if (info.app_id == c.ZC_EXPOSURE_TIME_MODE or info.app_id == c.ZC_ANALOGUE_GAIN_MODE) {
                const n = info.app_id - c.ZC_EXPOSURE_TIME_MODE;
                aliases[n] = converted;
                alias_saved[n] = persistent;
            }
            if (persistent) p.desired[info.app_id] = converted;
        }
        var normalized = try wire.Writer.init(alloc, 6, api.limit);
        defer normalized.deinit();
        try writeRecord(&normalized, info, value);
        var it = (try wire.Reader.init(try normalized.finish())).records();
        const rc = ctl.emit(sink, (try it.next()).?);
        if (rc != 0) return rc;
        if (info.app_id == 0) {
            try writeRecord(&vendors, info, value);
            if (persistent) try writeRecord(&saved, info, value);
        }
    }
    if (ae) |enabled| {
        for ([_]u32{ c.ZC_EXPOSURE_TIME_MODE, c.ZC_ANALOGUE_GAIN_MODE }) |app| {
            var mode = h.saved[app].?;
            mode.values[0] = if (enabled.values[0] != 0) 0 else 1;
            p.pending[app] = mode;
            if (ae_saved) p.desired[app] = mode;
        }
        for (aliases, 0..) |mode, i| if (mode) |explicit| {
            p.pending[c.ZC_EXPOSURE_TIME_MODE + i] = explicit;
            if (alias_saved[i]) p.desired[c.ZC_EXPOSURE_TIME_MODE + i] = explicit;
        };
    }
    if (vendors.count > 0) {
        const next = try merge(h.vendor_current, &vendors);
        Ref.release(p.current);
        p.current = next;
    }
    if (saved.count > 0) {
        const next = try merge(h.vendor_saved, &saved);
        Ref.release(p.saved);
        p.saved = next;
    }
    if (h.fail_controls_once) {
        h.fail_controls_once = false;
        return c.ZC_IO;
    }
    out.* = p;
    published = true;
    return c.ZC_OK;
}
pub fn commit(h: *backend.Handle, p: *Prepared, revision: *u64) c_int {
    if (p.owner != h or p.version != h.revision or p.committed) return c.ZC_STALE;
    if (h.revision == std.math.maxInt(u64)) return c.ZC_STATE;
    h.pending = p.pending;
    h.saved = p.desired;
    Ref.release(h.vendor_current);
    Ref.release(h.vendor_saved);
    h.vendor_current = p.current;
    h.vendor_saved = p.saved;
    p.current = null;
    p.saved = null;
    h.revision += 1;
    revision.* = h.revision;
    p.committed = true;
    return c.ZC_OK;
}
pub fn close(p: *Prepared) void {
    Ref.release(p.current);
    Ref.release(p.saved);
    alloc.destroy(p);
}
pub fn metadata(h: *backend.Handle, index: u32, sink: *const api.Sink) c_int {
    if (h.vendor_frames[index]) |p| {
        var it = (wire.Reader.init(p.writer.finish() catch return c.ZC_INVALID) catch return c.ZC_INVALID).records();
        while (it.next() catch return c.ZC_INVALID) |record| {
            var output = record;
            output.info.flags = (output.info.flags & ~@as(u32, 1)) | 2;
            const rc = ctl.emit(sink, output);
            if (rc != 0) return rc;
        }
    }
    return c.ZC_OK;
}
pub fn capabilities(h: *backend.Handle, sink: *const api.Sink) c_int {
    var writer = wire.Writer.init(alloc, 3, api.limit) catch return c.ZC_NOMEM;
    defer writer.deinit();
    for (specs, 0..) |spec, i| {
        writer.begin(specInfo(i)) catch return c.ZC_NOMEM;
        var bytes: [16]u8 = @splat(0);
        const endian = @import("builtin").cpu.arch.endian();
        for (1..4) |role| {
            const count: u32 = if (spec.kind == .string or (spec.array and role == 3)) 0 else 1;
            const width: usize = switch (spec.kind) {
                .i64 => 8,
                .u16 => 2,
                .u32, .i32 => 4,
                .point, .size => 8,
                .rectangle => 16,
                .f32 => 4,
                else => 1,
            };
            if (spec.kind == .i64) std.mem.writeInt(i64, bytes[0..8], if (role == 1) std.math.minInt(i64) else if (role == 2) std.math.maxInt(i64) else 0, endian);
            if (spec.kind == .u16) std.mem.writeInt(u16, bytes[0..2], if (role == 2) std.math.maxInt(u16) else 0, endian);
            if (spec.kind == .u32) std.mem.writeInt(u32, bytes[0..4], if (role == 2) std.math.maxInt(u32) else 0, endian);
            if (spec.kind == .f32) std.mem.writeInt(u32, bytes[0..4], @bitCast(@as(f32, if (role == 1) -16 else if (role == 2) 16 else 0)), endian);
            if (spec.kind == .byte) bytes[0] = if (role == 2) 255 else 0;
            if (spec.kind == .rectangle) {
                for (0..4) |n| std.mem.writeInt(u32, bytes[n * 4 ..][0..4], if (n < 2) 0 else if (role == 1) 1 else if (n == 2) h.info.main.width else h.info.main.height, endian);
            }
            if (spec.kind == .point) for (0..2) |n| std.mem.writeInt(i32, bytes[n * 4 ..][0..4], if (role == 1) -4096 else if (role == 2) 4096 else 0, endian);
            if (spec.kind == .size) for (0..2) |n| std.mem.writeInt(u32, bytes[n * 4 ..][0..4], if (role == 2) 65535 else 1, endian);
            writer.append(.{ .role = @intCast(role), .kind = spec.kind, .flags = (if ((spec.array and role == 3) or spec.kind == .string) @as(u32, 1) else 0) | (if (endian == .little) @as(u32, 2) else 0), .count = count, .data = bytes[0 .. width * count] }) catch return c.ZC_NOMEM;
        }
        writer.end() catch return c.ZC_NOMEM;
    }
    var it = (wire.Reader.init(writer.finish() catch return c.ZC_INVALID) catch return c.ZC_INVALID).records();
    while (it.next() catch return c.ZC_INVALID) |record| {
        const rc = ctl.emit(sink, record);
        if (rc != 0) return rc;
    }
    return c.ZC_OK;
}
