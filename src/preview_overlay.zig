//! Immutable owned overlays, independent of camera leases and SDL resources.
const std = @import("std");
const c = @import("abi.zig").c;
const View = @import("home/rgba_view.zig").View;
const Overlay = struct { data: []u8, width: u32, height: u32 };
fn image(p: *const c.zc_preview_overlay) *const Overlay {
    return @ptrCast(@alignCast(p));
}
pub export fn zc_preview_overlay_create(data: ?[*]const u8, length: u64, width: u32, height: u32, stride: u32, out: *?*c.zc_preview_overlay) c_int {
    out.* = null;
    if (data == null or width == 0 or height == 0 or width > 4096 or height > 4096 or length > std.math.maxInt(usize)) return c.ZC_INVALID;
    const view = View.init(data.?[0..@intCast(length)], width, height, stride) catch return c.ZC_INVALID;
    const owned = std.heap.c_allocator.alloc(u8, view.packed_size) catch return c.ZC_NOMEM;
    view.copy(owned) catch {
        std.heap.c_allocator.free(owned);
        return c.ZC_INVALID;
    };
    const result = std.heap.c_allocator.create(Overlay) catch {
        std.heap.c_allocator.free(owned);
        return c.ZC_NOMEM;
    };
    result.* = .{ .data = owned, .width = width, .height = height };
    out.* = @ptrCast(result);
    return c.ZC_OK;
}
pub export fn zc_preview_overlay_close(p: ?*c.zc_preview_overlay) void {
    const value = p orelse return;
    const result: *Overlay = @ptrCast(@alignCast(value));
    std.heap.c_allocator.free(result.data);
    std.heap.c_allocator.destroy(result);
}
extern fn zcm_preview_overlay(*c.zc_preview, ?[*]const u8, u32, u32, u32) c_int;
pub export fn zc_preview_set_overlay(p: *c.zc_preview, overlay: ?*const c.zc_preview_overlay) c_int {
    if (!@import("options").preview) return c.ZC_UNSUPPORTED;
    if (overlay) |value| {
        const src = image(value);
        return zcm_preview_overlay(p, src.data.ptr, src.width, src.height, src.width * 4);
    }
    return zcm_preview_overlay(p, null, 0, 0, 0);
}
test "overlay owns only active RGBA bytes and clears result on failed creation" {
    var src = [_]u8{ 1, 2, 3, 0, 4, 5, 6, 128, 99, 99, 99, 99, 7, 8, 9, 255, 10, 11, 12, 1 };
    var out: ?*c.zc_preview_overlay = null;
    try std.testing.expectEqual(c.ZC_OK, zc_preview_overlay_create(&src, src.len, 2, 2, 12, &out));
    defer zc_preview_overlay_close(out);
    @memset(&src, 0);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 0, 4, 5, 6, 128, 7, 8, 9, 255, 10, 11, 12, 1 }, image(out.?).data);
    var bad = out;
    try std.testing.expectEqual(c.ZC_INVALID, zc_preview_overlay_create(&src, 7, 2, 2, 12, &bad));
    try std.testing.expectEqual(@as(?*c.zc_preview_overlay, null), bad);
    try std.testing.expectEqual(c.ZC_INVALID, zc_preview_overlay_create(null, 4, 1, 1, 4, &bad));
    try std.testing.expectEqual(c.ZC_INVALID, zc_preview_overlay_create(&src, src.len, 4097, 1, 16388, &bad));
    zc_preview_overlay_close(null);
}
