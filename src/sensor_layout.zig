//! Native logical-client lease across camera close/reopen worker transactions.
const std = @import("std");
const c = @import("abi.zig").c;
const tuning = @import("tuning_session.zig");
const A = std.heap.c_allocator;
const Lease = struct { backend: u32 };
var mutex: std.Thread.Mutex = .{};
var live: usize = 0;
pub export fn zc_sensor_layout_scope_open(backend: u32, out: *?*c.zc_sensor_layout_scope) c_int {
    out.* = null;
    if (backend > 1) return c.ZC_INVALID;
    mutex.lock();
    if (live == 64) {
        mutex.unlock();
        return c.ZC_BUSY;
    }
    live += 1;
    mutex.unlock();
    var success = false;
    defer if (!success) {
        mutex.lock();
        live -= 1;
        mutex.unlock();
    };
    const lease = A.create(Lease) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(lease);
    const rc = tuning.beginLayout(backend);
    if (rc != c.ZC_OK) return rc;
    lease.* = .{ .backend = backend };
    out.* = @ptrCast(lease);
    success = true;
    return c.ZC_OK;
}
pub export fn zc_sensor_layout_scope_close(p: ?*c.zc_sensor_layout_scope) c_int {
    const lease: *Lease = @ptrCast(@alignCast(p orelse return c.ZC_OK));
    const backend = lease.backend;
    A.destroy(lease);
    tuning.endLayout(backend);
    mutex.lock();
    live -= 1;
    mutex.unlock();
    return c.ZC_OK;
}
pub export fn zc_sensor_layout_users_get(backend: u32, count: *u32) c_int {
    return tuning.layoutUsers(backend, count);
}
test "logical layout scopes remain exclusive blockers across absent SDK manager lifetimes" {
    const t = std.testing;
    var p: ?*c.zc_sensor_layout_scope = null;
    var count: u32 = 0;
    try t.expectEqual(c.ZC_OK, zc_sensor_layout_scope_open(c.ZC_SYNTHETIC, &p));
    defer if (p != null) {
        _ = zc_sensor_layout_scope_close(p);
    };
    try t.expectEqual(c.ZC_OK, zc_sensor_layout_users_get(c.ZC_SYNTHETIC, &count));
    try t.expectEqual(@as(u32, 1), count);
    try t.expectEqual(c.ZC_BUSY, tuning.beginExclusive(c.ZC_SYNTHETIC));
    try t.expectEqual(c.ZC_OK, tuning.begin(c.ZC_SYNTHETIC));
    tuning.end(c.ZC_SYNTHETIC);
    try t.expectEqual(c.ZC_BUSY, tuning.beginExclusive(c.ZC_SYNTHETIC));
    try t.expectEqual(c.ZC_OK, zc_sensor_layout_scope_close(p));
    p = null;
    try t.expectEqual(c.ZC_OK, tuning.beginExclusive(c.ZC_SYNTHETIC));
    var rejected: ?*c.zc_sensor_layout_scope = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, zc_sensor_layout_scope_open(c.ZC_SYNTHETIC, &rejected));
    try t.expect(rejected == null);
    try t.expectEqual(c.ZC_OK, tuning.endExclusive(c.ZC_SYNTHETIC));
}

test "layout scope admission is bounded and invalid opens leave no owner" {
    const t = std.testing;
    var scopes: [64]?*c.zc_sensor_layout_scope = @splat(null);
    defer for (scopes) |p| {
        _ = zc_sensor_layout_scope_close(p);
    };
    for (&scopes) |*p| try t.expectEqual(c.ZC_OK, zc_sensor_layout_scope_open(c.ZC_SYNTHETIC, p));
    var rejected: ?*c.zc_sensor_layout_scope = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, zc_sensor_layout_scope_open(c.ZC_SYNTHETIC, &rejected));
    try t.expect(rejected == null);
    try t.expectEqual(c.ZC_OK, zc_sensor_layout_scope_close(scopes[0]));
    scopes[0] = null;
    try t.expectEqual(c.ZC_INVALID, zc_sensor_layout_scope_open(2, &rejected));
    try t.expect(rejected == null);
    try t.expectEqual(c.ZC_OK, zc_sensor_layout_scope_open(c.ZC_SYNTHETIC, &scopes[0]));
}
