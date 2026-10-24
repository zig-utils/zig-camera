//! Externally serialized, bounded display ownership; no borrowed pixels survive push.
const std = @import("std");
const c = @import("abi.zig").c;
const Home = @import("home/apng_compositor.zig");
const admission = @import("image_admission.zig");
const raster = @import("raster_api.zig");
const A = std.heap.c_allocator;
const Owner = struct { canvas: Home.Canvas, ticket: admission.Ticket };
fn owner(p: *c.zc_apng_compositor) *Owner {
    return @ptrCast(@alignCast(p));
}
pub export fn zc_apng_compositor_open(width: u32, height: u32, bits: u32, maximum: u64, out: *?*c.zc_apng_compositor) c_int {
    out.* = null;
    if ((bits != 8 and bits != 16) or maximum == 0 or maximum > 256 * 1024 * 1024) return c.ZC_INVALID;
    const required = Home.Canvas.requiredBytes(width, height, @intCast(bits)) catch return c.ZC_INVALID;
    if (required > maximum) return c.ZC_INVALID;
    const ticket = admission.reserve(required + @sizeOf(Owner)) catch return c.ZC_BUSY;
    var success = false;
    defer if (!success) admission.release(ticket);
    const self = A.create(Owner) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(self);
    self.* = .{ .canvas = Home.Canvas.init(A, width, height, @intCast(bits), @intCast(maximum)) catch return c.ZC_NOMEM, .ticket = ticket };
    out.* = @ptrCast(self);
    success = true;
    return c.ZC_OK;
}
pub export fn zc_apng_compositor_push(p: *c.zc_apng_compositor, source: ?*const c.zc_raster, x: u32, y: u32, dispose: u32, blend: u32) c_int {
    if (dispose > 2 or blend > 1) return c.ZC_INVALID;
    const view = raster.read(source) catch return c.ZC_INVALID;
    owner(p).canvas.push(view, .{ .x = x, .y = y, .dispose = @intCast(dispose), .blend = @intCast(blend) }) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_apng_compositor_copy(p: *c.zc_apng_compositor, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const bytes = owner(p).canvas.pixels;
    length.* = bytes.len;
    const dest = data orelse return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < bytes.len) return c.ZC_INVALID;
    @memcpy(dest[0..bytes.len], bytes);
    return c.ZC_OK;
}
pub export fn zc_apng_compositor_reset(p: *c.zc_apng_compositor) void {
    owner(p).canvas.reset();
}
pub export fn zc_apng_compositor_close(p: ?*c.zc_apng_compositor) void {
    const self = owner(p orelse return);
    self.canvas.deinit();
    const ticket = self.ticket;
    A.destroy(self);
    admission.release(ticket);
}
