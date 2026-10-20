//! Bounded request ownership shared by real and synthetic devices.
//! Callbacks only publish descriptors. Recycling and DMA sync run on consumers.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const driver = if (options.libcamera) @import("real.zig") else @import("synthetic.zig");
const State = enum { idle, queued, ready, leased };
const Slot = struct { state: State = .idle, frame: c.zc_frame = std.mem.zeroes(c.zc_frame), metadata: c.zc_metadata = std.mem.zeroes(c.zc_metadata) };
const Gate = @import("home/completion_gate.zig").Gate;
const ControlState = @import("home/keyed_state.zig").State(c.zc_control, c.ZC_MAX_CONTROLS);
const Session = struct {
    desired: ControlState = .{},
    control_revision: u64 = 0,
    control_base: u64 = 0,
    restored: bool = false,
    started_once: bool = false,
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
    leases: @import("home/lease_pool.zig").Pool(c.ZC_MAX_BUFFERS, c.ZC_MAX_FRAME_REFERENCES) = .{},
    config: c.zc_config,
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
        self.slots[i].state = .queued;
        self.mutex.unlock();
        const rc = driver.queue(self.device.?, i);
        if (rc != 0) {
            self.mutex.lock();
            self.slots[i].state = .idle;
            self.fatal = rc;
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
    self.latest.event_id = self.stats.completed + 1;
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
    self.stats.completed += 1;
    self.changed.broadcast();
}
pub export fn zc_abi_version() u32 {
    return c.ZC_ABI_VERSION;
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
    out.* = null;
    const opts = &pipeline.capture;
    if (pipeline.struct_size != @sizeOf(c.zc_pipeline_options) or
        pipeline.sensor_width > 16384 or pipeline.sensor_height > 16384 or pipeline.sensor_bit_depth > 16 or
        ((pipeline.sensor_width == 0) != (pipeline.sensor_height == 0)) or ((pipeline.sensor_width == 0) != (pipeline.sensor_bit_depth == 0)) or
        pipeline.lores_width > 16384 or pipeline.lores_height > 16384 or
        ((pipeline.lores_width == 0) != (pipeline.lores_height == 0)) or pipeline.lores_format > c.ZC_RGB24 or
        (pipeline.lores_format == c.ZC_YUV420 and (pipeline.lores_width | pipeline.lores_height) & 1 != 0)) return c.ZC_INVALID;
    if (!valid(cfg) or opts.struct_size != @sizeOf(c.zc_capture_options) or opts.role > c.ZC_VIDEO or opts.unpacked_raw > 1 or
        (opts.unpacked_raw != 0 and cfg.raw == 0) or (opts.noise_reduction > 4 and opts.noise_reduction != std.math.maxInt(u32))) return c.ZC_INVALID;
    const self = std.heap.c_allocator.create(Session) catch return c.ZC_NOMEM;
    self.* = .{ .config = cfg.* };
    const rc = driver.open(cfg, pipeline, self, completed, &self.device, &self.info, &self.pipeline);
    if (rc != 0) {
        std.heap.c_allocator.destroy(self);
        return rc;
    }
    if (self.info.buffer_count < 2 or self.info.buffer_count > c.ZC_MAX_BUFFERS) {
        driver.close(self.device.?);
        std.heap.c_allocator.destroy(self);
        return c.ZC_DEVICE;
    }
    out.* = self.ptr();
    return c.ZC_OK;
}
pub export fn zc_get_pipeline_info(p: *c.zc_camera, out: *c.zc_pipeline_info) c_int {
    out.* = session(p).pipeline;
    return c.ZC_OK;
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
            self.fatal = rc;
            self.changed.broadcast();
            self.mutex.unlock();
            return rc;
        }
        self.mutex.lock();
        self.stats.delivered += 1;
        out.* = slot.frame;
        self.mutex.unlock();
        return c.ZC_OK;
    }
}
pub export fn zc_retain(p: *c.zc_camera, token: u64, out: *c.zc_frame) c_int {
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    self.mutex.lock();
    defer self.mutex.unlock();
    const index = self.leases.resource(token) orelse return c.ZC_STALE;
    // Reserve primary reference capacity for every currently unleased buffer.
    if (c.ZC_MAX_FRAME_REFERENCES - self.leases.used <= self.info.buffer_count - self.stats.leased) return c.ZC_BUSY;
    const retained = self.leases.retain(token) catch |err| return if (err == error.SequenceExhausted) c.ZC_STATE else c.ZC_BUSY;
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
    self.mutex.lock();
    const index = self.leases.resource(token) orelse {
        self.mutex.unlock();
        return c.ZC_STALE;
    };
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
        self.fatal = rc;
        self.stats.errors += 1;
        self.changed.broadcast();
    }
    self.mutex.unlock();
    if (rc != 0) return rc;
    return if (running) self.queue(index) else c.ZC_OK;
}
fn stopLocked(self: *Session) c_int {
    self.mutex.lock();
    self.running = false;
    self.af_lock_valid = false;
    self.pause_command = 2;
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
pub export fn zc_close(p: *c.zc_camera) c_int {
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
            const previous = for (self.desired.values()) |old| {
                if (old.id == c.ZC_AF_MODE) break old.values[0];
            } else @as(f64, if (self.config.lens_position >= 0) 0 else 2);
            if (previous != value.values[0]) self.pause_command = 2;
        }
        if (value.id == c.ZC_AF_PAUSE) pause = @intFromFloat(value.values[0]);
    }
    // Backends process mode before pause regardless of caller batch order.
    if (pause) |command| self.pause_command = command;
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
    for (self.desired.values()) |value| if (value.id == c.ZC_AF_MODE) return value.values[0] == 2;
    return false;
}
// operation held. Replacing an owned pause command is explicit and returns a fresh ID.
fn pauseStartLocked(self: *Session, command: u32, replace: bool, job_id: *u64) c_int {
    if (command > 2) return c.ZC_INVALID;
    self.mutex.lock();
    const running = self.running;
    const busy = if (self.af) |af| !af.terminal() else false;
    self.mutex.unlock();
    if (!running or !continuous(self)) return c.ZC_STATE;
    if ((!replace and busy) or self.af_id == std.math.maxInt(u64)) return c.ZC_BUSY;
    // Leave one revision for restoring accepted pause intent after cancellation.
    if (!replace and self.control_revision >= std.math.maxInt(u64) - 1) return c.ZC_STATE;
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
    if (id != self.af_id or self.af_command == null or !self.af_lock_valid) return c.ZC_STALE;
    return pauseStartLocked(self, self.af_restore_pause, true, job_id);
}
// Both operation and mutex held.
fn focusLockStatus(self: *Session, id: u64) c_int {
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
    if (metadata.control_revision < self.af.?.revision or metadata.valid & 32 == 0 or metadata.af_pause_state != 2) return c.ZC_TIMEOUT;
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
extern fn zcd_save_jpeg(*const c.zc_frame, [*:0]const u8, u32) c_int;
pub export fn zc_save_jpeg(p: *c.zc_camera, token: u64, path: [*:0]const u8, quality: u32) c_int {
    if (quality < 1 or quality > 100) return c.ZC_INVALID;
    const self = session(p);
    self.operation.lock();
    defer self.operation.unlock();
    const index = self.leaseIndex(token) orelse return c.ZC_STALE;
    const slot = &self.slots[index];
    if (options.jpeg) return zcd_save_jpeg(&slot.frame, path, quality);
    var encoder = @import("home/jpeg_encoder.zig").Encoder.init(std.heap.c_allocator);
    defer encoder.deinit();
    const m = slot.frame.main;
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
