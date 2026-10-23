//! Native camera/payload ownership for supervised process jobs. Host verifies
//! peer exits; Home tracks fair bounded dispatch, ACKs and retained cleanup slots.
const std = @import("std");
const c = @import("abi.zig").c;
const frames = @import("frame_export.zig");
const channel = @import("frame_channel.zig");
const Policy = @import("home/dispatch_pool.zig").Pool(8, 32);
const Admission = @import("home/owned_admission.zig").Registry(8);
const A = std.heap.c_allocator;
var admission: Admission = .{ .max_items = 8, .max_bytes = 1024 * 1024 };
var mutex: std.Thread.Mutex = .{};
const Payload = struct { loan: ?*c.zc_frame_export, args: ?[]u8 };
const Session = struct { ticket: Admission.Ticket, policy: Policy, payloads: [32]?Payload = @splat(null) };
fn owner(p: *c.zc_process_session) *Session {
    return @ptrCast(@alignCast(p));
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.BufferFull, error.NeedsJoin => c.ZC_BUSY,
        error.StaleTicket, error.StaleWorker => c.ZC_STALE,
        error.NoWorkers => c.ZC_STATE,
        else => c.ZC_INVALID,
    };
}
pub export fn zc_process_open(workers: u32, items: u32, bytes: u64, out: *?*c.zc_process_session) c_int {
    out.* = null;
    if (bytes > 512 * 1024 * 1024) return c.ZC_INVALID;
    const policy = Policy.init(workers, items, @intCast(bytes)) catch |err| return status(err);
    mutex.lock();
    defer mutex.unlock();
    const ticket = admission.reserve(@sizeOf(Session)) catch |err| return status(err);
    const self = A.create(Session) catch {
        admission.release(ticket) catch unreachable;
        return c.ZC_NOMEM;
    };
    self.* = .{ .ticket = ticket, .policy = policy };
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub export fn zc_process_close(p: *c.zc_process_session) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    if (self.policy.admission.count != 0) return c.ZC_BUSY;
    for (self.policy.workers[0..self.policy.count]) |worker| if (!worker.joined) return c.ZC_BUSY;
    admission.release(self.ticket) catch unreachable;
    A.destroy(self);
    return c.ZC_OK;
}
pub export fn zc_process_can_submit(p: *c.zc_process_session, length: u64, result_capacity: u64) c_int {
    if (length > 16 * 1024 * 1024 or result_capacity > 256 * 1024 * 1024) return c.ZC_INVALID;
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    const a = &self.policy.admission;
    const cost = length + result_capacity;
    if (cost > a.max_bytes) return c.ZC_INVALID;
    if (a.count >= a.max_items or cost > a.max_bytes - a.used) return c.ZC_BUSY;
    for (self.policy.workers[0..self.policy.count]) |worker| if (worker.accepting and !worker.joined) return c.ZC_OK;
    return c.ZC_STATE;
}
pub export fn zc_process_submit(p: *c.zc_process_session, loan: *c.zc_frame_export, args: ?[*]const u8, length: u64, result_capacity: u64, cookie: *u64, worker: *u32, generation: *u64) c_int {
    cookie.* = 0;
    worker.* = 0;
    generation.* = 0;
    if (length > 16 * 1024 * 1024 or result_capacity > 256 * 1024 * 1024 or (length != 0 and args == null)) return c.ZC_INVALID;
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    const task = self.policy.reserve(@intCast(length + result_capacity)) catch |err| return status(err);
    const bytes = A.alloc(u8, @intCast(length)) catch {
        self.policy.retire(task.ticket.id) catch unreachable;
        self.policy.release(task.ticket.id) catch unreachable;
        return c.ZC_NOMEM;
    };
    if (length != 0) @memcpy(bytes, args.?[0..@intCast(length)]);
    self.payloads[task.ticket.slot] = .{ .loan = loan, .args = bytes };
    cookie.* = task.ticket.id;
    worker.* = @intCast(task.worker);
    generation.* = task.generation;
    return c.ZC_OK;
}
pub export fn zc_process_next(p: *c.zc_process_session, worker: u32, generation: u64, cookie: *u64) c_int {
    cookie.* = 0;
    mutex.lock();
    defer mutex.unlock();
    const task = owner(p).policy.next(worker, generation) catch |err| return status(err);
    cookie.* = task orelse return c.ZC_TIMEOUT;
    return c.ZC_OK;
}
pub export fn zc_process_send(p: *c.zc_process_session, cookie: u64, fd: i32) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    const task = self.policy.task(cookie) catch |err| return status(err);
    const next = self.policy.next(task.worker, task.generation) catch |err| return status(err);
    if (next != cookie or task.phase != .queued) return c.ZC_STATE;
    const rc = channel.zc_frame_channel_send(fd, self.payloads[task.ticket.slot].?.loan.?, cookie);
    if (rc != c.ZC_OK) return rc;
    self.policy.sent(cookie) catch unreachable;
    return c.ZC_OK;
}
pub export fn zc_process_payload_copy(p: *c.zc_process_session, cookie: u64, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    const task = self.policy.task(cookie) catch |err| return status(err);
    const bytes = self.payloads[task.ticket.slot].?.args orelse return c.ZC_STATE;
    length.* = bytes.len;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < bytes.len) return c.ZC_INVALID;
    @memcpy(data.?[0..bytes.len], bytes);
    return c.ZC_OK;
}
pub export fn zc_process_receive_ack(p: *c.zc_process_session, worker: u32, generation: u64, fd: i32, cookie: *u64) c_int {
    cookie.* = 0;
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    _ = self.policy.worker(worker, generation) catch |err| return status(err);
    var id: u64 = 0;
    const rc = channel.zc_frame_channel_receive_ack(fd, &id);
    if (rc != c.ZC_OK) return rc;
    self.policy.acknowledge(id, worker, generation) catch |err| return status(err);
    cookie.* = id;
    return c.ZC_OK;
}
pub export fn zc_process_stop_worker(p: *c.zc_process_session, worker: u32, generation: u64) c_int {
    mutex.lock();
    defer mutex.unlock();
    owner(p).policy.stop(worker, generation) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_process_worker_joined(p: *c.zc_process_session, worker: u32, generation: u64) c_int {
    mutex.lock();
    defer mutex.unlock();
    owner(p).policy.joined(worker, generation) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_process_restart_worker(p: *c.zc_process_session, worker: u32, generation: u64, next: *u64) c_int {
    next.* = 0;
    mutex.lock();
    defer mutex.unlock();
    next.* = owner(p).policy.restart(worker, generation) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_process_retire(p: *c.zc_process_session, cookie: u64) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    const task = self.policy.task(cookie) catch |err| return status(err);
    self.policy.retire(cookie) catch |err| return status(err);
    const payload = &self.payloads[task.ticket.slot].?;
    const loan = payload.loan;
    payload.loan = null;
    if (payload.args) |bytes| A.free(bytes);
    payload.args = null;
    return frames.zc_frame_export_close(loan);
}
pub export fn zc_process_release(p: *c.zc_process_session, cookie: u64) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    const task = self.policy.task(cookie) catch |err| return status(err);
    const slot = task.ticket.slot;
    self.policy.release(cookie) catch |err| return status(err);
    self.payloads[slot] = null;
    return c.ZC_OK;
}
pub export fn zc_process_get_state(p: *c.zc_process_session, out: *c.zc_process_state) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    var result = std.mem.zeroes(c.zc_process_state);
    result.struct_size = @sizeOf(c.zc_process_state);
    result.workers = @intCast(self.policy.count);
    result.pending = @intCast(self.policy.admission.count);
    result.bytes = self.policy.admission.used;
    result.issued = self.policy.admission.issued;
    result.released = self.policy.admission.released;
    for (self.policy.workers[0..self.policy.count]) |worker| if (worker.accepting and !worker.joined) {
        result.live_workers += 1;
    };
    for (self.policy.tasks) |entry| if (entry) |task| {
        switch (task.phase) {
            .queued => result.queued += 1,
            .retired => result.retired += 1,
            else => result.active += 1,
        }
    };
    out.* = result;
    return c.ZC_OK;
}
pub export fn zc_process_get_worker_state(p: *c.zc_process_session, index: u32, out: *c.zc_process_worker_state) c_int {
    mutex.lock();
    defer mutex.unlock();
    const self = owner(p);
    if (index >= self.policy.count) return c.ZC_INVALID;
    const worker = self.policy.workers[index];
    out.* = .{ .pending = @intCast(worker.pending), .accepting = @intFromBool(worker.accepting), .joined = @intFromBool(worker.joined), .reserved = 0, .generation = worker.generation, .active = worker.active orelse 0 };
    return c.ZC_OK;
}
pub export fn zc_process_pending_through(p: *c.zc_process_session, target: u64, out: *u32) c_int {
    mutex.lock();
    defer mutex.unlock();
    const pending = owner(p).policy.admission.pendingThrough(target) catch |err| return status(err);
    out.* = @intFromBool(pending);
    return c.ZC_OK;
}
