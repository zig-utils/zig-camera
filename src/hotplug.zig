//! Bounded manager events; SDK callbacks copy IDs and wake native waiters only.
//! Reuses Home's preallocated owned FIFO and exact device identity validation.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const Tuning = @import("tuning_session.zig");
const Identity = @import("home/device_identity.zig").Identity(c.ZC_MAX_CAMERA_ID);
const Queue = @import("home/owned_fifo.zig").Queue(Notice);
const A = std.heap.c_allocator;
const Notice = struct { kind: u32, sequence: u64 };
const RealWatch = opaque {};
const Callback = *const fn (?*anyopaque, u32, ?[*]const u8, usize) callconv(.c) void;
extern fn zcd_camera_watch_open(?*anyopaque, Callback, *?*RealWatch) c_int;
extern fn zcd_camera_watch_close(*RealWatch) void;
var registry: std.Thread.Mutex = .{};
var live: [2]u32 = .{ 0, 0 };
const Watch = struct {
    backend: u32,
    queue: Queue,
    operation: std.Thread.Mutex = .{},
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    sequence: u64 = 0,
    missed: u64 = 0,
    stopped: bool = false,
    waiters: u32 = 0,
    real: ?*RealWatch = null,
    fn pointer(self: *Watch) *c.zc_camera_watch {
        return @ptrCast(self);
    }
    fn publish(self: *Watch, kind: u32, id: ?[*]const u8, length: usize) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stopped) return;
        // Do not wrap event identity. Once exhausted, force a rescan forever.
        self.sequence +|= 1;
        const valid = (kind == c.ZC_CAMERA_ADDED or kind == c.ZC_CAMERA_REMOVED) and length > 0 and length <= c.ZC_MAX_CAMERA_ID and id != null;
        const identity = if (valid) Identity.init(id.?[0..length]) catch null else null;
        const payload: []const u8 = if (identity) |*value| value.bytes() else &.{};
        const exhausted = self.sequence == std.math.maxInt(u64);
        const rescan = identity == null or exhausted;
        if (rescan) self.missed +|= 1;
        if (!self.queue.fits(payload.len)) {
            self.queue.pop();
            self.missed +|= 1;
        }
        self.queue.push(.{ .kind = if (rescan) c.ZC_CAMERA_RESCAN else kind, .sequence = self.sequence }, if (rescan) &.{} else payload) catch unreachable;
        self.changed.broadcast();
    }
};
fn owner(p: *c.zc_camera_watch) *Watch {
    return @ptrCast(@alignCast(p));
}
fn notice(ctx: ?*anyopaque, kind: u32, id: ?[*]const u8, length: usize) callconv(.c) void {
    const self: *Watch = @ptrCast(@alignCast(ctx.?));
    self.publish(kind, id, length);
}
pub export fn zc_camera_watch_open(backend: u32, capacity: u32, out: *?*c.zc_camera_watch) c_int {
    out.* = null;
    if (backend > 1 or capacity == 0 or capacity > 64) return c.ZC_INVALID;
    if (backend == c.ZC_LIBCAMERA and !options.libcamera) return c.ZC_UNSUPPORTED;
    registry.lock();
    if (live[backend] == 32) {
        registry.unlock();
        return c.ZC_BUSY;
    }
    live[backend] += 1;
    registry.unlock();
    var success = false;
    defer if (!success) {
        registry.lock();
        live[backend] -= 1;
        registry.unlock();
    };
    const self = A.create(Watch) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(self);
    self.* = .{ .backend = backend, .queue = Queue.init(A, @as(usize, capacity) * c.ZC_MAX_CAMERA_ID, capacity) catch return c.ZC_NOMEM };
    defer if (!success) self.queue.deinit();
    const rc = if (backend == c.ZC_SYNTHETIC) Tuning.begin(backend) else if (options.libcamera) zcd_camera_watch_open(self, notice, &self.real) else c.ZC_UNSUPPORTED;
    if (rc != c.ZC_OK) return rc;
    out.* = self.pointer();
    success = true;
    return c.ZC_OK;
}
pub export fn zc_camera_watch_get_state(p: *c.zc_camera_watch, out: *c.zc_camera_watch_state) c_int {
    const self = owner(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = .{ .struct_size = @sizeOf(c.zc_camera_watch_state), .backend = self.backend, .capacity = @intCast(self.queue.entries.len), .queued = @intCast(self.queue.count), .sequence = self.sequence, .missed = self.missed, .stopped = @intFromBool(self.stopped), .waiters = self.waiters };
    return c.ZC_OK;
}
pub export fn zc_camera_watch_wait(p: *c.zc_camera_watch, timeout_ms: u32, out: *c.zc_camera_event) c_int {
    const self = owner(p);
    var timer = std.time.Timer.start() catch return c.ZC_IO;
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.waiters == 32) return c.ZC_BUSY;
    self.waiters += 1;
    defer self.waiters -= 1;
    while (self.queue.front() == null) {
        if (self.stopped) return c.ZC_CANCELLED;
        const limit = @as(u64, timeout_ms) * std.time.ns_per_ms;
        const elapsed = timer.read();
        if (elapsed >= limit) return c.ZC_TIMEOUT;
        self.changed.timedWait(&self.mutex, limit - elapsed) catch {};
    }
    const entry = self.queue.front().?;
    var event = std.mem.zeroes(c.zc_camera_event);
    event.struct_size = @sizeOf(c.zc_camera_event);
    event.backend = self.backend;
    event.kind = entry.value.kind;
    event.sequence = entry.value.sequence;
    event.missed = self.missed;
    const bytes = self.queue.copyFront(&event.id) catch unreachable;
    event.id_length = @intCast(bytes.len);
    self.queue.pop();
    out.* = event;
    return c.ZC_OK;
}
fn stop(self: *Watch) void {
    self.mutex.lock();
    const was_stopped = self.stopped;
    self.stopped = true;
    self.changed.broadcast();
    self.mutex.unlock();
    if (was_stopped) return;
    // Never hold the queue mutex while joining a callback relay or manager.
    if (self.backend == c.ZC_SYNTHETIC) Tuning.end(self.backend) else if (options.libcamera) zcd_camera_watch_close(self.real.?);
    self.real = null;
}
pub export fn zc_camera_watch_stop(p: *c.zc_camera_watch) c_int {
    const self = owner(p);
    self.operation.lock();
    defer self.operation.unlock();
    stop(self);
    return c.ZC_OK;
}
pub export fn zc_camera_watch_close(p: *c.zc_camera_watch) c_int {
    const self = owner(p);
    self.operation.lock();
    stop(self);
    self.mutex.lock();
    const busy = self.waiters != 0;
    self.mutex.unlock();
    self.operation.unlock();
    if (busy) return c.ZC_BUSY;
    self.queue.deinit();
    registry.lock();
    live[self.backend] -= 1;
    registry.unlock();
    A.destroy(self);
    return c.ZC_OK;
}
pub export fn zc_camera_watch_simulate_event(p: *c.zc_camera_watch, kind: u32, id: ?[*]const u8, length: u32) c_int {
    const self = owner(p);
    if (self.backend != c.ZC_SYNTHETIC) return c.ZC_UNSUPPORTED;
    if ((kind != c.ZC_CAMERA_ADDED and kind != c.ZC_CAMERA_REMOVED) or id == null or length == 0 or length > c.ZC_MAX_CAMERA_ID) return c.ZC_INVALID;
    _ = Identity.init(id.?[0..length]) catch return c.ZC_INVALID;
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    const stopped = self.stopped;
    self.mutex.unlock();
    if (stopped) return c.ZC_STATE;
    self.publish(kind, id, length);
    return c.ZC_OK;
}

test "hotplug queue owns exact IDs, exposes eviction and rescan, preserves failed output" {
    const t = std.testing;
    var p: ?*c.zc_camera_watch = null;
    try t.expectEqual(c.ZC_OK, zc_camera_watch_open(0, 2, &p));
    defer _ = zc_camera_watch_close(p.?);
    const w = owner(p.?);
    var event: c.zc_camera_event = undefined;
    @memset(std.mem.asBytes(&event), 0xa5);
    const before = event;
    try t.expectEqual(c.ZC_TIMEOUT, zc_camera_watch_wait(p.?, 0, &event));
    try t.expectEqualSlices(u8, std.mem.asBytes(&before), std.mem.asBytes(&event));
    var name = [_]u8{ 'C', 'a', 'm', '/', '1' };
    try t.expectEqual(c.ZC_OK, zc_camera_watch_simulate_event(p.?, 1, &name, name.len));
    @memset(&name, 0);
    try t.expectEqual(c.ZC_OK, zc_camera_watch_wait(p.?, 0, &event));
    try t.expectEqualStrings("Cam/1", event.id[0..event.id_length]);
    const long: [c.ZC_MAX_CAMERA_ID]u8 = @splat('x');
    try t.expectEqual(c.ZC_OK, zc_camera_watch_simulate_event(p.?, 1, &long, long.len));
    try t.expectEqual(c.ZC_OK, zc_camera_watch_simulate_event(p.?, 2, "removed", 7));
    try t.expectEqual(c.ZC_OK, zc_camera_watch_simulate_event(p.?, 1, "new", 3));
    try t.expectEqual(c.ZC_OK, zc_camera_watch_wait(p.?, 0, &event));
    try t.expectEqual(@as(u64, 3), event.sequence);
    try t.expectEqual(@as(u64, 1), event.missed);
    try t.expectEqualStrings("removed", event.id[0..event.id_length]);
    w.publish(1, "too big", c.ZC_MAX_CAMERA_ID + 1); // No out-of-range read.
    _ = zc_camera_watch_wait(p.?, 0, &event);
    try t.expectEqualStrings("new", event.id[0..event.id_length]);
    _ = zc_camera_watch_wait(p.?, 0, &event);
    try t.expectEqual(@as(u32, c.ZC_CAMERA_RESCAN), event.kind);
    try t.expectEqual(@as(u32, 0), event.id_length);
    try t.expectEqual(@as(u64, 2), event.missed);
    w.sequence = std.math.maxInt(u64) - 1;
    w.publish(1, "cam", 3);
    _ = zc_camera_watch_wait(p.?, 0, &event);
    try t.expectEqual(@as(u32, c.ZC_CAMERA_RESCAN), event.kind);
    try t.expectEqual(@as(u64, std.math.maxInt(u64)), event.sequence);
}
test "hotplug watch bounds, invalid admission and tuning ownership across discovery gaps" {
    const t = std.testing;
    var list: [32]?*c.zc_camera_watch = @splat(null);
    var opened: usize = 0;
    defer for (list[0..opened]) |p| {
        _ = zc_camera_watch_close(p.?);
    };
    for (&list) |*p| {
        try t.expectEqual(c.ZC_OK, zc_camera_watch_open(0, 1, p));
        opened += 1;
    }
    var out: ?*c.zc_camera_watch = list[0];
    try t.expectEqual(c.ZC_BUSY, zc_camera_watch_open(0, 1, &out));
    try t.expectEqual(null, out);
    for ([_]u32{ 0, 65 }) |capacity| try t.expectEqual(c.ZC_INVALID, zc_camera_watch_open(0, capacity, &out));
    try t.expectEqual(c.ZC_INVALID, zc_camera_watch_open(2, 1, &out));
    for ([_][]const u8{ "", "a\x00b", "\xff" }) |id| try t.expectEqual(c.ZC_INVALID, zc_camera_watch_simulate_event(list[0].?, 1, id.ptr, @intCast(id.len)));
    var state: c.zc_camera_watch_state = undefined;
    _ = zc_camera_watch_get_state(list[0].?, &state);
    try t.expectEqual(@as(u64, 0), state.sequence);
    var token: ?*c.zc_tuning_session = null;
    try t.expectEqual(c.ZC_BUSY, Tuning.create("{\"a\":1}", 7, 0, &token));
    for (list[0..opened]) |p| {
        _ = zc_camera_watch_close(p.?);
    }
    opened = 0;
    try t.expectEqual(c.ZC_OK, Tuning.create("{\"a\":1}", 7, 0, &token));
    try t.expectEqual(c.ZC_OK, zc_camera_watch_open(0, 1, &out));
    defer _ = zc_camera_watch_close(out.?);
    try t.expectEqual(c.ZC_OK, Tuning.zc_tuning_session_close(token.?));
    var tuning_state: c.zc_tuning_state = undefined;
    _ = Tuning.zc_get_tuning_state(0, &tuning_state);
    try t.expectEqual(@as(u32, 1), tuning_state.custom);
    try t.expectEqual(c.ZC_OK, zc_camera_watch_stop(out.?));
    _ = Tuning.zc_get_tuning_state(0, &tuning_state);
    try t.expectEqual(@as(u32, 0), tuning_state.custom);
    var event: c.zc_camera_event = undefined;
    try t.expectEqual(c.ZC_CANCELLED, zc_camera_watch_wait(out.?, 0, &event));
    try t.expectEqual(c.ZC_STATE, zc_camera_watch_simulate_event(out.?, 1, "cam", 3));
}
test "stop wakes blocked native watch waiters and close joins callback admission" {
    const t = std.testing;
    var p: ?*c.zc_camera_watch = null;
    try t.expectEqual(c.ZC_OK, zc_camera_watch_open(0, 1, &p));
    const Worker = struct {
        fn run(watch: *c.zc_camera_watch, result: *std.atomic.Value(c_int)) void {
            var event: c.zc_camera_event = undefined;
            result.store(zc_camera_watch_wait(watch, 5000, &event), .release);
        }
    };
    var result = std.atomic.Value(c_int).init(c.ZC_OK);
    const thread = try std.Thread.spawn(.{}, Worker.run, .{ p.?, &result });
    var timer = try std.time.Timer.start();
    var state: c.zc_camera_watch_state = undefined;
    while (true) {
        _ = zc_camera_watch_get_state(p.?, &state);
        if (state.waiters != 0 or timer.read() > std.time.ns_per_s) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const entered = state.waiters != 0;
    _ = zc_camera_watch_stop(p.?);
    thread.join();
    try t.expect(entered);
    try t.expectEqual(c.ZC_CANCELLED, result.load(.acquire));
    try t.expectEqual(c.ZC_OK, zc_camera_watch_close(p.?));
}
