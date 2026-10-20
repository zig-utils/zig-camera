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
pub const catalog_format = @import("catalog.zig").wire;
pub const Catalog = struct {
    handle: ?*c.zc_catalog,
    pub fn deinit(self: *Catalog) void {
        @import("catalog.zig").zc_catalog_close(self.handle);
        self.handle = null;
    }
    pub fn copy(self: Catalog, allocator: std.mem.Allocator) Error![]u8 {
        const owned = self.handle orelse return error.Invalid;
        var length: u64 = 0;
        try check(@import("catalog.zig").zc_catalog_copy(owned, null, 0, &length));
        const bytes = try allocator.alloc(u8, @intCast(length));
        errdefer allocator.free(bytes);
        try check(@import("catalog.zig").zc_catalog_copy(owned, bytes.ptr, bytes.len, &length));
        return bytes;
    }
};
pub fn discover(backend: u32) Error!Catalog {
    var out: ?*c.zc_catalog = null;
    try check(core.zc_discover(backend, &out));
    return .{ .handle = out.? };
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
    pub fn properties(self: Camera) Error!Catalog {
        var out: ?*c.zc_catalog = null;
        try check(core.zc_camera_properties(self.handle, &out));
        return .{ .handle = out.? };
    }
    pub fn controls(self: Camera) Error!Catalog {
        var out: ?*c.zc_catalog = null;
        try check(core.zc_camera_controls(self.handle, &out));
        return .{ .handle = out.? };
    }
    pub fn initId(cfg: Config, id: []const u8) Error!Camera {
        var options: c.zc_pipeline_options = undefined;
        core.zc_default_pipeline_options(&options);
        return initPipelineId(cfg, options, id);
    }
    pub fn initPipelineId(cfg: Config, opts: c.zc_pipeline_options, id: []const u8) Error!Camera {
        if (id.len > c.ZC_MAX_CAMERA_ID) return error.Invalid;
        var out: ?*c.zc_camera = null;
        try check(core.zc_open_id_pipeline(&cfg, &opts, id.ptr, @intCast(id.len), &out));
        return .{ .handle = out.? };
    }
    pub fn cameraId(self: Camera, allocator: std.mem.Allocator) Error![]u8 {
        var length: u32 = 0;
        try check(core.zc_get_camera_id(self.handle, null, 0, &length));
        const bytes = try allocator.alloc(u8, length);
        errdefer allocator.free(bytes);
        try check(core.zc_get_camera_id(self.handle, bytes.ptr, @intCast(bytes.len), &length));
        return bytes;
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
/// Linear reference: copying the descriptor does not create another lease.
/// retain creates a distinct reference; mappings expire only on final release.
/// Views expire on release. DMA-BUF fds are borrowed and must never be closed.
pub const Frame = struct {
    camera: Camera,
    value: c.zc_frame,
    pub fn retain(self: *const Frame) Error!Frame {
        if (self.value.token == 0) return error.StaleFrame;
        var out: c.zc_frame = undefined;
        try check(core.zc_retain(self.camera.handle, self.value.token, &out));
        return .{ .camera = self.camera, .value = out };
    }
    pub fn referenceCount(self: *const Frame) Error!u32 {
        if (self.value.token == 0) return error.StaleFrame;
        var count: u32 = 0;
        try check(core.zc_frame_references(self.camera.handle, self.value.token, &count));
        return count;
    }
    pub fn release(self: *Frame) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        const rc = core.zc_release(self.camera.handle, self.value.token);
        self.value.token = 0;
        try check(rc);
    }
    pub fn rgb(self: *const Frame) pixels.RgbView.Error!pixels.RgbView {
        if (self.value.token == 0) return error.ReleasedFrame;
        const m = self.value.main;
        return pixels.RgbView.init(m.planes[0].data[0..@intCast(m.planes[0].bytes_used)], m.width, m.height, m.stride);
    }
    pub fn stream(self: *const Frame, id: u32) Error!c.zc_stream {
        if (self.value.token == 0) return error.StaleFrame;
        var out: c.zc_stream = undefined;
        try check(core.zc_get_stream(self.camera.handle, self.value.token, id, &out));
        return out;
    }
    pub fn metadataCatalog(self: *const Frame) Error!Catalog {
        if (self.value.token == 0) return error.StaleFrame;
        var out: ?*c.zc_catalog = null;
        try check(core.zc_frame_metadata_catalog(self.camera.handle, self.value.token, &out));
        return .{ .handle = out.? };
    }
    pub fn metadata(self: *const Frame) Error!c.zc_metadata {
        if (self.value.token == 0) return error.StaleFrame;
        var out: c.zc_metadata = undefined;
        try check(core.zc_get_frame_metadata(self.camera.handle, self.value.token, &out));
        return out;
    }
    pub fn saveDng(self: *const Frame, path: [:0]const u8) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        try check(core.zc_save_dng(self.camera.handle, self.value.token, path));
    }
    pub fn saveJpeg(self: *const Frame, path: [:0]const u8, quality: u32) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
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

test "Zig retained frames pin a stopped request until every independent owner leaves" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var config = defaultConfig();
    config.width = 16;
    config.height = 16;
    const camera = try Camera.init(config);
    defer camera.deinit() catch unreachable;
    try camera.start();
    var parent = try camera.acquire(0);
    var child = try parent.retain();
    defer child.release() catch {};
    try std.testing.expectEqual(@as(u32, 2), try child.referenceCount());
    try std.testing.expect(parent.value.token != child.value.token);
    try parent.release();
    try std.testing.expectEqual(@as(u32, 1), try child.referenceCount());
    try camera.stop();
    const pixels_view = try child.rgb();
    try std.testing.expectEqual(@as(usize, 16), pixels_view.width);
    try std.testing.expectEqual(child.value.sequence, (try child.metadata()).sequence);
    try std.testing.expectError(error.Busy, camera.start());
    try std.testing.expectError(error.Busy, camera.deinit());
    try child.release();
    try camera.start();
    var next = try camera.acquire(0);
    defer next.release() catch unreachable;
    try std.testing.expect(next.value.token != child.value.token);
}

test "released Zig references reject locally after their camera is destroyed" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var config = defaultConfig();
    config.width = 16;
    config.height = 16;
    const camera = try Camera.init(config);
    var closed = false;
    defer if (!closed) camera.deinit() catch {};
    try camera.start();
    var frame = try camera.acquire(0);
    try check(core.zc_release(camera.handle, frame.value.token));
    try std.testing.expectError(error.StaleFrame, frame.release());
    try std.testing.expectEqual(@as(u64, 0), frame.value.token);
    try camera.deinit();
    closed = true;
    try std.testing.expectError(error.StaleFrame, frame.retain());
    try std.testing.expectError(error.StaleFrame, frame.referenceCount());
    try std.testing.expectError(error.StaleFrame, frame.release());
    try std.testing.expectError(error.StaleFrame, frame.stream(c.ZC_MAIN));
    try std.testing.expectError(error.StaleFrame, frame.metadata());
    try std.testing.expectError(error.StaleFrame, frame.saveDng("never-created.dng"));
    try std.testing.expectError(error.StaleFrame, frame.saveJpeg("never-created.jpg", 90));
}

test "Zig catalogs own snapshots and copy/read independently after camera close" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var snapshot = try discover(c.ZC_SYNTHETIC);
    defer snapshot.deinit();
    const bytes = try snapshot.copy(std.testing.allocator);
    defer std.testing.allocator.free(bytes);
    try std.testing.expectEqual(@as(u32, 1), (try catalog_format.Reader.init(bytes)).catalog_kind);
    var cfg = defaultConfig();
    cfg.width = 16;
    cfg.height = 16;
    const cam = try Camera.init(cfg);
    var props = try cam.properties();
    defer props.deinit();
    var controls = try cam.controls();
    defer controls.deinit();
    try cam.start();
    var frame = try cam.acquire(0);
    var meta = try frame.metadataCatalog();
    defer meta.deinit();
    try frame.release();
    try std.testing.expectError(error.StaleFrame, frame.metadataCatalog());
    try cam.deinit();
    const owned = try meta.copy(std.testing.allocator);
    defer std.testing.allocator.free(owned);
    try std.testing.expectEqual(@as(u32, 4), (try catalog_format.Reader.init(owned)).catalog_kind);
    meta.deinit();
    try std.testing.expectError(error.Invalid, meta.copy(std.testing.allocator));
}

test "synthetic catalogs and DNG calibration describe the same virtual sensor" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 16;
    cfg.height = 16;
    const cam = try Camera.init(cfg);
    defer cam.deinit() catch unreachable;
    try cam.start();
    var frame = try cam.acquire(0);
    defer frame.release() catch unreachable;
    var raw_meta: c.zc_raw_metadata = undefined;
    try check(core.zc_get_raw_metadata(cam.handle, frame.value.token, &raw_meta));
    var meta = try frame.metadataCatalog();
    defer meta.deinit();
    const data = try meta.copy(std.testing.allocator);
    defer std.testing.allocator.free(data);
    var records = (try catalog_format.Reader.init(data)).records();
    var fields: u32 = 0;
    while (try records.next()) |record| {
        var values = record.values();
        const first = (try values.next()).?;
        if (std.mem.eql(u8, record.info.name, "SensorBlackLevels")) {
            fields += 1;
            for (0..4) |i| {
                const level = std.mem.readInt(i32, first.data[i * 4 ..][0..4], @import("builtin").cpu.arch.endian());
                try std.testing.expectEqual(raw_meta.black_levels[i], @as(f32, @floatFromInt(level)));
            }
        } else if (std.mem.eql(u8, record.info.name, "ColourCorrectionMatrix")) {
            fields += 1;
            try std.testing.expectEqualSlices(u8, std.mem.asBytes(&raw_meta.camera_to_srgb), first.data);
        }
    }
    try std.testing.expectEqual(@as(u32, 2), fields);
    var props = try cam.properties();
    defer props.deinit();
    const properties = try props.copy(std.testing.allocator);
    defer std.testing.allocator.free(properties);
    var property_records = (try catalog_format.Reader.init(properties)).records();
    var found = false;
    while (try property_records.next()) |record| {
        if (std.mem.eql(u8, record.info.name, "Model")) {
            var values = record.values();
            try std.testing.expectEqualStrings(std.mem.sliceTo(&raw_meta.model, 0), (try values.next()).?.data);
            found = true;
        }
    }
    try std.testing.expect(found);
}

test "Zig exact camera IDs survive open close and preserve the old index API" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 16;
    cfg.height = 16;
    const first = try Camera.init(cfg);
    const id = try first.cameraId(std.testing.allocator);
    defer std.testing.allocator.free(id);
    try first.deinit();
    const selected = try Camera.initId(cfg, id);
    defer selected.deinit() catch unreachable;
    const copy = try selected.cameraId(std.testing.allocator);
    defer std.testing.allocator.free(copy);
    try std.testing.expectEqualSlices(u8, id, copy);
    try std.testing.expectError(error.Device, Camera.initId(cfg, "missing"));
    try std.testing.expectError(error.Invalid, Camera.initId(cfg, "bad\x00id"));
}
