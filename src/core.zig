//! Bounded request ownership shared by real and synthetic devices.
//! Callbacks only publish descriptors. Recycling and DMA sync run on consumers.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
comptime {
    _ = @import("capture_delay.zig").zc_default_capture_delay;
    _ = @import("capture_delay.zig").zc_capture_delay_arm;
    _ = @import("capture_delay.zig").zc_capture_delay_remaining;
    _ = @import("alignment.zig").zc_align_stream_geometry;
    _ = @import("tuning.zig");
    _ = @import("tuning_session.zig");
    _ = @import("hotplug.zig");
    _ = @import("recovery.zig");
}
const driver = if (options.libcamera) @import("real.zig") else @import("synthetic.zig");
const State = enum { idle, queued, ready, leased };
const Slot = struct { state: State = .idle, frame: c.zc_frame = std.mem.zeroes(c.zc_frame), metadata: c.zc_metadata = std.mem.zeroes(c.zc_metadata), access: @import("home/frame_access.zig").Gate = .{} };
const Gate = @import("home/completion_gate.zig").Gate;
const ControlState = @import("home/keyed_state.zig").State(c.zc_control, c.ZC_MAX_CONTROLS);
const Identity = @import("home/device_identity.zig").Identity(c.ZC_MAX_CAMERA_ID);
const CaptureFilter = @import("capture_filter.zig");
const colors = @import("color_policy.zig");
const Session = struct {
    identity: Identity = .{},
    desired: ControlState = .{},
    native_desired: ?@import("catalog.zig").wire.Writer = null,
    native_restored: bool = false,
    accepted_af_mode: ?f64 = null,
    control_revision: u64 = 0,
    control_base: u64 = 0,
    restored: bool = false,
    started_once: bool = false,
    writable: bool = false,
    orientation: c.zc_orientation_info = std.mem.zeroes(c.zc_orientation_info),
    latest: c.zc_metadata = std.mem.zeroes(c.zc_metadata),
    af: ?Gate = null,
    af_id: u64 = 0,
    af_command: ?u32 = null,
    pause_command: u32 = 2,
    af_restore_pause: u32 = 2,
    af_lock_valid: bool = false,
    operation: std.Thread.Mutex = .{},
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    running: bool = false,
    fatal: c_int = 0,
    removed: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    disconnect_event: u64 = 0,
    leases: @import("home/lease_pool.zig").Pool(c.ZC_MAX_BUFFERS, c.ZC_MAX_FRAME_REFERENCES) = .{},
    config: c.zc_config,
    processed: c.zc_processed_options = colors.defaults(),
    info: c.zc_info = std.mem.zeroes(c.zc_info),
    pipeline: c.zc_pipeline_info = std.mem.zeroes(c.zc_pipeline_info),
    device: ?*driver.Handle = null,
    slots: [c.ZC_MAX_BUFFERS]Slot = @splat(.{}),
    ready: [c.ZC_MAX_BUFFERS]u32 = undefined,
    head: usize = 0,
    count: usize = 0,
    stats: c.zc_stats = std.mem.zeroes(c.zc_stats),

    fn leaseIndex(self: *Session, token: u64) ?u32 {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.leases.resource(token);
    }
    fn ptr(self: *Session) *c.zc_camera {
        return @ptrCast(self);
    }
    fn pop(self: *Session) u32 {
        const i = self.ready[self.head];
        self.head = (self.head + 1) % c.ZC_MAX_BUFFERS;
        self.count -= 1;
        return i;
    }
    // operation held, mutex NOT held: synthetic queue may complete synchronously.
    fn queue(self: *Session, i: u32) c_int {
        self.mutex.lock();
        if (self.removed.load(.acquire)) {
            self.mutex.unlock();
            return c.ZC_DISCONNECTED;
        }
        self.slots[i].state = .queued;
        self.mutex.unlock();
        const rc = driver.queue(self.device.?, i);
        if (rc != 0) {
            self.mutex.lock();
            self.slots[i].state = .idle;
            if (!self.removed.load(.acquire)) self.fatal = rc;
            self.stats.errors += 1;
            self.changed.broadcast();
            self.mutex.unlock();
        }
        return rc;
    }
};
fn session(p: *c.zc_camera) *Session {
    return @ptrCast(@alignCast(p));
}
fn completed(ctx: ?*anyopaque, index: u32, frame: ?*const c.zc_frame, metadata: ?*const c.zc_metadata, status: c_int) callconv(.c) void {
    const self: *Session = @ptrCast(@alignCast(ctx.?));
    self.mutex.lock();
    defer self.mutex.unlock();
    // Out-of-band terminal notification is valid even before first start or
    // after stop. It never consumes an index or recycles an outstanding lease.
    if (status == c.ZC_DISCONNECTED) {
        if (!self.removed.swap(true, .acq_rel)) {
            self.disconnect_event = self.stats.completed;
            self.fatal = c.ZC_DISCONNECTED;
            self.running = false;
            self.af_lock_valid = false;
            self.stats.errors += 1;
            self.stats.dropped += self.count;
            self.count = 0;
            for (&self.slots) |*slot| if (slot.state == .ready) {
                slot.state = .idle;
            };
            self.changed.broadcast();
        }
        return;
    }
    if (self.removed.load(.acquire)) return;
    if (!self.running) return;
    if (index >= self.info.buffer_count or self.slots[index].state != .queued or status != 0 or frame == null or metadata == null) {
        self.fatal = if (status != 0) status else c.ZC_DEVICE;
        self.stats.errors += 1;
        self.changed.broadcast();
        return;
    }
    self.latest = metadata.?.*;
    self.latest.control_revision = std.math.add(u64, self.control_base, self.latest.control_revision) catch {
        self.fatal = c.ZC_DEVICE;
        self.stats.errors += 1;
        self.changed.broadcast();
        return;
    };
    const event = std.math.add(u64, self.stats.completed, 1) catch {
        self.fatal = c.ZC_STATE;
        self.stats.errors += 1;
        self.changed.broadcast();
        return;
    };
    self.latest.event_id = event;
    self.latest.struct_size = @sizeOf(c.zc_metadata);
    self.slots[index] = .{ .state = .ready, .frame = frame.?.*, .metadata = self.latest };
    if (self.af) |*af| {
        if (self.af_command) |command| {
            if (self.latest.valid & 32 != 0) {
                const expected: i32 = if (command == 2) 0 else 2;
                af.acknowledge(self.latest.control_revision, if (self.latest.af_pause_state == expected) true else null);
            }
        } else if (self.latest.valid & 1 != 0) {
            const state = self.latest.af_state;
            af.observe(self.latest.control_revision, state == 1, if (state == 2) true else if (state == 3 or state == 0) false else null);
        }
    }
    self.ready[(self.head + self.count) % c.ZC_MAX_BUFFERS] = index;
    self.count += 1;
    self.stats.completed = event;
    self.changed.broadcast();
}
pub export fn zc_abi_version() u32 {
    return c.ZC_ABI_VERSION;
}
pub export fn zc_tuning_session_open(data: ?[*]const u8, length: u64, backend: u32, out: *?*c.zc_tuning_session) c_int {
    out.* = null;
    if (backend > 1) return c.ZC_INVALID;
    if (backend == c.ZC_LIBCAMERA and !options.libcamera) return c.ZC_UNSUPPORTED;
    return @import("tuning_session.zig").create(data, length, backend, out);
}
pub export fn zc_default_config(out: *c.zc_config) void {
    out.* = std.mem.zeroes(c.zc_config);
    out.buffer_count = 4;
    out.policy = c.ZC_LATEST;
    out.lens_position = -1;
}
fn valid(cfg: *const c.zc_config) bool {
    return cfg.buffer_count >= 2 and cfg.buffer_count <= c.ZC_MAX_BUFFERS and
        cfg.width <= 16384 and cfg.height <= 16384 and ((cfg.width == 0) == (cfg.height == 0)) and
        cfg.policy <= c.ZC_LATEST and cfg.raw <= 1 and cfg.raw_format[31] == 0 and
        (cfg.raw != 0 or cfg.raw_format[0] == 0) and
        ((cfg.exposure_us == 0) == (cfg.analogue_gain == 0)) and cfg.exposure_us <= 1_000_000_000 and
        cfg.frame_duration_us <= 1_000_000_000 and std.math.isFinite(cfg.analogue_gain) and
        cfg.analogue_gain >= 0 and cfg.analogue_gain <= 64 and std.math.isFinite(cfg.lens_position) and
        cfg.lens_position >= -1 and cfg.lens_position <= 100;
}
pub export fn zc_default_capture_options(out: *c.zc_capture_options) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_capture_options), .role = c.ZC_STILL, .unpacked_raw = 0, .noise_reduction = std.math.maxInt(u32) };
}
pub export fn zc_open(cfg: *const c.zc_config, out: *?*c.zc_camera) c_int {
    var opts: c.zc_capture_options = undefined;
    zc_default_capture_options(&opts);
    return zc_open_ex(cfg, &opts, out);
}
pub export fn zc_open_ex(cfg: *const c.zc_config, opts: *const c.zc_capture_options, out: *?*c.zc_camera) c_int {
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&pipeline);
    pipeline.capture = opts.*;
    return zc_open_pipeline(cfg, &pipeline, out);
}
pub export fn zc_default_pipeline_options(out: *c.zc_pipeline_options) void {
    out.* = std.mem.zeroes(c.zc_pipeline_options);
    out.struct_size = @sizeOf(c.zc_pipeline_options);
    zc_default_capture_options(&out.capture);
}
pub export fn zc_open_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, out: *?*c.zc_camera) c_int {
    return zc_open_oriented_pipeline(cfg, pipeline, c.ZC_ROTATE0, 0, out);
}
pub export fn zc_open_id_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, id: ?[*]const u8, length: u32, out: *?*c.zc_camera) c_int {
    return zc_open_id_oriented_pipeline(cfg, pipeline, c.ZC_ROTATE0, 0, id, length, out);
}
pub export fn zc_orientation_from_transform(rotation: u32, hflip: u32, vflip: u32, transpose: u32, out: *u32) c_int {
    if (hflip > 1 or vflip > 1 or transpose > 1) return c.ZC_INVALID;
    var transform = @import("home/orientation.zig").Transform.fromRotation(rotation, hflip != 0, vflip != 0) catch return c.ZC_INVALID;
    if (transpose != 0) transform.transpose = !transform.transpose;
    out.* = transform.orientation();
    return c.ZC_OK;
}
pub export fn zc_get_orientation(camera: *c.zc_camera, out: *c.zc_orientation_info) c_int {
    out.* = session(camera).orientation;
    return c.ZC_OK;
}
pub export fn zc_open_oriented_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, orientation: u32, strict: u32, out: *?*c.zc_camera) c_int {
    return zc_open_formatted_pipeline(cfg, pipeline, c.ZC_RGB24, orientation, strict, out);
}
pub export fn zc_open_id_oriented_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, orientation: u32, strict: u32, id: ?[*]const u8, length: u32, out: *?*c.zc_camera) c_int {
    return zc_open_id_formatted_pipeline(cfg, pipeline, c.ZC_RGB24, orientation, strict, id, length, out);
}
pub export fn zc_open_formatted_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, main_format: u32, orientation: u32, strict: u32, out: *?*c.zc_camera) c_int {
    var processed = colors.defaults();
    processed.main_format = main_format;
    return zc_open_processed_pipeline(cfg, pipeline, &processed, orientation, strict, out);
}
pub export fn zc_open_id_formatted_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, main_format: u32, orientation: u32, strict: u32, id: ?[*]const u8, length: u32, out: *?*c.zc_camera) c_int {
    var processed = colors.defaults();
    processed.main_format = main_format;
    return zc_open_id_processed_pipeline(cfg, pipeline, &processed, orientation, strict, id, length, out);
}
pub export fn zc_open_processed_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, processed: *const c.zc_processed_options, orientation: u32, strict: u32, out: *?*c.zc_camera) c_int {
    return openPipeline(cfg, pipeline, processed, null, orientation, strict, out);
}
pub export fn zc_open_id_processed_pipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, processed: *const c.zc_processed_options, orientation: u32, strict: u32, id: ?[*]const u8, length: u32, out: *?*c.zc_camera) c_int {
    out.* = null;
    if (id == null or length == 0 or length > c.ZC_MAX_CAMERA_ID or cfg.camera_index != 0) return c.ZC_INVALID;
    const requested = Identity.init(id.?[0..length]) catch return c.ZC_INVALID;
    return openPipeline(cfg, pipeline, processed, requested.bytes(), orientation, strict, out);
}
pub export fn zc_check_camera_configuration(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, processed: *const c.zc_processed_options, orientation: u32, strict: u32) c_int {
    if (colors.zc_check_processed_options(processed, pipeline) != c.ZC_OK) return c.ZC_INVALID;
    const main_format = processed.main_format;
    if (orientation < 1 or orientation > 8 or strict > 1 or main_format > c.ZC_BGR48 or !@import("processed_format.zig").geometry(main_format, cfg.width, cfg.height)) return c.ZC_INVALID;
    const opts = &pipeline.capture;
    if (pipeline.struct_size != @sizeOf(c.zc_pipeline_options) or
        pipeline.sensor_width > 16384 or pipeline.sensor_height > 16384 or pipeline.sensor_bit_depth > 16 or
        ((pipeline.sensor_width == 0) != (pipeline.sensor_height == 0)) or ((pipeline.sensor_width == 0) != (pipeline.sensor_bit_depth == 0)) or
        pipeline.lores_width > 16384 or pipeline.lores_height > 16384 or
        ((pipeline.lores_width == 0) != (pipeline.lores_height == 0)) or pipeline.lores_format > c.ZC_BGR48 or
        !@import("processed_format.zig").geometry(pipeline.lores_format, pipeline.lores_width, pipeline.lores_height)) return c.ZC_INVALID;
    if (!valid(cfg) or opts.struct_size != @sizeOf(c.zc_capture_options) or opts.role > c.ZC_VIDEO or opts.unpacked_raw > 1 or
        (opts.unpacked_raw != 0 and cfg.raw == 0) or (opts.noise_reduction > 4 and opts.noise_reduction != std.math.maxInt(u32))) return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_align_camera_configuration(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, processed: *const c.zc_processed_options, profile: u32, optimal: u32, out_config: *c.zc_config, out_pipeline: *c.zc_pipeline_options) c_int {
    if (colors.zc_check_processed_options(processed, pipeline) != c.ZC_OK) return c.ZC_INVALID;
    const selected = @import("alignment.zig").policy(profile, optimal) catch return c.ZC_INVALID;
    var config = cfg.*;
    var pipe = pipeline.*;
    const color = processed.*;
    if (config.width != 0 or config.height != 0) {
        const plan = selected.aligned(config.width, config.height, @import("processed_format.zig").alignment(color.main_format)) catch return c.ZC_INVALID;
        config.width = plan.width;
        config.height = plan.height;
    }
    if (pipe.lores_width != 0 or pipe.lores_height != 0) {
        const plan = selected.aligned(pipe.lores_width, pipe.lores_height, @import("processed_format.zig").alignment(pipe.lores_format)) catch return c.ZC_INVALID;
        pipe.lores_width = plan.width;
        pipe.lores_height = plan.height;
    }
    const rc = zc_check_camera_configuration(&config, &pipe, &color, c.ZC_ROTATE0, 0);
    if (rc != c.ZC_OK) return rc;
    out_config.* = config;
    out_pipeline.* = pipe;
    return c.ZC_OK;
}
fn openPipeline(cfg: *const c.zc_config, pipeline: *const c.zc_pipeline_options, processed: *const c.zc_processed_options, id: ?[]const u8, orientation: u32, strict: u32, out: *?*c.zc_camera) c_int {
    out.* = null;
    if (zc_check_camera_configuration(cfg, pipeline, processed, orientation, strict) != c.ZC_OK) return c.ZC_INVALID;
    const self = std.heap.c_allocator.create(Session) catch return c.ZC_NOMEM;
    self.* = .{ .config = cfg.*, .processed = processed.* };
    var actual: u32 = 0;
    const rc = if (id) |selected| driver.openId(cfg, pipeline, processed, orientation, strict != 0, &actual, selected, self, completed, &self.device, &self.info, &self.pipeline) else driver.open(cfg, pipeline, processed, orientation, strict != 0, &actual, self, completed, &self.device, &self.info, &self.pipeline);
    if (rc != 0) {
        const disconnected = self.removed.load(.acquire);
        std.heap.c_allocator.destroy(self);
        return if (disconnected) c.ZC_DISCONNECTED else rc;
    }
    if (actual < 1 or actual > 8 or (strict != 0 and actual != orientation)) {
        driver.close(self.device.?);
        std.heap.c_allocator.destroy(self);
        return c.ZC_UNSUPPORTED;
    }
    self.orientation = .{ .struct_size = @sizeOf(c.zc_orientation_info), .requested = orientation, .actual = actual, .adjusted = @intFromBool(actual != orientation) };
    if (self.info.buffer_count < 2 or self.info.buffer_count > c.ZC_MAX_BUFFERS) {
        driver.close(self.device.?);
        std.heap.c_allocator.destroy(self);
        return c.ZC_DEVICE;
    }
    if (processed.color_space.present != 0) {
        for ([_]u32{ c.ZC_MAIN, c.ZC_LORES }) |which| {
            if (which == c.ZC_LORES and self.pipeline.lores.plane_count == 0) continue;
            var negotiation: c.zc_color_negotiation = undefined;
            const checked = colorNegotiation(self, which, true, &negotiation);
            if (checked != c.ZC_OK) {
                driver.close(self.device.?);
                std.heap.c_allocator.destroy(self);
                return checked;
            }
        }
    }
    var length: u64 = 0;
    var identity_rc = driver.cameraId(self.device.?, null, 0, &length);
    if (identity_rc == 0 and (length == 0 or length > c.ZC_MAX_CAMERA_ID)) identity_rc = c.ZC_DEVICE;
    if (identity_rc == 0) identity_rc = driver.cameraId(self.device.?, &self.identity.storage, c.ZC_MAX_CAMERA_ID, &length);
    if (identity_rc == 0) {
        self.identity = Identity.init(self.identity.storage[0..@intCast(length)]) catch {
            driver.close(self.device.?);
            std.heap.c_allocator.destroy(self);
            return c.ZC_DEVICE;
        };
        if (id) |expected| if (!self.identity.matches(expected)) {
            identity_rc = c.ZC_DEVICE;
        };
    }
    if (identity_rc != 0) {
        driver.close(self.device.?);
        std.heap.c_allocator.destroy(self);
        return identity_rc;
    }
    if (self.removed.load(.acquire)) {
        driver.close(self.device.?);
        std.heap.c_allocator.destroy(self);
        return c.ZC_DISCONNECTED;
    }
    out.* = self.ptr();
    return c.ZC_OK;
}
fn colorNegotiation(self: *Session, which: u32, enforce: bool, out: *c.zc_color_negotiation) c_int {
    if (which != c.ZC_MAIN and which != c.ZC_LORES) return if (which == c.ZC_RAW) c.ZC_UNSUPPORTED else c.ZC_INVALID;
    const stream = if (which == c.ZC_MAIN) self.info.main else self.pipeline.lores;
    if (stream.plane_count == 0) return c.ZC_UNSUPPORTED;
    const name = std.mem.sliceTo(&stream.format, 0);
    const format = @import("processed_format.zig").code(name) orelse return c.ZC_UNSUPPORTED;
    var actual: c.zc_color_space = undefined;
    const rc = driver.colorSpace(self.device.?, which, &actual);
    if (rc != c.ZC_OK) return rc;
    return colors.negotiation(self.processed, actual, format, enforce, out);
}
pub export fn zc_get_color_negotiation(camera: *c.zc_camera, which: u32, out: *c.zc_color_negotiation) c_int {
    const self = session(camera);
    self.operation.lock();
    defer self.operation.unlock();
    return colorNegotiation(self, which, false, out);
}
pub export fn zc_get_pipeline_info(p: *c.zc_camera, out: *c.zc_pipeline_info) c_int {
    out.* = session(p).pipeline;
    return c.ZC_OK;
}
test "oriented pipeline admission preserves ABI and rejects invalid values atomically" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 18;
    cfg.height = 10;
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&pipeline);
    var camera: ?*c.zc_camera = undefined;
    for ([_]u32{ 0, 9, std.math.maxInt(u32) }) |value| {
        try std.testing.expectEqual(c.ZC_INVALID, zc_open_oriented_pipeline(&cfg, &pipeline, value, 0, &camera));
        try std.testing.expectEqual(null, camera);
    }
    try std.testing.expectEqual(c.ZC_INVALID, zc_open_oriented_pipeline(&cfg, &pipeline, 1, 2, &camera));
    try std.testing.expectEqual(null, camera);
    var encoded: u32 = 77;
    try std.testing.expectEqual(c.ZC_INVALID, zc_orientation_from_transform(45, 0, 0, 0, &encoded));
    try std.testing.expectEqual(c.ZC_INVALID, zc_orientation_from_transform(0, 2, 0, 0, &encoded));
    try std.testing.expectEqual(@as(u32, 77), encoded);
    try std.testing.expectEqual(c.ZC_OK, zc_orientation_from_transform(90, 0, 0, 0, &encoded));
    try std.testing.expectEqual(@as(u32, c.ZC_ROTATE90), encoded);
    try std.testing.expectEqual(c.ZC_OK, zc_orientation_from_transform(90, 1, 0, 0, &encoded));
    try std.testing.expectEqual(@as(u32, c.ZC_ROTATE90_MIRROR), encoded);
}
test "all eight orientations expose transformed RGB samples and CFA descriptors" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 18;
    cfg.height = 10;
    cfg.raw = 1;
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&pipeline);
    const corners = [8][2]u8{ .{ 0, 0 }, .{ 17, 0 }, .{ 17, 9 }, .{ 0, 9 }, .{ 0, 0 }, .{ 9, 0 }, .{ 9, 17 }, .{ 0, 17 } };
    const patterns = [8][]const u8{ "SRGGB12", "SGRBG12", "SBGGR12", "SGBRG12", "SRGGB12", "SGBRG12", "SBGGR12", "SGRBG12" };
    for (1..9) |value| {
        var camera: ?*c.zc_camera = null;
        try std.testing.expectEqual(c.ZC_OK, zc_open_oriented_pipeline(&cfg, &pipeline, @intCast(value), 1, &camera));
        defer _ = zc_close(camera.?);
        var negotiated: c.zc_orientation_info = undefined;
        try std.testing.expectEqual(c.ZC_OK, zc_get_orientation(camera.?, &negotiated));
        try std.testing.expectEqual(@as(u32, 16), negotiated.struct_size);
        try std.testing.expectEqual(@as(u32, @intCast(value)), negotiated.actual);
        try std.testing.expectEqual(@as(u32, 0), negotiated.adjusted);
        try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
        var frame: c.zc_frame = undefined;
        try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
        try std.testing.expectEqualSlices(u8, &corners[value - 1], frame.main.planes[0].data[0..2]);
        try std.testing.expectEqualStrings(patterns[value - 1], std.mem.sliceTo(&frame.raw.format, 0));
        try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
        try std.testing.expectEqual(c.ZC_OK, zc_stop(camera.?));
    }
}
pub export fn zc_get_sensor_modes(p: *c.zc_camera, modes: ?[*]c.zc_sensor_mode, capacity: u32, count: *u32) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return driver.sensorModes(self.device.?, modes, capacity, count);
}
pub export fn zc_get_stream(p: *c.zc_camera, token: u64, stream: u32, out: *c.zc_stream) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const i = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[i].access.writer) return c.ZC_BUSY;
    return streamLocked(self, i, stream, out);
}
pub export fn zc_copy_frame_streams(p: *c.zc_camera, token: u64, streams: ?[*]const u32, count: u32, layouts: ?[*]c.zc_packed_stream, layout_capacity: u32, data: ?[*]u8, capacity: u64, size: *u64, metadata: *c.zc_metadata) c_int {
    size.* = 0;
    if (count == 0 or count > 3 or streams == null or layouts == null or layout_capacity < count or capacity > std.math.maxInt(usize) or (data == null and capacity != 0)) return c.ZC_INVALID;
    var ids: [3]u32 = undefined;
    var seen: u32 = 0;
    for (0..count) |i| {
        const id = streams.?[i];
        if (id > c.ZC_LORES) return c.ZC_INVALID;
        const bit = @as(u32, 1) << @as(u5, @intCast(id));
        if (seen & bit != 0) return c.ZC_INVALID;
        seen |= bit;
        ids[i] = id;
    }
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    const pack = @import("home/plane_pack.zig");
    var planes: [9]pack.Plane = undefined;
    var plane_count: usize = 0;
    var descriptions: [3]c.zc_packed_stream = undefined;
    var total: usize = 0;
    for (ids[0..count], 0..) |id, i| {
        var source: c.zc_stream = undefined;
        const rc = streamLocked(self, index, id, &source);
        if (rc != 0) return rc;
        var selected: [3]pack.Plane = undefined;
        const selected_count = @import("media.zig").streamPlanes(&source, &selected) catch |err| return if (err == error.UnsupportedFormat) c.ZC_UNSUPPORTED else c.ZC_INVALID;
        const length = pack.packedSize(selected[0..selected_count]) catch return c.ZC_INVALID;
        descriptions[i] = .{ .stream = id, .width = source.width, .height = source.height, .row_bytes = @intCast(selected[0].row_bytes), .format = source.format, .offset = total, .length = length };
        total = std.math.add(usize, total, length) catch return c.ZC_INVALID;
        @memcpy(planes[plane_count..][0..selected_count], selected[0..selected_count]);
        plane_count += selected_count;
    }
    if (data) |out| {
        if (capacity < total) return c.ZC_INVALID;
        _ = pack.pack(planes[0..plane_count], out[0..@intCast(capacity)]) catch return c.ZC_INVALID;
    }
    @memcpy(layouts.?[0..count], descriptions[0..count]);
    metadata.* = self.slots[index].metadata;
    size.* = total;
    return c.ZC_OK;
}
pub export fn zc_get_stream_color_space(p: *c.zc_camera, stream: u32, out: *c.zc_color_space) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return driver.colorSpace(self.device.?, stream, out);
}
pub export fn zc_copy_stream_rgb(p: *c.zc_camera, token: u64, stream: u32, out: [*c]u8, length: u64) c_int {
    if (stream > c.ZC_LORES or out == null or length > std.math.maxInt(usize)) return c.ZC_INVALID;
    if (stream == c.ZC_RAW) return c.ZC_UNSUPPORTED;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    var selected: c.zc_stream = undefined;
    var space: c.zc_color_space = undefined;
    var rc = streamLocked(self, index, stream, &selected);
    if (rc != 0) return rc;
    rc = driver.colorSpace(self.device.?, stream, &space);
    if (rc != 0) return rc;
    @import("stream_rgb.zig").copy(selected, space, out[0..@intCast(length)]) catch |err| return still.status(err);
    return c.ZC_OK;
}
pub export fn zc_copy_stream_rgb16(p: *c.zc_camera, token: u64, stream: u32, out: [*c]u8, length: u64) c_int {
    if (stream > c.ZC_LORES or out == null or length > std.math.maxInt(usize)) return c.ZC_INVALID;
    if (stream == c.ZC_RAW) return c.ZC_UNSUPPORTED;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    var selected: c.zc_stream = undefined;
    const rc = streamLocked(self, index, stream, &selected);
    if (rc != 0) return rc;
    @import("stream_rgb.zig").copy16(selected, out[0..@intCast(length)]) catch |err| return still.status(err);
    return c.ZC_OK;
}
pub export fn zc_copy_raw16(p: *c.zc_camera, token: u64, out: [*c]u8, length: u64) c_int {
    if (out == null or length > std.math.maxInt(usize)) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    const selected = self.slots[index].frame.raw;
    if (selected.plane_count != 1) return c.ZC_UNSUPPORTED;
    const plane = selected.planes[0];
    if (plane.data == null or plane.bytes_used > plane.length or plane.bytes_used > std.math.maxInt(usize)) return c.ZC_INVALID;
    const format = @import("raw.zig").Format.parse(std.mem.sliceTo(&selected.format, 0)) catch |err| return still.status(err);
    const view = @import("raw.zig").View.init(plane.data[0..@intCast(plane.bytes_used)], selected.width, selected.height, selected.stride, format) catch |err| return still.status(err);
    view.copy16(out[0..@intCast(length)], @as(usize, selected.width) * 2) catch |err| return still.status(err);
    return c.ZC_OK;
}
fn streamLocked(self: *Session, i: u32, stream: u32, out: *c.zc_stream) c_int {
    if (stream == c.ZC_MAIN) out.* = self.slots[i].frame.main else if (stream == c.ZC_RAW) out.* = self.slots[i].frame.raw else if (stream == c.ZC_LORES) return driver.lores(self.device.?, i, out) else return c.ZC_INVALID;
    return if (out.plane_count == 0) c.ZC_UNSUPPORTED else c.ZC_OK;
}
pub export fn zc_get_info(p: *c.zc_camera, out: *c.zc_info) c_int {
    out.* = session(p).info;
    return c.ZC_OK;
}
pub export fn zc_start(p: *c.zc_camera) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    if (self.removed.load(.acquire)) {
        self.mutex.unlock();
        return c.ZC_DISCONNECTED;
    }
    if (self.running or self.stats.leased != 0) {
        self.mutex.unlock();
        return c.ZC_BUSY;
    }
    self.fatal = 0;
    self.latest = std.mem.zeroes(c.zc_metadata);
    self.head = 0;
    self.count = 0;
    for (&self.slots) |*slot| slot.state = .idle;
    self.mutex.unlock();
    const rc = driver.start(self.device.?);
    if (rc != 0) return rc;
    self.mutex.lock();
    if (self.removed.load(.acquire)) {
        self.mutex.unlock();
        _ = driver.stop(self.device.?);
        return c.ZC_DISCONNECTED;
    }
    self.running = true;
    self.started_once = true;
    self.mutex.unlock();
    for (0..self.info.buffer_count) |i| {
        const queued = self.queue(@intCast(i));
        if (queued != 0) {
            _ = stopLocked(self);
            return queued;
        }
    }
    return c.ZC_OK;
}
pub export fn zc_acquire(p: *c.zc_camera, timeout_ms: u32, out: *c.zc_frame) c_int {
    const self = session(p);
    var timer = std.time.Timer.start() catch return c.ZC_IO;
    const wait_ns = @as(u64, timeout_ms) * std.time.ns_per_ms;
    while (true) {
        self.mutex.lock();
        while (self.running and self.fatal == 0 and self.count == 0) {
            const elapsed = timer.read();
            if (elapsed >= wait_ns) {
                self.mutex.unlock();
                return c.ZC_TIMEOUT;
            }
            self.changed.timedWait(&self.mutex, wait_ns - elapsed) catch {};
        }
        const status = if (self.fatal != 0) self.fatal else if (!self.running) c.ZC_STATE else 0;
        self.mutex.unlock();
        if (status != 0) return status;

        self.operation.lock();
        defer self.operation.unlock();
        self.mutex.lock();
        if (!self.running or self.fatal != 0) {
            const rc = if (self.fatal != 0) self.fatal else c.ZC_STATE;
            self.mutex.unlock();
            return rc;
        }
        if (self.count == 0) {
            self.mutex.unlock();
            continue;
        }
        if (self.leases.used == c.ZC_MAX_FRAME_REFERENCES or self.leases.issued == @TypeOf(self.leases).max_sequence) {
            const rc = if (self.leases.used == c.ZC_MAX_FRAME_REFERENCES) c.ZC_BUSY else c.ZC_STATE;
            self.mutex.unlock();
            return rc;
        }
        var dropped: [c.ZC_MAX_BUFFERS]u32 = undefined;
        var num_dropped: usize = 0;
        if (self.config.policy == c.ZC_LATEST) {
            while (self.count > 1) {
                const i = self.pop();
                self.slots[i].state = .idle;
                dropped[num_dropped] = i;
                num_dropped += 1;
            }
        }
        const index = self.pop();
        const slot = &self.slots[index];
        const token = self.leases.acquire(index) catch unreachable;
        slot.state = .leased;
        slot.frame.token = token;
        self.stats.leased += 1;
        self.stats.dropped += num_dropped;
        self.mutex.unlock();

        for (dropped[0..num_dropped]) |i| {
            if (self.queue(i) != 0) break;
        }
        const rc = driver.sync(self.device.?, index, true);
        if (rc != 0) {
            self.mutex.lock();
            slot.state = .idle;
            _ = self.leases.release(token) catch unreachable;
            self.stats.leased -= 1;
            self.stats.errors += 1;
            if (!self.removed.load(.acquire)) self.fatal = rc;
            self.changed.broadcast();
            self.mutex.unlock();
            return rc;
        }
        self.mutex.lock();
        if (self.removed.load(.acquire)) {
            self.mutex.unlock();
            const cleanup = releaseLocked(self, token);
            return if (cleanup != c.ZC_OK) cleanup else c.ZC_DISCONNECTED;
        }
        self.stats.delivered += 1;
        out.* = slot.frame;
        self.mutex.unlock();
        return c.ZC_OK;
    }
}
pub export fn zc_capture_filter_accept(p: *c.zc_camera, token: u64, filter: *c.zc_capture_filter) c_int {
    if (!CaptureFilter.valid(filter)) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    var ready: ?bool = null;
    if (filter.flags & c.ZC_CAPTURE_SYNC_READY != 0 and filter.observed & 2 == 0) {
        var state: c.zc_frame_sync_state = undefined;
        const rc = frameSyncState(self, index, &state);
        if (rc != c.ZC_OK) return rc;
        if (state.valid & 1 != 0) ready = state.ready != 0;
    }
    return CaptureFilter.observeReady(filter, &self.slots[index].metadata, ready);
}
fn frameSyncState(self: *Session, index: u32, out: *c.zc_frame_sync_state) c_int {
    const rc = driver.frameSyncState(self.device.?, index, out);
    if (rc != c.ZC_OK) return rc;
    if (out.struct_size != @sizeOf(c.zc_frame_sync_state) or out.valid & ~@as(u32, 3) != 0 or out.ready > 1 or out.reserved != 0 or
        (out.valid & 1 == 0 and out.ready != 0) or (out.valid & 2 == 0 and out.timer_us != 0)) return c.ZC_DEVICE;
    return c.ZC_OK;
}
pub export fn zc_get_frame_sync_state(p: *c.zc_camera, token: u64, out: *c.zc_frame_sync_state) c_int {
    out.* = std.mem.zeroes(c.zc_frame_sync_state);
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    var state: c.zc_frame_sync_state = undefined;
    const rc = frameSyncState(self, index, &state);
    if (rc != c.ZC_OK) return rc;
    out.* = state;
    return c.ZC_OK;
}
pub export fn zc_acquire_and_stop(p: *c.zc_camera, timeout_ms: u32, out: *c.zc_frame) c_int {
    out.* = std.mem.zeroes(c.zc_frame);
    var candidate: c.zc_frame = undefined;
    const rc = zc_acquire(p, timeout_ms, &candidate);
    if (rc != 0) return rc;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const stopped = stopLocked(self);
    if (stopped != 0) {
        const cleanup = releaseLocked(self, candidate.token);
        return if (cleanup != 0) cleanup else stopped;
    }
    out.* = candidate;
    return c.ZC_OK;
}
pub export fn zc_acquire_filtered(p: *c.zc_camera, filter: *c.zc_capture_filter, timeout_ms: u32, out: *c.zc_frame) c_int {
    if (!CaptureFilter.valid(filter)) return c.ZC_INVALID;
    var timer = std.time.Timer.start() catch return c.ZC_IO;
    while (true) {
        const elapsed = timer.read() / std.time.ns_per_ms;
        const remaining: u32 = if (elapsed >= timeout_ms) 0 else timeout_ms - @as(u32, @intCast(elapsed));
        var frame: c.zc_frame = undefined;
        const acquired = zc_acquire(p, remaining, &frame);
        if (acquired != 0) return acquired;
        const rc = zc_capture_filter_accept(p, frame.token, filter);
        if (rc == c.ZC_OK) {
            out.* = frame;
            return c.ZC_OK;
        }
        const released = zc_release(p, frame.token);
        if (released != 0) return released;
        if (rc != c.ZC_TIMEOUT) return rc;
        if (timer.read() / std.time.ns_per_ms >= timeout_ms) return c.ZC_TIMEOUT;
    }
}
pub export fn zc_retain(p: *c.zc_camera, token: u64, out: *c.zc_frame) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    defer self.mutex.unlock();
    const index = self.leases.resource(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    // Reserve primary reference capacity for every currently unleased buffer.
    const retained = self.leases.retainReserved(token, self.info.buffer_count - self.stats.leased) catch |err| return if (err == error.SequenceExhausted) c.ZC_STATE else c.ZC_BUSY;
    out.* = self.slots[index].frame;
    out.token = retained;
    return c.ZC_OK;
}
pub export fn zc_frame_references(p: *c.zc_camera, token: u64, out: *u32) c_int {
    const self = session(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = self.leases.count(token) catch return c.ZC_STALE;
    return c.ZC_OK;
}
pub export fn zc_release(p: *c.zc_camera, token: u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return releaseLocked(self, token);
}
fn releaseLocked(self: *Session, token: u64) c_int {
    self.mutex.lock();
    const index = self.leases.resource(token) orelse {
        self.mutex.unlock();
        return c.ZC_STALE;
    };
    if ((self.leases.count(token) catch unreachable) == 1 and (self.slots[index].access.writer or self.slots[index].access.readers != 0)) {
        self.mutex.unlock();
        return c.ZC_BUSY;
    }
    const final = self.leases.release(token) catch unreachable;
    if (!final) {
        self.mutex.unlock();
        return c.ZC_OK;
    }
    const slot = &self.slots[index];
    self.mutex.unlock();
    const rc = driver.sync(self.device.?, index, false);
    self.mutex.lock();
    slot.state = .idle;
    self.stats.leased -= 1;
    const running = self.running and self.fatal == 0;
    if (rc != 0) {
        if (!self.removed.load(.acquire)) self.fatal = rc;
        self.stats.errors += 1;
        self.changed.broadcast();
    }
    self.mutex.unlock();
    if (rc != 0) return rc;
    return if (running) self.queue(index) else c.ZC_OK;
}
const FrameMap = struct { owner: *Session, token: u64, index: u32, write: bool, stream: c.zc_stream };
pub export fn zc_enable_writable(p: *c.zc_camera) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    if (self.started_once) return c.ZC_STATE;
    if (self.stats.leased != 0) return c.ZC_BUSY;
    if (self.writable) return c.ZC_OK;
    const rc = driver.enableWritable(self.device.?);
    if (rc == c.ZC_OK) self.writable = true;
    return rc;
}
pub export fn zc_frame_readable(p: *c.zc_camera, token: u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    return if (self.slots[index].access.writer) c.ZC_BUSY else c.ZC_OK;
}
pub export fn zc_copy_frame_rgb(p: *c.zc_camera, token: u64, out: [*]u8, length: u64) c_int {
    return zc_copy_stream_rgb(p, token, c.ZC_MAIN, out, length);
}
/// Internal synchronous read scope. The caller keeps its lease through finish;
/// the access gate prevents final release/writes without allocating another token.
/// Do not copy or retain this scope beyond the consuming native call.
pub const ProcessedRead = struct {
    owner: ?*Session,
    index: u32,
    stream: c.zc_stream,
    color: c.zc_color_space,
    pub fn finish(self: *ProcessedRead) c_int {
        const owner = self.owner orelse return c.ZC_STATE;
        owner.operation.lock();
        defer owner.operation.unlock();
        const next = owner.slots[self.index].access.ending(false) catch return c.ZC_STALE;
        owner.slots[self.index].access = next;
        self.owner = null;
        return c.ZC_OK;
    }
};
pub fn beginProcessedRead(p: *c.zc_camera, token: u64, which: u32, out: *ProcessedRead) c_int {
    if (which != c.ZC_MAIN and which != c.ZC_LORES) return c.ZC_UNSUPPORTED;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    const next = self.slots[index].access.beginning(false, self.leases.count(token) catch unreachable) catch return c.ZC_BUSY;
    var descriptor: c.zc_stream = undefined;
    var color: c.zc_color_space = undefined;
    const rc = streamLocked(self, index, which, &descriptor);
    if (rc != c.ZC_OK) return rc;
    const colored = driver.colorSpace(self.device.?, which, &color);
    if (colored != c.ZC_OK) return colored;
    self.slots[index].access = next;
    out.* = .{ .owner = self, .index = index, .stream = descriptor, .color = color };
    return c.ZC_OK;
}
pub export fn zc_frame_map_open(p: *c.zc_camera, token: u64, stream: u32, write: u32, out: *?*c.zc_frame_map) c_int {
    out.* = null;
    if (write > 1) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (write != 0 and !self.writable) return c.ZC_UNSUPPORTED;
    const next = self.slots[index].access.beginning(write != 0, self.leases.count(token) catch unreachable) catch return c.ZC_BUSY;
    var descriptor: c.zc_stream = undefined;
    const rc = streamLocked(self, index, stream, &descriptor);
    if (rc != c.ZC_OK) return rc;
    for (descriptor.planes[0..descriptor.plane_count]) |plane| {
        if (plane.data == null or plane.length == 0 or plane.bytes_used > plane.length) return c.ZC_INVALID;
    }
    const map = std.heap.c_allocator.create(FrameMap) catch return c.ZC_NOMEM;
    self.mutex.lock();
    const retained = self.leases.retainReserved(token, self.info.buffer_count - self.stats.leased) catch |err| {
        self.mutex.unlock();
        std.heap.c_allocator.destroy(map);
        return if (err == error.SequenceExhausted) c.ZC_STATE else c.ZC_BUSY;
    };
    self.slots[index].access = next;
    self.mutex.unlock();
    map.* = .{ .owner = self, .token = retained, .index = index, .write = write != 0, .stream = descriptor };
    out.* = @ptrCast(map);
    return c.ZC_OK;
}
pub export fn zc_frame_map_stream(p: *const c.zc_frame_map, out: *c.zc_stream) c_int {
    const map: *const FrameMap = @ptrCast(@alignCast(p));
    out.* = map.stream;
    return c.ZC_OK;
}
pub export fn zc_frame_map_close(p: ?*c.zc_frame_map) c_int {
    const map: *FrameMap = @ptrCast(@alignCast(p orelse return c.ZC_OK));
    const self = map.owner;
    self.operation.lock();
    defer self.operation.unlock();
    defer std.heap.c_allocator.destroy(map);
    self.slots[map.index].access = self.slots[map.index].access.ending(map.write) catch return c.ZC_STALE;
    return releaseLocked(self, map.token);
}
fn stopLocked(self: *Session) c_int {
    self.mutex.lock();
    self.running = false;
    self.af_lock_valid = false;
    self.pause_command = 2;
    self.accepted_af_mode = null;
    for (self.desired.values()) |value| if (value.id == c.ZC_AF_MODE) {
        self.accepted_af_mode = value.values[0];
    };
    if (self.af) |*af| af.stop();
    self.changed.broadcast();
    self.mutex.unlock();
    // No queue mutex held: stop waits for completion callbacks to finish.
    const rc = driver.stop(self.device.?);
    self.mutex.lock();
    self.count = 0;
    for (&self.slots) |*slot| {
        if (slot.state != .leased) slot.state = .idle;
    }
    self.mutex.unlock();
    return rc;
}
pub export fn zc_stop(p: *c.zc_camera) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return stopLocked(self);
}
fn deviceStateLocked(self: *Session, out: *c.zc_device_state) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_device_state), .connected = @intFromBool(!self.removed.load(.acquire)), .running = @intFromBool(self.running), .leased = self.stats.leased, .status = self.fatal, .ready = @intCast(self.count), .disconnect_event = self.disconnect_event };
}
pub export fn zc_get_device_state(p: *c.zc_camera, out: *c.zc_device_state) c_int {
    const self = session(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    deviceStateLocked(self, out);
    return c.ZC_OK;
}
test "disconnect is terminal before start and completed leases survive loss without requeue" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.buffer_count = 2;
    cfg.policy = c.ZC_FIFO;
    var p: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open(&cfg, &p));
    try t.expectEqual(c.ZC_OK, zc_simulate_disconnect(p.?));
    try t.expectEqual(c.ZC_DISCONNECTED, zc_start(p.?));
    try t.expectEqual(c.ZC_OK, zc_stop(p.?));
    try t.expectEqual(c.ZC_DISCONNECTED, zc_start(p.?));
    try t.expectEqual(c.ZC_OK, zc_close(p.?));
    try t.expectEqual(c.ZC_OK, zc_open(&cfg, &p));
    defer _ = zc_close(p.?);
    try t.expectEqual(c.ZC_OK, zc_start(p.?));
    var frame: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &frame));
    var retained: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_retain(p.?, frame.token, &retained));
    const event = session(p.?).stats.completed;
    try t.expectEqual(c.ZC_OK, zc_simulate_disconnect(p.?));
    try t.expectEqual(c.ZC_OK, zc_simulate_disconnect(p.?));
    var state: c.zc_device_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_get_device_state(p.?, &state));
    try t.expectEqual(@as(u32, 0), state.connected);
    try t.expectEqual(@as(u32, 1), state.leased);
    try t.expectEqual(event, state.disconnect_event);
    try t.expectEqual(@as(u64, 1), session(p.?).stats.errors);
    var metadata: c.zc_metadata = undefined;
    try t.expectEqual(c.ZC_OK, zc_get_frame_metadata(p.?, frame.token, &metadata));
    try t.expectEqual(c.ZC_OK, zc_frame_readable(p.?, frame.token));
    try t.expectEqual(c.ZC_DISCONNECTED, zc_acquire(p.?, 5000, &frame));
    try t.expectEqual(c.ZC_OK, zc_release(p.?, frame.token));
    try t.expectEqual(c.ZC_BUSY, zc_close(p.?));
    try t.expectEqual(c.ZC_OK, zc_release(p.?, retained.token));
    try t.expectEqual(event, session(p.?).stats.completed);
    try t.expectEqual(c.ZC_DISCONNECTED, zc_start(p.?));
}
const DisconnectWait = struct {
    camera: *c.zc_camera,
    kind: u32,
    ready: std.Thread.ResetEvent = .{},
    result: c_int = 123,
    fn run(self: *DisconnectWait) void {
        self.ready.set();
        var frame: c.zc_frame = undefined;
        var metadata: c.zc_metadata = undefined;
        var state: c.zc_device_state = undefined;
        self.result = switch (self.kind) {
            0 => zc_acquire(self.camera, 5000, &frame),
            1 => zc_wait_metadata(self.camera, std.math.maxInt(u64), 5000, &metadata),
            else => zc_wait_disconnected(self.camera, 5000, &state),
        };
    }
};
test "disconnect wakes capture metadata and lifecycle waits without releasing their frame owners" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.buffer_count = 2;
    cfg.policy = c.ZC_FIFO;
    var p: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open(&cfg, &p));
    defer _ = zc_close(p.?);
    try t.expectEqual(c.ZC_OK, zc_start(p.?));
    var a: c.zc_frame = undefined;
    var b: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &a));
    try t.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &b));
    var waits = [_]DisconnectWait{ .{ .camera = p.?, .kind = 0 }, .{ .camera = p.?, .kind = 1 }, .{ .camera = p.?, .kind = 2 } };
    var threads: [3]std.Thread = undefined;
    for (&waits, 0..) |*wait, i| threads[i] = try std.Thread.spawn(.{}, DisconnectWait.run, .{wait});
    for (&waits) |*wait| wait.ready.wait();
    try t.expectEqual(c.ZC_OK, zc_simulate_disconnect(p.?));
    for (threads) |thread| thread.join();
    try t.expectEqual(c.ZC_DISCONNECTED, waits[0].result);
    try t.expectEqual(c.ZC_DISCONNECTED, waits[1].result);
    try t.expectEqual(c.ZC_OK, waits[2].result);
    try t.expectEqual(@as(u32, 2), session(p.?).stats.leased);
    try t.expectEqual(c.ZC_OK, zc_release(p.?, a.token));
    try t.expectEqual(c.ZC_OK, zc_release(p.?, b.token));
}
test "loss keeps fence errors observable and mapped access retains the last owner" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var p: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open(&cfg, &p));
    defer _ = zc_close(p.?);
    try t.expectEqual(c.ZC_OK, zc_start(p.?));
    var frame: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &frame));
    var map: ?*c.zc_frame_map = null;
    try t.expectEqual(c.ZC_OK, zc_frame_map_open(p.?, frame.token, c.ZC_MAIN, 0, &map));
    try t.expectEqual(c.ZC_OK, zc_simulate_disconnect(p.?));
    try t.expectEqual(c.ZC_OK, zc_release(p.?, frame.token));
    try t.expectEqual(c.ZC_BUSY, zc_close(p.?));
    session(p.?).device.?.fail_sync_end = true;
    try t.expectEqual(c.ZC_IO, zc_frame_map_close(map));
    try t.expectEqual(@as(u32, 0), session(p.?).stats.leased);
    var state: c.zc_device_state = undefined;
    _ = zc_get_device_state(p.?, &state);
    try t.expectEqual(c.ZC_DISCONNECTED, state.status);
    try t.expectEqual(c.ZC_DISCONNECTED, zc_start(p.?));
}
test "removal during the begin fence never publishes a candidate and still attempts its end fence" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    for ([_]bool{ false, true }) |fail_end| {
        var cfg: c.zc_config = undefined;
        zc_default_config(&cfg);
        cfg.width = 16;
        cfg.height = 16;
        var camera: ?*c.zc_camera = null;
        try t.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
        defer _ = zc_close(camera.?);
        try t.expectEqual(c.ZC_OK, zc_start(camera.?));
        const device = session(camera.?).device.?;
        device.remove_on_sync_begin = true;
        device.fail_sync_end = fail_end;
        var output: c.zc_frame = undefined;
        @memset(std.mem.asBytes(&output), 0x5a);
        const before = output;
        try t.expectEqual(if (fail_end) @as(c_int, c.ZC_IO) else @as(c_int, c.ZC_DISCONNECTED), zc_acquire(camera.?, 0, &output));
        try t.expectEqualSlices(u8, std.mem.asBytes(&before), std.mem.asBytes(&output));
        try t.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
        try t.expectEqual(@as(u64, 0), session(camera.?).stats.delivered);
        try t.expectEqual(c.ZC_DISCONNECTED, session(camera.?).fatal);
    }
}
pub export fn zc_wait_disconnected(p: *c.zc_camera, timeout_ms: u32, out: *c.zc_device_state) c_int {
    const self = session(p);
    var timer = std.time.Timer.start() catch return c.ZC_IO;
    self.mutex.lock();
    defer self.mutex.unlock();
    while (!self.removed.load(.acquire)) {
        const elapsed = timer.read();
        const limit = @as(u64, timeout_ms) * std.time.ns_per_ms;
        if (elapsed >= limit) return c.ZC_TIMEOUT;
        self.changed.timedWait(&self.mutex, limit - elapsed) catch {};
    }
    deviceStateLocked(self, out);
    return c.ZC_OK;
}
pub export fn zc_simulate_disconnect(p: *c.zc_camera) c_int {
    if (options.libcamera) return c.ZC_UNSUPPORTED;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    driver.disconnect(self.device.?);
    return c.ZC_OK;
}
pub export fn zc_close(p: *c.zc_camera) c_int {
    return closeWithState(p, null);
}
pub export fn zc_close_with_device_state(p: *c.zc_camera, out: *c.zc_device_state) c_int {
    return closeWithState(p, out);
}
fn closeWithState(p: *c.zc_camera, out: ?*c.zc_device_state) c_int {
    const self = session(p);
    self.operation.lock();
    self.mutex.lock();
    const busy = self.stats.leased != 0;
    self.mutex.unlock();
    if (busy) {
        self.operation.unlock();
        return c.ZC_BUSY;
    }
    const rc = stopLocked(self);
    if (rc != 0) {
        self.operation.unlock();
        return rc;
    }
    driver.close(self.device.?);
    if (out) |state| {
        self.mutex.lock();
        deviceStateLocked(self, state);
        self.mutex.unlock();
    }
    if (self.native_desired) |*writer| writer.deinit();
    self.operation.unlock();
    std.heap.c_allocator.destroy(self);
    return c.ZC_OK;
}
pub export fn zc_get_stats(p: *c.zc_camera, out: *c.zc_stats) c_int {
    const self = session(p);
    self.mutex.lock();
    defer self.mutex.unlock();
    out.* = self.stats;
    out.ready = @intCast(self.count);
    return c.ZC_OK;
}
pub export fn zc_get_control_info(p: *c.zc_camera, id: u32, out: *c.zc_control_info) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return driver.controlInfo(self.device.?, id, out);
}
fn setControlsLocked(self: *Session, values: []const c.zc_control, revision: *u64) c_int {
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    if (values.len == 0 or values.len > c.ZC_MAX_CONTROLS) return c.ZC_INVALID;
    for (values, 0..) |*v, i| {
        var info: c.zc_control_info = undefined;
        const rc = driver.controlInfo(self.device.?, v.id, &info);
        if (rc != 0) return rc;
        if (!@import("controls.zig").valid(v, &info)) return c.ZC_INVALID;
        for (values[0..i]) |prev| {
            if (prev.id == v.id) return c.ZC_INVALID;
        }
    }
    if (self.control_revision == std.math.maxInt(u64)) return c.ZC_STATE;
    var kept: [c.ZC_MAX_CONTROLS]c.zc_control = undefined;
    var count: usize = 0;
    var ae = false;
    for (values) |value| {
        if (value.id == c.ZC_AE_ENABLE) ae = true;
        if (value.id == c.ZC_AF_TRIGGER or value.id == c.ZC_AF_PAUSE) continue;
        kept[count] = value;
        count += 1;
    }
    // AeEnable resets both modern mode aliases in the backend. Do not replay
    // older explicit overrides; explicit modes in THIS batch still win.
    const removed: []const u32 = if (ae) &.{ c.ZC_EXPOSURE_TIME_MODE, c.ZC_ANALOGUE_GAIN_MODE } else &.{};
    const next = self.desired.updated(kept[0..count], removed) catch return c.ZC_INVALID;
    var staged_native = stageLegacyOverwrite(self, values) catch |e| return catalogs.status(e);
    defer if (staged_native) |*writer| writer.deinit();
    var native_revision: u64 = 0;
    const rc = driver.setControls(self.device.?, values.ptr, @intCast(values.len), &native_revision);
    if (rc != 0) return rc;
    const logical = std.math.add(u64, self.control_base, native_revision) catch return c.ZC_DEVICE;
    // Track accepted operational intent separately from persistent replay state.
    // Any later focus command invalidates an older focus-lock token.
    var pause: ?u32 = null;
    for (values) |value| {
        if (value.id >= c.ZC_LENS_POSITION and value.id <= c.ZC_AF_WINDOWS or value.id == c.ZC_AF_PAUSE) self.af_lock_valid = false;
        if (value.id == c.ZC_AF_MODE) {
            const previous = self.accepted_af_mode orelse @as(f64, if (self.config.lens_position >= 0) 0 else 2);
            if (previous != value.values[0]) self.pause_command = 2;
            self.accepted_af_mode = value.values[0];
        }
        if (value.id == c.ZC_AF_PAUSE) pause = @intFromFloat(value.values[0]);
    }
    // Backends process mode before pause regardless of caller batch order.
    if (pause) |command| self.pause_command = command;
    publishNative(self, &staged_native);
    self.desired = next;
    self.control_revision = logical;
    revision.* = logical;
    return c.ZC_OK;
}
pub export fn zc_set_controls(p: *c.zc_camera, values: [*]const c.zc_control, count: u32, revision: *u64) c_int {
    if (count == 0 or count > c.ZC_MAX_CONTROLS) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    const af_busy = if (self.af) |af| !af.terminal() else false;
    self.mutex.unlock();
    if (af_busy) {
        for (values[0..count]) |v| {
            if (v.id >= c.ZC_LENS_POSITION and v.id <= c.ZC_AF_WINDOWS or v.id == c.ZC_AF_PAUSE) return c.ZC_BUSY;
        }
    }
    return setControlsLocked(self, values[0..count], revision);
}
/// Accepted persistent requests, not inferred automatic sensor state.
pub export fn zc_get_controls(p: *c.zc_camera, values: ?[*]c.zc_control, capacity: u32, count: *u32, revision: *u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    count.* = @intCast(self.desired.count);
    revision.* = self.control_revision;
    if (values) |out| {
        if (capacity < self.desired.count) return c.ZC_INVALID;
        @memcpy(out[0..self.desired.count], self.desired.values());
    } else if (capacity != 0) return c.ZC_INVALID;
    return c.ZC_OK;
}
/// Fresh unopened-to-stream session only. Revalidate before first start; retain
/// logical revision continuity without replaying one-shot autofocus commands.
pub export fn zc_restore_controls(p: *c.zc_camera, values: ?[*]const c.zc_control, count: u32, base: u64, revision: *u64) c_int {
    if (count > c.ZC_MAX_CONTROLS or (count != 0 and values == null)) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    if (self.started_once or self.restored or self.control_revision != 0 or self.desired.count != 0) return c.ZC_STATE;
    if (count != 0) {
        if (base == std.math.maxInt(u64)) return c.ZC_STATE;
        for (values.?[0..count]) |value| if (value.id == c.ZC_AF_TRIGGER or value.id == c.ZC_AF_PAUSE) return c.ZC_INVALID;
    }
    self.control_base = base;
    self.control_revision = base;
    if (count != 0) {
        const rc = setControlsLocked(self, values.?[0..count], revision);
        if (rc != c.ZC_OK) {
            self.control_base = 0;
            self.control_revision = 0;
            return rc;
        }
    } else revision.* = base;
    self.restored = true;
    return c.ZC_OK;
}
pub export fn zc_get_frame_metadata(p: *c.zc_camera, token: u64, out: *c.zc_metadata) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.leaseIndex(token)) |i| {
        out.* = self.slots[i].metadata;
        return c.ZC_OK;
    }
    return c.ZC_STALE;
}
pub export fn zc_wait_metadata(p: *c.zc_camera, after: u64, timeout_ms: u32, out: *c.zc_metadata) c_int {
    const self = session(p);
    var timer = std.time.Timer.start() catch return c.ZC_IO;
    self.mutex.lock();
    defer self.mutex.unlock();
    while (true) {
        if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
        if (!self.running) return c.ZC_STATE;
        if (self.fatal != 0) return self.fatal;
        if (self.latest.event_id > after) {
            out.* = self.latest;
            return c.ZC_OK;
        }
        const limit = @as(u64, timeout_ms) * std.time.ns_per_ms;
        const elapsed = timer.read();
        if (elapsed >= limit) return c.ZC_TIMEOUT;
        self.changed.timedWait(&self.mutex, limit - elapsed) catch {};
    }
}
pub export fn zc_autofocus_start(p: *c.zc_camera, job_id: *u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    self.mutex.lock();
    const running = self.running;
    const busy = if (self.af) |af| !af.terminal() else false;
    self.mutex.unlock();
    if (!running) return c.ZC_STATE;
    if (busy or self.af_id == std.math.maxInt(u64)) return c.ZC_BUSY;
    var values: [2]c.zc_control = @splat(std.mem.zeroes(c.zc_control));
    values[0].id = c.ZC_AF_MODE;
    values[0].type = c.ZC_INT;
    values[0].count = 1;
    values[0].values[0] = 1;
    values[1].id = c.ZC_AF_TRIGGER;
    values[1].type = c.ZC_INT;
    values[1].count = 1;
    values[1].values[0] = 0;
    var revision: u64 = 0;
    const rc = setControlsLocked(self, &values, &revision);
    if (rc != 0) return rc;
    self.mutex.lock();
    defer self.mutex.unlock();
    self.af_id += 1;
    self.af = .{ .revision = revision };
    self.af_command = null;
    job_id.* = self.af_id;
    return c.ZC_OK;
}
fn continuous(self: *Session) bool {
    return self.accepted_af_mode != null and self.accepted_af_mode.? == 2;
}
// operation held. Replacing an owned pause command is explicit and returns a fresh ID.
fn pauseStartLocked(self: *Session, command: u32, replace: bool, job_id: *u64) c_int {
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    if (command > 2) return c.ZC_INVALID;
    self.mutex.lock();
    const running = self.running;
    const busy = if (self.af) |af| !af.terminal() else false;
    self.mutex.unlock();
    if (!running or !continuous(self)) return c.ZC_STATE;
    if ((!replace and busy) or self.af_id == std.math.maxInt(u64)) return c.ZC_BUSY;
    // Leave one revision and one command ID for restoring accepted pause intent.
    if (!replace and (self.control_revision >= std.math.maxInt(u64) - 1 or self.af_id >= std.math.maxInt(u64) - 1)) return c.ZC_STATE;
    const previous = self.pause_command;
    var value = std.mem.zeroes(c.zc_control);
    value.id = c.ZC_AF_PAUSE;
    value.type = c.ZC_INT;
    value.count = 1;
    value.values[0] = @floatFromInt(command);
    var revision: u64 = 0;
    const rc = setControlsLocked(self, (&value)[0..1], &revision);
    if (rc != 0) return rc;
    self.mutex.lock();
    defer self.mutex.unlock();
    self.af_id += 1;
    self.af = .{ .revision = revision };
    self.af_command = command;
    self.af_restore_pause = previous;
    self.af_lock_valid = true;
    job_id.* = self.af_id;
    return c.ZC_OK;
}
pub export fn zc_autofocus_pause_start(p: *c.zc_camera, command: u32, job_id: *u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return pauseStartLocked(self, command, false, job_id);
}
pub export fn zc_autofocus_pause_restore(p: *c.zc_camera, id: u64, job_id: *u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    if (id != self.af_id or self.af_command == null or !self.af_lock_valid) return c.ZC_STALE;
    return pauseStartLocked(self, self.af_restore_pause, true, job_id);
}
// Both operation and mutex held.
fn focusLockStatus(self: *Session, id: u64) c_int {
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    if (self.af_id != id or self.af_command == null or self.af_command.? == 2 or !self.af_lock_valid) return c.ZC_STALE;
    if (self.af == null or self.af.?.state != .succeeded) return c.ZC_STATE;
    return c.ZC_OK;
}
/// Validate an existing lease without consuming another frame. TIMEOUT means
/// this frame predates the lock; it can still be used by recording/preview.
pub export fn zc_focus_locked_validate(p: *c.zc_camera, id: u64, token: u64, require_focused: u32) c_int {
    if (require_focused > 1) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    defer self.mutex.unlock();
    const status = focusLockStatus(self, id);
    if (status != 0) return status;
    const index = self.leases.resource(token) orelse return c.ZC_STALE;
    const metadata = self.slots[index].metadata;
    if (!self.af.?.acceptsResult(metadata.control_revision) or metadata.valid & 32 == 0 or metadata.af_pause_state != 2) return c.ZC_TIMEOUT;
    if (require_focused != 0) {
        if (metadata.valid & 1 == 0) return c.ZC_UNSUPPORTED;
        if (metadata.af_state != 2) return c.ZC_STATE;
    }
    return c.ZC_OK;
}
/// Select a frame proven to have been captured while this pause token was valid.
/// A zero timeout attempts one frame; rejected frames are always released.
pub export fn zc_acquire_focus_locked(p: *c.zc_camera, id: u64, require_focused: u32, timeout_ms: u32, out: *c.zc_frame) c_int {
    if (require_focused > 1) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    self.mutex.lock();
    const status = focusLockStatus(self, id);
    self.mutex.unlock();
    self.operation.unlock();
    if (status != 0) return status;
    var timer = std.time.Timer.start() catch return c.ZC_IO;
    while (true) {
        const elapsed = timer.read() / std.time.ns_per_ms;
        const remaining: u32 = if (elapsed >= timeout_ms) 0 else timeout_ms - @as(u32, @intCast(elapsed));
        var frame: c.zc_frame = undefined;
        const acquire_rc = zc_acquire(p, remaining, &frame);
        if (acquire_rc != 0) return acquire_rc;
        const rc = zc_focus_locked_validate(p, id, frame.token, require_focused);
        if (rc == c.ZC_OK) {
            out.* = frame;
            return c.ZC_OK;
        }
        const release_rc = zc_release(p, frame.token);
        if (release_rc != 0) return release_rc;
        if (rc != c.ZC_TIMEOUT) return rc;
        if (timer.read() / std.time.ns_per_ms >= timeout_ms) return c.ZC_TIMEOUT;
    }
}
pub export fn zc_autofocus_cancel(p: *c.zc_camera, id: u64) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    if (self.af == null or self.af_id != id) {
        self.mutex.unlock();
        return c.ZC_STALE;
    }
    const terminal = self.af.?.terminal();
    if (self.removed.load(.acquire)) {
        self.af.?.cancel();
        self.changed.broadcast();
        self.mutex.unlock();
        return c.ZC_OK;
    }
    self.mutex.unlock();
    if (terminal) return c.ZC_OK;
    var value: c.zc_control = std.mem.zeroes(c.zc_control);
    value.id = if (self.af_command != null) c.ZC_AF_PAUSE else c.ZC_AF_TRIGGER;
    value.type = c.ZC_INT;
    value.count = 1;
    value.values[0] = if (self.af_command != null) @floatFromInt(self.af_restore_pause) else 1;
    var revision: u64 = 0;
    const rc = setControlsLocked(self, (&value)[0..1], &revision);
    if (rc != 0) return rc;
    self.mutex.lock();
    defer self.mutex.unlock();
    self.af.?.cancel();
    self.changed.broadcast();
    return c.ZC_OK;
}
pub export fn zc_autofocus_wait(p: *c.zc_camera, id: u64, timeout_ms: u32, state: *u32) c_int {
    const self = session(p);
    var timer = std.time.Timer.start() catch return c.ZC_IO;
    self.mutex.lock();
    defer self.mutex.unlock();
    while (true) {
        if (self.af == null or self.af_id != id) return c.ZC_STALE;
        state.* = @intFromEnum(self.af.?.state);
        if (self.af.?.terminal()) return c.ZC_OK;
        if (self.fatal != 0) return self.fatal;
        const limit = @as(u64, timeout_ms) * std.time.ns_per_ms;
        const elapsed = timer.read();
        if (elapsed >= limit) return c.ZC_TIMEOUT;
        self.changed.timedWait(&self.mutex, limit - elapsed) catch {};
    }
}
extern fn zcd_write_jpeg_fd(*const c.zc_frame, c_int, u32) c_int;
const still = @import("still.zig");
const exif = @import("exif.zig");
extern fn zcd_write_jpeg_fd_markers(*const c.zc_frame, c_int, u32, ?[*]const u8, usize) c_int;
const image_file = @import("image_file.zig");
comptime {
    _ = image_file;
    _ = @import("apng_job.zig");
    _ = @import("raster_api.zig");
}
pub export fn zc_image_file_prepare(output: *c.zc_image_file, p: *c.zc_camera, token: u64, stream: u32, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile) c_int {
    return zc_image_file_prepare_metadata(output, p, token, stream, opts, profile, null);
}
pub export fn zc_image_file_prepare_metadata(output: *c.zc_image_file, p: *c.zc_camera, token: u64, stream: u32, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif) c_int {
    const start = image_file.begin(output);
    if (start != 0) return start;
    if (options.jpeg and opts.format == c.ZC_IMAGE_JPEG and stream == c.ZC_MAIN and profile == null) return image_file.prepared(output, systemJpegMetadata(output, p, token, stream, null, opts, metadata));
    var encoded: ?*c.zc_image_blob = null;
    var rc = zc_encode_stream_image_metadata(p, token, stream, opts, profile, metadata, &encoded);
    if (rc == c.ZC_OK) {
        const blob: *const still.Blob = @ptrCast(@alignCast(encoded.?));
        rc = image_file.write(output, blob.bytes);
        zc_image_blob_close(encoded);
    }
    return image_file.prepared(output, rc);
}
fn captureExifLocked(self: *Session, index: u32, selected: c.zc_stream, metadata: ?*const c.zc_image_exif) !?[]u8 {
    if (!exif.enabled(metadata) or metadata.?.flags & c.ZC_IMAGE_EXIF_CAPTURE == 0) return null;
    const before = std.time.nanoTimestamp();
    const capture_now = @import("capture_filter.zig").clockNs() catch null;
    const after = std.time.nanoTimestamp();
    var photo = std.mem.zeroes(@import("catalog.zig").bridge.zcd_photo_metadata);
    _ = driver.photoValues(self.device.?, index, &photo);
    const frame_metadata = self.slots[index].metadata;
    const stamp: ?i128 = if (photo.valid & 2 != 0 and photo.wallclock_ns > 0) photo.wallclock_ns else if (frame_metadata.valid & 16 != 0 and capture_now != null) exif.correlateUtc(before, capture_now.?, after, frame_metadata.timestamp_ns) else null;
    var raw = std.mem.zeroes(c.zc_raw_metadata);
    _ = driver.metadata(self.device.?, index, &raw);
    const model = std.mem.sliceTo(&raw.model, 0);
    return exif.generate(std.heap.c_allocator, metadata, .{
        .width = selected.width,
        .height = selected.height,
        .model = if (model.len != 0) model else self.identity.bytes(),
        .exposure_us = if (frame_metadata.valid & 64 != 0) frame_metadata.exposure_us else null,
        .analogue_gain = self.slots[index].frame.analogue_gain,
        .digital_gain = if (photo.valid & 1 != 0) photo.digital_gain else null,
        .saved_utc_ns = after,
        .captured_utc_ns = stamp,
    });
}
fn systemJpegMetadata(output: ?*c.zc_image_file, p: *c.zc_camera, token: u64, stream: u32, path: ?[*:0]const u8, opts: *const c.zc_image_options, metadata: ?*const c.zc_image_exif) c_int {
    const status = zc_check_image_metadata(opts, null, metadata);
    if (status != 0) return status;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    var selected: c.zc_stream = undefined;
    const stream_rc = streamLocked(self, index, stream, &selected);
    if (stream_rc != 0) return stream_rc;
    const generated = captureExifLocked(self, index, selected, metadata) catch |err| return still.status(err);
    defer if (generated) |bytes| std.heap.c_allocator.free(bytes);
    const markers = @import("home/jpeg_metadata.zig").encode(std.heap.c_allocator, .{ .exif = generated orelse exif.bytes(metadata) }) catch |err| return still.status(err);
    defer std.heap.c_allocator.free(markers);
    var color = std.mem.zeroes(c.zc_color_space);
    if (!std.mem.eql(u8, std.mem.sliceTo(&selected.format, 0), "BGR888")) {
        const rc = driver.colorSpace(self.device.?, stream, &color);
        if (rc != 0) return rc;
    }
    const source = @import("stream_rgb.zig").Selected.init(std.heap.c_allocator, self.slots[index].frame, selected, color) catch |err| return still.status(err);
    defer source.deinit(std.heap.c_allocator);
    if (output) |target| {
        var fd: std.posix.fd_t = undefined;
        const rc = image_file.open(target, &fd);
        if (rc != 0) return rc;
        return zcd_write_jpeg_fd_markers(&source.frame, fd, opts.quality, if (markers.len != 0) markers.ptr else null, markers.len);
    }
    var atom = std.fs.cwd().atomicFile(std.mem.span(path.?), .{ .write_buffer = &.{} }) catch return c.ZC_IO;
    defer atom.deinit();
    const rc = zcd_write_jpeg_fd_markers(&source.frame, atom.file_writer.file.handle, opts.quality, if (markers.len != 0) markers.ptr else null, markers.len);
    if (rc != 0) return rc;
    atom.finish() catch return c.ZC_IO;
    return c.ZC_OK;
}
pub export fn zc_default_image_options(out: *c.zc_image_options) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_image_options), .format = c.ZC_IMAGE_JPEG, .quality = 98, .png_compression = 1, .png_filter = c.ZC_PNG_ADAPTIVE };
}
pub export fn zc_encode_image(p: *c.zc_camera, token: u64, opts: *const c.zc_image_options, out: *?*c.zc_image_blob) c_int {
    return zc_encode_stream_image(p, token, if (opts.format == c.ZC_IMAGE_DNG) c.ZC_RAW else c.ZC_MAIN, opts, out);
}
fn imageStreamStatus(stream: u32, opts: *const c.zc_image_options) c_int {
    if (stream > c.ZC_LORES or !still.valid(opts)) return c.ZC_INVALID;
    if ((opts.format == c.ZC_IMAGE_DNG) != (stream == c.ZC_RAW)) return c.ZC_UNSUPPORTED;
    return c.ZC_OK;
}
pub export fn zc_encode_stream_image(p: *c.zc_camera, token: u64, stream: u32, opts: *const c.zc_image_options, out: *?*c.zc_image_blob) c_int {
    return zc_encode_stream_image_profile(p, token, stream, opts, null, out);
}
pub export fn zc_check_image_profile(opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile) c_int {
    still.checkProfile(opts, profile) catch |err| return still.status(err);
    return c.ZC_OK;
}
pub export fn zc_check_image_metadata(opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif) c_int {
    const rc = zc_check_image_profile(opts, profile);
    if (rc != 0) return rc;
    exif.check(opts, metadata) catch |err| return still.status(err);
    return c.ZC_OK;
}
pub export fn zc_encode_stream_image_profile(p: *c.zc_camera, token: u64, stream: u32, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile, out: *?*c.zc_image_blob) c_int {
    return zc_encode_stream_image_metadata(p, token, stream, opts, profile, null, out);
}
pub export fn zc_encode_stream_image_metadata(p: *c.zc_camera, token: u64, stream: u32, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata_exif: ?*const c.zc_image_exif, out: *?*c.zc_image_blob) c_int {
    out.* = null;
    const source_status = imageStreamStatus(stream, opts);
    if (source_status != 0) return source_status;
    const profile_status = zc_check_image_metadata(opts, profile, metadata_exif);
    if (profile_status != 0) return profile_status;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    var selected: c.zc_stream = undefined;
    const stream_rc = streamLocked(self, index, stream, &selected);
    if (stream_rc != 0) return stream_rc;
    var metadata: c.zc_raw_metadata = undefined;
    if (opts.format == c.ZC_IMAGE_DNG) {
        const rc = driver.metadata(self.device.?, index, &metadata);
        if (rc != 0) return rc;
    }
    const allocator = std.heap.c_allocator;
    const generated_exif = captureExifLocked(self, index, selected, metadata_exif) catch |err| return still.status(err);
    defer if (generated_exif) |bytes| allocator.free(bytes);
    const exif_bytes = generated_exif orelse exif.bytes(metadata_exif);
    if (generated_exif) |bytes| {
        _ = @import("home/metadata_embed.zig").check(switch (opts.format) {
            c.ZC_IMAGE_JPEG => .jpeg,
            c.ZC_IMAGE_PNG => .png,
            c.ZC_IMAGE_TIFF => .tiff,
            else => unreachable,
        }, .{ .exif = bytes }) catch |err| return still.status(err);
    }
    var source = @import("stream_rgb.zig").Selected{ .frame = self.slots[index].frame };
    if (opts.format != c.ZC_IMAGE_DNG) {
        var space: c.zc_color_space = undefined;
        const rc = driver.colorSpace(self.device.?, stream, &space);
        if (rc != 0) return rc;
        still.checkProfileSource(profile, space) catch |err| return still.status(err);
        source = @import("stream_rgb.zig").Selected.image(allocator, source.frame, selected, space, opts.format) catch |err| return still.status(err);
    }
    defer source.deinit(allocator);
    const blob = allocator.create(still.Blob) catch return c.ZC_NOMEM;
    const bytes = still.encodeMetadata(allocator, &source.frame, if (opts.format == c.ZC_IMAGE_DNG) &metadata else null, opts, profile, exif_bytes) catch |err| {
        std.heap.c_allocator.destroy(blob);
        return still.status(err);
    };
    blob.bytes = bytes;
    out.* = @ptrCast(blob);
    return c.ZC_OK;
}
pub export fn zc_image_blob_copy(p: *const c.zc_image_blob, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const blob: *const still.Blob = @ptrCast(@alignCast(p));
    length.* = blob.bytes.len;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < blob.bytes.len) return c.ZC_INVALID;
    @memcpy(data.?[0..blob.bytes.len], blob.bytes);
    return c.ZC_OK;
}
pub export fn zc_image_blob_close(p: ?*c.zc_image_blob) void {
    const blob: *still.Blob = @ptrCast(@alignCast(p orelse return));
    std.heap.c_allocator.free(blob.bytes);
    std.heap.c_allocator.destroy(blob);
}
test "encoded image blobs own all formats after frame and camera release and never copy prefixes" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 18;
    cfg.height = 10;
    cfg.raw = 1;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer if (camera) |p| {
        _ = zc_stop(p);
        _ = zc_close(p);
    };
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var blobs: [7]?*c.zc_image_blob = @splat(null);
    defer for (blobs) |blob| zc_image_blob_close(blob);
    var opts: c.zc_image_options = undefined;
    zc_default_image_options(&opts);
    for (&blobs, 1..) |*blob, format| {
        opts.format = @intCast(format);
        try std.testing.expectEqual(c.ZC_OK, zc_encode_image(camera.?, frame.token, &opts, blob));
    }
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    try std.testing.expectEqual(c.ZC_OK, zc_stop(camera.?));
    try std.testing.expectEqual(c.ZC_OK, zc_close(camera.?));
    camera = null;
    const signatures = [7][]const u8{ &.{ 255, 216 }, &.{ 137, 80, 78, 71, 13, 10, 26, 10 }, "BM", "II", "P6\n", "II", "GIF89a" };
    for (blobs, signatures) |blob, signature| {
        var length: u64 = 0;
        try std.testing.expectEqual(c.ZC_OK, zc_image_blob_copy(blob.?, null, 0, &length));
        try std.testing.expect(length > signature.len and length < 8192);
        var out: [8192]u8 = @splat(0xa7);
        try std.testing.expectEqual(c.ZC_INVALID, zc_image_blob_copy(blob.?, &out, 1, &length));
        try std.testing.expectEqual(@as(u8, 0xa7), out[0]);
        try std.testing.expectEqual(c.ZC_OK, zc_image_blob_copy(blob.?, &out, out.len, &length));
        try std.testing.expectEqualSlices(u8, signature, out[0..signature.len]);
        try std.testing.expectEqual(@as(u8, 0xa7), out[@intCast(length)]);
    }
}
test "image encoding validates options and rejects exclusive mappings or stale frames without publishing" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 18;
    cfg.height = 10;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer _ = zc_close(camera.?);
    try std.testing.expectEqual(c.ZC_OK, zc_enable_writable(camera.?));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var opts: c.zc_image_options = undefined;
    zc_default_image_options(&opts);
    var blob: ?*c.zc_image_blob = undefined;
    opts.png_compression = 10;
    try std.testing.expectEqual(c.ZC_INVALID, zc_encode_image(camera.?, frame.token, &opts, &blob));
    try std.testing.expectEqual(null, blob);
    zc_default_image_options(&opts);
    opts.format = c.ZC_IMAGE_DNG;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_encode_image(camera.?, frame.token, &opts, &blob));
    try std.testing.expectEqual(null, blob);
    opts.format = c.ZC_IMAGE_PNG;
    var mapping: ?*c.zc_frame_map = null;
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_open(camera.?, frame.token, c.ZC_MAIN, 1, &mapping));
    try std.testing.expectEqual(c.ZC_BUSY, zc_encode_image(camera.?, frame.token, &opts, &blob));
    try std.testing.expectEqual(null, blob);
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_close(mapping));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_encode_image(camera.?, frame.token, &opts, &blob));
    try std.testing.expectEqual(null, blob);
    try std.testing.expectEqual(c.ZC_OK, zc_stop(camera.?));
}
pub export fn zc_save_image(p: *c.zc_camera, token: u64, path: [*:0]const u8, opts: *const c.zc_image_options) c_int {
    return zc_save_stream_image(p, token, if (opts.format == c.ZC_IMAGE_DNG) c.ZC_RAW else c.ZC_MAIN, path, opts);
}
pub export fn zc_save_stream_image(p: *c.zc_camera, token: u64, stream: u32, path: [*:0]const u8, opts: *const c.zc_image_options) c_int {
    return zc_save_stream_image_profile(p, token, stream, path, opts, null);
}
pub export fn zc_save_stream_image_profile(p: *c.zc_camera, token: u64, stream: u32, path: [*:0]const u8, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile) c_int {
    return zc_save_stream_image_metadata(p, token, stream, path, opts, profile, null);
}
pub export fn zc_save_stream_image_metadata(p: *c.zc_camera, token: u64, stream: u32, path: [*:0]const u8, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif) c_int {
    const source_status = imageStreamStatus(stream, opts);
    if (source_status != 0) return source_status;
    const profile_status = zc_check_image_metadata(opts, profile, metadata);
    if (profile_status != 0) return profile_status;
    if (!exif.enabled(metadata) and profile == null and opts.format == c.ZC_IMAGE_JPEG and stream == c.ZC_MAIN) return zc_save_jpeg(p, token, path, opts.quality);
    if (options.jpeg and profile == null and stream == c.ZC_MAIN and opts.format == c.ZC_IMAGE_JPEG) return systemJpegMetadata(null, p, token, stream, path, opts, metadata);
    if (opts.format == c.ZC_IMAGE_DNG) return zc_save_dng(p, token, path);
    var encoded: ?*c.zc_image_blob = null;
    const rc = zc_encode_stream_image_metadata(p, token, stream, opts, profile, metadata, &encoded);
    if (rc != 0) return rc;
    defer zc_image_blob_close(encoded);
    const blob: *const still.Blob = @ptrCast(@alignCast(encoded.?));
    var atom = std.fs.cwd().atomicFile(std.mem.span(path), .{ .write_buffer = &.{} }) catch return c.ZC_IO;
    defer atom.deinit();
    atom.file_writer.file.writeAll(blob.bytes) catch return c.ZC_IO;
    atom.finish() catch return c.ZC_IO;
    return c.ZC_OK;
}
pub export fn zc_save_jpeg(p: *c.zc_camera, token: u64, path: [*:0]const u8, quality: u32) c_int {
    if (quality < 1 or quality > 100) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    if (self.slots[index].access.writer) return c.ZC_BUSY;
    const slot = &self.slots[index];
    var color = std.mem.zeroes(c.zc_color_space);
    if (!std.mem.eql(u8, std.mem.sliceTo(&slot.frame.main.format, 0), "BGR888")) {
        const rc = driver.colorSpace(self.device.?, c.ZC_MAIN, &color);
        if (rc != c.ZC_OK) return rc;
    }
    const source = @import("stream_rgb.zig").Selected.init(std.heap.c_allocator, slot.frame, slot.frame.main, color) catch |err| return still.status(err);
    defer source.deinit(std.heap.c_allocator);
    if (options.jpeg) {
        var atom = std.fs.cwd().atomicFile(std.mem.span(path), .{ .write_buffer = &.{} }) catch return c.ZC_IO;
        defer atom.deinit();
        const rc = zcd_write_jpeg_fd(&source.frame, atom.file_writer.file.handle, quality);
        if (rc != 0) return rc;
        atom.finish() catch return c.ZC_IO;
        return c.ZC_OK;
    }
    var encoder = @import("home/jpeg_encoder.zig").Encoder.init(std.heap.c_allocator);
    defer encoder.deinit();
    const m = source.frame.main;
    const encoded = encoder.encode(m.planes[0].data[0..@intCast(m.planes[0].bytes_used)], m.width, m.height, m.stride, 3, @intCast(quality)) catch return c.ZC_NOMEM;
    var atom = std.fs.cwd().atomicFile(std.mem.span(path), .{ .write_buffer = &.{} }) catch return c.ZC_IO;
    defer atom.deinit();
    atom.file_writer.file.writeAll(encoded) catch return c.ZC_IO;
    atom.finish() catch return c.ZC_IO;
    return c.ZC_OK;
}
pub export fn zc_get_raw_metadata(p: *c.zc_camera, token: u64, out: *c.zc_raw_metadata) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.leaseIndex(token)) |i| return driver.metadata(self.device.?, i, out);
    return c.ZC_STALE;
}
pub export fn zc_save_dng(p: *c.zc_camera, token: u64, path: [*:0]const u8) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.leaseIndex(token)) |i| {
        if (self.slots[i].access.writer) return c.ZC_BUSY;
        const slot = &self.slots[i];
        {
            var meta: c.zc_raw_metadata = undefined;
            const rc = driver.metadata(self.device.?, @intCast(i), &meta);
            if (rc != 0) return rc;
            @import("dng.zig").save(std.heap.c_allocator, &slot.frame, &meta, std.mem.span(path)) catch |err| return switch (err) {
                error.OutOfMemory => c.ZC_NOMEM,
                error.UnsupportedFormat, error.MissingCalibration => c.ZC_UNSUPPORTED,
                error.InvalidGeometry, error.InvalidCalibration, error.BufferTooSmall, error.InvalidSample, error.FileTooLarge => c.ZC_INVALID,
                else => c.ZC_IO,
            };
            return c.ZC_OK;
        }
    }
    return c.ZC_STALE;
}
pub export fn zc_status_string(status: c_int) [*:0]const u8 {
    return switch (status) {
        0 => "success",
        c.ZC_INVALID => "invalid configuration or argument",
        c.ZC_STATE => "camera is stopped or state invalid",
        c.ZC_TIMEOUT => "operation timed out",
        c.ZC_BUSY => "camera running or outstanding frame leases",
        c.ZC_STALE => "stale or already released frame token",
        c.ZC_IO => "I/O or DMA synchronization failed",
        c.ZC_NOMEM => "out of memory",
        c.ZC_UNSUPPORTED => "requested feature unavailable in this backend or camera",
        c.ZC_DEVICE => "libcamera device/configuration failure",
        c.ZC_DISCONNECTED => "camera disconnected; close this handle before reopening",
        else => "unknown error",
    };
}

test "configuration rejects invalid and nonfinite input" {
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    var p: ?*c.zc_camera = null;
    cfg.width = 100;
    try std.testing.expectEqual(c.ZC_INVALID, zc_open(&cfg, &p));
    cfg.width = 0;
    cfg.analogue_gain = std.math.nan(f32);
    try std.testing.expectEqual(c.ZC_INVALID, zc_open(&cfg, &p));
    try std.testing.expect(p == null);
}
test "configuration alignment preserves raw auto geometry and both outputs on late failures" {
    const t = std.testing;
    var cfg: c.zc_config = undefined;
    var pipe: c.zc_pipeline_options = undefined;
    zc_default_config(&cfg);
    zc_default_pipeline_options(&pipe);
    var processed = colors.defaults();
    cfg.width = 1919;
    cfg.height = 1081;
    cfg.raw = 1;
    pipe.capture.unpacked_raw = 1;
    pipe.sensor_width = 4056;
    pipe.sensor_height = 3040;
    pipe.sensor_bit_depth = 12;
    pipe.lores_width = 1;
    pipe.lores_height = 3;
    const before_cfg = cfg;
    const before_pipe = pipe;
    try t.expectEqual(c.ZC_INVALID, zc_align_camera_configuration(&cfg, &pipe, &processed, c.ZC_ALIGN_PISP, 1, &cfg, &pipe));
    try t.expectEqualDeep(before_cfg, cfg);
    try t.expectEqualDeep(before_pipe, pipe);
    pipe.lores_width = 641;
    pipe.lores_height = 481;
    const valid_pipe = pipe;
    processed.strict_color = 1; // Missing color request is a late preflight error.
    try t.expectEqual(c.ZC_INVALID, zc_align_camera_configuration(&cfg, &pipe, &processed, c.ZC_ALIGN_PISP, 1, &cfg, &pipe));
    try t.expectEqualDeep(before_cfg, cfg);
    try t.expectEqualDeep(valid_pipe, pipe);
    processed.strict_color = 0;
    processed.main_format = c.ZC_YUV420;
    try t.expectEqual(c.ZC_OK, zc_align_camera_configuration(&cfg, &pipe, &processed, c.ZC_ALIGN_PISP, 1, &cfg, &pipe));
    var expected_cfg = before_cfg;
    expected_cfg.width = 1792;
    expected_cfg.height = 1080;
    var expected_pipe = valid_pipe;
    expected_pipe.lores_width = 640;
    expected_pipe.lores_height = 480;
    try t.expectEqualDeep(expected_cfg, cfg);
    try t.expectEqualDeep(expected_pipe, pipe);
    cfg.width = 0;
    cfg.height = 0;
    pipe.lores_width = 0;
    pipe.lores_height = 0;
    const auto_cfg = cfg;
    const auto_pipe = pipe;
    try t.expectEqual(c.ZC_OK, zc_align_camera_configuration(&cfg, &pipe, &processed, c.ZC_ALIGN_PISP, 1, &cfg, &pipe));
    try t.expectEqualDeep(auto_cfg, cfg);
    try t.expectEqualDeep(auto_pipe, pipe);
    try t.expectEqual(c.ZC_INVALID, zc_align_camera_configuration(&cfg, &pipe, &processed, 2, 1, &cfg, &pipe));
    try t.expectEqualDeep(auto_cfg, cfg);
    try t.expectEqualDeep(auto_pipe, pipe);
}
test "sync readiness belongs to a leased request and survives retain stop and later completions" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 8;
    cfg.height = 6;
    cfg.buffer_count = 3;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer t.expectEqual(c.ZC_OK, zc_close(camera.?)) catch unreachable;
    const self = session(camera.?);
    self.device.?.sync_mode = 1;
    self.device.?.sync_frames = 3;
    try t.expectEqual(c.ZC_OK, zc_start(camera.?));
    var first: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &first));
    var retained: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_retain(camera.?, first.token, &retained));
    var state: c.zc_frame_sync_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_get_frame_sync_state(camera.?, first.token, &state));
    try t.expectEqual(@as(u32, 3), state.valid);
    try t.expectEqual(@as(u32, 0), state.ready);
    try t.expect(state.timer_us > 0);
    const before = state;
    var filter: c.zc_capture_filter = undefined;
    try t.expectEqual(c.ZC_OK, CaptureFilter.zc_capture_filter_init(&filter, 0, c.ZC_CAPTURE_SYNC_READY, 0));
    try t.expectEqual(c.ZC_TIMEOUT, zc_capture_filter_accept(camera.?, first.token, &filter));
    var selected: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_acquire_filtered(camera.?, &filter, 100, &selected));
    try t.expectEqual(@as(u64, 2), selected.sequence);
    try t.expectEqual(c.ZC_OK, zc_get_frame_sync_state(camera.?, selected.token, &state));
    try t.expectEqual(@as(u32, 1), state.ready);
    try t.expectEqual(@as(i64, 0), state.timer_us);
    try t.expectEqual(c.ZC_OK, zc_stop(camera.?));
    try t.expectEqual(c.ZC_OK, zc_get_frame_sync_state(camera.?, retained.token, &state));
    try t.expectEqualDeep(before, state);
    try t.expectEqual(c.ZC_OK, zc_release(camera.?, selected.token));
    try t.expectEqual(c.ZC_OK, zc_release(camera.?, first.token));
    try t.expectEqual(c.ZC_OK, zc_release(camera.?, retained.token));
    try t.expectEqual(c.ZC_STALE, zc_get_frame_sync_state(camera.?, retained.token, &state));
    try t.expectEqualDeep(std.mem.zeroes(c.zc_frame_sync_state), state);
    try t.expectEqual(@as(u32, 0), self.stats.leased);
}
test "sync query failures preserve filter state and rejected pending frames retire their owners" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 8;
    cfg.height = 6;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer t.expectEqual(c.ZC_OK, zc_close(camera.?)) catch unreachable;
    const self = session(camera.?);
    self.device.?.sync_mode = 2;
    try t.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var filter: c.zc_capture_filter = undefined;
    try t.expectEqual(c.ZC_OK, CaptureFilter.zc_capture_filter_init(&filter, 0, c.ZC_CAPTURE_SYNC_READY, 0));
    const before = filter;
    self.device.?.fail_sync_metadata = true;
    try t.expectEqual(c.ZC_IO, zc_capture_filter_accept(camera.?, frame.token, &filter));
    try t.expectEqualDeep(before, filter);
    var state: c.zc_frame_sync_state = undefined;
    try t.expectEqual(c.ZC_IO, zc_get_frame_sync_state(camera.?, frame.token, &state));
    try t.expectEqualDeep(std.mem.zeroes(c.zc_frame_sync_state), state);
    self.device.?.fail_sync_metadata = false;
    const index = self.leaseIndex(frame.token).?;
    const original = self.device.?.sync_states[index];
    self.device.?.sync_states[index].ready = 2;
    try t.expectEqual(c.ZC_DEVICE, zc_capture_filter_accept(camera.?, frame.token, &filter));
    try t.expectEqualDeep(before, filter);
    try t.expectEqual(c.ZC_DEVICE, zc_get_frame_sync_state(camera.?, frame.token, &state));
    try t.expectEqualDeep(std.mem.zeroes(c.zc_frame_sync_state), state);
    self.device.?.sync_states[index] = original;
    try t.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    frame.token = 42;
    try t.expectEqual(c.ZC_TIMEOUT, zc_acquire_filtered(camera.?, &filter, 0, &frame));
    try t.expectEqual(@as(u64, 42), frame.token);
    try t.expectEqual(@as(u32, 0), self.stats.leased);
    self.device.?.fail_sync_end = true;
    try t.expectEqual(c.ZC_IO, zc_acquire_filtered(camera.?, &filter, 0, &frame));
    try t.expectEqual(@as(u32, 0), self.stats.leased);
    self.device.?.fail_sync_end = false;
}
test "structural preflight shares open validation without opening a device" {
    var cfg: c.zc_config = undefined;
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_config(&cfg);
    zc_default_pipeline_options(&pipeline);
    var processed = colors.defaults();
    try std.testing.expectEqual(c.ZC_OK, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 0));
    cfg.height = 6;
    try std.testing.expectEqual(c.ZC_INVALID, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 0));
    cfg.width = 9;
    processed.main_format = c.ZC_YUV420;
    try std.testing.expectEqual(c.ZC_INVALID, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 0));
    cfg.width = 8;
    try std.testing.expectEqual(c.ZC_OK, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 0));
    pipeline.lores_height = 4;
    try std.testing.expectEqual(c.ZC_INVALID, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 0));
    pipeline.lores_width = 4;
    try std.testing.expectEqual(c.ZC_OK, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 0));
    try std.testing.expectEqual(c.ZC_INVALID, zc_check_camera_configuration(&cfg, &pipeline, &processed, 9, 0));
    try std.testing.expectEqual(c.ZC_INVALID, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 2));
    cfg.buffer_count = 1;
    try std.testing.expectEqual(c.ZC_INVALID, zc_check_camera_configuration(&cfg, &pipeline, &processed, 1, 0));
}
test "leases survive stop, reject double release and prevent close/restart" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 17;
    cfg.height = 3;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(0, zc_open(&cfg, &p));
    defer std.testing.expectEqual(0, zc_close(p.?)) catch unreachable;
    var f: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_STATE, zc_acquire(p.?, 0, &f));
    try std.testing.expectEqual(0, zc_start(p.?));
    try std.testing.expectEqual(0, zc_acquire(p.?, 0, &f));
    try std.testing.expectEqual(@as(u32, 64), f.main.stride);
    try std.testing.expectEqual(@as(u64, 3), f.sequence);
    try std.testing.expectEqual(c.ZC_BUSY, zc_close(p.?));
    try std.testing.expectEqual(0, zc_stop(p.?));
    try std.testing.expectEqual(@as(u8, 16), f.main.planes[0].data[48]);
    try std.testing.expectEqual(c.ZC_BUSY, zc_start(p.?));
    try std.testing.expectEqual(0, zc_release(p.?, f.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_release(p.?, f.token));
    try std.testing.expectEqual(0, zc_start(p.?));
    var newer: c.zc_frame = undefined;
    try std.testing.expectEqual(0, zc_acquire(p.?, 0, &newer));
    try std.testing.expect(newer.token != f.token);
    try std.testing.expectEqual(c.ZC_STALE, zc_release(p.?, f.token));
    try std.testing.expectEqual(0, zc_release(p.?, newer.token));
}
test "FIFO exhausts at bounded capacity and waits time out" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.policy = c.ZC_FIFO;
    cfg.width = 1;
    cfg.height = 1;
    cfg.buffer_count = 2;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(0, zc_open(&cfg, &p));
    defer std.testing.expectEqual(0, zc_close(p.?)) catch unreachable;
    try std.testing.expectEqual(0, zc_start(p.?));
    var frames: [2]c.zc_frame = undefined;
    for (&frames, 0..) |*f, i| {
        try std.testing.expectEqual(0, zc_acquire(p.?, 0, f));
        try std.testing.expectEqual(@as(u64, i), f.sequence);
    }
    var spare: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_acquire(p.?, 1, &spare));
    for (frames) |f| try std.testing.expectEqual(0, zc_release(p.?, f.token));
}

test "device failures consume leases safely and stop can retry" {
    if (!options.libcamera) {
        var cfg: c.zc_config = undefined;
        zc_default_config(&cfg);
        cfg.width = 1;
        cfg.height = 1;
        cfg.policy = c.ZC_FIFO;
        var p: ?*c.zc_camera = null;
        try std.testing.expectEqual(0, zc_open(&cfg, &p));
        defer std.testing.expectEqual(0, zc_close(p.?)) catch unreachable;
        const self = session(p.?);
        const device = self.device.?;
        device.fail_queue = true;
        try std.testing.expectEqual(c.ZC_DEVICE, zc_start(p.?));
        device.fail_queue = false;
        try std.testing.expectEqual(0, zc_start(p.?));
        device.fail_sync_begin = true;
        var frame: c.zc_frame = undefined;
        try std.testing.expectEqual(c.ZC_IO, zc_acquire(p.?, 0, &frame));
        try std.testing.expectEqual(@as(u32, 0), self.stats.leased);
        device.fail_sync_begin = false;
        try std.testing.expectEqual(0, zc_stop(p.?));
        try std.testing.expectEqual(0, zc_start(p.?));
        try std.testing.expectEqual(0, zc_acquire(p.?, 0, &frame));
        device.fail_sync_end = true;
        try std.testing.expectEqual(c.ZC_IO, zc_release(p.?, frame.token));
        try std.testing.expectEqual(c.ZC_STALE, zc_release(p.?, frame.token));
        try std.testing.expectEqual(@as(u32, 0), self.stats.leased);
        try std.testing.expectEqual(c.ZC_IO, zc_acquire(p.?, 0, &frame));
        device.fail_sync_end = false;
        device.fail_stop_once = true;
        try std.testing.expectEqual(c.ZC_IO, zc_stop(p.?));
        const attempts = device.stop_calls;
        try std.testing.expectEqual(0, zc_stop(p.?));
        try std.testing.expectEqual(attempts + 1, device.stop_calls);
        try std.testing.expectEqual(0, zc_start(p.?));
    }
}

fn testControl(id: u32, kind: u32, values: []const f64) c.zc_control {
    var v = std.mem.zeroes(c.zc_control);
    v.id = id;
    v.type = kind;
    v.count = @intCast(values.len);
    @memcpy(v.values[0..values.len], values);
    return v;
}
test "runtime batches are atomic; queued and leased metadata retain their revision" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 17;
    cfg.height = 9;
    cfg.policy = c.ZC_FIFO;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &p));
    defer _ = zc_close(p.?);
    try std.testing.expectEqual(c.ZC_OK, zc_start(p.?));
    var rev: u64 = 0;
    const bad = [_]c.zc_control{ testControl(c.ZC_EXPOSURE_TIME, c.ZC_INT, &.{25000}), testControl(c.ZC_BRIGHTNESS, c.ZC_FLOAT, &.{99}) };
    try std.testing.expectEqual(c.ZC_INVALID, zc_set_controls(p.?, &bad, bad.len, &rev));
    try std.testing.expectEqual(@as(u64, 0), rev);
    const values = [_]c.zc_control{ testControl(c.ZC_AE_ENABLE, c.ZC_BOOL, &.{0}), testControl(c.ZC_EXPOSURE_TIME, c.ZC_INT, &.{25000}), testControl(c.ZC_ANALOGUE_GAIN, c.ZC_FLOAT, &.{2}) };
    try std.testing.expectEqual(c.ZC_OK, zc_set_controls(p.?, &values, values.len, &rev));
    try std.testing.expectEqual(@as(u64, 1), rev);
    var f: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &f));
    var m: c.zc_metadata = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_get_frame_metadata(p.?, f.token, &m));
    try std.testing.expectEqual(@as(u64, 0), m.control_revision);
    try std.testing.expectEqual(@as(u32, 10000), m.exposure_us);
    try std.testing.expectEqual(c.ZC_OK, zc_release(p.?, f.token));
    for (0..4) |_| {
        try std.testing.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &f));
        try std.testing.expectEqual(c.ZC_OK, zc_get_frame_metadata(p.?, f.token, &m));
        try std.testing.expectEqual(c.ZC_OK, zc_release(p.?, f.token));
    }
    try std.testing.expectEqual(rev, m.control_revision);
    try std.testing.expectEqual(@as(u32, 25000), m.exposure_us);
    const before = session(p.?).stats.delivered;
    try std.testing.expectEqual(c.ZC_OK, zc_wait_metadata(p.?, 0, 0, &m));
    try std.testing.expectEqual(before, session(p.?).stats.delivered);
    const event = m.event_id;
    try std.testing.expectEqual(c.ZC_OK, zc_stop(p.?));
    try std.testing.expectEqual(c.ZC_STATE, zc_wait_metadata(p.?, event, 0, &m));
    try std.testing.expectEqual(c.ZC_OK, zc_start(p.?));
    try std.testing.expectEqual(c.ZC_OK, zc_wait_metadata(p.?, event, 0, &m));
    try std.testing.expect(m.event_id > event);
}
test "autofocus observes scan before terminal; cancellation stop and failures are bounded" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.policy = c.ZC_FIFO;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &p));
    defer _ = zc_close(p.?);
    try std.testing.expectEqual(c.ZC_OK, zc_start(p.?));
    var id: u64 = 0;
    var state: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_start(p.?, &id));
    var other: u64 = 0;
    try std.testing.expectEqual(c.ZC_BUSY, zc_autofocus_start(p.?, &other));
    const lens = testControl(c.ZC_LENS_POSITION, c.ZC_FLOAT, &.{1});
    var revision: u64 = 0;
    try std.testing.expectEqual(c.ZC_BUSY, zc_set_controls(p.?, (&lens)[0..1].ptr, 1, &revision));
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_autofocus_wait(p.?, id, 0, &state));
    for (0..8) |_| {
        var f: c.zc_frame = undefined;
        try std.testing.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &f));
        try std.testing.expectEqual(c.ZC_OK, zc_release(p.?, f.token));
    }
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(p.?, id, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), state);
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_cancel(p.?, id));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(p.?, id, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), state);
    session(p.?).device.?.fail_af = true;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_start(p.?, &other));
    try std.testing.expectEqual(c.ZC_STALE, zc_autofocus_wait(p.?, id, 0, &state));
    for (0..8) |_| {
        var f: c.zc_frame = undefined;
        try std.testing.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &f));
        try std.testing.expectEqual(c.ZC_OK, zc_release(p.?, f.token));
    }
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(p.?, other, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_FAILED), state);
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_start(p.?, &id));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_cancel(p.?, id));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(p.?, id, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_CANCELLED), state);
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_start(p.?, &id));
    try std.testing.expectEqual(c.ZC_OK, zc_stop(p.?));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(p.?, id, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_STOPPED), state);
}

test "pipeline mode selection and lores preserve ownership and ABI" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 64;
    cfg.height = 32;
    var opts: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&opts);
    opts.sensor_width = 640;
    opts.sensor_height = 480;
    opts.sensor_bit_depth = 10;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_open_pipeline(&cfg, &opts, &p));
    opts.sensor_bit_depth = 12;
    opts.lores_width = 16;
    opts.lores_height = 8;
    try std.testing.expectEqual(c.ZC_OK, zc_open_pipeline(&cfg, &opts, &p));
    defer _ = zc_close(p.?);
    var count: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_get_sensor_modes(p.?, null, 0, &count));
    try std.testing.expectEqual(@as(u32, 3), count);
    var modes: [3]c.zc_sensor_mode = undefined;
    try std.testing.expectEqual(c.ZC_INVALID, zc_get_sensor_modes(p.?, &modes, 2, &count));
    try std.testing.expectEqual(c.ZC_OK, zc_get_sensor_modes(p.?, &modes, 3, &count));
    try std.testing.expectEqual(c.ZC_OK, zc_start(p.?));
    var f: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(p.?, 0, &f));
    var lores: c.zc_stream = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_get_stream(p.?, f.token, c.ZC_LORES, &lores));
    try std.testing.expectEqual(@as(u32, 3), lores.plane_count);
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_get_stream(p.?, f.token, c.ZC_RAW, &lores));
    try std.testing.expectEqual(c.ZC_INVALID, zc_get_stream(p.?, f.token, 3, &lores));
    try std.testing.expectEqual(c.ZC_OK, zc_stop(p.?));
    try std.testing.expectEqual(c.ZC_OK, zc_get_stream(p.?, f.token, c.ZC_LORES, &lores));
    try std.testing.expectEqual(c.ZC_OK, zc_release(p.?, f.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_get_stream(p.?, f.token, c.ZC_LORES, &lores));
}

test "persistent control journal commits only accepted settings, excludes commands and invalidates stale AE aliases" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 32;
    cfg.height = 24;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer _ = zc_close(camera.?);
    var revision: u64 = 0;
    const manual = [_]c.zc_control{ testControl(c.ZC_EXPOSURE_TIME_MODE, c.ZC_INT, &.{1}), testControl(c.ZC_ANALOGUE_GAIN_MODE, c.ZC_INT, &.{1}), testControl(c.ZC_EXPOSURE_TIME, c.ZC_INT, &.{1500}) };
    try std.testing.expectEqual(c.ZC_OK, zc_set_controls(camera.?, &manual, manual.len, &revision));
    const before = revision;
    session(camera.?).device.?.fail_controls_once = true;
    var gain = testControl(c.ZC_ANALOGUE_GAIN, c.ZC_FLOAT, &.{2});
    try std.testing.expectEqual(c.ZC_IO, zc_set_controls(camera.?, (&gain)[0..1].ptr, 1, &revision));
    var data: [32]c.zc_control = undefined;
    var count: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_get_controls(camera.?, &data, data.len, &count, &revision));
    try std.testing.expectEqual(before, revision);
    try std.testing.expectEqual(@as(u32, 3), count);
    const reset = [_]c.zc_control{ testControl(c.ZC_AF_TRIGGER, c.ZC_INT, &.{0}), testControl(c.ZC_AE_ENABLE, c.ZC_BOOL, &.{1}), testControl(c.ZC_AF_PAUSE, c.ZC_INT, &.{0}), gain };
    try std.testing.expectEqual(c.ZC_OK, zc_set_controls(camera.?, &reset, reset.len, &revision));
    try std.testing.expectEqual(c.ZC_OK, zc_get_controls(camera.?, &data, data.len, &count, &revision));
    try std.testing.expectEqual(@as(u32, 3), count);
    for (data[0..count]) |value| try std.testing.expect(value.id < c.ZC_AF_TRIGGER);
    var sentinel: [1]c.zc_control = .{testControl(999, c.ZC_INT, &.{123})};
    try std.testing.expectEqual(c.ZC_INVALID, zc_get_controls(camera.?, &sentinel, 1, &count, &revision));
    try std.testing.expectEqual(@as(u32, 999), sentinel[0].id);
}
test "fresh control replay preserves logical revisions, rejects commands and is retryable after driver failure" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 32;
    cfg.height = 24;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer _ = zc_close(camera.?);
    var revision: u64 = 0;
    var command = testControl(c.ZC_AF_TRIGGER, c.ZC_INT, &.{0});
    try std.testing.expectEqual(c.ZC_INVALID, zc_restore_controls(camera.?, (&command)[0..1].ptr, 1, 100, &revision));
    var exposure = testControl(c.ZC_EXPOSURE_TIME, c.ZC_INT, &.{1700});
    session(camera.?).device.?.fail_controls_once = true;
    try std.testing.expectEqual(c.ZC_IO, zc_restore_controls(camera.?, (&exposure)[0..1].ptr, 1, 100, &revision));
    var count: u32 = 99;
    try std.testing.expectEqual(c.ZC_OK, zc_get_controls(camera.?, null, 0, &count, &revision));
    try std.testing.expectEqual(@as(u32, 0), count);
    try std.testing.expectEqual(@as(u64, 0), revision);
    try std.testing.expectEqual(c.ZC_OK, zc_restore_controls(camera.?, (&exposure)[0..1].ptr, 1, 100, &revision));
    try std.testing.expectEqual(@as(u64, 101), revision);
    try std.testing.expectEqual(c.ZC_STATE, zc_restore_controls(camera.?, null, 0, 0, &revision));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var meta: c.zc_metadata = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_get_frame_metadata(camera.?, frame.token, &meta));
    try std.testing.expectEqual(@as(u64, 101), meta.control_revision);
    try std.testing.expectEqual(@as(u32, 1700), meta.exposure_us);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    var id: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_start(camera.?, &id));
    var state: u32 = 0;
    for (0..12) |_| {
        try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
        try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
        if (zc_autofocus_wait(camera.?, id, 0, &state) == c.ZC_OK) break;
    }
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), state);
}
test "control revision seeding and update exhaustion never wrap" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer _ = zc_close(camera.?);
    var exposure = testControl(c.ZC_EXPOSURE_TIME, c.ZC_INT, &.{1700});
    var revision: u64 = 0;
    try std.testing.expectEqual(c.ZC_STATE, zc_restore_controls(camera.?, (&exposure)[0..1].ptr, 1, std.math.maxInt(u64), &revision));
    try std.testing.expectEqual(c.ZC_OK, zc_restore_controls(camera.?, (&exposure)[0..1].ptr, 1, std.math.maxInt(u64) - 1, &revision));
    try std.testing.expectEqual(std.math.maxInt(u64), revision);
    try std.testing.expectEqual(c.ZC_STATE, zc_set_controls(camera.?, (&exposure)[0..1].ptr, 1, &revision));
    var count: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_get_controls(camera.?, null, 0, &count, &revision));
    try std.testing.expectEqual(std.math.maxInt(u64), revision);
    try std.testing.expectEqual(@as(u32, 1), count);
}

test "AF callbacks ignore an older outcome after observing newer controls" {
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    var self: Session = .{ .config = cfg, .running = true, .af = .{ .revision = 9 } };
    self.info.buffer_count = 4;
    var frame = std.mem.zeroes(c.zc_frame);
    var metadata = std.mem.zeroes(c.zc_metadata);
    metadata.valid = 1;
    metadata.control_revision = 12;
    metadata.af_state = 1;
    self.slots[0].state = .queued;
    completed(&self, 0, &frame, &metadata, 0);
    try std.testing.expectEqual(@import("home/completion_gate.zig").State.active, self.af.?.state);
    metadata.control_revision = 11;
    metadata.af_state = 3;
    self.slots[1].state = .queued;
    completed(&self, 1, &frame, &metadata, 0);
    try std.testing.expectEqual(@import("home/completion_gate.zig").State.active, self.af.?.state);
    metadata.control_revision = 12;
    metadata.af_state = 2;
    self.slots[2].state = .queued;
    completed(&self, 2, &frame, &metadata, 0);
    try std.testing.expectEqual(@import("home/completion_gate.zig").State.succeeded, self.af.?.state);
}

test "failed AF cancellation retains ownership until retry or stop and stale IDs cannot cancel a new scan" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var p: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &p));
    defer _ = zc_close(p.?);
    try std.testing.expectEqual(c.ZC_OK, zc_start(p.?));
    var id: u64 = 0;
    var next: u64 = 0;
    var state: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_start(p.?, &id));
    session(p.?).device.?.fail_controls_once = true;
    try std.testing.expect(zc_autofocus_cancel(p.?, id) != c.ZC_OK);
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_autofocus_wait(p.?, id, 0, &state));
    try std.testing.expectEqual(c.ZC_BUSY, zc_autofocus_start(p.?, &next));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_cancel(p.?, id));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_start(p.?, &next));
    try std.testing.expectEqual(c.ZC_STALE, zc_autofocus_cancel(p.?, id));
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_autofocus_wait(p.?, next, 0, &state));
    try std.testing.expectEqual(c.ZC_OK, zc_stop(p.?));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(p.?, next, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_STOPPED), state);
}

fn testAFRecycle(camera: *c.zc_camera, id: u64) !u32 {
    for (0..64) |_| {
        var state: u32 = 0;
        const rc = zc_autofocus_wait(camera, id, 0, &state);
        if (rc == c.ZC_OK) return state;
        try std.testing.expectEqual(c.ZC_TIMEOUT, rc);
        var frame: c.zc_frame = undefined;
        try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &frame));
        try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
    }
    return error.TestUnexpectedResult;
}
fn testContinuousCamera(buffers: u32) !*c.zc_camera {
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.buffer_count = buffers;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    errdefer _ = zc_close(camera.?);
    const value = testControl(c.ZC_AF_MODE, c.ZC_INT, &.{2});
    var revision: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_set_controls(camera.?, (&value)[0..1], 1, &revision));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    return camera.?;
}
test "continuous AF deferred pause acknowledges metadata and selects only focused paused leases" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var id: u64 = 0;
    var other: u64 = 0;
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 1, &id));
    try std.testing.expectEqual(c.ZC_BUSY, zc_autofocus_start(camera, &other));
    try std.testing.expectEqual(c.ZC_BUSY, zc_autofocus_pause_start(camera, 2, &other));
    try std.testing.expectEqual(c.ZC_STATE, zc_acquire_focus_locked(camera, id, 1, 0, &frame));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, id));
    const revision = session(camera).af.?.revision;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire_focus_locked(camera, id, 1, 100, &frame));
    var metadata: c.zc_metadata = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_get_frame_metadata(camera, frame.token, &metadata));
    try std.testing.expect(metadata.valid & 32 != 0);
    try std.testing.expectEqual(@as(i32, 2), metadata.af_pause_state);
    try std.testing.expectEqual(@as(i32, 2), metadata.af_state);
    try std.testing.expect(metadata.control_revision >= revision);
    try std.testing.expectEqual(c.ZC_OK, zc_focus_locked_validate(camera, id, frame.token, 1));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_focus_locked_validate(camera, id, frame.token, 1));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_restore(camera, id, &other));
    try std.testing.expectEqual(c.ZC_STALE, zc_autofocus_cancel(camera, id));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, other));
    try std.testing.expectEqual(@as(u32, 2), session(camera).pause_command);
    try std.testing.expectEqual(@as(u64, 0), session(camera).stats.leased);
}
test "immediate pause freezes a scan without claiming focus and restoration preserves nested pause intent" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var id: u64 = 0;
    var next: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 0, &id));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, id));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire_focus_locked(camera, id, 0, 100, &frame));
    try std.testing.expectEqual(c.ZC_STATE, zc_focus_locked_validate(camera, id, frame.token, 1));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 1, &next));
    // Repeated pause cannot resume a scan frozen by immediate pause.
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, next));
    try std.testing.expectEqual(c.ZC_STATE, zc_acquire_focus_locked(camera, next, 1, 100, &frame));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_restore(camera, next, &id));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, id));
    try std.testing.expectEqual(@as(u32, 0), session(camera).pause_command);
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 2, &next));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, next));
}
test "pause cancellation failures retain ownership; stop invalidates locks and wakes waiters" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var id: u64 = 0;
    var state: u32 = 0;
    try std.testing.expectEqual(c.ZC_INVALID, zc_autofocus_pause_start(camera, 3, &id));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 1, &id));
    session(camera).device.?.fail_controls_once = true;
    try std.testing.expectEqual(c.ZC_IO, zc_autofocus_cancel(camera, id));
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_autofocus_wait(camera, id, 0, &state));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_cancel(camera, id));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(camera, id, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_CANCELLED), state);
    try std.testing.expectEqual(@as(u32, 2), session(camera).pause_command);
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 1, &id));
    try std.testing.expectEqual(c.ZC_OK, zc_stop(camera));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_wait(camera, id, 0, &state));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_STOPPED), state);
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_STALE, zc_acquire_focus_locked(camera, id, 1, 0, &frame));
}
test "missing pause metadata never acknowledges; focus mutation invalidates a completed lock" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var id: u64 = 0;
    var state: u32 = 0;
    session(camera).device.?.omit_pause_metadata = true;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 0, &id));
    for (0..8) |_| {
        var frame: c.zc_frame = undefined;
        try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &frame));
        try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
    }
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_autofocus_wait(camera, id, 0, &state));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_cancel(camera, id));
    session(camera).device.?.omit_pause_metadata = false;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 0, &id));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, id));
    var revision: u64 = 0;
    const mode = testControl(c.ZC_AF_MODE, c.ZC_INT, &.{0});
    try std.testing.expectEqual(c.ZC_OK, zc_set_controls(camera, (&mode)[0..1], 1, &revision));
    var frame: c.zc_frame = undefined;
    const delivered = session(camera).stats.delivered;
    try std.testing.expectEqual(c.ZC_STALE, zc_acquire_focus_locked(camera, id, 0, 0, &frame));
    try std.testing.expectEqual(delivered, session(camera).stats.delivered);
    try std.testing.expectEqual(c.ZC_STALE, zc_autofocus_pause_restore(camera, id, &id));
}

test "pause acknowledgement fences stale metadata independently of scan metadata" {
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    var self: Session = .{ .config = cfg, .running = true, .af = .{ .revision = 9 }, .af_command = 1 };
    self.info.buffer_count = 4;
    var frame = std.mem.zeroes(c.zc_frame);
    var metadata = std.mem.zeroes(c.zc_metadata);
    metadata.valid = 32;
    metadata.control_revision = 12;
    metadata.af_pause_state = 1;
    self.slots[0].state = .queued;
    completed(&self, 0, &frame, &metadata, 0);
    metadata.control_revision = 11;
    metadata.af_pause_state = 2;
    self.slots[1].state = .queued;
    completed(&self, 1, &frame, &metadata, 0);
    try std.testing.expectEqual(@import("home/completion_gate.zig").State.pending, self.af.?.state);
    metadata.control_revision = 12;
    self.slots[2].state = .queued;
    completed(&self, 2, &frame, &metadata, 0);
    try std.testing.expectEqual(@import("home/completion_gate.zig").State.succeeded, self.af.?.state);
}
test "focus selection fences buffered results older than the successful acknowledgement" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var id: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 1, &id));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, id));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire_focus_locked(camera, id, 1, 100, &frame));
    const self = session(camera);
    const index = self.leaseIndex(frame.token).?;
    // Model out-of-order buffers from the command revision and a later
    // acknowledgement. Both say focused/paused, but only the latter is proven.
    const revision = self.af.?.revision;
    self.af.?.observed_revision = revision + 2;
    self.slots[index].metadata.control_revision = revision + 1;
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_focus_locked_validate(camera, id, frame.token, 1));
    self.slots[index].metadata.control_revision = revision + 2;
    try std.testing.expectEqual(c.ZC_OK, zc_focus_locked_validate(camera, id, frame.token, 1));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
}
test "focus selection rejects failed scans and missing AF metadata and never hides rejected-frame sync errors" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    session(camera).device.?.fail_af = true;
    var id: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 1, &id));
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, id));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_STATE, zc_acquire_focus_locked(camera, id, 1, 100, &frame));
    try std.testing.expectEqual(c.ZC_OK, zc_acquire_focus_locked(camera, id, 0, 100, &frame));
    const index = session(camera).leaseIndex(frame.token).?;
    session(camera).slots[index].metadata.valid &= ~@as(u32, 1);
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_focus_locked_validate(camera, id, frame.token, 1));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
    session(camera).slots[session(camera).ready[session(camera).head]].metadata.valid &= ~@as(u32, 32);
    session(camera).device.?.fail_sync_end = true;
    try std.testing.expectEqual(c.ZC_IO, zc_acquire_focus_locked(camera, id, 0, 0, &frame));
    try std.testing.expectEqual(@as(u64, 0), session(camera).stats.leased);
}
test "continuous AF command headroom rejects before mutation and preserves cancellation capacity" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer _ = zc_close(camera.?);
    const control = testControl(c.ZC_AF_MODE, c.ZC_INT, &.{2});
    var revision: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_restore_controls(camera.?, (&control)[0..1].ptr, 1, std.math.maxInt(u64) - 2, &revision));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var id: u64 = 0;
    try std.testing.expectEqual(c.ZC_STATE, zc_autofocus_pause_start(camera.?, 0, &id));
    try std.testing.expectEqual(@as(u64, 0), id);
    try std.testing.expectEqual(revision, session(camera.?).control_revision);
}
test "continuous AF reserves a replacement command ID before accepting a pause" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    const self = session(camera);
    const revision = self.control_revision;
    self.af_id = std.math.maxInt(u64) - 1;
    var id: u64 = 42;
    try std.testing.expectEqual(c.ZC_STATE, zc_autofocus_pause_start(camera, 1, &id));
    try std.testing.expectEqual(@as(u64, 42), id);
    try std.testing.expectEqual(revision, self.control_revision);
    self.af_id = std.math.maxInt(u64) - 2;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_start(camera, 1, &id));
    try std.testing.expectEqual(std.math.maxInt(u64) - 1, id);
    var restored: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_pause_restore(camera, id, &restored));
    try std.testing.expectEqual(std.math.maxInt(u64), restored);
    try std.testing.expectEqual(@as(u32, c.ZC_AF_SUCCEEDED), try testAFRecycle(camera, restored));
    try std.testing.expectEqual(c.ZC_BUSY, zc_autofocus_pause_start(camera, 1, &id));
    try std.testing.expectEqual(c.ZC_OK, zc_autofocus_cancel(camera, restored));
}

test "retained request tokens release independently and synchronize only once on final release" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var parent: c.zc_frame = undefined;
    var child: c.zc_frame = undefined;
    var sibling: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &parent));
    try std.testing.expectEqual(c.ZC_OK, zc_retain(camera, parent.token, &child));
    try std.testing.expectEqual(c.ZC_OK, zc_retain(camera, child.token, &sibling));
    try std.testing.expect(parent.token != child.token and child.token != sibling.token);
    try std.testing.expectEqual(parent.sequence, child.sequence);
    var count: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_frame_references(camera, child.token, &count));
    try std.testing.expectEqual(@as(u32, 3), count);
    const index = session(camera).leaseIndex(child.token).?;
    const completed_before = session(camera).stats.completed;
    session(camera).device.?.fail_sync_end = true;
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, parent.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_release(camera, parent.token));
    var metadata: c.zc_metadata = undefined;
    try std.testing.expectEqual(c.ZC_STALE, zc_get_frame_metadata(camera, parent.token, &metadata));
    try std.testing.expectEqual(c.ZC_OK, zc_get_frame_metadata(camera, child.token, &metadata));
    try std.testing.expectEqual(parent.sequence, metadata.sequence);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, child.token));
    try std.testing.expectEqual(completed_before, session(camera).stats.completed);
    try std.testing.expectEqual(State.leased, session(camera).slots[index].state);
    try std.testing.expectEqual(c.ZC_IO, zc_release(camera, sibling.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_release(camera, sibling.token));
    try std.testing.expectEqual(@as(usize, 0), session(camera).leases.used);
    try std.testing.expectEqual(@as(u32, 0), session(camera).stats.leased);
}
test "retains reserve primary capacity for other buffers and stale refs cannot consume reused slots" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var refs: [c.ZC_MAX_FRAME_REFERENCES]c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &refs[0]));
    var used: usize = 1;
    while (used < c.ZC_MAX_FRAME_REFERENCES - 1) : (used += 1) try std.testing.expectEqual(c.ZC_OK, zc_retain(camera, refs[0].token, &refs[used]));
    var other: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_BUSY, zc_retain(camera, refs[0].token, &other));
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &other));
    try std.testing.expectEqual(c.ZC_BUSY, zc_retain(camera, other.token, &other));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, other.token));
    try std.testing.expectEqual(c.ZC_OK, zc_stop(camera));
    try std.testing.expectEqual(c.ZC_BUSY, zc_start(camera));
    try std.testing.expectEqual(c.ZC_BUSY, zc_close(camera));
    for (refs[0..used]) |frame| try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera));
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &other));
    for (refs[0..used]) |frame| try std.testing.expectEqual(c.ZC_STALE, zc_release(camera, frame.token));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, other.token));
}
test "reference sequence exhaustion preserves live leases and leaves outputs untouched" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &frame));
    session(camera).leases.issued = @TypeOf(session(camera).leases).max_sequence;
    var unchanged = frame;
    try std.testing.expectEqual(c.ZC_STATE, zc_retain(camera, frame.token, &unchanged));
    try std.testing.expectEqual(frame.token, unchanged.token);
    const ready = session(camera).count;
    try std.testing.expectEqual(c.ZC_STATE, zc_acquire(camera, 0, &unchanged));
    try std.testing.expectEqual(ready, session(camera).count);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, frame.token));
}
test "concurrent owners retain and retire unique references without recycling a live parent" {
    if (options.libcamera) return error.SkipZigTest;
    const camera = try testContinuousCamera(2);
    defer _ = zc_close(camera);
    var parent: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera, 0, &parent));
    const completed_before = session(camera).stats.completed;
    var errors = std.atomic.Value(u32).init(0);
    const Worker = struct {
        fn run(p: *c.zc_camera, token: u64, failures: *std.atomic.Value(u32)) void {
            for (0..200) |_| {
                var child: c.zc_frame = undefined;
                if (zc_retain(p, token, &child) != 0) {
                    _ = failures.fetchAdd(1, .monotonic);
                    continue;
                }
                var metadata: c.zc_metadata = undefined;
                if (zc_get_frame_metadata(p, child.token, &metadata) != 0 or metadata.sequence != child.sequence) _ = failures.fetchAdd(1, .monotonic);
                if (zc_release(p, child.token) != 0) _ = failures.fetchAdd(1, .monotonic);
                if (zc_release(p, child.token) != c.ZC_STALE) _ = failures.fetchAdd(1, .monotonic);
            }
        }
    };
    {
        var threads: [4]std.Thread = undefined;
        var started: usize = 0;
        defer for (threads[0..started]) |thread| thread.join();
        for (&threads) |*thread| {
            thread.* = try std.Thread.spawn(.{}, Worker.run, .{ camera, parent.token, &errors });
            started += 1;
        }
    }
    try std.testing.expectEqual(@as(u32, 0), errors.load(.monotonic));
    try std.testing.expectEqual(completed_before, session(camera).stats.completed);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera, parent.token));
    try std.testing.expectEqual(completed_before + 1, session(camera).stats.completed);
}

const catalogs = @import("catalog.zig");
pub export fn zc_discover(backend: u32, out: *?*c.zc_catalog) c_int {
    out.* = null;
    if (backend != c.ZC_SYNTHETIC and backend != c.ZC_LIBCAMERA) return c.ZC_INVALID;
    const result = catalogs.Catalog.create(1) catch |e| return catalogs.status(e);
    var success = false;
    defer if (!success) result.destroy();
    const sink = result.sink();
    // Synthetic discovery remains explicitly selectable in real-backend builds.
    const rc = if (backend == c.ZC_SYNTHETIC) @import("synthetic.zig").discover(&sink) else if (options.libcamera) driver.discover(&sink) else c.ZC_UNSUPPORTED;
    if (rc != 0) return rc;
    _ = result.writer.finish() catch |e| return catalogs.status(e);
    out.* = result.ptr();
    success = true;
    return c.ZC_OK;
}
fn cameraCatalog(p: *c.zc_camera, kind: u32, token: u64, out: *?*c.zc_catalog) c_int {
    out.* = null;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = if (kind == 4) self.leaseIndex(token) orelse return c.ZC_STALE else 0;
    const result = catalogs.Catalog.create(kind) catch |e| return catalogs.status(e);
    var success = false;
    defer if (!success) result.destroy();
    const sink = result.sink();
    const rc = driver.catalog(self.device.?, kind, index, &sink);
    if (rc != 0) return rc;
    _ = result.writer.finish() catch |e| return catalogs.status(e);
    out.* = result.ptr();
    success = true;
    return c.ZC_OK;
}
pub export fn zc_camera_properties(p: *c.zc_camera, out: *?*c.zc_catalog) c_int {
    return cameraCatalog(p, 2, 0, out);
}
pub export fn zc_camera_controls(p: *c.zc_camera, out: *?*c.zc_catalog) c_int {
    return cameraCatalog(p, 3, 0, out);
}
pub export fn zc_frame_metadata_catalog(p: *c.zc_camera, token: u64, out: *?*c.zc_catalog) c_int {
    return cameraCatalog(p, 4, token, out);
}

test "owned catalogs survive source release and reject undersized copies without writes" {
    if (options.libcamera) return error.SkipZigTest;
    var discovery: ?*c.zc_catalog = null;
    try std.testing.expectEqual(c.ZC_OK, zc_discover(c.ZC_SYNTHETIC, &discovery));
    defer catalogs.zc_catalog_close(discovery);
    var length: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, catalogs.zc_catalog_copy(discovery.?, null, 0, &length));
    const bytes = try std.testing.allocator.alloc(u8, @intCast(length));
    defer std.testing.allocator.free(bytes);
    @memset(bytes, 0xaa);
    try std.testing.expectEqual(c.ZC_INVALID, catalogs.zc_catalog_copy(discovery.?, bytes.ptr, length - 1, &length));
    for (bytes) |v| try std.testing.expectEqual(@as(u8, 0xaa), v);
    try std.testing.expectEqual(c.ZC_OK, catalogs.zc_catalog_copy(discovery.?, bytes.ptr, bytes.len, &length));
    const discovered = try catalogs.wire.Reader.init(bytes);
    try std.testing.expectEqual(@as(u32, 1), discovered.catalog_kind);
    try std.testing.expectEqual(@as(u32, 4), discovered.count);
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    var closed = false;
    defer if (!closed) {
        _ = zc_close(camera.?);
    };
    var control_catalog: ?*c.zc_catalog = null;
    try std.testing.expectEqual(c.ZC_OK, zc_camera_controls(camera.?, &control_catalog));
    defer catalogs.zc_catalog_close(control_catalog);
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var metadata_catalog: ?*c.zc_catalog = null;
    try std.testing.expectEqual(c.ZC_OK, zc_frame_metadata_catalog(camera.?, frame.token, &metadata_catalog));
    defer catalogs.zc_catalog_close(metadata_catalog);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    var stale: ?*c.zc_catalog = discovery;
    try std.testing.expectEqual(c.ZC_STALE, zc_frame_metadata_catalog(camera.?, frame.token, &stale));
    try std.testing.expect(stale == null);
    try std.testing.expectEqual(c.ZC_OK, zc_close(camera.?));
    closed = true;
    for ([_]*c.zc_catalog{ control_catalog.?, metadata_catalog.? }) |snapshot| {
        try std.testing.expectEqual(c.ZC_OK, catalogs.zc_catalog_copy(snapshot, null, 0, &length));
        const copy = try std.testing.allocator.alloc(u8, @intCast(length));
        defer std.testing.allocator.free(copy);
        try std.testing.expectEqual(c.ZC_OK, catalogs.zc_catalog_copy(snapshot, copy.ptr, copy.len, &length));
        const reader = try catalogs.wire.Reader.init(copy);
        try std.testing.expect(reader.count >= 11);
    }
    var invalid: ?*c.zc_catalog = discovery;
    try std.testing.expectEqual(c.ZC_INVALID, zc_discover(99, &invalid));
    try std.testing.expect(invalid == null);
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_discover(c.ZC_LIBCAMERA, &invalid));
    try std.testing.expect(invalid == null);
}

pub export fn zc_get_camera_id(p: *c.zc_camera, data: ?[*]u8, capacity: u32, length: *u32) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    length.* = self.identity.length;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    _ = self.identity.copy(data.?[0..capacity]) catch return c.ZC_INVALID;
    return c.ZC_OK;
}

test "camera ID selection is exact and full ID copies are atomic" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&pipeline);
    var camera: ?*c.zc_camera = null;
    const expected = "synthetic";
    try std.testing.expectEqual(c.ZC_OK, zc_open_id_pipeline(&cfg, &pipeline, expected, expected.len, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    var length: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_get_camera_id(camera.?, null, 0, &length));
    try std.testing.expectEqual(@as(u32, expected.len), length);
    var output: [12]u8 = @splat(0xaa);
    try std.testing.expectEqual(c.ZC_INVALID, zc_get_camera_id(camera.?, &output, expected.len - 1, &length));
    for (output) |b| try std.testing.expectEqual(@as(u8, 0xaa), b);
    try std.testing.expectEqual(c.ZC_OK, zc_get_camera_id(camera.?, &output, output.len, &length));
    try std.testing.expectEqualStrings(expected, output[0..length]);
    try std.testing.expectEqual(@as(u8, 0xaa), output[length]);
    for ([_][]const u8{ "syntheti", "synthetic2", "Synthetic", " synthetic", "synthetic " }) |other| {
        var missing: ?*c.zc_camera = camera;
        try std.testing.expectEqual(c.ZC_DEVICE, zc_open_id_pipeline(&cfg, &pipeline, other.ptr, @intCast(other.len), &missing));
        try std.testing.expect(missing == null);
    }
    for ([_][]const u8{ "", "bad\x00id", "\xff" }) |bad| {
        var invalid: ?*c.zc_camera = camera;
        try std.testing.expectEqual(c.ZC_INVALID, zc_open_id_pipeline(&cfg, &pipeline, bad.ptr, @intCast(bad.len), &invalid));
        try std.testing.expect(invalid == null);
    }
    cfg.camera_index = 1;
    var invalid: ?*c.zc_camera = camera;
    try std.testing.expectEqual(c.ZC_INVALID, zc_open_id_pipeline(&cfg, &pipeline, expected, expected.len, &invalid));
    try std.testing.expect(invalid == null);
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
}

test "full camera ID copies preserve identifiers beyond legacy info storage" {
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    const self = try std.heap.c_allocator.create(Session);
    defer std.heap.c_allocator.destroy(self);
    const source: [c.ZC_MAX_CAMERA_ID]u8 = @splat('x');
    self.* = .{ .config = cfg, .identity = try Identity.init(&source) };
    @memcpy(self.info.camera_id[0..6], "legacy");
    var length: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_get_camera_id(self.ptr(), null, 0, &length));
    try std.testing.expectEqual(@as(u32, c.ZC_MAX_CAMERA_ID), length);
    var output: [c.ZC_MAX_CAMERA_ID + 1]u8 = @splat(0xaa);
    try std.testing.expectEqual(c.ZC_INVALID, zc_get_camera_id(self.ptr(), &output, self.info.camera_id.len, &length));
    for (output) |value| try std.testing.expectEqual(@as(u8, 0xaa), value);
    try std.testing.expectEqual(c.ZC_OK, zc_get_camera_id(self.ptr(), &output, output.len, &length));
    try std.testing.expectEqualSlices(u8, &source, output[0..length]);
    try std.testing.expectEqual(@as(u8, 0xaa), output[length]);
}

const typed = @import("native_controls.zig");
const CatalogState = @import("home/catalog_state.zig");
fn nativeReader(self: *Session) !?catalogs.wire.Reader {
    if (self.native_desired) |*writer| return try catalogs.wire.Reader.init(try writer.finish());
    return null;
}
fn stageLegacyOverwrite(self: *Session, values: []const c.zc_control) !?catalogs.wire.Writer {
    const source = (try nativeReader(self)) orelse return null;
    var removed: [typed.max_controls]u32 = undefined;
    var count: usize = 0;
    var records = source.records();
    while (try records.next()) |record| {
        for (values) |value| {
            if (value.id == c.ZC_AF_TRIGGER or value.id == c.ZC_AF_PAUSE) continue;
            if (record.info.app_id == value.id or (value.id == c.ZC_AE_ENABLE and (record.info.app_id == c.ZC_EXPOSURE_TIME_MODE or record.info.app_id == c.ZC_ANALOGUE_GAIN_MODE))) {
                removed[count] = record.info.id;
                count += 1;
                break;
            }
        }
    }
    if (count == 0) return null;
    var empty = try catalogs.wire.Writer.init(std.heap.c_allocator, typed.update_kind, catalogs.limit);
    defer empty.deinit();
    return try CatalogState.updated(std.heap.c_allocator, source, try catalogs.wire.Reader.init(try empty.finish()), removed[0..count], typed.state_kind, typed.max_controls, catalogs.limit);
}
fn publishNative(self: *Session, staged: *?catalogs.wire.Writer) void {
    if (staged.*) |writer| {
        if (self.native_desired) |*old| old.deinit();
        self.native_desired = writer;
        staged.* = null;
    }
}
fn applyTypedLocked(self: *Session, input_reader: catalogs.wire.Reader, revision: *u64, restoring: bool) c_int {
    if (self.removed.load(.acquire)) return c.ZC_DISCONNECTED;
    if (input_reader.count == 0 or input_reader.count > typed.max_controls) return c.ZC_INVALID;
    if (self.control_revision == std.math.maxInt(u64)) return c.ZC_STATE;
    var entries: [typed.max_controls]typed.Input = undefined;
    var index: usize = 0;
    var records = input_reader.records();
    while (records.next() catch return c.ZC_INVALID) |record| {
        entries[index] = typed.input(record) catch return if (record.info.kind == .unknown or record.info.kind == .none) c.ZC_UNSUPPORTED else c.ZC_INVALID;
        index += 1;
    }
    const normalized = catalogs.Catalog.create(typed.update_kind) catch |e| return catalogs.status(e);
    defer normalized.destroy();
    const sink = normalized.sink();
    var prepared: ?*driver.PreparedControls = null;
    const prepare_rc = driver.prepareNative(self.device.?, &entries, @intCast(index), &sink, &prepared);
    if (prepare_rc != 0) return prepare_rc;
    defer driver.closeNative(prepared.?);
    const normalized_reader = catalogs.wire.Reader.init(normalized.writer.finish() catch return c.ZC_DEVICE) catch return c.ZC_DEVICE;
    var persistent = catalogs.wire.Writer.init(std.heap.c_allocator, typed.update_kind, catalogs.limit) catch return c.ZC_NOMEM;
    defer persistent.deinit();
    var kept: [c.ZC_MAX_CONTROLS]c.zc_control = undefined;
    var removed_apps: [c.ZC_MAX_CONTROLS]u32 = undefined;
    var kept_count: usize = 0;
    var removed_count: usize = 0;
    var ae = false;
    var focus = false;
    records = normalized_reader.records();
    while (records.next() catch return c.ZC_DEVICE) |record| {
        const app = record.info.app_id;
        if (restoring and !typed.persistent(record)) return c.ZC_INVALID;
        if (app >= c.ZC_LENS_POSITION and app <= c.ZC_AF_WINDOWS or app == c.ZC_AF_PAUSE) focus = true;
        if (!typed.persistent(record)) continue;
        persistent.begin(record.info) catch |e| return catalogs.status(e);
        var values = record.values();
        while (values.next() catch return c.ZC_DEVICE) |value| persistent.append(value) catch |e| return catalogs.status(e);
        persistent.end() catch |e| return catalogs.status(e);
        if (app != 0) {
            if (removed_count == removed_apps.len) return c.ZC_INVALID;
            removed_apps[removed_count] = app;
            removed_count += 1;
            if (typed.legacy(record)) |value| {
                kept[kept_count] = value;
                kept_count += 1;
            }
            if (app == c.ZC_AE_ENABLE) ae = true;
        }
    }
    self.mutex.lock();
    const busy = if (self.af) |af| !af.terminal() else false;
    self.mutex.unlock();
    if (focus and busy) return c.ZC_BUSY;
    if (ae) {
        // Dependency removals precede explicit updates in this batch.
        for ([_]u32{ c.ZC_EXPOSURE_TIME_MODE, c.ZC_ANALOGUE_GAIN_MODE }) |app| {
            var present = false;
            for (removed_apps[0..removed_count]) |existing| if (existing == app) {
                present = true;
            };
            if (!present) {
                removed_apps[removed_count] = app;
                removed_count += 1;
            }
        }
    }
    const cache = self.desired.updated(kept[0..kept_count], removed_apps[0..removed_count]) catch return c.ZC_INVALID;
    var removed_native: [typed.max_controls]u32 = undefined;
    var removed_native_count: usize = 0;
    const source = nativeReader(self) catch return c.ZC_DEVICE;
    if (ae) if (source) |reader| {
        var old = reader.records();
        while (old.next() catch return c.ZC_DEVICE) |record| {
            if (record.info.app_id == c.ZC_EXPOSURE_TIME_MODE or record.info.app_id == c.ZC_ANALOGUE_GAIN_MODE) {
                removed_native[removed_native_count] = record.info.id;
                removed_native_count += 1;
            }
        }
    };
    var staged: ?catalogs.wire.Writer = null;
    defer if (staged) |*writer| writer.deinit();
    if (persistent.count != 0 or removed_native_count != 0) staged = CatalogState.updated(std.heap.c_allocator, source, catalogs.wire.Reader.init(persistent.finish() catch return c.ZC_DEVICE) catch return c.ZC_DEVICE, removed_native[0..removed_native_count], typed.state_kind, typed.max_controls, catalogs.limit) catch |e| return if (e == error.StateFull) c.ZC_BUSY else catalogs.status(e);
    var native_revision: u64 = 0;
    const rc = driver.commitNative(self.device.?, prepared.?, &native_revision);
    if (rc != 0) return rc;
    const logical = std.math.add(u64, self.control_base, native_revision) catch return c.ZC_DEVICE;
    records = normalized_reader.records();
    var pause: ?u32 = null;
    while (records.next() catch unreachable) |record| {
        const app = record.info.app_id;
        if (app >= c.ZC_LENS_POSITION and app <= c.ZC_AF_WINDOWS or app == c.ZC_AF_PAUSE) self.af_lock_valid = false;
        const value = typed.legacy(record);
        if (app == c.ZC_AF_MODE) {
            if (value != null and value.?.type == c.ZC_INT and value.?.count == 1) {
                const current = value.?.values[0];
                if (current != (self.accepted_af_mode orelse @as(f64, if (self.config.lens_position >= 0) 0 else 2))) self.pause_command = 2;
                self.accepted_af_mode = current;
            } else {
                self.accepted_af_mode = null;
                self.pause_command = 2;
            }
        }
        if (app == c.ZC_AF_PAUSE and value != null and value.?.type == c.ZC_INT and value.?.count == 1 and value.?.values[0] >= 0 and value.?.values[0] <= 2) pause = @intFromFloat(value.?.values[0]);
    }
    if (pause) |command| self.pause_command = command;
    publishNative(self, &staged);
    self.desired = cache;
    self.control_revision = logical;
    revision.* = logical;
    return c.ZC_OK;
}
pub export fn zc_set_native_controls(p: *c.zc_camera, data: ?[*]const u8, length: u64, revision: *u64) c_int {
    if (data == null or length > catalogs.limit or length < 16) return c.ZC_INVALID;
    const reader = typed.reader(data.?[0..@intCast(length)], typed.update_kind) catch return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    return applyTypedLocked(self, reader, revision, false);
}
pub export fn zc_get_native_controls(p: *c.zc_camera, out: *?*c.zc_catalog, revision: *u64) c_int {
    out.* = null;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const result = catalogs.Catalog.create(typed.state_kind) catch return c.ZC_NOMEM;
    var success = false;
    defer if (!success) result.destroy();
    if (nativeReader(self) catch return c.ZC_DEVICE) |reader| {
        const sink = result.sink();
        var records = reader.records();
        while (records.next() catch return c.ZC_DEVICE) |record| {
            const rc = typed.emit(&sink, record);
            if (rc != 0) return rc;
        }
    }
    revision.* = self.control_revision;
    out.* = result.ptr();
    success = true;
    return c.ZC_OK;
}
pub export fn zc_restore_native_controls(p: *c.zc_camera, data: ?[*]const u8, length: u64, base: u64, revision: *u64) c_int {
    if (data == null or length > catalogs.limit or length < 16) return c.ZC_INVALID;
    const reader = typed.reader(data.?[0..@intCast(length)], typed.state_kind) catch return c.ZC_INVALID;
    var records = reader.records();
    while (records.next() catch return c.ZC_INVALID) |record| if (!typed.persistent(record)) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    if (self.started_once or self.native_restored or (self.native_desired != null and self.native_desired.?.count != 0)) return c.ZC_STATE;
    const seeded = self.restored;
    if (seeded) {
        if (base != self.control_revision) return c.ZC_STATE;
    } else {
        if (self.control_revision != 0 or self.desired.count != 0) return c.ZC_STATE;
        self.control_base = base;
        self.control_revision = base;
    }
    if (reader.count != 0) {
        const rc = applyTypedLocked(self, reader, revision, true);
        if (rc != 0) {
            if (!seeded) {
                self.control_base = 0;
                self.control_revision = 0;
            }
            return rc;
        }
    } else revision.* = base;
    self.native_restored = true;
    self.restored = true;
    return c.ZC_OK;
}

test "typed preparation errors preserve backend state, journals and revision outputs" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    var writer = try catalogs.wire.Writer.init(std.testing.allocator, typed.update_kind, 1024);
    defer writer.deinit();
    try writer.begin(.{ .id = 0x10001, .kind = .i64, .name = "" });
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(i64, &bytes, 9007199254740993, .little);
    try writer.append(.{ .kind = .i64, .data = &bytes });
    try writer.end();
    const packet = try writer.finish();
    var revision: u64 = 77;
    session(camera.?).device.?.fail_controls_once = true;
    try std.testing.expectEqual(c.ZC_IO, zc_set_native_controls(camera.?, packet.ptr, packet.len, &revision));
    try std.testing.expectEqual(@as(u64, 77), revision);
    try std.testing.expectEqual(@as(u64, 0), session(camera.?).control_revision);
    try std.testing.expect(session(camera.?).native_desired == null);
    try std.testing.expect(session(camera.?).device.?.vendor_current == null);
    try std.testing.expectEqual(c.ZC_OK, zc_set_native_controls(camera.?, packet.ptr, packet.len, &revision));
    try std.testing.expectEqual(@as(u64, 1), revision);
    const old = session(camera.?).device.?.vendor_current.?;
    session(camera.?).device.?.fail_controls_once = true;
    try std.testing.expectEqual(c.ZC_IO, zc_set_native_controls(camera.?, packet.ptr, packet.len, &revision));
    try std.testing.expect(old == session(camera.?).device.?.vendor_current.?);
    try std.testing.expectEqual(@as(u64, 1), revision);
}

test "capture barriers count completion identities once across independent references" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    const before = try CaptureFilter.clockNs();
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    const after = try CaptureFilter.clockNs();
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    try std.testing.expect(frame.timestamp_ns >= before and frame.timestamp_ns <= after);
    var filter: c.zc_capture_filter = undefined;
    try std.testing.expectEqual(c.ZC_OK, CaptureFilter.zc_capture_filter_init(&filter, 2, 0, 0));
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_capture_filter_accept(camera.?, frame.token, &filter));
    var retained: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_retain(camera.?, frame.token, &retained));
    const progress = filter;
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_capture_filter_accept(camera.?, retained.token, &filter));
    try std.testing.expectEqualDeep(progress, filter);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    try std.testing.expectEqual(c.ZC_STALE, zc_capture_filter_accept(camera.?, frame.token, &filter));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, retained.token));
    try std.testing.expectEqual(c.ZC_OK, zc_acquire_filtered(camera.?, &filter, 100, &frame));
    try std.testing.expectEqual(@as(u64, 2), frame.sequence);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    try std.testing.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
}
test "filtered acquisition retires rejected owners on missing timing and DMA failure" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var filter: c.zc_capture_filter = undefined;
    try std.testing.expectEqual(c.ZC_OK, CaptureFilter.zc_capture_filter_init(&filter, 0, 3, 1));
    session(camera.?).slots[session(camera.?).ready[session(camera.?).head]].metadata.valid &= ~@as(u32, 64);
    const before = filter;
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 99;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_acquire_filtered(camera.?, &filter, 100, &frame));
    try std.testing.expectEqual(@as(u64, 99), frame.token);
    try std.testing.expectEqualDeep(before, filter);
    try std.testing.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
    try std.testing.expectEqual(c.ZC_OK, CaptureFilter.zc_capture_filter_init(&filter, 1, 0, 0));
    session(camera.?).device.?.fail_sync_end = true;
    try std.testing.expectEqual(c.ZC_IO, zc_acquire_filtered(camera.?, &filter, 100, &frame));
    try std.testing.expectEqual(@as(u64, 99), frame.token);
    try std.testing.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
}
test "filtered zero-timeout attempts one request and retains progress without publishing a frame" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var filter: c.zc_capture_filter = undefined;
    try std.testing.expectEqual(c.ZC_OK, CaptureFilter.zc_capture_filter_init(&filter, 1, 0, 0));
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 99;
    try std.testing.expectEqual(c.ZC_TIMEOUT, zc_acquire_filtered(camera.?, &filter, 0, &frame));
    try std.testing.expectEqual(@as(u64, 99), frame.token);
    try std.testing.expectEqual(@as(u32, 0), filter.remaining);
    try std.testing.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
    try std.testing.expectEqual(c.ZC_OK, zc_acquire_filtered(camera.?, &filter, 0, &frame));
    try std.testing.expectEqual(@as(u64, 1), frame.sequence);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
}

test "completion identities reach maximum once and fail explicitly before wrapping" {
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    var self: Session = .{ .config = cfg, .running = true };
    self.info.buffer_count = 2;
    self.stats.completed = std.math.maxInt(u64) - 1;
    self.slots[0].state = .queued;
    self.slots[1].state = .queued;
    const frame = std.mem.zeroes(c.zc_frame);
    const metadata = std.mem.zeroes(c.zc_metadata);
    completed(&self, 0, &frame, &metadata, 0);
    try std.testing.expectEqual(std.math.maxInt(u64), self.slots[0].metadata.event_id);
    try std.testing.expectEqual(@as(usize, 1), self.count);
    completed(&self, 1, &frame, &metadata, 0);
    try std.testing.expectEqual(c.ZC_STATE, self.fatal);
    try std.testing.expectEqual(std.math.maxInt(u64), self.stats.completed);
    try std.testing.expectEqual(@as(usize, 1), self.count);
    try std.testing.expectEqual(@as(u64, 1), self.stats.errors);
}

test "writable maps pin an exclusive frame, reject pixel aliases and survive source release/stop" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    session(camera.?).device.?.fail_writable_once = true;
    try std.testing.expectEqual(c.ZC_IO, zc_enable_writable(camera.?));
    try std.testing.expect(!session(camera.?).writable);
    try std.testing.expectEqual(c.ZC_OK, zc_enable_writable(camera.?));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    try std.testing.expectEqual(c.ZC_STATE, zc_enable_writable(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var map: ?*c.zc_frame_map = null;
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_open(camera.?, frame.token, 0, 1, &map));
    try std.testing.expectEqual(c.ZC_BUSY, zc_frame_readable(camera.?, frame.token));
    var duplicate = std.mem.zeroes(c.zc_frame);
    duplicate.token = 99;
    try std.testing.expectEqual(c.ZC_BUSY, zc_retain(camera.?, frame.token, &duplicate));
    try std.testing.expectEqual(@as(u64, 99), duplicate.token);
    var descriptor: c.zc_stream = undefined;
    try std.testing.expectEqual(c.ZC_BUSY, zc_get_stream(camera.?, frame.token, 0, &descriptor));
    var bytes: [16 * 16 * 3]u8 = @splat(33);
    try std.testing.expectEqual(c.ZC_BUSY, zc_copy_frame_rgb(camera.?, frame.token, &bytes, bytes.len));
    try std.testing.expectEqual(@as(u8, 33), bytes[0]);
    var metadata: c.zc_metadata = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_get_frame_metadata(camera.?, frame.token, &metadata));
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_stream(map.?, &descriptor));
    @constCast(descriptor.planes[0].data)[0] = 77;
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    try std.testing.expectEqual(@as(u32, 1), session(camera.?).stats.leased);
    try std.testing.expectEqual(c.ZC_OK, zc_stop(camera.?));
    try std.testing.expectEqual(c.ZC_BUSY, zc_close(camera.?));
    try std.testing.expectEqual(@as(u8, 77), descriptor.planes[0].data[0]);
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_close(map.?));
    try std.testing.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
}
test "read maps share bounded references and write admission failures preserve every owner" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    try std.testing.expectEqual(c.ZC_OK, zc_enable_writable(camera.?));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var first: ?*c.zc_frame_map = null;
    var second: ?*c.zc_frame_map = null;
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_open(camera.?, frame.token, 0, 0, &first));
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_open(camera.?, frame.token, 0, 0, &second));
    var failed = first;
    try std.testing.expectEqual(c.ZC_BUSY, zc_frame_map_open(camera.?, frame.token, 0, 1, &failed));
    try std.testing.expect(failed == null);
    try std.testing.expectEqual(c.ZC_OK, zc_frame_readable(camera.?, frame.token));
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_close(first.?));
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_close(second.?));
    var count: u32 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_frame_references(camera.?, frame.token, &count));
    try std.testing.expectEqual(@as(u32, 1), count);
    session(camera.?).leases.issued = @TypeOf(session(camera.?).leases).max_sequence;
    try std.testing.expectEqual(c.ZC_STATE, zc_frame_map_open(camera.?, frame.token, 0, 1, &failed));
    try std.testing.expect(failed == null);
    try std.testing.expect(!session(camera.?).slots[session(camera.?).leaseIndex(frame.token).?].access.writer);
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
}
test "map retirement consumes its reference on DMA failure and unsupported writes preserve read capture" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var map: ?*c.zc_frame_map = null;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_frame_map_open(camera.?, frame.token, 0, 1, &map));
    try std.testing.expect(map == null);
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_open(camera.?, frame.token, 0, 0, &map));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    session(camera.?).device.?.fail_sync_end = true;
    try std.testing.expectEqual(c.ZC_IO, zc_frame_map_close(map.?));
    try std.testing.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
    try std.testing.expectEqual(c.ZC_OK, zc_frame_map_close(null));
}

test "mapped readers preserve primary capacity and reject pool saturation without access-state changes" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    cfg.buffer_count = 3;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    var maps: [c.ZC_MAX_FRAME_REFERENCES]?*c.zc_frame_map = @splat(null);
    var count: usize = 0;
    while (true) {
        var out: ?*c.zc_frame_map = null;
        const rc = zc_frame_map_open(camera.?, frame.token, 0, 0, &out);
        if (rc == c.ZC_BUSY) {
            try std.testing.expect(out == null);
            break;
        }
        try std.testing.expectEqual(c.ZC_OK, rc);
        maps[count] = out;
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, c.ZC_MAX_FRAME_REFERENCES - 3), count);
    const index = session(camera.?).leaseIndex(frame.token).?;
    try std.testing.expectEqual(@as(u32, @intCast(count)), session(camera.?).slots[index].access.readers);
    var other: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &other));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, other.token));
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    for (maps[0..count]) |map| try std.testing.expectEqual(c.ZC_OK, zc_frame_map_close(map.?));
    try std.testing.expectEqual(@as(u32, 0), session(camera.?).stats.leased);
}

test "synchronous processed readers pin final release and writers without allocating reference tokens" {
    if (options.libcamera) return error.SkipZigTest;
    var config: c.zc_config = undefined;
    zc_default_config(&config);
    config.width = 16;
    config.height = 16;
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&pipeline);
    pipeline.lores_width = 8;
    pipeline.lores_height = 8;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, zc_open_pipeline(&config, &pipeline, &camera));
    defer {
        _ = zc_close(camera.?);
    }
    try std.testing.expectEqual(c.ZC_OK, zc_enable_writable(camera.?));
    try std.testing.expectEqual(c.ZC_OK, zc_start(camera.?));
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_acquire(camera.?, 1000, &frame));
    var first: ProcessedRead = undefined;
    var second: ProcessedRead = undefined;
    const before = try session(camera.?).leases.count(frame.token);
    try std.testing.expectEqual(c.ZC_OK, beginProcessedRead(camera.?, frame.token, c.ZC_LORES, &first));
    try std.testing.expectEqual(c.ZC_OK, beginProcessedRead(camera.?, frame.token, c.ZC_MAIN, &second));
    try std.testing.expectEqual(before, try session(camera.?).leases.count(frame.token));
    try std.testing.expectEqual(@as(u32, 8), first.stream.width);
    try std.testing.expectEqual(c.ZC_BUSY, zc_release(camera.?, frame.token));
    var writer: ?*c.zc_frame_map = null;
    try std.testing.expectEqual(c.ZC_BUSY, zc_frame_map_open(camera.?, frame.token, c.ZC_MAIN, 1, &writer));
    try std.testing.expectEqual(c.ZC_OK, first.finish());
    try std.testing.expectEqual(c.ZC_STATE, first.finish());
    try std.testing.expectEqual(c.ZC_BUSY, zc_release(camera.?, frame.token));
    try std.testing.expectEqual(c.ZC_OK, second.finish());
    try std.testing.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    try std.testing.expectEqual(c.ZC_STALE, beginProcessedRead(camera.?, frame.token, c.ZC_MAIN, &first));
}

test "explicit processed colors normalize per stream and strict metadata remains observable" {
    if (options.libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&pipeline);
    pipeline.lores_width = 8;
    pipeline.lores_height = 8;
    for ([_]u32{ c.ZC_RGB24, c.ZC_YUV420 }) |format| for ([_]u32{ c.ZC_COLOR_SYCC, c.ZC_COLOR_SMPTE170M, c.ZC_COLOR_REC709, c.ZC_COLOR_REC2020 }) |preset| {
        var processed = colors.defaults();
        processed.main_format = format;
        processed.strict_color = 1;
        try std.testing.expectEqual(c.ZC_OK, colors.zc_color_space_preset(preset, &processed.color_space));
        pipeline.lores_format = if (format == c.ZC_RGB24) c.ZC_YUV420 else c.ZC_RGB24;
        var camera: ?*c.zc_camera = null;
        try std.testing.expectEqual(c.ZC_OK, zc_open_processed_pipeline(&cfg, &pipeline, &processed, c.ZC_ROTATE0, 0, &camera));
        defer std.testing.expectEqual(c.ZC_OK, zc_close(camera.?)) catch unreachable;
        for ([_]u32{ c.ZC_MAIN, c.ZC_LORES }) |which| {
            var result: c.zc_color_negotiation = undefined;
            try std.testing.expectEqual(c.ZC_OK, zc_get_color_negotiation(camera.?, which, &result));
            try std.testing.expectEqual(@as(u32, 0), result.flags & 8);
            try std.testing.expectEqual(@as(u32, 3), result.flags & 3);
            try std.testing.expectEqual(processed.color_space.primaries, result.actual.primaries);
            try std.testing.expectEqual(processed.color_space.transfer, result.actual.transfer);
            if (result.format == c.ZC_RGB24) {
                try std.testing.expectEqual(@as(u32, c.ZC_YCBCR_NONE), result.actual.ycbcr_encoding);
                try std.testing.expectEqual(@as(u32, c.ZC_RANGE_FULL), result.actual.range);
                try std.testing.expectEqual(@as(u32, 4), result.flags & 4);
            } else {
                try std.testing.expectEqual(processed.color_space.ycbcr_encoding, result.actual.ycbcr_encoding);
                try std.testing.expectEqual(processed.color_space.range, result.actual.range);
            }
        }
        // Fault injection changes only synthetic backend metadata. Strict opening
        // was accepted; a later query reports drift rather than hiding it.
        _ = colors.zc_color_space_preset(if (preset == c.ZC_COLOR_SYCC) c.ZC_COLOR_REC709 else c.ZC_COLOR_SYCC, &session(camera.?).device.?.color_request);
        var changed: c.zc_color_negotiation = undefined;
        try std.testing.expectEqual(c.ZC_UNSUPPORTED, colorNegotiation(session(camera.?), c.ZC_MAIN, true, &changed));
        try std.testing.expectEqual(c.ZC_OK, zc_get_color_negotiation(camera.?, c.ZC_MAIN, &changed));
        try std.testing.expectEqual(@as(u32, 8), changed.flags & 8);
    };
}

test "bundle copy validates every stream before output, preserves metadata and excludes writers" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    try t.expectEqual(@as(usize, 64), @sizeOf(c.zc_packed_stream));
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 18;
    cfg.height = 10;
    cfg.raw = 1;
    var pipeline: c.zc_pipeline_options = undefined;
    zc_default_pipeline_options(&pipeline);
    pipeline.capture.unpacked_raw = 1;
    pipeline.lores_width = 8;
    pipeline.lores_height = 6;
    var camera: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open_pipeline(&cfg, &pipeline, &camera));
    defer _ = zc_close(camera.?);
    try t.expectEqual(c.ZC_OK, zc_enable_writable(camera.?));
    try t.expectEqual(c.ZC_OK, zc_start(camera.?));
    defer _ = zc_stop(camera.?);
    var frame: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, zc_acquire(camera.?, 0, &frame));
    defer _ = zc_release(camera.?, frame.token);
    const ids = [_]u32{ c.ZC_LORES, c.ZC_MAIN, c.ZC_RAW };
    var layouts: [3]c.zc_packed_stream = undefined;
    var meta: c.zc_metadata = undefined;
    var size: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_copy_frame_streams(camera.?, frame.token, &ids, 3, &layouts, 3, null, 0, &size, &meta));
    try t.expectEqual(@as(u64, 72 + 540 + 360), size);
    try t.expectEqual(frame.sequence, meta.sequence);
    const before_layouts = layouts;
    const before_meta = meta;
    var data: [972]u8 = @splat(42);
    try t.expectEqual(c.ZC_INVALID, zc_copy_frame_streams(camera.?, frame.token, &ids, 3, &layouts, 3, &data, data.len - 1, &size, &meta));
    try t.expectEqual(@as(u64, 0), size);
    try t.expectEqualSlices(u8, &@as([972]u8, @splat(42)), &data);
    try t.expectEqualDeep(before_layouts, layouts);
    try t.expectEqualDeep(before_meta, meta);
    // A late malformed raw plane cannot publish earlier lores/main pixels.
    const self = session(camera.?);
    const index = self.leaseIndex(frame.token).?;
    const original = self.slots[index].frame.raw.planes[0].bytes_used;
    self.slots[index].frame.raw.planes[0].bytes_used = 1;
    try t.expectEqual(c.ZC_INVALID, zc_copy_frame_streams(camera.?, frame.token, &ids, 3, &layouts, 3, &data, data.len, &size, &meta));
    try t.expectEqualSlices(u8, &@as([972]u8, @splat(42)), &data);
    try t.expectEqualDeep(before_layouts, layouts);
    try t.expectEqualDeep(before_meta, meta);
    self.slots[index].frame.raw.planes[0].bytes_used = original;
    try t.expectEqual(c.ZC_OK, zc_copy_frame_streams(camera.?, frame.token, &ids, 3, &layouts, 3, &data, data.len, &size, &meta));
    try t.expectEqual(@as(u64, 0), layouts[0].offset);
    try t.expectEqual(@as(u64, 72), layouts[1].offset);
    try t.expectEqual(@as(u64, 612), layouts[2].offset);
    for (ids, layouts) |id, layout| {
        var selected: c.zc_stream = undefined;
        try t.expectEqual(c.ZC_OK, zc_get_stream(camera.?, frame.token, id, &selected));
        var expected: [540]u8 = undefined;
        try t.expectEqual(c.ZC_OK, @import("media.zig").zc_copy_stream(&selected, &expected, expected.len));
        try t.expectEqualSlices(u8, expected[0..@intCast(layout.length)], data[@intCast(layout.offset)..][0..@intCast(layout.length)]);
    }
    try t.expectEqual(c.ZC_INVALID, zc_copy_frame_streams(camera.?, frame.token, &.{ 0, 0 }, 2, &layouts, 3, null, 0, &size, &meta));
    var map: ?*c.zc_frame_map = null;
    try t.expectEqual(c.ZC_OK, zc_frame_map_open(camera.?, frame.token, c.ZC_MAIN, 1, &map));
    try t.expectEqual(c.ZC_BUSY, zc_copy_frame_streams(camera.?, frame.token, &ids, 3, &layouts, 3, null, 0, &size, &meta));
    try t.expectEqual(c.ZC_OK, zc_frame_map_close(map.?));
    try t.expectEqual(c.ZC_STALE, zc_copy_frame_streams(camera.?, frame.token + 1000, &ids, 3, &layouts, 3, null, 0, &size, &meta));
}

test "acquire-and-stop publishes one readable lease and clears every failed private candidate" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg: c.zc_config = undefined;
    zc_default_config(&cfg);
    cfg.width = 8;
    cfg.height = 6;
    cfg.policy = c.ZC_FIFO;
    var camera: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open(&cfg, &camera));
    defer _ = zc_close(camera.?);
    const self = session(camera.?);
    var frame: c.zc_frame = undefined;
    @memset(std.mem.asBytes(&frame), 42);
    try t.expectEqual(c.ZC_STATE, zc_acquire_and_stop(camera.?, 0, &frame));
    try t.expectEqual(@as(u64, 0), frame.token);
    try t.expectEqual(c.ZC_OK, zc_start(camera.?));
    try t.expectEqual(c.ZC_OK, zc_acquire_and_stop(camera.?, 0, &frame));
    try t.expect(frame.token != 0);
    try t.expectEqual(@as(u32, 1), self.stats.leased);
    try t.expectEqual(c.ZC_OK, zc_frame_readable(camera.?, frame.token));
    try t.expectEqual(c.ZC_BUSY, zc_start(camera.?));
    try t.expectEqual(c.ZC_BUSY, zc_close(camera.?));
    var rgb: [8 * 6 * 3]u8 = undefined;
    try t.expectEqual(c.ZC_OK, zc_copy_frame_rgb(camera.?, frame.token, &rgb, rgb.len));
    try t.expectEqual(c.ZC_OK, zc_release(camera.?, frame.token));
    for ([_]bool{ false, true }) |sync_failure| {
        try t.expectEqual(c.ZC_OK, zc_start(camera.?));
        self.device.?.fail_stop_once = true;
        self.device.?.fail_sync_end = sync_failure;
        @memset(std.mem.asBytes(&frame), 42);
        try t.expectEqual(c.ZC_IO, zc_acquire_and_stop(camera.?, 0, &frame));
        try t.expectEqual(@as(u32, 0), self.stats.leased);
        for (std.mem.asBytes(&frame)) |byte| try t.expectEqual(@as(u8, 0), byte);
        self.device.?.fail_sync_end = false;
        try t.expectEqual(c.ZC_OK, zc_stop(camera.?));
    }
    try t.expectEqual(c.ZC_OK, zc_start(camera.?));
    const stops = self.device.?.stop_calls;
    self.device.?.fail_sync_begin = true;
    try t.expectEqual(c.ZC_IO, zc_acquire_and_stop(camera.?, 0, &frame));
    try t.expectEqual(stops, self.device.?.stop_calls);
    try t.expectEqual(@as(u64, 0), frame.token);
    try t.expectEqual(@as(u32, 0), self.stats.leased);
    self.device.?.fail_sync_begin = false;
    try t.expectEqual(c.ZC_OK, zc_stop(camera.?));
}
