//! Hosted copied-input RTP cursors. Shared framing remains in Home.
const std = @import("std");
const c = @import("abi.zig").c;
pub const Home = @import("home/rtp_packetizer.zig");
const Registry = @import("home/owned_admission.zig").Registry(16);
const A = std.heap.c_allocator;
var registry: Registry = .{ .max_bytes = 64 * 1024 * 1024, .max_items = 16 };
var mutex: std.Thread.Mutex = .{};
const Owner = struct { operation: std.Thread.Mutex = .{}, ticket: Registry.Ticket, data: []u8, cursor: Home.Packetizer };
fn owner(p: *c.zc_rtp_packetizer) *Owner {
    return @ptrCast(@alignCast(p));
}
fn release(ticket: Registry.Ticket) void {
    mutex.lock();
    defer mutex.unlock();
    registry.release(ticket) catch unreachable;
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.BufferFull, error.SequenceOverflow => c.ZC_BUSY,
        else => c.ZC_INVALID,
    };
}
fn config(input: c.zc_rtp_config) !Home.Config {
    if (input.struct_size != @sizeOf(c.zc_rtp_config) or input.payload_type > 127 or input.sequence > 65535 or input.mtu < 64 or input.mtu > 65507) return error.InvalidConfig;
    return .{ .codec = switch (input.codec) {
        1 => .h264,
        2 => .hevc,
        3 => .aac,
        else => return error.InvalidConfig,
    }, .format = switch (input.format) {
        0 => .annex_b,
        1 => .length4,
        2 => .raw,
        else => return error.InvalidConfig,
    }, .mtu = @intCast(input.mtu), .payload_type = @intCast(input.payload_type), .sequence = @intCast(input.sequence), .timestamp = input.timestamp, .ssrc = input.ssrc };
}
pub export fn zc_default_rtp_config(out: *c.zc_rtp_config) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_rtp_config), .codec = 1, .format = 0, .mtu = 1200, .payload_type = 96, .sequence = 0, .timestamp = 0, .ssrc = 1 };
}
pub export fn zc_rtp_packetizer_open(input: *const c.zc_rtp_config, data: ?[*]const u8, length: u64, out: *?*c.zc_rtp_packetizer) c_int {
    out.* = null;
    const options = config(input.*) catch return c.ZC_INVALID;
    if (data == null or length == 0 or length > 16 * 1024 * 1024) return c.ZC_INVALID;
    mutex.lock();
    const ticket = registry.reserve(@as(usize, @intCast(length)) + @sizeOf(Owner)) catch |err| {
        mutex.unlock();
        return status(err);
    };
    mutex.unlock();
    var published = false;
    defer if (!published) release(ticket);
    const self = A.create(Owner) catch return c.ZC_NOMEM;
    defer if (!published) A.destroy(self);
    const bytes = A.dupe(u8, data.?[0..@intCast(length)]) catch return c.ZC_NOMEM;
    defer if (!published) A.free(bytes);
    const cursor = Home.Packetizer.init(options, bytes, .{}) catch |err| return status(err);
    self.* = .{ .ticket = ticket, .data = bytes, .cursor = cursor };
    out.* = @ptrCast(self);
    published = true;
    return c.ZC_OK;
}
pub export fn zc_rtp_packetizer_next(p: *c.zc_rtp_packetizer, data: ?[*]u8, capacity: u32, length: *u32) c_int {
    length.* = 0;
    const self = owner(p);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    defer self.operation.unlock();
    const needed = self.cursor.nextSize();
    length.* = @intCast(needed);
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < needed) return c.ZC_INVALID;
    _ = self.cursor.next(data.?[0..capacity]) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_rtp_packetizer_state(p: *c.zc_rtp_packetizer, out: *c.zc_rtp_state) c_int {
    out.* = std.mem.zeroes(c.zc_rtp_state);
    const self = owner(p);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    defer self.operation.unlock();
    out.* = .{ .struct_size = @sizeOf(c.zc_rtp_state), .total = self.cursor.total, .emitted = self.cursor.emitted, .next_sequence = self.cursor.sequence, .timestamp = self.cursor.config.timestamp, .next_bytes = @intCast(self.cursor.nextSize()) };
    return c.ZC_OK;
}
pub export fn zc_rtp_packetizer_close(p: ?*c.zc_rtp_packetizer) c_int {
    const self = owner(p orelse return c.ZC_OK);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    const ticket = self.ticket;
    A.free(self.data);
    self.operation.unlock();
    A.destroy(self);
    release(ticket);
    return c.ZC_OK;
}
pub export fn zc_rtp_timestamp(ns: u64, rate: u32, origin: u32, out: *u32) c_int {
    out.* = 0;
    out.* = Home.timestamp(ns, rate, origin) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_rtcp_sender_report(input: *const c.zc_rtcp_report, cname: ?[*]const u8, cname_length: u32, data: ?[*]u8, capacity: u32, length: *u32) c_int {
    length.* = 0;
    if (input.struct_size != @sizeOf(c.zc_rtcp_report) or input.bye > 1 or cname == null or cname_length == 0 or cname_length > 255) return c.ZC_INVALID;
    const report = Home.SenderReport{ .ssrc = input.ssrc, .unix_ns = input.unix_ns, .rtp_timestamp = input.rtp_timestamp, .packets = input.packets, .octets = input.octets, .bye = input.bye != 0, .cname = cname.?[0..cname_length] };
    const needed = Home.senderReportSize(report) catch |err| return status(err);
    length.* = @intCast(needed);
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < needed) return c.ZC_INVALID;
    _ = Home.senderReport(data.?[0..capacity], report) catch |err| return status(err);
    return c.ZC_OK;
}
test "owned RTP cursors copy AU data and keep state and short destinations atomic" {
    const t = std.testing;
    var cfg: c.zc_rtp_config = undefined;
    zc_default_rtp_config(&cfg);
    cfg.sequence = 65535;
    var input = [_]u8{ 0, 0, 1, 0x65, 0x80 };
    var p: ?*c.zc_rtp_packetizer = null;
    try t.expectEqual(c.ZC_OK, zc_rtp_packetizer_open(&cfg, &input, input.len, &p));
    defer _ = zc_rtp_packetizer_close(p);
    @memset(&input, 0);
    var out: [20]u8 = @splat(0xa5);
    var count: u32 = 0;
    try t.expectEqual(c.ZC_OK, zc_rtp_packetizer_next(p.?, null, 0, &count));
    try t.expectEqual(@as(u32, 14), count);
    try t.expectEqual(c.ZC_INVALID, zc_rtp_packetizer_next(p.?, &out, 13, &count));
    for (out) |v| try t.expectEqual(@as(u8, 0xa5), v);
    var state: c.zc_rtp_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_rtp_packetizer_state(p.?, &state));
    try t.expectEqual(@as(u32, 0), state.emitted);
    try t.expectEqual(c.ZC_OK, zc_rtp_packetizer_next(p.?, &out, out.len, &count));
    try t.expectEqualSlices(u8, &.{ 0x65, 0x80 }, out[12..14]);
    try t.expectEqual(c.ZC_OK, zc_rtp_packetizer_state(p.?, &state));
    try t.expectEqual(@as(u32, 0), state.next_sequence);
    owner(p.?).operation.lock();
    try t.expectEqual(c.ZC_BUSY, zc_rtp_packetizer_close(p));
    owner(p.?).operation.unlock();
}
test "RTP owner admission unwinds malformed inputs and bounds retained cursors" {
    const t = std.testing;
    var cfg: c.zc_rtp_config = undefined;
    zc_default_rtp_config(&cfg);
    var p: ?*c.zc_rtp_packetizer = @ptrFromInt(1);
    for (0..32) |_| {
        try t.expectEqual(c.ZC_INVALID, zc_rtp_packetizer_open(&cfg, &.{ 0, 0, 1, 0 }, 4, &p));
        try t.expect(p == null);
    }
    var owners: [16]?*c.zc_rtp_packetizer = @splat(null);
    defer for (owners) |value| {
        _ = zc_rtp_packetizer_close(value);
    };
    for (&owners) |*value| try t.expectEqual(c.ZC_OK, zc_rtp_packetizer_open(&cfg, &.{ 0, 0, 1, 0x65, 0x80 }, 5, value));
    try t.expectEqual(c.ZC_BUSY, zc_rtp_packetizer_open(&cfg, &.{ 0, 0, 1, 0x65, 0x80 }, 5, &p));
    try t.expect(p == null);
}
pub export fn zc_rtp_timestamp_signed(value: i64, rate: u32, origin: u32, out: *u32) c_int {
    out.* = 0;
    out.* = Home.signedTimestamp(value, rate, origin) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_rtp_hevc_profile(data: ?[*]const u8, length: u32, out: *c.zc_rtp_hevc_profile_info) c_int {
    out.* = std.mem.zeroes(c.zc_rtp_hevc_profile_info);
    if (data == null or length > 1024 * 1024) return c.ZC_INVALID;
    const result = Home.hevcProfile(data.?[0..length]) catch |err| return status(err);
    out.* = .{ .struct_size = @sizeOf(c.zc_rtp_hevc_profile_info), .space = result.space, .tier = result.tier, .profile_id = result.id, .compatibility = result.compatibility, .level = result.level, .constraints = result.constraints };
    return c.ZC_OK;
}
