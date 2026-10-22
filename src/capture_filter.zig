//! Consumer-side exact frame-selection policy. No callback or borrowed frame
//! storage is retained here; the caller serializes one filter per capture job.
const std = @import("std");
const c = @import("abi.zig").c;
const Gate = @import("home/frame_barrier.zig").Gate;
pub fn valid(filter: *const c.zc_capture_filter) bool {
    return filter.struct_size == @sizeOf(c.zc_capture_filter) and filter.flags & ~@as(u32, 7) == 0 and
        filter.observed & ~@as(u32, 3) == 0 and (filter.flags & 2 == 0 or filter.flags & 1 != 0);
}
pub export fn zc_capture_filter_init(out: *c.zc_capture_filter, drop_frames: u32, flags: u32, after_ns: u64) c_int {
    const value: c.zc_capture_filter = .{ .struct_size = @sizeOf(c.zc_capture_filter), .remaining = drop_frames, .flags = flags, .observed = 0, .after_ns = after_ns, .last_event = 0 };
    if (!valid(&value)) return c.ZC_INVALID;
    out.* = value;
    return c.ZC_OK;
}
pub fn observe(filter: *c.zc_capture_filter, metadata: *const c.zc_metadata) c_int {
    return observeReady(filter, metadata, null);
}
pub fn observeReady(filter: *c.zc_capture_filter, metadata: *const c.zc_metadata, ready: ?bool) c_int {
    if (!valid(filter)) return c.ZC_INVALID;
    var gate: Gate = .{ .remaining = filter.remaining, .after_ns = if (filter.flags & 1 != 0) filter.after_ns else null, .subtract_exposure = filter.flags & 2 != 0, .last_event = if (filter.observed & 1 != 0) filter.last_event else null, .accepted = filter.observed & 2 != 0, .require_ready = filter.flags & c.ZC_CAPTURE_SYNC_READY != 0 };
    const accepted = gate.observeReady(metadata.event_id, if (metadata.valid & 16 != 0) metadata.timestamp_ns else null, if (metadata.valid & 64 != 0) metadata.exposure_us else null, ready) catch return c.ZC_UNSUPPORTED;
    filter.remaining = gate.remaining;
    filter.last_event = gate.last_event orelse 0;
    filter.observed = (if (gate.last_event != null) @as(u32, 1) else 0) | (if (gate.accepted) @as(u32, 2) else 0);
    return if (accepted) c.ZC_OK else c.ZC_TIMEOUT;
}
/// The real SensorTimestamp contract uses CLOCK_BOOTTIME. Darwin's explicit
/// virtual backend uses MONOTONIC and publishes the same domain as this query.
pub fn clockNs() !u64 {
    const stamp = try std.posix.clock_gettime(if (@import("builtin").os.tag == .linux) .BOOTTIME else .MONOTONIC);
    const value = @as(i128, stamp.sec) * std.time.ns_per_s + stamp.nsec;
    if (value < 0 or value > std.math.maxInt(u64)) return error.InvalidTime;
    return @intCast(value);
}
pub export fn zc_capture_clock_ns(out: *u64) c_int {
    out.* = clockNs() catch return c.ZC_IO;
    return c.ZC_OK;
}
test "capture filter validation and missing metadata leave caller state untouched" {
    var filter: c.zc_capture_filter = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_capture_filter_init(&filter, 2, 3, 100));
    const before = filter;
    try std.testing.expectEqual(c.ZC_INVALID, zc_capture_filter_init(&filter, 0, 2, 0));
    try std.testing.expectEqualDeep(before, filter);
    var metadata = std.mem.zeroes(c.zc_metadata);
    metadata.event_id = 1;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, observe(&filter, &metadata));
    try std.testing.expectEqualDeep(before, filter);
    metadata.valid = 16;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, observe(&filter, &metadata));
    try std.testing.expectEqualDeep(before, filter);
    metadata.valid |= 64;
    try std.testing.expectEqual(c.ZC_TIMEOUT, observe(&filter, &metadata));
    try std.testing.expectEqual(@as(u32, 1), filter.remaining);
    const after = filter;
    try std.testing.expectEqual(c.ZC_TIMEOUT, observe(&filter, &metadata));
    try std.testing.expectEqualDeep(after, filter);
}
test "sync-ready filters wait for explicit per-request readiness without changing the ABI" {
    var filter: c.zc_capture_filter = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_capture_filter_init(&filter, 1, c.ZC_CAPTURE_SYNC_READY, 0));
    try std.testing.expectEqual(@as(usize, 32), @sizeOf(c.zc_capture_filter));
    var metadata = std.mem.zeroes(c.zc_metadata);
    metadata.event_id = 1;
    try std.testing.expectEqual(c.ZC_TIMEOUT, observeReady(&filter, &metadata, true));
    metadata.event_id = 2;
    try std.testing.expectEqual(c.ZC_TIMEOUT, observe(&filter, &metadata));
    const before = filter;
    try std.testing.expectEqual(c.ZC_TIMEOUT, observeReady(&filter, &metadata, true));
    try std.testing.expectEqualDeep(before, filter);
    metadata.event_id = 3;
    try std.testing.expectEqual(c.ZC_TIMEOUT, observeReady(&filter, &metadata, false));
    metadata.event_id = 4;
    try std.testing.expectEqual(c.ZC_OK, observeReady(&filter, &metadata, true));
    const accepted = filter;
    try std.testing.expectEqual(c.ZC_OK, observe(&filter, &metadata));
    try std.testing.expectEqualDeep(accepted, filter);
    try std.testing.expectEqual(c.ZC_INVALID, zc_capture_filter_init(&filter, 0, 8, 0));
    try std.testing.expectEqualDeep(accepted, filter);
}
