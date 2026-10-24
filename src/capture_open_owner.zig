//! Camera ownership survives a host worker, callback notification and native
//! thread independently. No worker-close event is treated as a thread join.
const std = @import("std");
const c = @import("abi.zig").c;
const attachments = @import("home/thread_attachment.zig");
const A = std.heap.c_allocator;
const Leases = @import("home/lease_pool.zig").Pool(32, 32);
var leases: Leases = .{};
pub var mutex: std.Thread.Mutex = .{};
var slots: [32]?*Context = @splat(null);
var thread_key: ?attachments.Key = null;
pub const Context = struct {
    id: u64 = 0,
    allocation: *c.zc_capture_allocator,
    allocation_pin: u64,
    camera: ?*c.zc_camera,
    started: bool,
    stage: u32 = 0, // original, target, restored
    threads: u32 = 0,
    active: bool = false,
    opening: bool = false,
    restoring: bool = false,
    pending_factories: u32 = 0,
    cancel: std.atomic.Value(bool) = .init(false),
    abort: std.atomic.Value(bool) = .init(false),
    sealed: bool = false,
    deadline: u64,
    binding: attachments.Binding = .{},
};
pub fn lookup(id: u64) ?*Context {
    const index = leases.resource(id) orelse return null;
    return slots[index];
}
fn clock() u64 {
    return @import("capture_filter.zig").clockNs() catch std.math.maxInt(u64);
}
pub fn create(allocation: *c.zc_capture_allocator, pin: u64, initial: ?*c.zc_camera, started: u32, timeout_ms: u32, out: *u64) c_int {
    out.* = 0;
    const self = A.create(Context) catch return c.ZC_NOMEM;
    var owned = false;
    defer if (!owned) A.destroy(self);
    const deadline = if (timeout_ms == std.math.maxInt(u32)) std.math.maxInt(u64) else clock() +| (@as(u64, timeout_ms) * std.time.ns_per_ms);
    self.* = .{ .allocation = allocation, .allocation_pin = pin, .camera = initial, .started = started != 0, .deadline = deadline };
    mutex.lock();
    defer mutex.unlock();
    if (thread_key == null) thread_key = attachments.Key.init(threadExit) catch return c.ZC_IO;
    for (&slots, 0..) |*entry, i| if (entry.* == null) {
        self.id = leases.acquire(@intCast(i)) catch return c.ZC_STATE;
        entry.* = self;
        out.* = self.id;
        owned = true;
        return c.ZC_OK;
    };
    return c.ZC_BUSY;
}
fn threadExit(raw: *anyopaque) void {
    const self: *Context = @ptrCast(@alignCast(raw));
    mutex.lock();
    defer mutex.unlock();
    std.debug.assert(self.threads == 1 and !self.active);
    self.threads = 0;
}
pub fn zc_capture_open_scope_attach(id: u64) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = lookup(id) orelse return c.ZC_STALE;
    if (self.abort.load(.acquire) or self.sealed) return c.ZC_STATE;
    if (self.threads != 0) return c.ZC_BUSY;
    thread_key.?.attach(&self.binding, self) catch |failure| return if (failure == error.AlreadyAttached) c.ZC_BUSY else c.ZC_IO;
    self.threads = 1;
    return c.ZC_OK;
}
pub fn zc_capture_open_scope_detach(id: u64) c_int {
    // Key.detach calls threadExit, which takes the registry lock. Never hold
    // that lock across cleanup or across an allocator pin/release operation.
    mutex.lock();
    const self = lookup(id) orelse {
        mutex.unlock();
        return c.ZC_STALE;
    };
    const key = &thread_key.?;
    const current = key.current() catch {
        mutex.unlock();
        return c.ZC_IO;
    };
    if (current != @as(?*anyopaque, @ptrCast(self)) or self.active) {
        mutex.unlock();
        return c.ZC_STATE;
    }
    mutex.unlock();
    key.detach() catch return c.ZC_IO;
    return c.ZC_OK;
}
pub fn attached(id: u64) ?*Context {
    const self = lookup(id) orelse return null;
    const current = thread_key.?.current() catch return null;
    return if (current == @as(?*anyopaque, @ptrCast(self))) self else null;
}
/// Borrowed only during this native opening call on the attached thread.
pub fn currentFor(allocation: *c.zc_capture_allocator) ?*Context {
    mutex.lock();
    defer mutex.unlock();
    const key = if (thread_key) |*value| value else return null;
    const raw = (key.current() catch return null) orelse return null;
    const self: *Context = @ptrCast(@alignCast(raw));
    return if (self.allocation == allocation and self.active and self.opening) self else null;
}
pub fn waitCancelled(self: *const Context) bool {
    return self.abort.load(.acquire) or (!self.restoring and (self.cancel.load(.acquire) or clock() >= self.deadline));
}
pub fn isRestoring(self: *const Context) bool {
    return self.restoring;
}
pub fn retainFactory(self: *Context) void {
    mutex.lock();
    defer mutex.unlock();
    std.debug.assert(self.active and self.opening);
    self.pending_factories += 1;
}
pub fn releaseFactory(self: *Context) void {
    mutex.lock();
    defer mutex.unlock();
    std.debug.assert(self.pending_factories != 0);
    self.pending_factories -= 1;
}
pub fn zc_capture_open_scope_cancel(id: u64, fatal: u32) c_int {
    if (fatal > 1) return c.ZC_INVALID;
    mutex.lock();
    defer mutex.unlock();
    const self = lookup(id) orelse return c.ZC_STALE;
    self.cancel.store(true, .release);
    if (fatal != 0) self.abort.store(true, .release);
    return c.ZC_OK;
}
pub fn zc_capture_open_scope_state_get(id: u64, out: *c.zc_capture_open_scope_state) c_int {
    out.* = std.mem.zeroes(c.zc_capture_open_scope_state);
    mutex.lock();
    defer mutex.unlock();
    const self = lookup(id) orelse return c.ZC_STALE;
    out.* = .{ .struct_size = @sizeOf(c.zc_capture_open_scope_state), .stage = self.stage, .started = @intFromBool(self.started), .threads = self.threads, .active = @intFromBool(self.active), .pending_factories = self.pending_factories, .cancelled = @intFromBool(self.cancel.load(.acquire) or clock() >= self.deadline), .aborted = @intFromBool(self.abort.load(.acquire)), .camera = self.camera };
    return c.ZC_OK;
}
pub fn zc_capture_open_scope_take(id: u64, out: *?*c.zc_camera, started: *u32) c_int {
    out.* = null;
    started.* = 0;
    mutex.lock();
    defer mutex.unlock();
    const self = lookup(id) orelse return c.ZC_STALE;
    if (self.active or self.threads != 0 or self.pending_factories != 0) return c.ZC_BUSY;
    if (self.sealed) return c.ZC_STATE;
    self.sealed = true;
    out.* = self.camera;
    started.* = @intFromBool(self.started);
    self.camera = null;
    self.started = false;
    return c.ZC_OK;
}

pub fn requestCancelled(self: *const Context, restoring: bool) bool {
    return self.abort.load(.acquire) or (!restoring and (self.cancel.load(.acquire) or clock() >= self.deadline));
}
pub fn destroy(id: u64, allocation: *?*c.zc_capture_allocator, pin: *u64) c_int {
    allocation.* = null;
    pin.* = 0;
    mutex.lock();
    const self = lookup(id) orelse {
        mutex.unlock();
        return c.ZC_STALE;
    };
    if (self.active or self.threads != 0 or self.pending_factories != 0) {
        mutex.unlock();
        return c.ZC_BUSY;
    }
    if (self.camera != null) {
        mutex.unlock();
        return c.ZC_STATE;
    }
    const index = leases.resource(id).?;
    allocation.* = self.allocation;
    pin.* = self.allocation_pin;
    slots[index] = null;
    const final = leases.release(id) catch unreachable;
    std.debug.assert(final);
    mutex.unlock();
    A.destroy(self);
    return c.ZC_OK;
}
