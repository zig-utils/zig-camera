//! Native-only callbacks bridge Home writers to an asynchronous host runtime.
const std = @import("std");
const c = @import("abi.zig").c;
const A = std.heap.c_allocator;
const CapacityWait = @import("home/capacity_wait.zig");
const Event = struct { kind: u32, codec: u32 = 0, flags: u32 = 0, offset: u64 = 0, timestamp: u64 = 0 };
const Mailbox = struct {
    mutex: std.Thread.Mutex = .{},
    queue: @import("home/delivery_fifo.zig").Queue(Event),
    timer: std.time.Timer,
    waits: CapacityWait.Registry(16) = .{},
    retired: bool = false,
    fn send(self: *Mailbox, event: Event, data: []const u8) c_int {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.retired) return c.ZC_STATE;
        _ = self.queue.push(event, data) catch |err| return switch (err) {
            error.Closed => c.ZC_IO,
            error.BufferFull, error.PacketTooLarge => c.ZC_BUSY,
            else => c.ZC_INVALID,
        };
        return c.ZC_OK;
    }
    fn packet(ctx: ?*anyopaque, value: [*c]const c.zc_output_packet) callconv(.c) c_int {
        const self: *Mailbox = @ptrCast(@alignCast(ctx.?));
        const p = value.*;
        if (p.length > std.math.maxInt(usize) or (p.data == null and p.length != 0)) return c.ZC_INVALID;
        return self.send(.{ .kind = 0, .codec = p.codec, .flags = p.flags, .timestamp = p.timestamp_ns }, if (p.length == 0) &.{} else p.data[0..@intCast(p.length)]);
    }
    fn write(ctx: ?*anyopaque, data: [*c]const u8, size: u64) callconv(.c) c_int {
        if (size > std.math.maxInt(usize)) return c.ZC_INVALID;
        const self: *Mailbox = @ptrCast(@alignCast(ctx.?));
        return self.send(.{ .kind = 1 }, data[0..@intCast(size)]);
    }
    fn patch(ctx: ?*anyopaque, offset: u64, data: [*c]const u8, size: u64) callconv(.c) c_int {
        if (size > std.math.maxInt(usize)) return c.ZC_INVALID;
        const self: *Mailbox = @ptrCast(@alignCast(ctx.?));
        return self.send(.{ .kind = 2, .offset = offset }, data[0..@intCast(size)]);
    }
};
fn box(p: *c.zc_output_mailbox) *Mailbox {
    return @ptrCast(@alignCast(p));
}
pub export fn zc_output_mailbox_open(bytes: u64, operations: u32, out: *?*c.zc_output_mailbox) c_int {
    out.* = null;
    if (bytes == 0 or bytes > 1024 * 1024 * 1024 or operations == 0 or operations > 65536) return c.ZC_INVALID;
    const self = A.create(Mailbox) catch return c.ZC_NOMEM;
    const timer = std.time.Timer.start() catch {
        A.destroy(self);
        return c.ZC_IO;
    };
    self.* = .{ .timer = timer, .queue = @TypeOf(self.queue).init(A, @intCast(bytes), operations) catch {
        A.destroy(self);
        return c.ZC_NOMEM;
    } };
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_callbacks(p: *c.zc_output_mailbox, format: u32, out: *c.zc_output_callbacks) c_int {
    if (format > c.ZC_OUTPUT_MKV) return c.ZC_INVALID;
    out.* = .{ .struct_size = @sizeOf(c.zc_output_callbacks), .format = format, .context = box(p), .packet = Mailbox.packet, .write = Mailbox.write, .patch = Mailbox.patch, .file_fd = -1, .pts_fd = -1, .secondary_pts_fd = -1, .reserved = 0 };
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_peek(p: *c.zc_output_mailbox, out: *c.zc_output_event) c_int {
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = std.mem.zeroes(c.zc_output_event);
    if (self.queue.failure) |code| return code;
    const entry = self.queue.fifo.front() orelse return c.ZC_TIMEOUT;
    const event = entry.value.value;
    out.* = .{ .sequence = entry.value.sequence, .offset = event.offset, .timestamp_ns = event.timestamp, .length = entry.length, .kind = event.kind, .codec = event.codec, .flags = event.flags, .reserved = 0 };
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_copy(p: *c.zc_output_mailbox, sequence: u64, out: [*]u8, capacity: u64) c_int {
    if (capacity > std.math.maxInt(usize)) return c.ZC_INVALID;
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    _ = self.queue.copy(sequence, out[0..@intCast(capacity)]) catch |err| return if (err == error.StaleSequence or err == error.EmptyBuffer) c.ZC_STALE else c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_ack(p: *c.zc_output_mailbox, sequence: u64) c_int {
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.queue.ack(sequence) catch return c.ZC_STALE;
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_fail(p: *c.zc_output_mailbox, code: c_int) c_int {
    if (code >= 0) return c.ZC_INVALID;
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.queue.fail(code);
    self.waits.close(self.timer.read());
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_prefix(p: *c.zc_output_mailbox, out: *u64) c_int {
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = self.queue.issued;
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_poll(p: *c.zc_output_mailbox, target: u64) c_int {
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    return (self.queue.poll(target) catch return c.ZC_INVALID) orelse c.ZC_TIMEOUT;
}
pub export fn zc_output_mailbox_close(p: *c.zc_output_mailbox) void {
    const self = box(p);
    self.queue.deinit();
    A.destroy(self);
}
pub export fn zc_output_mailbox_stats_get(p: *c.zc_output_mailbox, out: *c.zc_output_mailbox_stats) c_int {
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    const q = self.queue.stats();
    const w = self.waits.counters;
    out.* = .{ .queued_bytes = q.queued_bytes, .queued_ops = q.queued_items, .accepted_ops = q.accepted, .completed_ops = q.completed, .rejected_ops = q.rejected, .high_bytes = q.high_bytes, .high_ops = q.high_items, .max_bytes = q.max_bytes, .max_ops = q.max_items, .accepted_bytes = q.accepted_bytes, .completed_bytes = q.completed_bytes, .wait_requests = w.requested, .blocked_waits = w.blocked, .satisfied_waits = w.satisfied, .timed_out_waits = w.timed_out, .cancelled_waits = w.cancelled, .closed_waits = w.closed, .pending_waits = w.pending, .total_wait_ns = w.total_ns, .high_wait_ns = w.high_ns, .error_code = q.failure orelse 0, .reserved = 0 };
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_wait_open(p: *c.zc_output_mailbox, bytes: u64, operations: u32, timeout: u64, ticket: *u64) c_int {
    ticket.* = 0;
    if (bytes > std.math.maxInt(usize) or timeout > 60_000_000_000) return c.ZC_INVALID;
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.retired) return c.ZC_STATE;
    const available = self.queue.capacity(@intCast(bytes), operations) catch |err| return if (err == error.Closed) self.queue.failure.? else c.ZC_INVALID;
    ticket.* = self.waits.begin(bytes, operations, timeout, self.timer.read(), available) catch return c.ZC_BUSY;
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_wait_poll(p: *c.zc_output_mailbox, ticket: u64, out: *c.zc_output_wait_state) c_int {
    out.* = std.mem.zeroes(c.zc_output_wait_state);
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    const wait = self.waits.get(ticket) orelse return c.ZC_STALE;
    const now = self.timer.read();
    const available = self.queue.capacity(@intCast(wait.bytes), wait.operations) catch false;
    const outcome = (self.waits.poll(ticket, now, available, self.retired or self.queue.failure != null) catch unreachable);
    out.remaining_ns = if (outcome == null) wait.deadline -| now else 0;
    out.done = @intFromBool(outcome != null);
    out.code = if (outcome) |value| switch (value) {
        .ready => c.ZC_OK,
        .timeout => c.ZC_TIMEOUT,
        .cancelled => c.ZC_STALE,
        .closed => self.queue.failure orelse c.ZC_STATE,
    } else c.ZC_TIMEOUT;
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_wait_close(p: *c.zc_output_mailbox, ticket: u64) c_int {
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.waits.release(ticket, self.timer.read()) catch return c.ZC_STALE;
    return c.ZC_OK;
}
pub export fn zc_output_mailbox_retire(p: *c.zc_output_mailbox) void {
    const self = box(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.retired = true;
    self.waits.close(self.timer.read());
}
test {
    _ = @import("home/delivery_fifo.zig");
}

pub fn isMailbox(cb: c.zc_output_callbacks) bool {
    return cb.packet == Mailbox.packet and cb.write == Mailbox.write and cb.patch == Mailbox.patch;
}

// Packet offsets carry the unre-based recorder source clock, so a shared PTS
// observer never has to infer an old segment's epoch from mutable output state.
pub fn sendPacket(cb: c.zc_output_callbacks, packet: c.zc_output_packet, origin: u64) c_int {
    const self: *Mailbox = @ptrCast(@alignCast(cb.context.?));
    const source = std.math.add(u64, origin, packet.timestamp_ns) catch return c.ZC_INVALID;
    return self.send(.{ .kind = 0, .codec = packet.codec, .flags = packet.flags, .timestamp = packet.timestamp_ns, .offset = source }, if (packet.length == 0) &.{} else packet.data[0..@intCast(packet.length)]);
}

test "mailbox owns bytes, sequence-checks acknowledgement and preserves completed prefixes" {
    var mailbox: ?*c.zc_output_mailbox = null;
    try std.testing.expectEqual(c.ZC_INVALID, zc_output_mailbox_open(0, 2, &mailbox));
    try std.testing.expectEqual(c.ZC_OK, zc_output_mailbox_open(3, 2, &mailbox));
    defer zc_output_mailbox_close(mailbox.?);
    var callbacks: c.zc_output_callbacks = undefined;
    _ = zc_output_mailbox_callbacks(mailbox.?, 0, &callbacks);
    var bytes = [_]u8{ 1, 2, 3 };
    var packet: c.zc_output_packet = .{ .data = &bytes, .length = 3, .timestamp_ns = 123, .codec = 3, .flags = 1 };
    try std.testing.expectEqual(c.ZC_OK, callbacks.packet.?(callbacks.context, &packet));
    bytes[0] = 99;
    try std.testing.expectEqual(c.ZC_BUSY, callbacks.packet.?(callbacks.context, &packet));
    var event: c.zc_output_event = undefined;
    _ = zc_output_mailbox_peek(mailbox.?, &event);
    try std.testing.expectEqual(@as(u64, 123), event.timestamp_ns);
    var owned: [3]u8 = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_output_mailbox_copy(mailbox.?, event.sequence, &owned, owned.len));
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, &owned);
    try std.testing.expectEqual(c.ZC_STALE, zc_output_mailbox_ack(mailbox.?, event.sequence + 1));
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_output_mailbox_poll(mailbox.?, event.sequence));
    _ = zc_output_mailbox_ack(mailbox.?, event.sequence);
    _ = callbacks.packet.?(callbacks.context, &packet);
    _ = zc_output_mailbox_fail(mailbox.?, c.ZC_IO);
    try std.testing.expectEqual(c.ZC_OK, zc_output_mailbox_poll(mailbox.?, event.sequence));
    try std.testing.expectEqual(c.ZC_IO, zc_output_mailbox_poll(mailbox.?, event.sequence + 1));
}

test "capacity tickets are bounded, retained through failure and never expose freed queue storage" {
    var mailbox: ?*c.zc_output_mailbox = null;
    try std.testing.expectEqual(c.ZC_OK, zc_output_mailbox_open(3, 2, &mailbox));
    defer zc_output_mailbox_close(mailbox.?);
    var cb: c.zc_output_callbacks = undefined;
    _ = zc_output_mailbox_callbacks(mailbox.?, 0, &cb);
    const data = [_]u8{1};
    const packet: c.zc_output_packet = .{ .data = &data, .length = 1, .timestamp_ns = 0, .codec = 3, .flags = 1 };
    try std.testing.expectEqual(c.ZC_OK, cb.packet.?(cb.context, &packet));
    var tickets: [16]u64 = undefined;
    for (&tickets) |*ticket| try std.testing.expectEqual(c.ZC_OK, zc_output_mailbox_wait_open(mailbox.?, 3, 1, 1_000_000_000, ticket));
    var overflow: u64 = 123;
    try std.testing.expectEqual(c.ZC_BUSY, zc_output_mailbox_wait_open(mailbox.?, 3, 1, 0, &overflow));
    try std.testing.expectEqual(@as(u64, 0), overflow);
    var state: c.zc_output_wait_state = undefined;
    _ = zc_output_mailbox_wait_poll(mailbox.?, tickets[0], &state);
    try std.testing.expectEqual(@as(u32, 0), state.done);
    try std.testing.expectEqual(c.ZC_OK, zc_output_mailbox_wait_close(mailbox.?, tickets[0]));
    _ = zc_output_mailbox_ack(mailbox.?, 1);
    _ = zc_output_mailbox_wait_poll(mailbox.?, tickets[1], &state);
    try std.testing.expectEqual(@as(u32, 1), state.done);
    try std.testing.expectEqual(c.ZC_OK, state.code);
    _ = zc_output_mailbox_fail(mailbox.?, c.ZC_IO);
    _ = zc_output_mailbox_wait_poll(mailbox.?, tickets[1], &state);
    try std.testing.expectEqual(c.ZC_OK, state.code);
    _ = zc_output_mailbox_wait_poll(mailbox.?, tickets[2], &state);
    try std.testing.expectEqual(c.ZC_IO, state.code);
    zc_output_mailbox_retire(mailbox.?);
    var stats: c.zc_output_mailbox_stats = undefined;
    _ = zc_output_mailbox_stats_get(mailbox.?, &stats);
    try std.testing.expectEqual(@as(u64, 16), stats.wait_requests);
    try std.testing.expectEqual(@as(u64, 1), stats.cancelled_waits);
    try std.testing.expectEqual(@as(u64, 1), stats.satisfied_waits);
    try std.testing.expectEqual(@as(u64, 14), stats.closed_waits);
    try std.testing.expectEqual(@as(u64, 0), stats.pending_waits);
    try std.testing.expectEqual(@as(u64, 1), stats.completed_bytes);
    for (tickets[1..]) |ticket| try std.testing.expectEqual(c.ZC_OK, zc_output_mailbox_wait_close(mailbox.?, ticket));
}
