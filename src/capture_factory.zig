//! Allocation notifications carry tickets, never a synchronous JS return value.
//! Caller pool owns each request until its waiting native open AND application
//! callback/input cleanup have retired. All state/claims stay under pool.mutex.
const std = @import("std");
const c = @import("abi.zig").c;
const backing = @import("home/capture_backing.zig");
const Handoff = @import("home/factory_handoff.zig").Handoff;
const pools = @import("capture_allocator.zig");
const scopes = @import("capture_open_owner.zig");
pub const Notify = *const fn (?*anyopaque, u64) callconv(.c) void;
pub const Request = struct {
    ticket: u64,
    pin: u64,
    scope: *scopes.Context,
    restoring: bool,
    layout: backing.policy.Layout,
    handoff: Handoff = .{},
    loan: ?backing.policy.Claim = null,
};
pub const State = struct {
    issued: u64 = 0,
    notify: ?Notify = null,
    context: ?*anyopaque = null,
    requests: [16]?Request = @splat(null),
    condition: std.Thread.Condition = .{},
};
fn find(pool: *pools.Pool, ticket: u64) ?*Request {
    for (&pool.factory.requests) |*entry| if (entry.*) |*request| {
        if (request.ticket == ticket) return request;
    };
    return null;
}
fn dropLoan(pool: *pools.Pool, request: *Request) void {
    if (request.loan) |claim| {
        pool.owner.discard(claim) catch unreachable;
        request.loan = null;
    }
}
fn finishIfJoined(pool: *pools.Pool, index: usize) void {
    const request = pool.factory.requests[index] orelse return;
    if (!request.handoff.releasable()) return;
    std.debug.assert(request.loan == null);
    pool.factory.requests[index] = null;
    // Registry lock order is pool -> scope. Scope final close drops its pool
    // pin only after releasing its own registry lock, never in this direction.
    scopes.releaseFactory(request.scope);
    const final = pool.pins.release(request.pin) catch unreachable;
    std.debug.assert(!final);
}
pub export fn zc_capture_allocator_factory_set(handle: *c.zc_capture_allocator, notify: ?Notify, context: ?*anyopaque) c_int {
    const pool = pools.factoryPool(handle);
    pool.mutex.lock();
    defer pool.mutex.unlock();
    if (pool.closing) return c.ZC_STATE;
    if (std.meta.activeTag(pool.owner) != .imported) return c.ZC_STATE;
    if (pool.pins.used != 1 or pool.owner.cache().owners.used != 0) return c.ZC_BUSY;
    for (pool.factory.requests) |entry| if (entry != null) return c.ZC_BUSY;
    pool.factory.notify = notify;
    pool.factory.context = context;
    return c.ZC_OK;
}
/// Entered and returned with pool.mutex held. The native configure worker is
/// paused after negotiation, before buffer import; camera callbacks never wait.
pub fn wait(pool: *pools.Pool, handle: *c.zc_capture_allocator, layout: *const backing.policy.Layout, missing: c_int, out: *u64) c_int {
    const notify = pool.factory.notify orelse return missing;
    const scope = scopes.currentFor(handle) orelse return missing;
    if (scopes.waitCancelled(scope)) return c.ZC_CANCELLED;
    var index: ?usize = null;
    for (pool.factory.requests, 0..) |entry, i| if (entry == null) {
        index = i;
        break;
    };
    const at = index orelse return c.ZC_BUSY;
    if (pool.factory.issued == std.math.maxInt(u64)) return c.ZC_STATE;
    const pin = pool.pins.retain(pool.root_pin) catch return c.ZC_BUSY;
    pool.factory.issued += 1;
    const ticket = pool.factory.issued;
    scopes.retainFactory(scope);
    pool.factory.requests[at] = .{ .ticket = ticket, .pin = pin, .scope = scope, .restoring = scopes.isRestoring(scope), .layout = layout.* };
    const context = pool.factory.context;
    pool.mutex.unlock();
    notify(context, ticket);
    pool.mutex.lock();
    while (true) {
        const request = &pool.factory.requests[at].?;
        var code: c_int = c.ZC_TIMEOUT;
        var finished = false;
        if (scopes.waitCancelled(scope)) {
            _ = request.handoff.cancel();
            dropLoan(pool, request);
            code = c.ZC_CANCELLED;
            finished = true;
        } else if (request.handoff.callback_done) {
            finished = true;
            if (request.handoff.code != c.ZC_OK) code = request.handoff.code else if (request.loan != null and request.handoff.publish()) {
                out.* = request.loan.?.token;
                request.loan = null;
                code = c.ZC_OK;
            } else code = c.ZC_CANCELLED;
        }
        if (finished) {
            if (code != c.ZC_OK) dropLoan(pool, request);
            request.handoff.finishWaiter() catch unreachable;
            finishIfJoined(pool, at);
            return code;
        }
        pool.factory.condition.timedWait(&pool.mutex, 20 * std.time.ns_per_ms) catch {};
    }
}
fn cancelled(request: *Request) bool {
    return request.handoff.waiter_done or scopes.requestCancelled(request.scope, request.restoring);
}
pub export fn zc_capture_allocator_factory_begin(handle: *c.zc_capture_allocator, ticket: u64, layout: *c.zc_capture_import_layout, state: *c.zc_capture_factory_request_state) c_int {
    layout.* = std.mem.zeroes(c.zc_capture_import_layout);
    state.* = std.mem.zeroes(c.zc_capture_factory_request_state);
    const pool = pools.factoryPool(handle);
    pool.mutex.lock();
    defer pool.mutex.unlock();
    const request = find(pool, ticket) orelse return c.ZC_STALE;
    if (cancelled(request)) _ = request.handoff.cancel();
    const invoke = request.handoff.beginCallback() catch return c.ZC_BUSY;
    layout.struct_size = @sizeOf(c.zc_capture_import_layout);
    layout.backend = if (@import("options").libcamera) c.ZC_LIBCAMERA else c.ZC_SYNTHETIC;
    layout.id_length = request.layout.camera_length;
    layout.stream_count = request.layout.stream_count;
    @memcpy(layout.camera_id[0..layout.id_length], request.layout.camera[0..layout.id_length]);
    for (request.layout.streams[0..request.layout.stream_count], 0..) |stream, i| {
        layout.streams[i] = .{ .width = stream.width, .height = stream.height, .stride = stream.stride, .buffer_count = stream.buffer_count, .frame_bytes = stream.frame_bytes, .modifier = stream.modifier, .format = stream.format };
    }
    state.* = .{ .struct_size = @sizeOf(c.zc_capture_factory_request_state), .accepting = @intFromBool(invoke), .restoring = @intFromBool(request.restoring), .cancelled = @intFromBool(!invoke), .scope = request.scope.id };
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_factory_supply(handle: *c.zc_capture_allocator, ticket: u64, buffers: ?[*]const c.zc_capture_import_buffer, count: u32) c_int {
    if (buffers == null or count == 0 or count > 192) return c.ZC_INVALID;
    var inputs: [192]backing.ImportBuffer = undefined;
    for (buffers.?[0..count], 0..) |buffer, i| {
        if (buffer.reserved != 0 or buffer.fd < 0) return c.ZC_INVALID;
        inputs[i] = .{ .fd = buffer.fd, .offset = buffer.offset };
    }
    const pool = pools.factoryPool(handle);
    pool.mutex.lock();
    defer pool.mutex.unlock();
    const request = find(pool, ticket) orelse return c.ZC_STALE;
    if (!request.handoff.callback_started or request.handoff.callback_done or request.handoff.supplied) return c.ZC_STATE;
    if (cancelled(request)) {
        _ = request.handoff.cancel();
        return c.ZC_CANCELLED;
    }
    if (comptime @import("builtin").os.tag == .linux) switch (pool.owner) {
        .managed => return c.ZC_STATE,
        .imported => |*owner| {
            owner.reapPending() catch |failure| return pools.factoryStatus(failure);
            if (cancelled(request)) {
                _ = request.handoff.cancel();
                return c.ZC_CANCELLED;
            }
            owner.importBuffers(&request.layout, inputs[0..count]) catch |failure| return pools.factoryStatus(failure);
            // Reserve the prepared loan under this same mutex. A concurrent
            // same-layout camera cannot steal newly supplied storage here.
            const result = owner.checkoutExisting(&request.layout) catch unreachable;
            request.loan = result.claim;
        },
    } else return c.ZC_UNSUPPORTED;
    request.handoff.supply() catch unreachable;
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_factory_finish(handle: *c.zc_capture_allocator, ticket: u64, code: c_int) c_int {
    if (code > 0 or code < c.ZC_DISCONNECTED) return c.ZC_INVALID;
    const pool = pools.factoryPool(handle);
    pool.mutex.lock();
    defer pool.mutex.unlock();
    for (&pool.factory.requests, 0..) |*entry, i| if (entry.*) |*request| {
        if (request.ticket != ticket) continue;
        if (!request.handoff.callback_started or request.handoff.callback_done) return c.ZC_STATE;
        if (cancelled(request)) _ = request.handoff.cancel();
        if (code != c.ZC_OK or request.handoff.gate.cancel_requested or request.handoff.gate.phase == .cancelled) dropLoan(pool, request);
        request.handoff.finishCallback(code) catch return c.ZC_STATE;
        pool.factory.condition.broadcast();
        finishIfJoined(pool, i);
        return c.ZC_OK;
    };
    return c.ZC_STALE;
}
