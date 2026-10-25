//! Public ABI projection of Home's allocation-free timestamp intersection.
const c = @import("abi.zig").c;
pub const Home = @import("home/frame_match.zig");
pub export fn zc_match_frame_timestamps(input: ?[*]const u64, count: u32, tolerance_ns: u64, output: ?*c.zc_frame_match) c_int {
    if (input == null or output == null or count < 2 or count > Home.max_streams) return c.ZC_INVALID;
    const decision = Home.choose(input.?[0..count], tolerance_ns) catch return c.ZC_INVALID;
    output.?.* = .{ .struct_size = @sizeOf(c.zc_frame_match), .replace_mask = decision.replace_mask, .earliest_ns = decision.earliest_ns, .latest_ns = decision.latest_ns, .skew_ns = decision.skewNs() };
    return c.ZC_OK;
}
test "frame matching ABI rejects invalid pointers/counts before changing output" {
    const t = @import("std").testing;
    var out: c.zc_frame_match = .{ .struct_size = 77, .replace_mask = 33, .earliest_ns = 1, .latest_ns = 2, .skew_ns = 1 };
    const before = out;
    try t.expectEqual(c.ZC_INVALID, zc_match_frame_timestamps(null, 2, 0, &out));
    try t.expectEqualDeep(before, out);
    try t.expectEqual(c.ZC_INVALID, zc_match_frame_timestamps(&.{1}, 1, 0, &out));
    try t.expectEqualDeep(before, out);
    try t.expectEqual(c.ZC_INVALID, zc_match_frame_timestamps(&.{ 1, 2 }, 2, 0, null));
    try t.expectEqual(c.ZC_OK, zc_match_frame_timestamps(&.{ 1, 2 }, 2, 0, &out));
    try t.expectEqual(@as(usize, 32), @sizeOf(c.zc_frame_match));
    try t.expectEqual(@as(u32, 1), out.replace_mask);
    try t.expectEqual(@as(u64, 1), out.skew_ns);
}
