//! Caller-serialized capture fan-out identities. No native camera/recorder owns
//! this handle, so mode-worker reopen does not recycle consumer identities.
const std = @import("std");
const c = @import("abi.zig").c;
const home = @import("home/frame_fanout.zig");
const Registry = home.Registry(8);
const A = std.heap.c_allocator;
fn registry(p: *c.zc_fanout) *Registry {
    return @ptrCast(@alignCast(p));
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.Capacity, error.Busy => c.ZC_BUSY,
        error.Stale => c.ZC_STALE,
        else => c.ZC_STATE,
    };
}
fn snapshot(state: home.State, out: *c.zc_fanout_state) void {
    out.* = .{ .id = state.id, .submitted = state.submitted, .completed = state.completed, .skipped = state.skipped, .failures = state.failures, .cancelled = state.cancelled, .last_frame = state.last_frame orelse 0, .ticket = state.ticket orelse 0, .flags = @as(u32, @intFromBool(state.active)) | (@as(u32, @intFromBool(state.ticket != null)) << 1) | (@as(u32, @intFromBool(state.failed)) << 2) | (@as(u32, @intFromBool(state.retiring)) << 3) | (@as(u32, @intFromBool(state.policy == .drop)) << 4), .reserved = 0 };
}
pub export fn zc_fanout_open(out: *?*c.zc_fanout) c_int {
    out.* = null;
    const ptr = A.create(Registry) catch return c.ZC_NOMEM;
    ptr.* = .{};
    out.* = @ptrCast(ptr);
    return c.ZC_OK;
}
pub export fn zc_fanout_close(p: *c.zc_fanout) c_int {
    const self = registry(p);
    if (self.slots.count != 0) return c.ZC_BUSY;
    A.destroy(self);
    return c.ZC_OK;
}
pub export fn zc_fanout_add(p: *c.zc_fanout, policy: u32, id: *u64) c_int {
    if (policy > 1) return c.ZC_INVALID;
    id.* = registry(p).add(if (policy == 0) .wait else .drop) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_fanout_ready(p: *c.zc_fanout) c_int {
    return @intFromBool(registry(p).ready());
}
pub export fn zc_fanout_offer(p: *c.zc_fanout, frame: *u64) c_int {
    frame.* = registry(p).offer() catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_fanout_claim(p: *c.zc_fanout, id: u64, frame: u64, ticket: *u64) c_int {
    ticket.* = 0;
    const claim = registry(p).claim(id, frame) catch |err| return status(err);
    ticket.* = claim orelse return c.ZC_TIMEOUT;
    return c.ZC_OK;
}
pub export fn zc_fanout_state_get(p: *c.zc_fanout, id: u64, out: *c.zc_fanout_state) c_int {
    snapshot(registry(p).state(id) catch |err| return status(err), out);
    return c.ZC_OK;
}
pub export fn zc_fanout_finish(p: *c.zc_fanout, id: u64, ticket: u64, outcome: u32, out: *c.zc_fanout_state) c_int {
    if (outcome > 2) return c.ZC_INVALID;
    snapshot(registry(p).finish(id, ticket, switch (outcome) {
        0 => .completed,
        1 => .failed,
        else => .cancelled,
    }) catch |err| return status(err), out);
    return c.ZC_OK;
}
pub export fn zc_fanout_fail(p: *c.zc_fanout, id: u64, out: *c.zc_fanout_state) c_int {
    snapshot(registry(p).fail(id) catch |err| return status(err), out);
    return c.ZC_OK;
}
pub export fn zc_fanout_retire(p: *c.zc_fanout, id: u64, out: *c.zc_fanout_state) c_int {
    snapshot(registry(p).retire(id) catch |err| return status(err), out);
    return c.ZC_OK;
}
