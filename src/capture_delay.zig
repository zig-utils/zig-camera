//! Stable C state around Home's allocation-free relative idle interval helper.
const std = @import("std");
const c = @import("abi.zig").c;
const Delay = @import("home/relative_delay.zig").Delay;
fn read(state: *const c.zc_capture_delay) !Delay {
    if (state.armed > 1 or state.reserved != 0) return error.InvalidState;
    if (state.armed != 0 and (state.started_ns > state.last_ns or state.started_ns > state.deadline_ns)) return error.InvalidState;
    return .{ .started_ns = state.started_ns, .last_ns = state.last_ns, .deadline_ns = state.deadline_ns, .armed = state.armed != 0 };
}
fn write(state: *c.zc_capture_delay, value: Delay) void {
    state.* = .{ .started_ns = value.started_ns, .last_ns = value.last_ns, .deadline_ns = value.deadline_ns, .armed = @intFromBool(value.armed), .reserved = 0 };
}
pub export fn zc_default_capture_delay(out: *c.zc_capture_delay) void {
    out.* = std.mem.zeroes(c.zc_capture_delay);
}
pub export fn zc_capture_delay_arm(state: *c.zc_capture_delay, now_ns: u64, duration_ns: u64) c_int {
    var value = read(state) catch return c.ZC_INVALID;
    value.arm(now_ns, duration_ns) catch return c.ZC_INVALID;
    write(state, value);
    return c.ZC_OK;
}
pub export fn zc_capture_delay_remaining(state: *c.zc_capture_delay, now_ns: u64, out: *u64) c_int {
    out.* = 0;
    var value = read(state) catch return c.ZC_INVALID;
    const remaining = value.remaining(now_ns) catch |err| return if (err == error.NotArmed) c.ZC_STATE else c.ZC_INVALID;
    write(state, value);
    out.* = remaining;
    return c.ZC_OK;
}
test "capture delay ABI preserves failed state and reports exact boundaries" {
    const t = std.testing;
    try t.expectEqual(@as(usize, 32), @sizeOf(c.zc_capture_delay));
    var state: c.zc_capture_delay = undefined;
    zc_default_capture_delay(&state);
    var remaining: u64 = 42;
    try t.expectEqual(c.ZC_STATE, zc_capture_delay_remaining(&state, 0, &remaining));
    try t.expectEqual(@as(u64, 0), remaining);
    try t.expectEqual(c.ZC_OK, zc_capture_delay_arm(&state, 100, 20));
    try t.expectEqual(c.ZC_OK, zc_capture_delay_remaining(&state, 110, &remaining));
    try t.expectEqual(@as(u64, 10), remaining);
    const before = state;
    try t.expectEqual(c.ZC_INVALID, zc_capture_delay_remaining(&state, 109, &remaining));
    try t.expectEqual(@as(u64, 0), remaining);
    try t.expectEqualDeep(before, state);
    try t.expectEqual(c.ZC_INVALID, zc_capture_delay_arm(&state, std.math.maxInt(u64), 1));
    try t.expectEqualDeep(before, state);
    try t.expectEqual(c.ZC_OK, zc_capture_delay_remaining(&state, 120, &remaining));
    try t.expectEqual(@as(u64, 0), remaining);
    state.reserved = 1;
    const invalid = state;
    try t.expectEqual(c.ZC_INVALID, zc_capture_delay_arm(&state, 0, 0));
    try t.expectEqualDeep(invalid, state);
}
