//! Display-only geometry validation and Home viewport plans; no camera mutations.
const std = @import("std");
const c = @import("abi.zig").c;
const Home = @import("home/viewport.zig");
const Region = @import("home/region.zig").Region;
pub export fn zc_default_preview_view(out: *c.zc_preview_view) void {
    out.* = std.mem.zeroes(c.zc_preview_view);
    out.struct_size = @sizeOf(c.zc_preview_view);
    out.flags = 1;
    out.image_orientation = 1;
    out.overlay_orientation = 1;
}
fn plan(width: u32, height: u32, output_width: u32, output_height: u32, cfg: *const c.zc_preview_view) !Home.Plan {
    if (cfg.struct_size != @sizeOf(c.zc_preview_view) or cfg.flags & ~@as(u32, 15) != 0 or width > 16384 or height > 16384) return error.InvalidGeometry;
    if (cfg.flags & 2 != 0) {
        if (cfg.window_width == 0 or cfg.window_height == 0 or cfg.window_width > 16384 or cfg.window_height > 16384) return error.InvalidGeometry;
    } else if (cfg.window_width != 0 or cfg.window_height != 0) return error.InvalidGeometry;
    if (cfg.flags & 4 != 0) {
        if (cfg.window_x < -1_000_000 or cfg.window_x > 1_000_000 or cfg.window_y < -1_000_000 or cfg.window_y > 1_000_000) return error.InvalidGeometry;
    } else if (cfg.window_x != 0 or cfg.window_y != 0) return error.InvalidGeometry;
    var rectangle: ?Region = null;
    if (cfg.flags & 8 != 0) {
        rectangle = .{ .x = cfg.overlay_x, .y = cfg.overlay_y, .width = cfg.overlay_width, .height = cfg.overlay_height };
    } else if (cfg.overlay_x != 0 or cfg.overlay_y != 0 or cfg.overlay_width != 0 or cfg.overlay_height != 0) return error.InvalidGeometry;
    return Home.Plan.init(width, height, output_width, output_height, cfg.image_orientation, cfg.overlay_orientation, cfg.flags & 1 != 0, rectangle);
}
pub export fn zc_preview_check_view(width: u32, height: u32, cfg: *const c.zc_preview_view) c_int {
    _ = plan(width, height, 1, 1, cfg) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
extern fn zcm_preview_extent(*c.zc_preview, *u32, *u32) c_int;
extern fn zcm_preview_view(*c.zc_preview, *const c.zc_preview_view) c_int;
pub export fn zc_preview_set_view(p: *c.zc_preview, cfg: *const c.zc_preview_view) c_int {
    if (!@import("options").preview) return c.ZC_UNSUPPORTED;
    var width: u32 = 0;
    var height: u32 = 0;
    const result = zcm_preview_extent(p, &width, &height);
    if (result != c.ZC_OK) return result;
    const valid = zc_preview_check_view(width, height, cfg);
    if (valid != c.ZC_OK) return valid;
    return zcm_preview_view(p, cfg);
}
/// Private adapter call. Rectangles are image/overlay xywh; UV arrays contain
/// TL,TR,BR,BL pairs. Complete validation precedes writing either output.
pub export fn zcm_preview_geometry(width: u32, height: u32, output_width: u32, output_height: u32, cfg: *const c.zc_preview_view, rectangles: [*]u32, coordinates: [*]f32) c_int {
    const result = plan(width, height, output_width, output_height, cfg) catch return c.ZC_INVALID;
    rectangles[0..8].* = .{ result.image.x, result.image.y, result.image.width, result.image.height, result.overlay.x, result.overlay.y, result.overlay.width, result.overlay.height };
    coordinates[0..8].* = result.image_uv;
    coordinates[8..16].* = result.overlay_uv;
    return c.ZC_OK;
}
test "display view ABI validates every flag and rectangle before geometry output" {
    try std.testing.expectEqual(@as(usize, 48), @sizeOf(c.zc_preview_view));
    var cfg: c.zc_preview_view = undefined;
    zc_default_preview_view(&cfg);
    try std.testing.expectEqual(c.ZC_OK, zc_preview_check_view(4, 2, &cfg));
    var rectangles: [8]u32 = @splat(99);
    var uv: [16]f32 = @splat(99);
    cfg.flags |= 8;
    cfg.overlay_x = 3;
    cfg.overlay_width = std.math.maxInt(u32);
    cfg.overlay_height = 1;
    try std.testing.expectEqual(c.ZC_INVALID, zcm_preview_geometry(4, 2, 8, 8, &cfg, &rectangles, &uv));
    for (rectangles) |v| try std.testing.expectEqual(@as(u32, 99), v);
    for (uv) |v| try std.testing.expectEqual(@as(f32, 99), v);
    cfg.overlay_x = 1;
    cfg.overlay_width = 2;
    try std.testing.expectEqual(c.ZC_OK, zcm_preview_geometry(4, 2, 8, 8, &cfg, &rectangles, &uv));
    try std.testing.expectEqualSlices(u32, &.{ 0, 2, 8, 4, 2, 2, 4, 2 }, &rectangles);
    for (0..12) |field| {
        var bad: c.zc_preview_view = undefined;
        zc_default_preview_view(&bad);
        switch (field) {
            0 => bad.struct_size = 0,
            1 => bad.flags |= 16,
            2 => bad.image_orientation = 0,
            3 => bad.overlay_orientation = 9,
            4 => bad.window_width = 2,
            5 => bad.window_x = 1,
            6 => bad.flags |= 2,
            7 => {
                bad.flags |= 2;
                bad.window_width = 16385;
                bad.window_height = 1;
            },
            8 => {
                bad.flags |= 4;
                bad.window_y = -1_000_001;
            },
            9 => bad.overlay_width = 1,
            10 => bad.flags |= 8,
            11 => {
                bad.flags |= 8;
                bad.overlay_y = 1;
                bad.overlay_width = 1;
                bad.overlay_height = 2;
            },
            else => unreachable,
        }
        try std.testing.expectEqual(c.ZC_INVALID, zc_preview_check_view(4, 2, &bad));
    }
}
