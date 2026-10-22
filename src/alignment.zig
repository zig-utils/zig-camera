//! C ABI geometry planning over Home's shared processed-stream recipes.
const std = @import("std");
const c = @import("abi.zig").c;
pub const home = @import("home/stream_alignment.zig");
pub const Policy = struct {
    profile: home.Profile,
    optimal: bool,
    pub fn aligned(self: Policy, width: u32, height: u32, layout: home.Layout) !home.Plan {
        return home.aligned(width, height, layout, self.profile, self.optimal);
    }
};
pub fn policy(profile: u32, optimal: u32) !Policy {
    if (profile > c.ZC_ALIGN_PISP or optimal > 1) return error.InvalidPolicy;
    return .{ .profile = if (profile == c.ZC_ALIGN_VC4) .vc4 else .pisp, .optimal = optimal != 0 };
}
pub export fn zc_align_stream_geometry(width: u32, height: u32, layout: u32, profile: u32, optimal: u32, out: *c.zc_stream_alignment) c_int {
    const selected = policy(profile, optimal) catch return c.ZC_INVALID;
    const kind: home.Layout = switch (layout) {
        c.ZC_ALIGN_PACKED => .packed_pixels,
        c.ZC_ALIGN_PLANAR420 => .planar420,
        c.ZC_ALIGN_WIDE => .wide,
        else => return c.ZC_INVALID,
    };
    const plan = selected.aligned(width, height, kind) catch return c.ZC_INVALID;
    out.* = .{ .struct_size = @sizeOf(c.zc_stream_alignment), .width = plan.width, .height = plan.height, .width_alignment = plan.width_alignment, .height_alignment = plan.height_alignment };
    return c.ZC_OK;
}
test "stream alignment ABI preserves failures and distinguishes profile layout and minimum policy" {
    const t = std.testing;
    var out = std.mem.zeroes(c.zc_stream_alignment);
    out.width = 42;
    const before = out;
    try t.expectEqual(c.ZC_INVALID, zc_align_stream_geometry(63, 2, c.ZC_ALIGN_PACKED, c.ZC_ALIGN_PISP, 1, &out));
    try t.expectEqualDeep(before, out);
    try t.expectEqual(c.ZC_INVALID, zc_align_stream_geometry(640, 480, 3, 0, 1, &out));
    try t.expectEqual(c.ZC_INVALID, zc_align_stream_geometry(640, 480, 0, 2, 1, &out));
    try t.expectEqual(c.ZC_INVALID, zc_align_stream_geometry(640, 480, 0, 0, 2, &out));
    try t.expectEqualDeep(before, out);
    try t.expectEqual(c.ZC_OK, zc_align_stream_geometry(1919, 1081, c.ZC_ALIGN_PLANAR420, c.ZC_ALIGN_PISP, 1, &out));
    try t.expectEqual(@as(usize, 20), @sizeOf(c.zc_stream_alignment));
    try t.expectEqual(@as(u32, 1792), out.width);
    try t.expectEqual(@as(u32, 1080), out.height);
    try t.expectEqual(@as(u32, 128), out.width_alignment);
    try t.expectEqual(@as(u32, 2), out.height_alignment);
    try t.expectEqual(c.ZC_OK, zc_align_stream_geometry(1919, 1081, c.ZC_ALIGN_WIDE, c.ZC_ALIGN_VC4, 1, &out));
    try t.expectEqual(@as(u32, 1904), out.width);
    try t.expectEqual(c.ZC_OK, zc_align_stream_geometry(1919, 1081, c.ZC_ALIGN_WIDE, c.ZC_ALIGN_VC4, 0, &out));
    try t.expectEqual(@as(u32, 1918), out.width);
}
