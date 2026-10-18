//! Bounded request ownership shared by real and synthetic devices.
//! Callbacks only publish descriptors. Recycling and DMA sync run on consumers.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const driver = if (options.libcamera) @import("real.zig") else @import("synthetic.zig");
const State = enum { idle, queued, ready, leased };
const Slot = struct { state: State = .idle, frame: c.zc_frame = std.mem.zeroes(c.zc_frame) };
const Session = struct {
    operation: std.Thread.Mutex = .{},
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    running: bool = false,
    fatal: c_int = 0,
    next_token: u64 = 1,
    config: c.zc_config,
    info: c.zc_info = std.mem.zeroes(c.zc_info),
    device: ?*driver.Handle = null,
    slots: [c.ZC_MAX_BUFFERS]Slot = @splat(.{}),
    ready: [c.ZC_MAX_BUFFERS]u32 = undefined,
    head: usize = 0,
    count: usize = 0,
    stats: c.zc_stats = std.mem.zeroes(c.zc_stats),

    fn ptr(self: *Session) *c.zc_camera {
        return @ptrCast(self);
    }
    fn pop(self: *Session) u32 {
        const i = self.ready[self.head];
        self.head = (self.head + 1) % c.ZC_MAX_BUFFERS;
        self.count -= 1;
        return i;
    }
    // operation held, mutex NOT held: synthetic queue may complete synchronously.
    fn queue(self: *Session, i: u32) c_int {
        self.mutex.lock();
        self.slots[i].state = .queued;
        self.mutex.unlock();
        const rc = driver.queue(self.device.?, i);
        if (rc != 0) {
            self.mutex.lock();
            self.slots[i].state = .idle;
            self.fatal = rc;
            self.stats.errors += 1;
            self.changed.broadcast();
            self.mutex.unlock();
        }
        return rc;
    }
};
fn session(p: *c.zc_camera) *Session {
    return @ptrCast(@alignCast(p));
}
fn completed(ctx: ?*anyopaque, index: u32, frame: ?*const c.zc_frame, status: c_int) callconv(.c) void {
    const self: *Session = @ptrCast(@alignCast(ctx.?));
    self.mutex.lock();
    defer self.mutex.unlock();
    if (!self.running) return;
    if (index >= self.info.buffer_count or self.slots[index].state != .queued or status != 0 or frame == null) {
        self.fatal = if (status != 0) status else c.ZC_DEVICE;
        self.stats.errors += 1;
        self.changed.broadcast();
        return;
    }
    self.slots[index] = .{ .state = .ready, .frame = frame.?.* };
    self.ready[(self.head + self.count) % c.ZC_MAX_BUFFERS] = index;
    self.count += 1;
    self.stats.completed += 1;
    self.changed.signal();
}
pub export fn zc_abi_version() u32 {
    return c.ZC_ABI_VERSION;
}
pub export fn zc_default_config(out: *c.zc_config) void {
    out.* = std.mem.zeroes(c.zc_config);
    out.buffer_count = 4;
    out.policy = c.ZC_LATEST;
    out.lens_position = -1;
}
fn valid(cfg: *const c.zc_config) bool {
    return cfg.buffer_count >= 2 and cfg.buffer_count <= c.ZC_MAX_BUFFERS and
        cfg.width <= 16384 and cfg.height <= 16384 and ((cfg.width == 0) == (cfg.height == 0)) and
        cfg.policy <= c.ZC_LATEST and cfg.raw <= 1 and cfg.raw_format[31] == 0 and
        ((cfg.exposure_us == 0) == (cfg.analogue_gain == 0)) and cfg.exposure_us <= 1_000_000_000 and
        cfg.frame_duration_us <= 1_000_000_000 and std.math.isFinite(cfg.analogue_gain) and
        cfg.analogue_gain >= 0 and cfg.analogue_gain <= 64 and std.math.isFinite(cfg.lens_position) and
        cfg.lens_position >= -1 and cfg.lens_position <= 100;
}
pub export fn zc_open(cfg: *const c.zc_config, out: *?*c.zc_camera) c_int {
    out.* = null;
    if (!valid(cfg)) return c.ZC_INVALID;
    const self = std.heap.c_allocator.create(Session) catch return c.ZC_NOMEM;
    self.* = .{ .config = cfg.* };
    const rc = driver.open(cfg, self, completed, &self.device, &self.info);
    if (rc != 0) {
        std.heap.c_allocator.destroy(self);
        return rc;
    }
    if (self.info.buffer_count < 2 or self.info.buffer_count > c.ZC_MAX_BUFFERS) {
        driver.close(self.device.?);
        std.heap.c_allocator.destroy(self);
        return c.ZC_DEVICE;
    }
    out.* = self.ptr();
    return c.ZC_OK;
}
pub export fn zc_get_info(p: *c.zc_camera, out: *c.zc_info) c_int {
    out.* = session(p).info;
    return c.ZC_OK;
}
pub export fn zc_start(p: *c.zc_camera) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    if (self.running or self.stats.leased != 0) {
        self.mutex.unlock();
        return c.ZC_BUSY;
    }
    self.fatal = 0;
    self.head = 0;
    self.count = 0;
    for (&self.slots) |*slot| slot.state = .idle;
    self.mutex.unlock();
    const rc = driver.start(self.device.?);
    if (rc != 0) return rc;
    self.mutex.lock();
    self.running = true;
    self.mutex.unlock();
    for (0..self.info.buffer_count) |i| {
        const queued = self.queue(@intCast(i));
        if (queued != 0) {
            _ = stopLocked(self);
            return queued;
        }
    }
    return c.ZC_OK;
}
pub export fn zc_acquire(p: *c.zc_camera, timeout_ms: u32, out: *c.zc_frame) c_int {
    const self = session(p);
    const deadline = std.time.nanoTimestamp() + @as(i128, timeout_ms) * std.time.ns_per_ms;
    while (true) {
        self.mutex.lock();
        while (self.running and self.fatal == 0 and self.count == 0) {
            const remaining = deadline - std.time.nanoTimestamp();
            if (remaining <= 0) {
                self.mutex.unlock();
                return c.ZC_TIMEOUT;
            }
            self.changed.timedWait(&self.mutex, @intCast(remaining)) catch {};
        }
        const status = if (self.fatal != 0) self.fatal else if (!self.running) c.ZC_STATE else 0;
        self.mutex.unlock();
        if (status != 0) return status;

        self.operation.lock();
        defer self.operation.unlock();
        self.mutex.lock();
        if (!self.running or self.fatal != 0) {
            const rc = if (self.fatal != 0) self.fatal else c.ZC_STATE;
            self.mutex.unlock();
            return rc;
        }
        if (self.count == 0) {
            self.mutex.unlock();
            continue;
        }
        var dropped: [c.ZC_MAX_BUFFERS]u32 = undefined;
        var num_dropped: usize = 0;
        if (self.config.policy == c.ZC_LATEST) {
            while (self.count > 1) {
                const i = self.pop();
                self.slots[i].state = .idle;
                dropped[num_dropped] = i;
                num_dropped += 1;
            }
        }
        const index = self.pop();
        const slot = &self.slots[index];
        if (self.next_token == std.math.maxInt(u64)) {
            self.fatal = c.ZC_STATE;
            self.mutex.unlock();
            return c.ZC_STATE;
        }
        slot.state = .leased;
        slot.frame.token = self.next_token;
        self.next_token += 1;
        self.stats.leased += 1;
        self.stats.dropped += num_dropped;
        self.mutex.unlock();

        for (dropped[0..num_dropped]) |i| {
            if (self.queue(i) != 0) break;
        }
        const rc = driver.sync(self.device.?, index, true);
        if (rc != 0) {
            self.mutex.lock();
            slot.state = .idle;
            self.stats.leased -= 1;
            self.stats.errors += 1;
            self.fatal = rc;
            self.changed.broadcast();
            self.mutex.unlock();
            return rc;
        }
        self.mutex.lock();
        self.stats.delivered += 1;
        out.* = slot.frame;
        self.mutex.unlock();
        return c.ZC_OK;
    }
}
pub export fn zc_release(p: *c.zc_camera, token: u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    for (self.slots[0..self.info.buffer_count], 0..) |*slot, i| {
        if (slot.state == .leased and slot.frame.token == token) {
            self.mutex.unlock();
            const rc = driver.sync(self.device.?, @intCast(i), false);
            self.mutex.lock();
            slot.state = .idle;
            self.stats.leased -= 1;
            const running = self.running;
            if (rc != 0) {
                self.fatal = rc;
                self.stats.errors += 1;
                self.changed.broadcast();
            }
            self.mutex.unlock();
            if (rc != 0) return rc;
            return if (running) self.queue(@intCast(i)) else c.ZC_OK;
        }
    }
    self.mutex.unlock();
    return c.ZC_STALE;
}
fn stopLocked(self: *Session) c_int {
    self.mutex.lock();
    self.running = false;
    self.changed.broadcast();
    self.mutex.unlock();
    // No queue mutex held: stop waits for completion callbacks to finish.
    const rc = driver.stop(self.device.?);
    self.mutex.lock();
    self.count = 0;
    for (&self.slots) |*slot| {
        if (slot.state != .leased) slot.state = .idle;
    }
    self.mutex.unlock();
    return rc;
}
pub export fn zc_stop(p: *c.zc_camera) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return stopLocked(self);
}
pub export fn zc_close(p: *c.zc_camera) c_int {
    const self = session(p);
    self.operation.lock();
    self.mutex.lock();
    const busy = self.stats.leased != 0;
    self.mutex.unlock();
    if (busy) {
        self.operation.unlock();
        return c.ZC_BUSY;
    }
    const rc = stopLocked(self);
    if (rc != 0) {
        self.operation.unlock();
        return rc;
    }
    driver.close(self.device.?);
    self.operation.unlock();
    std.heap.c_allocator.destroy(self);
    return c.ZC_OK;
}
pub export fn zc_get_stats(p: *c.zc_camera, out: *c.zc_stats) c_int {
    const self = session(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = self.stats;
    out.ready = @intCast(self.count);
    return c.ZC_OK;
}
extern fn zcd_save_jpeg(*const c.zc_frame, [*:0]const u8, u32) c_int;
pub export fn zc_save_jpeg(p: *c.zc_camera, token: u64, path: [*:0]const u8, quality: u32) c_int {
    if (quality < 1 or quality > 100) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    for (self.slots[0..self.info.buffer_count]) |*slot| {
        if (slot.state == .leased and slot.frame.token == token) {
            self.mutex.unlock();
            if (!options.jpeg) return c.ZC_UNSUPPORTED;
            return zcd_save_jpeg(&slot.frame, path, quality);
        }
    }
    self.mutex.unlock();
    return c.ZC_STALE;
}
pub export fn zc_status_string(status: c_int) [*:0]const u8 {
    return switch (status) {
        0 => "success",
        c.ZC_INVALID => "invalid configuration or argument",
        c.ZC_STATE => "camera is stopped or state invalid",
        c.ZC_TIMEOUT => "timed out waiting for a frame",
        c.ZC_BUSY => "camera running or outstanding frame leases",
        c.ZC_STALE => "stale or already released frame token",
        c.ZC_IO => "I/O or DMA synchronization failed",
        c.ZC_NOMEM => "out of memory",
        c.ZC_UNSUPPORTED => "requested feature unavailable in this backend or camera",
        c.ZC_DEVICE => "libcamera device/configuration failure",
        else => "unknown error",
    };
}

test "configuration rejects invalid and nonfinite input" {
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    var p: ?*c.zc_camera = null;
    cfg.width = 100;
    try std.testing.expectEqual(c.ZC_INVALID, zc_open(&cfg, &p));
    cfg.width = 0;
    cfg.analogue_gain = std.math.nan(f32);
    try std.testing.expectEqual(c.ZC_INVALID, zc_open(&cfg, &p));
    try std.testing.expect(p == null);
}
test "leases survive stop, reject double release and prevent close/restart" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 17;
    cfg.height = 3;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(0, zc_open(&cfg, &p));
    defer std.testing.expectEqual(0, zc_close(p.?)) catch unreachable;
    var f: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_STATE, zc_acquire(p.?, 0, &f));
    try std.testing.expectEqual(0, zc_start(p.?));
    try std.testing.expectEqual(0, zc_acquire(p.?, 0, &f));
    try std.testing.expectEqual(@as(u32, 64), f.main.stride);
    try std.testing.expectEqual(@as(u64, 3), f.sequence);
    try std.testing.expectEqual(c.ZC_BUSY, zc_close(p.?));
    try std.testing.expectEqual(0, zc_stop(p.?));
    try std.testing.expectEqual(@as(u8, 16), f.main.planes[0].data[48]);
    try std.testing.expectEqual(c.ZC_BUSY, zc_start(p.?));
    try std.testing.expectEqual(0, zc_release(p.?, f.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_release(p.?, f.token));
    try std.testing.expectEqual(0, zc_start(p.?));
    var newer: c.zc_frame = undefined;
    try std.testing.expectEqual(0, zc_acquire(p.?, 0, &newer));
    try std.testing.expect(newer.token != f.token);
    try std.testing.expectEqual(c.ZC_STALE, zc_release(p.?, f.token));
    try std.testing.expectEqual(0, zc_release(p.?, newer.token));
}
test "FIFO exhausts at bounded capacity and waits time out" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.policy = c.ZC_FIFO;
    cfg.width = 1;
    cfg.height = 1;
    cfg.buffer_count = 2;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(0, zc_open(&cfg, &p));
    defer std.testing.expectEqual(0, zc_close(p.?)) catch unreachable;
    try std.testing.expectEqual(0, zc_start(p.?));
    var frames: [2]c.zc_frame = undefined;
    for (&frames, 0..) |*f, i| {
        try std.testing.expectEqual(0, zc_acquire(p.?, 0, f));
        try std.testing.expectEqual(@as(u64, i), f.sequence);
    }
    var spare: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_acquire(p.?, 1, &spare));
    for (frames) |f| try std.testing.expectEqual(0, zc_release(p.?, f.token));
}
