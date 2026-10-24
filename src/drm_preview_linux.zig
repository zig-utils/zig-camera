const std = @import("std");
const c = @import("abi.zig").c;
const host = @import("home/kms_scanout_host.zig");
const scan = @import("home/kms_discovery_host.zig");
const catalog = @import("home/kms_catalog.zig");
const exports = @import("frame_export.zig");
const core = @import("core.zig");
const format = @import("processed_format.zig");
const A = std.heap.c_allocator;
pub const Owner = struct {
    device: host.Device = .{},
    width: u32,
    height: u32,
    format_code: u32,
    view: c.zc_preview_view,
    sources: [2]?*c.zc_frame_export = @splat(null),
    last_error: c_int = 0,
    current_color: ?c.zc_color_space = null,
    fn geometry(self: *Owner, view: *const c.zc_preview_view, color: ?*const c.zc_color_space) !host.Geometry {
        if (view.flags & 8 != 0 or view.overlay_orientation != 1) return error.Unsupported;
        if (@import("preview_view.zig").zc_preview_check_view(self.width, self.height, view) != c.ZC_OK) return error.InvalidGeometry;
        const width = if (view.flags & 2 != 0) view.window_width else self.device.screen_width;
        const height = if (view.flags & 2 != 0) view.window_height else self.device.screen_height;
        const plan = try @import("home/viewport.zig").Plan.init(self.width, self.height, width, height, view.image_orientation, 1, view.flags & 1 != 0, null);
        const x = std.math.add(i32, if (view.flags & 4 != 0) view.window_x else 0, @intCast(plan.image.x)) catch return error.InvalidGeometry;
        const y = std.math.add(i32, if (view.flags & 4 != 0) view.window_y else 0, @intCast(plan.image.y)) catch return error.InvalidGeometry;
        var result = host.Geometry{ .x = x, .y = y, .width = plan.image.width, .height = plan.image.height, .rotation = try host.policy.rotation(view.image_orientation) };
        if (format.yuv(self.format_code)) {
            const value = color orelse return error.Unsupported;
            if (value.struct_size != @sizeOf(c.zc_color_space) or value.present == 0) return error.Unsupported;
            result.encoding = switch (value.ycbcr_encoding) {
                c.ZC_YCBCR_REC601 => .bt601,
                c.ZC_YCBCR_REC709 => .bt709,
                c.ZC_YCBCR_REC2020 => .bt2020,
                else => return error.Unsupported,
            };
            result.full_range = switch (value.range) {
                c.ZC_RANGE_FULL => true,
                c.ZC_RANGE_LIMITED => false,
                else => return error.Unsupported,
            };
        }
        try self.device.checkGeometry(result);
        return result;
    }
    fn reap(self: *Owner) c_int {
        var result: c_int = c.ZC_OK;
        for (0..2) |i| {
            if (self.device.gate.current == i + 1 or self.device.gate.candidate == i + 1) continue;
            self.device.retire(i) catch |err| {
                if (result == c.ZC_OK) result = status(err);
            };
            if (self.sources[i]) |source| {
                self.sources[i] = null;
                const code = exports.zc_frame_export_close(source);
                if (code != c.ZC_OK and result == c.ZC_OK) result = code;
            }
        }
        if (result != c.ZC_OK) {
            self.last_error = result;
            self.device.poisoned = true;
        }
        return result;
    }
};
var owners: [4]?*Owner = @splat(null);
var mutex: std.Thread.Mutex = .{};
fn pointer(owner: *Owner) *c.zc_preview {
    return @ptrCast(owner);
}
pub fn find(p: *c.zc_preview) ?*Owner {
    mutex.lock();
    defer mutex.unlock();
    for (owners) |owner| if (owner) |value| if (pointer(value) == p) return value;
    return null;
}
fn remove(owner: *Owner) void {
    mutex.lock();
    defer mutex.unlock();
    for (&owners) |*entry| if (entry.* == owner) {
        entry.* = null;
        return;
    };
    unreachable;
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.Unsupported => c.ZC_UNSUPPORTED,
        error.Timeout => c.ZC_TIMEOUT,
        error.State => c.ZC_STATE,
        error.OutOfMemory => c.ZC_NOMEM,
        error.InvalidGeometry, error.InvalidLayout, error.InvalidOptions => c.ZC_INVALID,
        else => c.ZC_IO,
    };
}
pub fn open(cfg: *const c.zc_drm_preview_config, out: *?*c.zc_preview) c_int {
    out.* = null;
    if (!format.valid(cfg.format)) return c.ZC_INVALID;
    const fourcc = catalog.fourccForProcessed(format.name(cfg.format)) orelse return c.ZC_UNSUPPORTED;
    const end = std.mem.indexOfScalar(u8, &cfg.card, 0) orelse return c.ZC_INVALID;
    const owner = A.create(Owner) catch return c.ZC_NOMEM;
    var view: c.zc_preview_view = undefined;
    @import("preview_view.zig").zc_default_preview_view(&view);
    owner.* = .{ .width = cfg.width, .height = cfg.height, .format_code = cfg.format, .view = view };
    // Reserve the owner slot before hardware preparation, without holding the
    // registry mutex across DRM calls. Public calls are externally serialized.
    mutex.lock();
    const index = blk: {
        for (owners, 0..) |entry, i| if (entry == null) break :blk i;
        mutex.unlock();
        A.destroy(owner);
        return c.ZC_BUSY;
    };
    owners[index] = owner;
    mutex.unlock();
    var success = false;
    defer if (!success) {
        remove(owner);
        A.destroy(owner);
    };
    const options = host.Options{ .connector = cfg.connector_id, .plane = cfg.plane_id, .fourcc = fourcc, .timeout_ms = cfg.timeout_ms };
    if (end != 0) {
        owner.device.open(cfg.card[0..end :0], options) catch |err| return status(err);
    } else {
        const found = A.create(scan.core.Result) catch return c.ZC_NOMEM;
        defer A.destroy(found);
        found.* = .{};
        scan.scan(found, null) catch |err| return status(err);
        var opened = false;
        for (found.displays[0..found.display_count]) |display| {
            if (display.status != 1 or display.active.width == 0 or std.mem.indexOfScalar(u32, display.formats.slice(), fourcc) == null) continue;
            if (cfg.connector_id != 0 and cfg.connector_id != display.connector) continue;
            const length = std.mem.indexOfScalar(u8, &display.card, 0) orelse continue;
            owner.device.open(display.card[0..length :0], options) catch continue;
            opened = true;
            break;
        }
        if (!opened) return c.ZC_DEVICE;
    }
    success = true;
    out.* = pointer(owner);
    return c.ZC_OK;
}
pub fn state(p: *c.zc_preview, out: *c.zc_drm_preview_state) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    out.* = std.mem.zeroes(c.zc_drm_preview_state);
    out.struct_size = @sizeOf(c.zc_drm_preview_state);
    for (owner.sources) |source| out.retained_frames += @intFromBool(source != null);
    out.uncertain = @intFromBool(owner.device.gate.uncertain);
    out.poisoned = @intFromBool(owner.device.poisoned);
    out.device_closed = @intFromBool(owner.device.closed);
    out.last_error = owner.last_error;
    out.last_error_number = owner.device.driver.last_errno;
    out.connector_id = owner.device.connector;
    out.plane_id = owner.device.plane;
    out.crtc_id = owner.device.crtc;
    return c.ZC_OK;
}
pub fn show(p: *c.zc_preview, camera: *c.zc_camera, token: u64, stream: u32) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (stream != c.ZC_MAIN and stream != c.ZC_LORES) return c.ZC_UNSUPPORTED;
    var info: c.zc_info = undefined;
    const inf = core.zc_get_info(camera, &info);
    if (inf != c.ZC_OK) return inf;
    if (info.buffer_count < 2) return c.ZC_UNSUPPORTED;
    const slot = owner.device.freeSlot() catch |err| return status(err);
    var source: ?*c.zc_frame_export = null;
    const acquired = exports.zc_frame_export_open(camera, token, @as(u32, 1) << @as(u5, @intCast(stream)), 0, &source);
    if (acquired != c.ZC_OK) return acquired;
    owner.sources[slot] = source;
    const result = presentOwned(owner, slot, source.?);
    const cleanup = owner.reap();
    return if (cleanup != c.ZC_OK) cleanup else result;
}
fn presentOwned(owner: *Owner, slot: usize, source: *c.zc_frame_export) c_int {
    var exported: c.zc_export_info = undefined;
    const read = exports.zc_frame_export_info(source, &exported);
    if (read != c.ZC_OK) return read;
    const input = exported.streams[0];
    if (input.width != owner.width or input.height != owner.height or !std.mem.eql(u8, std.mem.sliceTo(&input.format, 0), format.name(owner.format_code))) return c.ZC_INVALID;
    var planes: [4]host.policy.Plane = undefined;
    if (input.plane_count > planes.len) return c.ZC_INVALID;
    for (exported.planes[0..input.plane_count], 0..) |plane, i| planes[i] = .{ .fd = plane.fd, .offset = plane.offset, .length = plane.length, .used = plane.bytes_used };
    const layout = host.policy.Layout.init(format.name(owner.format_code), input.width, input.height, input.stride, planes[0..input.plane_count]) catch |err| return status(err);
    const geometry = owner.geometry(&owner.view, &exported.colors[0]) catch |err| return status(err);
    owner.device.prepare(slot, layout) catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    owner.device.present(slot, geometry) catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    owner.current_color = exported.colors[0];
    return c.ZC_OK;
}
pub fn background(p: *c.zc_preview) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (owner.device.closed) return c.ZC_STATE;
    owner.device.detach() catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    return owner.reap();
}
pub fn setView(p: *c.zc_preview, view: *const c.zc_preview_view) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (owner.device.closed) return c.ZC_STATE;
    // Before first YUV frame, validate geometry/rotation without inventing a color
    // description; actual matrix/range admission happens on the first source.
    const geometry = owner.geometry(view, if (owner.current_color) |*color| color else null) catch |err| {
        if (err == error.Unsupported and format.yuv(owner.format_code) and owner.current_color == null and view.flags & 8 == 0 and view.overlay_orientation == 1) {
            if (@import("preview_view.zig").zc_preview_check_view(owner.width, owner.height, view) != c.ZC_OK) return c.ZC_INVALID;
            const rotation = host.policy.rotation(view.image_orientation) catch return c.ZC_INVALID;
            owner.device.checkGeometry(.{ .width = 1, .height = 1, .rotation = rotation }) catch |failure| return status(failure);
            owner.view = view.*;
            return c.ZC_OK;
        }
        return status(err);
    };
    owner.device.changeGeometry(geometry) catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    owner.view = view.*;
    return c.ZC_OK;
}
pub fn close(p: *c.zc_preview) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (owner.device.closed) {
        remove(owner);
        A.destroy(owner);
        return c.ZC_OK;
    }
    owner.device.detach() catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    var result = owner.reap();
    owner.device.finishClose() catch |err| {
        if (result == c.ZC_OK) result = status(err);
    };
    if (result != c.ZC_OK) {
        owner.last_error = result;
        return result;
    } // retained acknowledgement owner
    remove(owner);
    A.destroy(owner);
    return c.ZC_OK;
}
