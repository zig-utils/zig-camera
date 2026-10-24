const std = @import("std");
const c = @import("abi.zig").c;
const host = @import("home/kms_scanout_host.zig");
const scan = @import("home/kms_discovery_host.zig");
const catalog = @import("home/kms_catalog.zig");
const exports = @import("frame_export.zig");
const core = @import("core.zig");
const format = @import("processed_format.zig");
const A = std.heap.c_allocator;
const Serial = @import("home/serial_worker.zig");
pub const Owner = struct {
    device: host.Device = .{},
    width: u32,
    height: u32,
    format_code: u32,
    copy_rgb16: bool = false,
    copied_frames: u64 = 0,
    view: c.zc_preview_view,
    sources: [2]?*c.zc_frame_export = @splat(null),
    last_error: c_int = 0,
    current_color: ?c.zc_color_space = null,
    executor: ?Serial.Worker = null,
    capacity: u32 = 0,
    live_jobs: u32 = 0,
    retiring: bool = false,
    rejected: u64 = 0,
    cache_lock: std.Thread.Mutex = .{},
    cache: c.zc_drm_preview_state = std.mem.zeroes(c.zc_drm_preview_state),
    storage_cache: c.zc_drm_preview_storage_state = std.mem.zeroes(c.zc_drm_preview_storage_state),
    fn busy(self: *Owner) bool {
        if (self.executor) |*worker| return (worker.snapshot() catch return true).outstanding != 0;
        return false;
    }
    fn publishState(self: *Owner) void {
        const value = liveState(self);
        const storage = liveStorage(self);
        self.cache_lock.lock();
        defer self.cache_lock.unlock();
        self.cache = value;
        self.storage_cache = storage;
    }
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
            self.device.recycle(i) catch |err| {
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
pub fn open(cfg: *const c.zc_drm_preview_config, out: *?*c.zc_preview, copy_rgb16: bool) c_int {
    out.* = null;
    if (!format.valid(cfg.format)) return c.ZC_INVALID;
    const fourcc = if (copy_rgb16) catalog.fourcc("XR24") else catalog.fourccForProcessed(format.name(cfg.format)) orelse return c.ZC_UNSUPPORTED;
    const end = std.mem.indexOfScalar(u8, &cfg.card, 0) orelse return c.ZC_INVALID;
    const owner = A.create(Owner) catch return c.ZC_NOMEM;
    var view: c.zc_preview_view = undefined;
    @import("preview_view.zig").zc_default_preview_view(&view);
    owner.* = .{ .width = cfg.width, .height = cfg.height, .format_code = cfg.format, .copy_rgb16 = copy_rgb16, .view = view };
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
    if (owner.executor != null) {
        owner.cache_lock.lock();
        defer owner.cache_lock.unlock();
        out.* = owner.cache;
    } else out.* = liveState(owner);
    return c.ZC_OK;
}
fn liveState(owner: *Owner) c.zc_drm_preview_state {
    var value = std.mem.zeroes(c.zc_drm_preview_state);
    value.struct_size = @sizeOf(c.zc_drm_preview_state);
    for (owner.sources) |source| value.retained_frames += @intFromBool(source != null);
    value.uncertain = @intFromBool(owner.device.gate.uncertain);
    value.poisoned = @intFromBool(owner.device.poisoned);
    value.device_closed = @intFromBool(owner.device.closed);
    value.last_error = owner.last_error;
    value.last_error_number = owner.device.driver.last_errno;
    value.connector_id = owner.device.connector;
    value.plane_id = owner.device.plane;
    value.crtc_id = owner.device.crtc;
    return value;
}
pub fn show(p: *c.zc_preview, camera: *c.zc_camera, token: u64, stream: u32) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (owner.busy()) return c.ZC_BUSY;
    if (owner.retiring) return c.ZC_STATE;
    defer owner.publishState();
    if (stream != c.ZC_MAIN and stream != c.ZC_LORES) return c.ZC_UNSUPPORTED;
    var info: c.zc_info = undefined;
    const inf = core.zc_get_info(camera, &info);
    if (inf != c.ZC_OK) return inf;
    if (info.buffer_count < 2) return c.ZC_UNSUPPORTED;
    const slot = owner.device.freeSlot() catch |err| return status(err);
    var source: ?*c.zc_frame_export = null;
    const acquired = if (owner.copy_rgb16) exports.openNativeRead(camera, token, stream, &source) else exports.zc_frame_export_open(camera, token, @as(u32, 1) << @as(u5, @intCast(stream)), 0, &source);
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
    if (owner.copy_rgb16) return presentCopied(owner, slot, source, &exported);
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
fn presentCopied(owner: *Owner, slot: usize, source: *c.zc_frame_export, exported: *const c.zc_export_info) c_int {
    var stream: c.zc_stream = undefined;
    const rc = exports.nativeStream(source, &stream);
    if (rc != c.ZC_OK) return rc;
    const words = @import("stream_rgb.zig").wideView(stream) catch return c.ZC_INVALID;
    const geometry = owner.geometry(&owner.view, &exported.colors[0]) catch |err| return status(err);
    const target = owner.device.prepareCpu(slot, owner.width, owner.height) catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    words.toPacked8(target.bytes, target.pitch, .bgra) catch {
        owner.device.finishCpu(slot) catch return c.ZC_IO;
        return c.ZC_INVALID;
    };
    owner.device.finishCpu(slot) catch return c.ZC_IO;
    owner.copied_frames +|= 1;
    // GPU scanout owns separate storage. Retire the input read fence now,
    // before an uninterruptible flip wait, and never recycle it on DMA error.
    owner.sources[slot] = null;
    const cleanup = exports.zc_frame_export_close(source);
    if (cleanup != c.ZC_OK) {
        owner.device.poisoned = true;
        return cleanup;
    }
    owner.device.present(slot, geometry) catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    owner.current_color = exported.colors[0];
    return c.ZC_OK;
}
fn liveStorage(owner: *Owner) c.zc_drm_preview_storage_state {
    var value = std.mem.zeroes(c.zc_drm_preview_storage_state);
    value.struct_size = @sizeOf(c.zc_drm_preview_storage_state);
    value.input_format = owner.format_code;
    value.scanout_format = if (owner.copy_rgb16) c.ZC_BGRX32 else owner.format_code;
    value.copy_policy = @intFromBool(owner.copy_rgb16);
    value.copied_frames = owner.copied_frames;
    for (owner.device.slots) |slot| {
        value.buffers += @intFromBool(slot.dumb != 0 or slot.cpu_fd >= 0 or slot.mapping != null);
        value.cpu_active += @intFromBool(slot.cpu_access);
        if (slot.mapping) |mapping| value.storage_bytes += mapping.len;
    }
    return value;
}
pub fn storageState(p: *c.zc_preview, out: *c.zc_drm_preview_storage_state) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (owner.executor != null) {
        owner.cache_lock.lock();
        defer owner.cache_lock.unlock();
        out.* = owner.storage_cache;
    } else out.* = liveStorage(owner);
    return c.ZC_OK;
}
pub fn background(p: *c.zc_preview) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (owner.busy()) return c.ZC_BUSY;
    defer owner.publishState();
    return backgroundOwned(owner);
}
fn backgroundOwned(owner: *Owner) c_int {
    if (owner.device.closed) return c.ZC_STATE;
    owner.device.detach() catch |err| {
        owner.last_error = status(err);
        return owner.last_error;
    };
    return owner.reap();
}
pub fn setView(p: *c.zc_preview, view: *const c.zc_preview_view) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (owner.busy()) return c.ZC_BUSY;
    if (owner.retiring) return c.ZC_STATE;
    defer owner.publishState();
    return setViewOwned(owner, view);
}
fn setViewOwned(owner: *Owner, view: *const c.zc_preview_view) c_int {
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
    if (owner.busy() or owner.live_jobs != 0) return c.ZC_BUSY;
    const result = closeResources(owner);
    if (result != c.ZC_OK) {
        owner.publishState();
        return result;
    }
    if (owner.executor) |*worker| worker.deinit() catch return c.ZC_STATE;
    remove(owner);
    A.destroy(owner);
    return c.ZC_OK;
}
fn closeResources(owner: *Owner) c_int {
    if (owner.device.closed) {
        owner.device.finishClose() catch |err| return status(err);
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
    return c.ZC_OK;
}

const Jobs = @import("home/owned_admission.zig").Registry(32);
var job_admission: Jobs = .{ .max_bytes = 32, .max_items = 32 };
var job_lock: std.Thread.Mutex = .{};
const Kind = enum { frame, fence, background, view, close_device };
const Job = struct {
    owner: *Owner,
    kind: Kind,
    ticket: u64 = 0,
    reservation: Jobs.Ticket,
    source: ?*c.zc_frame_export = null,
    view: c.zc_preview_view = undefined,
    mutex: std.Thread.Mutex = .{},
    started: bool = false,
    cancel_requested: bool = false,
    code: c_int = c.ZC_TIMEOUT,
    fn execute(context: *anyopaque) void {
        const self: *Job = @ptrCast(@alignCast(context));
        self.mutex.lock();
        self.started = true;
        const cancelled = self.cancel_requested;
        self.mutex.unlock();
        var code: c_int = if (cancelled) c.ZC_CANCELLED else switch (self.kind) {
            .frame => self.present(),
            .fence => c.ZC_OK,
            .background => backgroundOwned(self.owner),
            .view => setViewOwned(self.owner, &self.view),
            .close_device => closeResources(self.owner),
        };
        if (self.source) |source| {
            self.source = null;
            const cleanup = exports.zc_frame_export_close(source);
            if (cleanup != c.ZC_OK) {
                code = cleanup;
                self.owner.device.poisoned = true;
            }
        }
        if (code != c.ZC_OK and code != c.ZC_CANCELLED) self.owner.last_error = code;
        self.owner.publishState();
        self.mutex.lock();
        defer self.mutex.unlock();
        self.code = code;
    }
    fn present(self: *Job) c_int {
        const slot = self.owner.device.freeSlot() catch |err| return status(err);
        const source = self.source.?;
        self.source = null;
        self.owner.sources[slot] = source;
        const result = presentOwned(self.owner, slot, source);
        const cleanup = self.owner.reap();
        return if (cleanup != c.ZC_OK) cleanup else result;
    }
};
fn castJob(p: *c.zc_drm_preview_job) *Job {
    return @ptrCast(@alignCast(p));
}
fn releaseJob(self: *Job) void {
    job_lock.lock();
    job_admission.release(self.reservation) catch unreachable;
    job_lock.unlock();
    A.destroy(self);
}
pub fn enableAsync(p: *c.zc_preview, capacity: u32) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    if (capacity == 0 or capacity > 8) return c.ZC_INVALID;
    if (owner.executor != null or owner.device.closed or owner.retiring) return c.ZC_STATE;
    const worker = Serial.Worker.init(A, capacity) catch return c.ZC_NOMEM;
    owner.publishState();
    owner.capacity = capacity;
    owner.executor = worker;
    return c.ZC_OK;
}
pub fn queueState(p: *c.zc_preview, out: *c.zc_drm_preview_queue_state) c_int {
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    const worker = if (owner.executor) |*worker| worker else return c.ZC_STATE;
    const value = worker.snapshot() catch return c.ZC_STATE;
    out.* = .{ .struct_size = @sizeOf(c.zc_drm_preview_queue_state), .capacity = owner.capacity, .outstanding = @intCast(value.outstanding), .queued = @intCast(value.queued), .active = @intFromBool(value.active), .live_jobs = owner.live_jobs, .retiring = @intFromBool(owner.retiring), .reserved = 0, .issued = value.issued, .completed = value.completed, .rejected = value.rejected +| owner.rejected };
    return c.ZC_OK;
}
fn canSubmit(owner: *Owner, kind: Kind) c_int {
    const worker = if (owner.executor) |*worker| worker else return c.ZC_STATE;
    if (owner.retiring and kind != .close_device) return c.ZC_STATE;
    const current = worker.snapshot() catch return c.ZC_STATE;
    if (owner.retiring and (current.outstanding != 0 or owner.live_jobs != 0)) return c.ZC_BUSY;
    if (current.outstanding >= owner.capacity) return c.ZC_BUSY;
    return c.ZC_OK;
}
fn allocateJob(owner: *Owner, kind: Kind, out: *?*Job) c_int {
    out.* = null;
    const code = canSubmit(owner, kind);
    if (code != c.ZC_OK) {
        owner.rejected +|= 1;
        return code;
    }
    job_lock.lock();
    const reservation = job_admission.reserve(1) catch {
        job_lock.unlock();
        owner.rejected +|= 1;
        return c.ZC_BUSY;
    };
    job_lock.unlock();
    const value = A.create(Job) catch {
        job_lock.lock();
        job_admission.release(reservation) catch unreachable;
        job_lock.unlock();
        return c.ZC_NOMEM;
    };
    value.* = .{ .owner = owner, .kind = kind, .reservation = reservation };
    out.* = value;
    return c.ZC_OK;
}
fn submitJob(self: *Job, out: *?*c.zc_drm_preview_job) c_int {
    const owner = self.owner;
    self.ticket = owner.executor.?.submit(.{ .function = Job.execute, .context = self }) catch |err| {
        var code: c_int = if (err == error.BufferFull) c.ZC_BUSY else c.ZC_STATE;
        if (self.source) |source| {
            const cleanup = exports.zc_frame_export_close(source);
            if (cleanup != c.ZC_OK) code = cleanup;
        }
        releaseJob(self);
        return code;
    };
    owner.live_jobs += 1;
    if (self.kind == .close_device) owner.retiring = true;
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub fn showAsync(p: *c.zc_preview, camera: *c.zc_camera, token: u64, stream: u32, out: *?*c.zc_drm_preview_job) c_int {
    out.* = null;
    if (stream != c.ZC_MAIN and stream != c.ZC_LORES) return c.ZC_UNSUPPORTED;
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    var info: c.zc_info = undefined;
    const rc = core.zc_get_info(camera, &info);
    if (rc != c.ZC_OK) return rc;
    if (info.buffer_count < 2) return c.ZC_UNSUPPORTED;
    var allocated: ?*Job = null;
    const created = allocateJob(owner, .frame, &allocated);
    if (created != c.ZC_OK) return created;
    const self = allocated.?;
    const acquired = if (owner.copy_rgb16) exports.openNativeRead(camera, token, stream, &self.source) else exports.zc_frame_export_open(camera, token, @as(u32, 1) << @as(u5, @intCast(stream)), 0, &self.source);
    if (acquired != c.ZC_OK) {
        releaseJob(self);
        return acquired;
    }
    return submitJob(self, out);
}
pub fn commandAsync(p: *c.zc_preview, command: u32, input: ?*const anyopaque, out: *?*c.zc_drm_preview_job) c_int {
    out.* = null;
    if (command > 3 or ((command == 2) != (input != null))) return c.ZC_INVALID;
    const owner = find(p) orelse return c.ZC_UNSUPPORTED;
    const kind: Kind = switch (command) {
        0 => .fence,
        1 => .background,
        2 => .view,
        3 => .close_device,
        else => unreachable,
    };
    var view: c.zc_preview_view = undefined;
    if (input) |raw| {
        view = @as(*align(1) const c.zc_preview_view, @ptrCast(raw)).*;
        const code = @import("preview_view.zig").zc_preview_check_view(owner.width, owner.height, &view);
        if (code != c.ZC_OK) return code;
    }
    var allocated: ?*Job = null;
    const created = allocateJob(owner, kind, &allocated);
    if (created != c.ZC_OK) return created;
    if (input != null) allocated.?.view = view;
    return submitJob(allocated.?, out);
}
pub fn finishJob(p: *c.zc_drm_preview_job, out: *i32) c_int {
    const self = castJob(p);
    out.* = c.ZC_TIMEOUT;
    if (!(self.owner.executor.?.finished(self.ticket) catch return c.ZC_STATE)) return c.ZC_TIMEOUT;
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = self.code;
    return c.ZC_OK;
}
pub fn cancelJob(p: *c.zc_drm_preview_job) c_int {
    const self = castJob(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.started) return c.ZC_BUSY;
    self.cancel_requested = true;
    return c.ZC_OK;
}
pub fn closeJob(p: *c.zc_drm_preview_job) c_int {
    const self = castJob(p);
    if (!(self.owner.executor.?.finished(self.ticket) catch return c.ZC_STATE)) return c.ZC_BUSY;
    self.owner.live_jobs -= 1;
    releaseJob(self);
    return c.ZC_OK;
}
