const std = @import("std");
pub const c = @import("abi.zig").c;
pub const core = @import("core.zig");
comptime {
    _ = core;
}
pub const raw = @import("raw.zig");
pub const dng = @import("dng.zig");
pub const audio = @import("audio.zig");
comptime {
    _ = audio;
}
pub const recording_path = @import("home/recording_path.zig");
pub const output_mailbox = @import("output_mailbox.zig");
comptime {
    _ = output_mailbox;
    _ = @import("home/pts_clock.zig");
}
pub const media = @import("media.zig");
comptime {
    _ = media;
}
pub const pixels = @import("pixels.zig");
pub const Config = c.zc_config;
pub const Info = c.zc_info;
pub const Stats = c.zc_stats;
pub const ControlSnapshot = struct {
    values: [c.ZC_MAX_CONTROLS]c.zc_control = undefined,
    count: u32 = 0,
    revision: u64 = 0,
    pub fn controls(self: *const ControlSnapshot) []const c.zc_control {
        return self.values[0..self.count];
    }
};
pub const Error = error{ Invalid, Stopped, Timeout, Busy, StaleFrame, Io, OutOfMemory, Unsupported, Device };
pub fn check(rc: c_int) Error!void {
    return switch (rc) {
        0 => {},
        c.ZC_INVALID => error.Invalid,
        c.ZC_STATE => error.Stopped,
        c.ZC_TIMEOUT => error.Timeout,
        c.ZC_BUSY => error.Busy,
        c.ZC_STALE => error.StaleFrame,
        c.ZC_IO => error.Io,
        c.ZC_NOMEM => error.OutOfMemory,
        c.ZC_UNSUPPORTED => error.Unsupported,
        else => error.Device,
    };
}
pub fn defaultConfig() Config {
    var cfg: Config = undefined;
    core.zc_default_config(&cfg);
    return cfg;
}
pub const Camera = struct {
    handle: *c.zc_camera,
    pub fn init(cfg: Config) Error!Camera {
        var ptr: ?*c.zc_camera = null;
        try check(core.zc_open(&cfg, &ptr));
        return .{ .handle = ptr.? };
    }
    pub fn initWithOptions(cfg: Config, opts: c.zc_capture_options) Error!Camera {
        var ptr: ?*c.zc_camera = null;
        try check(core.zc_open_ex(&cfg, &opts, &ptr));
        return .{ .handle = ptr.? };
    }
    pub fn initPipeline(cfg: Config, opts: c.zc_pipeline_options) Error!Camera {
        var ptr: ?*c.zc_camera = null;
        try check(core.zc_open_pipeline(&cfg, &opts, &ptr));
        return .{ .handle = ptr.? };
    }
    pub fn pipelineInfo(self: Camera) c.zc_pipeline_info {
        var out: c.zc_pipeline_info = undefined;
        check(core.zc_get_pipeline_info(self.handle, &out)) catch unreachable;
        return out;
    }
    /// Caller supplies storage; query with an empty slice to obtain total count.
    pub fn sensorModes(self: Camera, modes: []c.zc_sensor_mode) Error!u32 {
        if (modes.len > std.math.maxInt(u32)) return error.Invalid;
        var count: u32 = 0;
        try check(core.zc_get_sensor_modes(self.handle, if (modes.len == 0) null else modes.ptr, @intCast(modes.len), &count));
        return count;
    }
    pub fn deinit(self: Camera) Error!void {
        try check(core.zc_close(self.handle));
    }
    pub fn info(self: Camera) Info {
        var i: Info = undefined;
        check(core.zc_get_info(self.handle, &i)) catch unreachable;
        return i;
    }
    pub fn stats(self: Camera) Stats {
        var s: Stats = undefined;
        check(core.zc_get_stats(self.handle, &s)) catch unreachable;
        return s;
    }
    pub fn start(self: Camera) Error!void {
        try check(core.zc_start(self.handle));
    }
    pub fn stop(self: Camera) Error!void {
        try check(core.zc_stop(self.handle));
    }
    pub fn controlInfo(self: Camera, id: u32) Error!c.zc_control_info {
        var out: c.zc_control_info = undefined;
        try check(core.zc_get_control_info(self.handle, id, &out));
        return out;
    }
    pub fn setControls(self: Camera, values: []const c.zc_control) Error!u64 {
        if (values.len == 0 or values.len > c.ZC_MAX_CONTROLS) return error.Invalid;
        var revision: u64 = 0;
        try check(core.zc_set_controls(self.handle, values.ptr, @intCast(values.len), &revision));
        return revision;
    }
    /// Owned settings survive source close. Excludes AF trigger/pause commands.
    pub fn controlSnapshot(self: Camera) Error!ControlSnapshot {
        var snapshot: ControlSnapshot = .{};
        try check(core.zc_get_controls(self.handle, &snapshot.values, snapshot.values.len, &snapshot.count, &snapshot.revision));
        return snapshot;
    }
    /// Fresh camera only, before first start. Revalidates the complete snapshot.
    pub fn restoreControls(self: Camera, values: []const c.zc_control, base: u64) Error!u64 {
        if (values.len > c.ZC_MAX_CONTROLS) return error.Invalid;
        var revision: u64 = 0;
        try check(core.zc_restore_controls(self.handle, if (values.len == 0) null else values.ptr, @intCast(values.len), base, &revision));
        return revision;
    }
    pub fn waitMetadata(self: Camera, after_event: u64, timeout_ms: u32) Error!c.zc_metadata {
        var out: c.zc_metadata = undefined;
        try check(core.zc_wait_metadata(self.handle, after_event, timeout_ms, &out));
        return out;
    }
    pub fn autofocusStart(self: Camera) Error!u64 {
        var id: u64 = 0;
        try check(core.zc_autofocus_start(self.handle, &id));
        return id;
    }
    pub fn autofocusPauseStart(self: Camera, command: u32) Error!u64 {
        var id: u64 = 0;
        try check(core.zc_autofocus_pause_start(self.handle, command, &id));
        return id;
    }
    pub fn autofocusPauseRestore(self: Camera, id: u64) Error!u64 {
        var restored: u64 = 0;
        try check(core.zc_autofocus_pause_restore(self.handle, id, &restored));
        return restored;
    }
    pub fn acquireFocusLocked(self: Camera, id: u64, require_focused: bool, timeout_ms: u32) Error!Frame {
        var frame: c.zc_frame = undefined;
        try check(core.zc_acquire_focus_locked(self.handle, id, @intFromBool(require_focused), timeout_ms, &frame));
        return .{ .camera = self, .value = frame };
    }
    pub fn autofocusWait(self: Camera, id: u64, timeout_ms: u32) Error!u32 {
        var state: u32 = 0;
        try check(core.zc_autofocus_wait(self.handle, id, timeout_ms, &state));
        return state;
    }
    pub fn autofocusCancel(self: Camera, id: u64) Error!void {
        try check(core.zc_autofocus_cancel(self.handle, id));
    }
    pub fn acquire(self: Camera, timeout_ms: u32) Error!Frame {
        var f: c.zc_frame = undefined;
        try check(core.zc_acquire(self.handle, timeout_ms, &f));
        return .{ .camera = self, .value = f };
    }
};
/// Linear resource: copying the descriptor does not create another lease.
/// Views expire on release. DMA-BUF fds are borrowed and must never be closed.
pub const Frame = struct {
    camera: Camera,
    value: c.zc_frame,
    pub fn release(self: *Frame) Error!void {
        const rc = core.zc_release(self.camera.handle, self.value.token);
        if (rc != c.ZC_STALE) self.value.token = 0;
        try check(rc);
    }
    pub fn rgb(self: *const Frame) pixels.RgbView.Error!pixels.RgbView {
        if (self.value.token == 0) return error.ReleasedFrame;
        const m = self.value.main;
        return pixels.RgbView.init(m.planes[0].data[0..@intCast(m.planes[0].bytes_used)], m.width, m.height, m.stride);
    }
    pub fn stream(self: *const Frame, id: u32) Error!c.zc_stream {
        var out: c.zc_stream = undefined;
        try check(core.zc_get_stream(self.camera.handle, self.value.token, id, &out));
        return out;
    }
    pub fn metadata(self: *const Frame) Error!c.zc_metadata {
        var out: c.zc_metadata = undefined;
        try check(core.zc_get_frame_metadata(self.camera.handle, self.value.token, &out));
        return out;
    }
    pub fn saveDng(self: *const Frame, path: [:0]const u8) Error!void {
        try check(core.zc_save_dng(self.camera.handle, self.value.token, path));
    }
    pub fn saveJpeg(self: *const Frame, path: [:0]const u8, quality: u32) Error!void {
        try check(core.zc_save_jpeg(self.camera.handle, self.value.token, path, quality));
    }
};
test {
    _ = core;
    _ = pixels;
    _ = raw;
    _ = dng;
    _ = @import("video.zig");
    _ = output_mailbox;
}

test "Zig control snapshots own settings after source close and replay before streaming" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var config = defaultConfig();
    config.width = 16;
    config.height = 16;
    const source = try Camera.init(config);
    const snapshot = blk: {
        defer source.deinit() catch unreachable;
        var value = std.mem.zeroes(c.zc_control);
        value.id = c.ZC_EXPOSURE_TIME;
        value.type = c.ZC_INT;
        value.count = 1;
        value.values[0] = 1800;
        _ = try source.setControls((&value)[0..1]);
        break :blk try source.controlSnapshot();
    };
    const target = try Camera.init(config);
    defer target.deinit() catch unreachable;
    const revision = try target.restoreControls(snapshot.controls(), snapshot.revision);
    try std.testing.expect(revision > snapshot.revision);
    try target.start();
    var frame = try target.acquire(0);
    defer frame.release() catch unreachable;
    const meta = try frame.metadata();
    try std.testing.expectEqual(revision, meta.control_revision);
    try std.testing.expectEqual(@as(u32, 1800), meta.exposure_us);
}
