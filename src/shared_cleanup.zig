const c = @import("abi.zig").c;
const exports = @import("frame_export.zig");
const remote = @import("frame_channel.zig");

pub export fn zc_shared_cleanup_state_get(out: *c.zc_shared_cleanup_state) c_int {
    const e = exports.cleanupState();
    const r = remote.cleanupState();
    out.* = .{ .struct_size = @sizeOf(c.zc_shared_cleanup_state), .exports = e.owners, .remote_frames = r.owners, .busy = e.busy + r.busy, .retained_bytes = e.bytes + r.bytes };
    return c.ZC_OK;
}
pub export fn zc_shared_cleanup_drain() c_int {
    const e = exports.drainCleanup();
    const r = remote.drainCleanup();
    if (e != c.ZC_OK or r != c.ZC_OK) return c.ZC_IO;
    var state: c.zc_shared_cleanup_state = undefined;
    _ = zc_shared_cleanup_state_get(&state);
    return if (state.exports + state.remote_frames != 0) c.ZC_BUSY else c.ZC_OK;
}

test "shared cleanup public layout and empty drain" {
    const t = @import("std").testing;
    try t.expectEqual(@as(usize, 24), @sizeOf(c.zc_shared_cleanup_state));
    try t.expectEqual(c.ZC_OK, zc_shared_cleanup_drain());
    var state: c.zc_shared_cleanup_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_shared_cleanup_state_get(&state));
    try t.expectEqual(@as(u64, 0), state.retained_bytes);
}
