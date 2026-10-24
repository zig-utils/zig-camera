//! Camera-specific operations over the shared native worker ownership registry.
const std = @import("std");
const c = @import("abi.zig").c;
const core = @import("core.zig");
const allocator = @import("capture_allocator.zig");
const owners = @import("capture_open_owner.zig");
const mutex = &owners.mutex;
const lookup = owners.lookup;
const attached = owners.attached;
fn releasePin(allocation: *c.zc_capture_allocator, token: u64) void {
    const code = allocator.zc_capture_allocator_unpin(allocation, token);
    std.debug.assert(code == c.ZC_OK);
}
pub export fn zc_capture_open_scope_open(allocation: *c.zc_capture_allocator, initial: ?*c.zc_camera, started: u32, timeout_ms: u32, out: *u64) c_int {
    out.* = 0;
    if (started > 1 or (initial == null and started != 0)) return c.ZC_INVALID;
    if (initial) |camera| {
        var owner: ?*c.zc_capture_allocator = null;
        const rc = core.zc_camera_capture_allocator_get(camera, &owner);
        if (rc != c.ZC_OK) return rc;
        if (owner != allocation) return c.ZC_INVALID;
    }
    var pin: u64 = 0;
    const pinned = allocator.zc_capture_allocator_pin(allocation, &pin);
    if (pinned != c.ZC_OK) return pinned;
    const code = owners.create(allocation, pin, initial, started, timeout_ms, out);
    if (code != c.ZC_OK) releasePin(allocation, pin);
    return code;
}
pub export fn zc_capture_open_scope_attach(id: u64) c_int {
    return owners.zc_capture_open_scope_attach(id);
}
pub export fn zc_capture_open_scope_detach(id: u64) c_int {
    return owners.zc_capture_open_scope_detach(id);
}
pub export fn zc_capture_open_scope_cancel(id: u64, fatal: u32) c_int {
    return owners.zc_capture_open_scope_cancel(id, fatal);
}
pub export fn zc_capture_open_scope_state_get(id: u64, out: *c.zc_capture_open_scope_state) c_int {
    return owners.zc_capture_open_scope_state_get(id, out);
}
pub export fn zc_capture_open_scope_take(id: u64, out: *?*c.zc_camera, started: *u32) c_int {
    return owners.zc_capture_open_scope_take(id, out, started);
}
pub export fn zc_capture_open_scope_close(id: u64) c_int {
    mutex.lock();
    const self = lookup(id) orelse {
        mutex.unlock();
        return c.ZC_STALE;
    };
    self.abort.store(true, .release);
    if (self.active or self.threads != 0 or self.pending_factories != 0) {
        mutex.unlock();
        return c.ZC_BUSY;
    }
    self.sealed = true;
    self.active = true;
    const camera = self.camera;
    mutex.unlock();
    var code: c_int = c.ZC_OK;
    var stopped = false;
    if (camera) |value| {
        code = core.zc_stop(value);
        if (code == c.ZC_OK) {
            stopped = true;
            code = core.zc_close(value);
        }
    }
    mutex.lock();
    self.active = false;
    if (stopped) self.started = false;
    if (code != c.ZC_OK) {
        mutex.unlock();
        return code;
    }
    self.camera = null;
    mutex.unlock();
    var allocation: ?*c.zc_capture_allocator = null;
    var pin: u64 = 0;
    const disposed = owners.destroy(id, &allocation, &pin);
    if (disposed == c.ZC_OK) releasePin(allocation.?, pin);
    return disposed;
}
pub export fn zc_open_allocated_scoped_pipeline(id: u64, config: *const c.zc_config, pipeline: *const c.zc_pipeline_options, processed: *const c.zc_processed_options, orientation: u32, strict: u32, camera_id: ?[*]const u8, length: u32, restoring: u32, out: *?*c.zc_camera) c_int {
    out.* = null;
    if (restoring > 1) return c.ZC_INVALID;
    mutex.lock();
    const self = attached(id) orelse {
        mutex.unlock();
        return c.ZC_STALE;
    };
    if (self.active or self.camera != null) {
        mutex.unlock();
        return c.ZC_BUSY;
    }
    if (self.sealed or self.abort.load(.acquire)) {
        mutex.unlock();
        return c.ZC_STATE;
    }
    self.active = true;
    self.opening = true;
    self.restoring = restoring != 0;
    mutex.unlock();
    var camera: ?*c.zc_camera = null;
    const code = core.zc_open_allocated_pipeline(config, pipeline, processed, orientation, strict, camera_id, length, self.allocation, &camera);
    mutex.lock();
    self.active = false;
    self.opening = false;
    if (code == c.ZC_OK) {
        self.camera = camera;
        self.started = false;
        self.stage = if (restoring != 0) 2 else 1;
        out.* = camera;
    }
    mutex.unlock();
    return code;
}
pub export fn zc_capture_open_scope_start_camera(id: u64) c_int {
    return changeRunning(id, true);
}
pub export fn zc_capture_open_scope_stop_camera(id: u64) c_int {
    return changeRunning(id, false);
}
fn changeRunning(id: u64, start: bool) c_int {
    mutex.lock();
    const self = attached(id) orelse {
        mutex.unlock();
        return c.ZC_STALE;
    };
    if (self.active) {
        mutex.unlock();
        return c.ZC_BUSY;
    }
    if (self.sealed or (start and self.abort.load(.acquire))) {
        mutex.unlock();
        return c.ZC_STATE;
    }
    const camera = self.camera orelse {
        mutex.unlock();
        return c.ZC_STATE;
    };
    self.active = true;
    mutex.unlock();
    const code = if (start) core.zc_start(camera) else core.zc_stop(camera);
    mutex.lock();
    self.active = false;
    if (code == c.ZC_OK) self.started = start;
    mutex.unlock();
    return code;
}
pub export fn zc_capture_open_scope_close_camera(id: u64, state: *c.zc_device_state) c_int {
    mutex.lock();
    const self = attached(id) orelse {
        mutex.unlock();
        return c.ZC_STALE;
    };
    if (self.active) {
        mutex.unlock();
        return c.ZC_BUSY;
    }
    const camera = self.camera orelse {
        mutex.unlock();
        return c.ZC_STATE;
    };
    self.active = true;
    mutex.unlock();
    var code = core.zc_stop(camera);
    if (code == c.ZC_OK) {
        mutex.lock();
        self.started = false;
        mutex.unlock();
        code = core.zc_close_with_device_state(camera, state);
    }
    mutex.lock();
    self.active = false;
    if (code == c.ZC_OK) self.camera = null;
    mutex.unlock();
    return code;
}

test "native opening scope keeps cameras and allocator pins through explicit detach or actual thread exit" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    try t.expectEqual(@as(usize, 40), @sizeOf(c.zc_capture_open_scope_state));
    const Worker = struct {
        scope: u64,
        entered: std.atomic.Value(bool) = .init(false),
        leave: std.atomic.Value(bool) = .init(false),
        explicit: bool,
        code: c_int = c.ZC_STATE,
        fn run(self: *@This()) void {
            self.code = zc_capture_open_scope_attach(self.scope);
            if (self.code != c.ZC_OK) {
                self.entered.store(true, .release);
                return;
            }
            var config: c.zc_config = undefined;
            core.zc_default_config(&config);
            config.width = 8;
            config.height = 4;
            config.buffer_count = 2;
            var pipeline: c.zc_pipeline_options = undefined;
            core.zc_default_pipeline_options(&pipeline);
            var processed: c.zc_processed_options = undefined;
            @import("color_policy.zig").zc_default_processed_options(&processed);
            var camera: ?*c.zc_camera = null;
            self.code = zc_open_allocated_scoped_pipeline(self.scope, &config, &pipeline, &processed, c.ZC_ROTATE0, 0, null, 0, 0, &camera);
            if (self.code == c.ZC_OK) self.code = zc_capture_open_scope_start_camera(self.scope);
            self.entered.store(true, .release);
            while (!self.leave.load(.acquire)) std.atomic.spinLoopHint();
            if (self.explicit) self.code = zc_capture_open_scope_detach(self.scope);
        }
    };
    for ([_]bool{ false, true }) |explicit| {
        var config: c.zc_capture_allocator_config = undefined;
        allocator.zc_default_capture_allocator_config(&config);
        var allocation: ?*c.zc_capture_allocator = null;
        try t.expectEqual(c.ZC_OK, allocator.zc_capture_allocator_open(&config, null, 0, &allocation));
        defer _ = allocator.zc_capture_allocator_close(allocation.?);
        var scope: u64 = 0;
        try t.expectEqual(c.ZC_OK, zc_capture_open_scope_open(allocation.?, null, 0, std.math.maxInt(u32), &scope));
        var worker: Worker = .{ .scope = scope, .explicit = explicit };
        const thread = try std.Thread.spawn(.{}, Worker.run, .{&worker});
        var joined = false;
        defer if (!joined) {
            worker.leave.store(true, .release);
            thread.join();
        };
        while (!worker.entered.load(.acquire)) std.atomic.spinLoopHint();
        var state: c.zc_capture_open_scope_state = undefined;
        try t.expectEqual(c.ZC_OK, zc_capture_open_scope_state_get(scope, &state));
        try t.expect(state.camera != null and state.started == 1 and state.threads == 1);
        try t.expectEqual(c.ZC_BUSY, allocator.zc_capture_allocator_close(allocation.?));
        var camera: ?*c.zc_camera = null;
        var started: u32 = 0;
        try t.expectEqual(c.ZC_BUSY, zc_capture_open_scope_take(scope, &camera, &started));
        worker.leave.store(true, .release);
        thread.join();
        joined = true;
        try t.expectEqual(c.ZC_OK, worker.code);
        try t.expectEqual(c.ZC_OK, zc_capture_open_scope_take(scope, &camera, &started));
        try t.expect(camera != null and started == 1);
        try t.expectEqual(c.ZC_OK, zc_capture_open_scope_close(scope));
        try t.expectEqual(c.ZC_STALE, zc_capture_open_scope_state_get(scope, &state));
        try t.expectEqual(c.ZC_STALE, zc_capture_open_scope_close(scope));
        try t.expectEqual(c.ZC_OK, core.zc_close(camera.?));
    }
}

test "scope disposal owns an untaken original camera and late generations cannot close a replacement" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var config: c.zc_capture_allocator_config = undefined;
    allocator.zc_default_capture_allocator_config(&config);
    var allocation: ?*c.zc_capture_allocator = null;
    try t.expectEqual(c.ZC_OK, allocator.zc_capture_allocator_open(&config, null, 0, &allocation));
    defer _ = allocator.zc_capture_allocator_close(allocation.?);
    var camera_config: c.zc_config = undefined;
    core.zc_default_config(&camera_config);
    camera_config.width = 8;
    camera_config.height = 4;
    var pipeline: c.zc_pipeline_options = undefined;
    core.zc_default_pipeline_options(&pipeline);
    var processed: c.zc_processed_options = undefined;
    @import("color_policy.zig").zc_default_processed_options(&processed);
    var camera: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, core.zc_open_allocated_pipeline(&camera_config, &pipeline, &processed, c.ZC_ROTATE0, 0, null, 0, allocation.?, &camera));
    var first: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_open(allocation.?, camera, 0, std.math.maxInt(u32), &first));
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_close(first));
    var second: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_open(allocation.?, null, 0, std.math.maxInt(u32), &second));
    try t.expect(first != second);
    try t.expectEqual(c.ZC_STALE, zc_capture_open_scope_cancel(first, 1));
    try t.expectEqual(c.ZC_STALE, zc_capture_open_scope_close(first));
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_close(second));
}

test "failed scope cleanup retains a stopped leased camera for explicit retry" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var pool_config: c.zc_capture_allocator_config = undefined;
    allocator.zc_default_capture_allocator_config(&pool_config);
    var pool: ?*c.zc_capture_allocator = null;
    try t.expectEqual(c.ZC_OK, allocator.zc_capture_allocator_open(&pool_config, null, 0, &pool));
    defer _ = allocator.zc_capture_allocator_close(pool.?);
    var scope: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_open(pool.?, null, 0, std.math.maxInt(u32), &scope));
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_attach(scope));
    var config: c.zc_config = undefined;
    core.zc_default_config(&config);
    config.width = 8;
    config.height = 4;
    var pipeline: c.zc_pipeline_options = undefined;
    core.zc_default_pipeline_options(&pipeline);
    var processed: c.zc_processed_options = undefined;
    @import("color_policy.zig").zc_default_processed_options(&processed);
    var camera: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, zc_open_allocated_scoped_pipeline(scope, &config, &pipeline, &processed, c.ZC_ROTATE0, 0, null, 0, 0, &camera));
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_start_camera(scope));
    var frame: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, core.zc_acquire(camera.?, 1000, &frame));
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_stop_camera(scope));
    var loss: c.zc_device_state = undefined;
    try t.expectEqual(c.ZC_BUSY, zc_capture_open_scope_close_camera(scope, &loss));
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_detach(scope));
    try t.expectEqual(c.ZC_BUSY, zc_capture_open_scope_close(scope));
    var state: c.zc_capture_open_scope_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_state_get(scope, &state));
    try t.expect(state.camera == camera and state.started == 0 and state.threads == 0 and state.active == 0);
    try t.expectEqual(c.ZC_BUSY, allocator.zc_capture_allocator_close(pool.?));
    var taken: ?*c.zc_camera = null;
    var started: u32 = 0;
    try t.expectEqual(c.ZC_STATE, zc_capture_open_scope_take(scope, &taken, &started));
    try t.expectEqual(c.ZC_OK, core.zc_release(camera.?, frame.token));
    try t.expectEqual(c.ZC_OK, zc_capture_open_scope_close(scope));
    try t.expectEqual(c.ZC_STALE, zc_capture_open_scope_state_get(scope, &state));
}
