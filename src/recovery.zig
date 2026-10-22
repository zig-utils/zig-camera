//! Stable caller-owned C bridge to Home's bounded monotonic retry policy.
const std = @import("std");
const c = @import("abi.zig").c;
const Home = @import("home/output_recovery.zig").Retry;
fn load(s: *const c.zc_recovery_retry) !Home {
    if (s.struct_size != @sizeOf(c.zc_recovery_retry) or s.max_attempts == 0 or s.max_attempts > 1024 or s.attempts > s.max_attempts or s.armed > 1 or s.initial_ns > s.maximum_ns or (s.armed == 0 and s.deadline_ns != 0)) return error.InvalidState;
    return .{ .limit = s.max_attempts, .attempts = s.attempts, .initial_ns = s.initial_ns, .maximum_ns = s.maximum_ns, .deadline = if (s.armed != 0) s.deadline_ns else null };
}
fn save(s: *c.zc_recovery_retry, value: Home) void {
    s.* = .{ .struct_size = @sizeOf(c.zc_recovery_retry), .max_attempts = value.limit, .attempts = value.attempts, .armed = @intFromBool(value.deadline != null), .initial_ns = value.initial_ns, .maximum_ns = value.maximum_ns, .deadline_ns = value.deadline orelse 0 };
}
pub export fn zc_recovery_retry_init(max_attempts: u32, initial_ns: u64, maximum_ns: u64, out: *c.zc_recovery_retry) c_int {
    if (max_attempts == 0 or max_attempts > 1024) return c.ZC_INVALID;
    const value = Home.init(max_attempts, initial_ns, maximum_ns) catch return c.ZC_INVALID;
    save(out, value);
    return c.ZC_OK;
}
pub export fn zc_recovery_retry_poll(s: *c.zc_recovery_retry, now_ns: u64, failed: u32) c_int {
    if (failed > 1) return c.ZC_INVALID;
    var value = load(s) catch return c.ZC_INVALID;
    const claimed = value.poll(now_ns, failed != 0);
    save(s, value);
    return @intFromBool(claimed);
}
pub export fn zc_recovery_retry_observe(s: *c.zc_recovery_retry, now_ns: u64, failed: u32) c_int {
    if (failed > 1) return c.ZC_INVALID;
    var value = load(s) catch return c.ZC_INVALID;
    value.observe(now_ns, failed != 0);
    save(s, value);
    return c.ZC_OK;
}
test "retry ABI preserves completion deadlines and lifetime budgets across success and clock regression" {
    const t = std.testing;
    var state: c.zc_recovery_retry = undefined;
    try t.expectEqual(c.ZC_OK, zc_recovery_retry_init(3, 10, 15, &state));
    try t.expectEqual(@as(c_int, 0), zc_recovery_retry_poll(&state, 100, 1));
    try t.expectEqual(@as(u64, 110), state.deadline_ns);
    try t.expectEqual(@as(c_int, 0), zc_recovery_retry_poll(&state, 90, 1));
    try t.expectEqual(@as(c_int, 1), zc_recovery_retry_poll(&state, 110, 1));
    try t.expectEqual(c.ZC_OK, zc_recovery_retry_observe(&state, 120, 1));
    try t.expectEqual(@as(u64, 135), state.deadline_ns);
    try t.expectEqual(@as(c_int, 0), zc_recovery_retry_poll(&state, 134, 1));
    try t.expectEqual(@as(c_int, 1), zc_recovery_retry_poll(&state, 135, 1));
    try t.expectEqual(c.ZC_OK, zc_recovery_retry_observe(&state, 136, 0));
    try t.expectEqual(@as(u32, 2), state.attempts);
    try t.expectEqual(@as(u32, 0), state.armed);
    try t.expectEqual(@as(c_int, 0), zc_recovery_retry_poll(&state, 200, 1));
    try t.expectEqual(@as(c_int, 1), zc_recovery_retry_poll(&state, 215, 1));
    try t.expectEqual(@as(c_int, 0), zc_recovery_retry_poll(&state, 999, 1));
}
test "retry ABI rejects malformed state without writes and saturates clocks without overflow" {
    const t = std.testing;
    var state: c.zc_recovery_retry = undefined;
    @memset(std.mem.asBytes(&state), 0xa5);
    const sentinel = state;
    try t.expectEqual(c.ZC_INVALID, zc_recovery_retry_init(0, 0, 0, &state));
    try t.expectEqual(c.ZC_INVALID, zc_recovery_retry_init(1025, 0, 0, &state));
    try t.expectEqual(c.ZC_INVALID, zc_recovery_retry_init(3, 11, 10, &state));
    try t.expectEqual(c.ZC_INVALID, zc_recovery_retry_poll(&state, 0, 1));
    try t.expectEqualSlices(u8, std.mem.asBytes(&sentinel), std.mem.asBytes(&state));
    _ = zc_recovery_retry_init(2, 10, std.math.maxInt(u64), &state);
    try t.expectEqual(@as(c_int, 0), zc_recovery_retry_poll(&state, std.math.maxInt(u64) - 1, 1));
    try t.expectEqual(@as(u64, std.math.maxInt(u64)), state.deadline_ns);
    try t.expectEqual(@as(c_int, 1), zc_recovery_retry_poll(&state, std.math.maxInt(u64), 1));
    const before = state;
    try t.expectEqual(c.ZC_INVALID, zc_recovery_retry_observe(&state, 0, 2));
    try t.expectEqualSlices(u8, std.mem.asBytes(&before), std.mem.asBytes(&state));
    try t.expectEqual(@as(c_int, 1), zc_recovery_retry_poll(&state, std.math.maxInt(u64), 1));
    try t.expectEqual(@as(c_int, 0), zc_recovery_retry_poll(&state, std.math.maxInt(u64), 1));
}
