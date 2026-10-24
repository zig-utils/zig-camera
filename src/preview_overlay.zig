//! Immutable owned overlays, independent of camera leases and SDL resources.
const std = @import("std");
const c = @import("abi.zig").c;
const View = @import("home/rgba_view.zig").View;
const Tickets = @import("home/owned_admission.zig").Registry(32);
var tickets: Tickets = .{ .max_bytes = 256 * 1024 * 1024, .max_items = 32 };
var ticket_lock: std.Thread.Mutex = .{};
const Overlay = struct { data: []u8, width: u32, height: u32, refs: std.atomic.Value(u32) = std.atomic.Value(u32).init(1), ticket: Tickets.Ticket };
fn releaseTicket(ticket: Tickets.Ticket) void {
    ticket_lock.lock();
    defer ticket_lock.unlock();
    tickets.release(ticket) catch unreachable;
}
/// Private immutable retain: accepted native jobs need no duplicate pixel copy.
pub fn retain(p: *const c.zc_preview_overlay) !*c.zc_preview_overlay {
    const value: *Overlay = @ptrCast(@alignCast(@constCast(p)));
    var count = value.refs.load(.acquire);
    while (true) {
        if (count == std.math.maxInt(u32)) return error.State;
        if (value.refs.cmpxchgWeak(count, count + 1, .acq_rel, .acquire)) |changed| {
            count = changed;
        } else break;
    }
    return @constCast(p);
}
pub fn borrowedView(p: *const c.zc_preview_overlay) View {
    const value = image(p);
    return View.init(value.data, value.width, value.height, @as(usize, value.width) * 4) catch unreachable;
}
fn image(p: *const c.zc_preview_overlay) *const Overlay {
    return @ptrCast(@alignCast(p));
}
pub export fn zc_preview_overlay_create(data: ?[*]const u8, length: u64, width: u32, height: u32, stride: u32, out: *?*c.zc_preview_overlay) c_int {
    out.* = null;
    if (data == null or width == 0 or height == 0 or width > 4096 or height > 4096 or length > std.math.maxInt(usize)) return c.ZC_INVALID;
    const view = View.init(data.?[0..@intCast(length)], width, height, stride) catch return c.ZC_INVALID;
    ticket_lock.lock();
    const ticket = tickets.reserve(view.packed_size) catch |err| {
        ticket_lock.unlock();
        return if (err == error.BufferFull) c.ZC_BUSY else c.ZC_STATE;
    };
    ticket_lock.unlock();
    var handed = false;
    defer if (!handed) releaseTicket(ticket);
    const owned = std.heap.c_allocator.alloc(u8, view.packed_size) catch return c.ZC_NOMEM;
    view.copy(owned) catch {
        std.heap.c_allocator.free(owned);
        return c.ZC_INVALID;
    };
    const result = std.heap.c_allocator.create(Overlay) catch {
        std.heap.c_allocator.free(owned);
        return c.ZC_NOMEM;
    };
    result.* = .{ .data = owned, .width = width, .height = height, .ticket = ticket };
    handed = true;
    out.* = @ptrCast(result);
    return c.ZC_OK;
}
pub export fn zc_preview_overlay_close(p: ?*c.zc_preview_overlay) void {
    const value = p orelse return;
    const result: *Overlay = @ptrCast(@alignCast(value));
    if (result.refs.fetchSub(1, .acq_rel) != 1) return;
    releaseTicket(result.ticket);
    std.heap.c_allocator.free(result.data);
    std.heap.c_allocator.destroy(result);
}
pub export fn zc_preview_overlay_clone(p: *const c.zc_preview_overlay, out: *?*c.zc_preview_overlay) c_int {
    const src = image(p);
    return zc_preview_overlay_create(src.data.ptr, src.data.len, src.width, src.height, src.width * 4, out);
}
extern fn zcm_preview_overlay(*c.zc_preview, ?[*]const u8, u32, u32, u32) c_int;
pub export fn zc_preview_set_overlay(p: *c.zc_preview, overlay: ?*const c.zc_preview_overlay) c_int {
    if (@import("drm_preview.zig").owns(p)) return @import("drm_preview.zig").setOverlay(p, overlay);
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
test "overlay snapshot owns exact compact alpha bytes after source retirement" {
    const t = std.testing;
    const pixels = [_]u8{ 1, 2, 3, 0, 4, 5, 6, 128, 99, 99, 99, 99, 7, 8, 9, 255, 10, 11, 12, 1 };
    var src: ?*c.zc_preview_overlay = null;
    try t.expectEqual(c.ZC_OK, zc_preview_overlay_create(&pixels, pixels.len, 2, 2, 12, &src));
    var copy: ?*c.zc_preview_overlay = null;
    try t.expectEqual(c.ZC_OK, zc_preview_overlay_clone(src.?, &copy));
    defer zc_preview_overlay_close(copy);
    try t.expect(src != copy);
    zc_preview_overlay_close(src);
    try t.expectEqual(@as(u32, 2), image(copy.?).width);
    try t.expectEqual(@as(u32, 2), image(copy.?).height);
    try t.expectEqualSlices(u8, &.{ 1, 2, 3, 0, 4, 5, 6, 128, 7, 8, 9, 255, 10, 11, 12, 1 }, image(copy.?).data);
}

test "native overlay references share immutable pixels and bound live owner admission" {
    const t = std.testing;
    const pixels = [_]u8{ 1, 2, 3, 127 };
    var original: ?*c.zc_preview_overlay = null;
    try t.expectEqual(c.ZC_OK, zc_preview_overlay_create(&pixels, 4, 1, 1, 4, &original));
    const shared = try retain(original.?);
    try t.expectEqual(original.?, shared);
    zc_preview_overlay_close(original);
    original = null;
    try t.expectEqualSlices(u8, &pixels, borrowedView(shared).data);
    zc_preview_overlay_close(shared);
    var images: [32]?*c.zc_preview_overlay = @splat(null);
    defer for (images) |value| zc_preview_overlay_close(value);
    for (&images) |*value| try t.expectEqual(c.ZC_OK, zc_preview_overlay_create(&pixels, 4, 1, 1, 4, value));
    var rejected: ?*c.zc_preview_overlay = null;
    try t.expectEqual(c.ZC_BUSY, zc_preview_overlay_create(&pixels, 4, 1, 1, 4, &rejected));
    try t.expectEqual(@as(?*c.zc_preview_overlay, null), rejected);
}
