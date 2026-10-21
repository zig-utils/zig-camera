const std = @import("std");
pub const c = @import("abi.zig").c;
pub const core = @import("core.zig");
comptime {
    _ = core;
}
pub const raw = @import("raw.zig");
pub const ImageTransform = @import("home/orientation.zig").Transform;
pub const still = @import("still.zig");
pub const ImageOptions = c.zc_image_options;
pub const ImageProfile = c.zc_image_profile;
pub fn srgbImageProfile() ImageProfile {
    return .{ .struct_size = @sizeOf(ImageProfile), .flags = c.ZC_IMAGE_PROFILE_SRGB, .data = null, .length = 0 };
}
pub fn customImageProfile(bytes: []const u8) ImageProfile {
    return .{ .struct_size = @sizeOf(ImageProfile), .flags = 0, .data = bytes.ptr, .length = bytes.len };
}
pub fn defaultImageOptions() ImageOptions {
    var out: ImageOptions = undefined;
    core.zc_default_image_options(&out);
    return out;
}
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
pub const color_policy = @import("color_policy.zig");
comptime {
    _ = color_policy;
}
pub const preview_input = @import("preview_input.zig");
comptime {
    _ = preview_input;
}
pub const preview_view = @import("preview_view.zig");
comptime {
    _ = preview_view;
}
pub const preview_overlay = @import("preview_overlay.zig");
comptime {
    _ = preview_overlay;
}
pub const media = @import("media.zig");
pub const fanout = @import("fanout.zig");
comptime {
    _ = media;
    _ = fanout;
}
pub const pixels = @import("pixels.zig");
pub const Config = c.zc_config;
pub const ProcessedOptions = c.zc_processed_options;
pub fn defaultProcessedOptions() ProcessedOptions {
    return color_policy.defaults();
}
pub fn colorSpacePreset(preset: u32) Error!c.zc_color_space {
    var out: c.zc_color_space = undefined;
    try check(color_policy.zc_color_space_preset(preset, &out));
    return out;
}
pub const Info = c.zc_info;
pub const Stats = c.zc_stats;
pub const CaptureFilter = c.zc_capture_filter;
pub fn captureClockNs() Error!u64 {
    var stamp: u64 = 0;
    try check(@import("capture_filter.zig").zc_capture_clock_ns(&stamp));
    return stamp;
}
pub fn captureFilter(drop_frames: u32, after_ns: ?u64, exposure_guard: bool) Error!CaptureFilter {
    var filter: CaptureFilter = undefined;
    try check(@import("capture_filter.zig").zc_capture_filter_init(&filter, drop_frames, (if (after_ns != null) @as(u32, 1) else 0) | (if (after_ns != null and exposure_guard) @as(u32, 2) else 0), after_ns orelse 0));
    return filter;
}
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
    pub fn initOrientedPipeline(cfg: Config, opts: c.zc_pipeline_options, transform: @import("home/orientation.zig").Transform, strict: bool) Error!Camera {
        var out: ?*c.zc_camera = null;
        try check(core.zc_open_oriented_pipeline(&cfg, &opts, transform.orientation(), @intFromBool(strict), &out));
        return .{ .handle = out.? };
    }
    pub fn initOrientedPipelineId(cfg: Config, opts: c.zc_pipeline_options, transform: @import("home/orientation.zig").Transform, strict: bool, id: []const u8) Error!Camera {
        if (id.len > c.ZC_MAX_CAMERA_ID) return error.Invalid;
        var out: ?*c.zc_camera = null;
        try check(core.zc_open_id_oriented_pipeline(&cfg, &opts, transform.orientation(), @intFromBool(strict), id.ptr, @intCast(id.len), &out));
        return .{ .handle = out.? };
    }
    pub fn initFormattedPipeline(cfg: Config, opts: c.zc_pipeline_options, format: u32, transform: ImageTransform, strict: bool) Error!Camera {
        var out: ?*c.zc_camera = null;
        try check(core.zc_open_formatted_pipeline(&cfg, &opts, format, transform.orientation(), @intFromBool(strict), &out));
        return .{ .handle = out.? };
    }
    pub fn initFormattedPipelineId(cfg: Config, opts: c.zc_pipeline_options, format: u32, transform: ImageTransform, strict: bool, id: []const u8) Error!Camera {
        if (id.len > c.ZC_MAX_CAMERA_ID) return error.Invalid;
        var out: ?*c.zc_camera = null;
        try check(core.zc_open_id_formatted_pipeline(&cfg, &opts, format, transform.orientation(), @intFromBool(strict), id.ptr, @intCast(id.len), &out));
        return .{ .handle = out.? };
    }
    pub fn initProcessedPipeline(cfg: Config, opts: c.zc_pipeline_options, processed: ProcessedOptions, transform: ImageTransform, strict: bool) Error!Camera {
        var out: ?*c.zc_camera = null;
        try check(core.zc_open_processed_pipeline(&cfg, &opts, &processed, transform.orientation(), @intFromBool(strict), &out));
        return .{ .handle = out.? };
    }
    pub fn initProcessedPipelineId(cfg: Config, opts: c.zc_pipeline_options, processed: ProcessedOptions, transform: ImageTransform, strict: bool, id: []const u8) Error!Camera {
        if (id.len > c.ZC_MAX_CAMERA_ID) return error.Invalid;
        var out: ?*c.zc_camera = null;
        try check(core.zc_open_id_processed_pipeline(&cfg, &opts, &processed, transform.orientation(), @intFromBool(strict), id.ptr, @intCast(id.len), &out));
        return .{ .handle = out.? };
    }
    pub fn colorNegotiation(self: Camera, stream: u32) Error!c.zc_color_negotiation {
        var out: c.zc_color_negotiation = undefined;
        try check(core.zc_get_color_negotiation(self.handle, stream, &out));
        return out;
    }
    pub fn orientation(self: Camera) Error!c.zc_orientation_info {
        var result: c.zc_orientation_info = undefined;
        try check(core.zc_get_orientation(self.handle, &result));
        return result;
    }
    pub fn colorSpace(self: Camera, id: u32) Error!c.zc_color_space {
        var out: c.zc_color_space = undefined;
        try check(core.zc_get_stream_color_space(self.handle, id, &out));
        return out;
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
    pub fn setNativeControls(self: Camera, bytes: []const u8) Error!u64 {
        var revision: u64 = 0;
        try check(core.zc_set_native_controls(self.handle, bytes.ptr, bytes.len, &revision));
        return revision;
    }
    pub fn nativeControlSnapshot(self: Camera) Error!struct { catalog: Catalog, revision: u64 } {
        var out: ?*c.zc_catalog = null;
        var revision: u64 = 0;
        try check(core.zc_get_native_controls(self.handle, &out, &revision));
        return .{ .catalog = .{ .handle = out.? }, .revision = revision };
    }
    pub fn restoreNativeControls(self: Camera, bytes: []const u8, base: u64) Error!u64 {
        var revision: u64 = 0;
        try check(core.zc_restore_native_controls(self.handle, bytes.ptr, bytes.len, base, &revision));
        return revision;
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
    pub fn enableWritable(self: Camera) Error!void {
        try check(core.zc_enable_writable(self.handle));
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
    pub fn acquireFiltered(self: Camera, filter: *CaptureFilter, timeout_ms: u32) Error!Frame {
        var frame: c.zc_frame = undefined;
        try check(core.zc_acquire_filtered(self.handle, filter, timeout_ms, &frame));
        return .{ .camera = self, .value = frame };
    }
};
pub const FrameMapping = struct {
    handle: ?*c.zc_frame_map,
    write: bool,
    pub fn deinit(self: *FrameMapping) Error!void {
        const owned = self.handle orelse return;
        self.handle = null;
        try check(core.zc_frame_map_close(owned));
    }
    pub fn stream(self: FrameMapping) Error!c.zc_stream {
        var out: c.zc_stream = undefined;
        try check(core.zc_frame_map_stream(self.handle orelse return error.StaleFrame, &out));
        return out;
    }
    pub fn plane(self: FrameMapping, index: u32) Error![]const u8 {
        const value = try self.stream();
        if (index >= value.plane_count) return error.Invalid;
        return value.planes[index].data[0..@intCast(value.planes[index].bytes_used)];
    }
    pub fn writablePlane(self: FrameMapping, index: u32) Error![]u8 {
        if (!self.write) return error.Unsupported;
        return @constCast(try self.plane(index));
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
        if (rc != c.ZC_BUSY) self.value.token = 0;
        try check(rc);
    }
    pub fn rgb(self: *const Frame) pixels.RgbView.Error!pixels.RgbView {
        if (self.value.token == 0) return error.ReleasedFrame;
        const access = core.zc_frame_readable(self.camera.handle, self.value.token);
        if (access == c.ZC_BUSY) return error.BusyFrame;
        if (access != c.ZC_OK) return error.ReleasedFrame;
        const m = self.value.main;
        if (m.plane_count != 1 or !std.mem.eql(u8, std.mem.sliceTo(&m.format, 0), "BGR888")) return error.UnsupportedFormat;
        return pixels.RgbView.init(m.planes[0].data[0..@intCast(m.planes[0].bytes_used)], m.width, m.height, m.stride);
    }
    pub fn mapStream(self: *const Frame, id: u32, write: bool) Error!FrameMapping {
        if (self.value.token == 0) return error.StaleFrame;
        var out: ?*c.zc_frame_map = null;
        try check(core.zc_frame_map_open(self.camera.handle, self.value.token, id, @intFromBool(write), &out));
        return .{ .handle = out.?, .write = write };
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
    pub fn saveImage(self: *const Frame, path: [:0]const u8, options: ImageOptions) Error!void {
        return self.saveStreamImage(path, if (options.format == c.ZC_IMAGE_DNG) c.ZC_RAW else c.ZC_MAIN, options);
    }
    pub fn saveStreamImage(self: *const Frame, path: [:0]const u8, id: u32, options: ImageOptions) Error!void {
        return self.saveStreamImageProfile(path, id, options, null);
    }
    pub fn saveStreamImageProfile(self: *const Frame, path: [:0]const u8, id: u32, options: ImageOptions, profile: ?*const ImageProfile) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        try check(core.zc_save_stream_image_profile(self.camera.handle, self.value.token, id, path, &options, profile));
    }
    pub fn encodeImage(self: *const Frame, allocator: std.mem.Allocator, options: ImageOptions) Error![]u8 {
        return self.encodeStreamImage(allocator, if (options.format == c.ZC_IMAGE_DNG) c.ZC_RAW else c.ZC_MAIN, options);
    }
    pub fn encodeStreamImage(self: *const Frame, allocator: std.mem.Allocator, id: u32, options: ImageOptions) Error![]u8 {
        return self.encodeStreamImageProfile(allocator, id, options, null);
    }
    pub fn encodeStreamImageProfile(self: *const Frame, allocator: std.mem.Allocator, id: u32, options: ImageOptions, profile: ?*const ImageProfile) Error![]u8 {
        if (self.value.token == 0) return error.StaleFrame;
        var blob: ?*c.zc_image_blob = null;
        try check(core.zc_encode_stream_image_profile(self.camera.handle, self.value.token, id, &options, profile, &blob));
        defer core.zc_image_blob_close(blob);
        var length: u64 = 0;
        try check(core.zc_image_blob_copy(blob.?, null, 0, &length));
        if (length > std.math.maxInt(usize)) return error.Invalid;
        const bytes = try allocator.alloc(u8, @intCast(length));
        errdefer allocator.free(bytes);
        try check(core.zc_image_blob_copy(blob.?, bytes.ptr, bytes.len, &length));
        return bytes;
    }
    pub fn colorSpace(self: *const Frame, id: u32) Error!c.zc_color_space {
        if (self.value.token == 0) return error.StaleFrame;
        var out: c.zc_color_space = undefined;
        try check(core.zc_get_stream_color_space(self.camera.handle, id, &out));
        return out;
    }
    pub fn copyStreamRgb(self: *const Frame, id: u32, out: []u8) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        try check(core.zc_copy_stream_rgb(self.camera.handle, self.value.token, id, out.ptr, out.len));
    }
    pub fn writeVideo(self: *const Frame, recorder: *c.zc_recorder, id: u32, timestamp_ns: u64) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        if (id != c.ZC_MAIN and id != c.ZC_LORES) return error.Unsupported;
        try check(core.zc_frame_readable(self.camera.handle, self.value.token));
        var selected = self.value;
        selected.main = try self.stream(id);
        const color = try self.colorSpace(id);
        try check(media.zc_video_write_input(recorder, &selected, &color, timestamp_ns));
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
    try std.testing.expectError(error.StaleFrame, frame.encodeImage(std.testing.allocator, defaultImageOptions()));
    try std.testing.expectError(error.StaleFrame, frame.saveImage("never-created.png", defaultImageOptions()));
}
test "Zig owned encoded images survive frame and camera disposal" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 2;
    cfg.height = 1;
    cfg.policy = c.ZC_FIFO;
    const camera = try Camera.init(cfg);
    try camera.start();
    var frame = try camera.acquire(0);
    var image_options = defaultImageOptions();
    image_options.format = c.ZC_IMAGE_PPM;
    const encoded = try frame.encodeImage(std.testing.allocator, image_options);
    defer std.testing.allocator.free(encoded);
    try frame.release();
    try camera.stop();
    try camera.deinit();
    try std.testing.expectEqualSlices(u8, "P6\n2 1\n255\n" ++ [_]u8{ 0, 0, 0, 1, 0, 0 }, encoded);
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

test "Zig typed control snapshots preserve i64 and replay before first start" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 16;
    cfg.height = 16;
    const cam = try Camera.init(cfg);
    var writer = try catalog_format.Writer.init(std.testing.allocator, 6, 1024);
    defer writer.deinit();
    try writer.begin(.{ .id = 0x10001, .kind = .i64, .name = "" });
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(i64, &bytes, 9007199254740993, .little);
    try writer.append(.{ .kind = .i64, .data = &bytes });
    try writer.end();
    const revision = try cam.setNativeControls(try writer.finish());
    var snapshot = try cam.nativeControlSnapshot();
    defer snapshot.catalog.deinit();
    try std.testing.expectEqual(revision, snapshot.revision);
    try cam.deinit();
    const state = try snapshot.catalog.copy(std.testing.allocator);
    defer std.testing.allocator.free(state);
    const target = try Camera.init(cfg);
    defer target.deinit() catch unreachable;
    const restored = try target.restoreNativeControls(state, snapshot.revision);
    try std.testing.expect(restored > snapshot.revision);
    try target.start();
    var frame = try target.acquire(0);
    defer frame.release() catch unreachable;
    try std.testing.expectEqual(restored, (try frame.metadata()).control_revision);
    var metadata = try frame.metadataCatalog();
    defer metadata.deinit();
    const data = try metadata.copy(std.testing.allocator);
    defer std.testing.allocator.free(data);
    var records = (try catalog_format.Reader.init(data)).records();
    var found = false;
    while (try records.next()) |record| if (record.info.id == 0x10001) {
        var values = record.values();
        const value = (try values.next()).?;
        try std.testing.expectEqual(@as(i64, 9007199254740993), std.mem.readInt(i64, value.data[0..8], if (value.flags & 2 != 0) .little else .big));
        found = true;
    };
    try std.testing.expect(found);
}

test "Zig capture filters transfer one request after exact frame drops" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 16;
    cfg.height = 16;
    cfg.policy = c.ZC_FIFO;
    const camera = try Camera.init(cfg);
    defer camera.deinit() catch unreachable;
    const before = try captureClockNs();
    try camera.start();
    var filter = try captureFilter(3, null, true);
    var frame = try camera.acquireFiltered(&filter, 100);
    defer frame.release() catch unreachable;
    try std.testing.expectEqual(@as(u64, 3), frame.value.sequence);
    try std.testing.expect(frame.value.timestamp_ns >= before);
    try std.testing.expectEqual(@as(u32, 0), filter.remaining);
}

test "Zig scoped mappings own buffers independently and publish writable pixel edits" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 16;
    cfg.height = 16;
    const camera = try Camera.init(cfg);
    defer camera.deinit() catch unreachable;
    try camera.enableWritable();
    try camera.start();
    var frame = try camera.acquire(0);
    var mapped = try frame.mapStream(c.ZC_MAIN, true);
    (try mapped.writablePlane(0))[0] = 123;
    try std.testing.expectError(error.BusyFrame, frame.rgb());
    try mapped.deinit();
    try std.testing.expectEqual(@as(u8, 123), (try frame.rgb()).row(0)[0]);
    var reader = try frame.mapStream(c.ZC_MAIN, false);
    try frame.release();
    try std.testing.expectEqual(@as(u8, 123), (try reader.plane(0))[0]);
    try std.testing.expectError(error.Unsupported, reader.writablePlane(0));
    try reader.deinit();
    try reader.deinit();
    try std.testing.expectEqual(@as(u32, 0), camera.stats().leased);
}

test "formatted main I420 admission preserves legacy layouts and never exposes luma as RGB" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 4;
    cfg.height = 2;
    var pipeline: c.zc_pipeline_options = undefined;
    core.zc_default_pipeline_options(&pipeline);
    var invalid: ?*c.zc_camera = undefined;
    for ([_]u32{ 2, std.math.maxInt(u32) }) |format| {
        try std.testing.expectEqual(c.ZC_INVALID, core.zc_open_formatted_pipeline(&cfg, &pipeline, format, 1, 0, &invalid));
        try std.testing.expectEqual(null, invalid);
    }
    cfg.width = 3;
    try std.testing.expectEqual(c.ZC_INVALID, core.zc_open_formatted_pipeline(&cfg, &pipeline, c.ZC_YUV420, 1, 0, &invalid));
    try std.testing.expectEqual(null, invalid);
    cfg.width = 4;
    const cam = try Camera.initFormattedPipelineId(cfg, pipeline, c.ZC_YUV420, .{}, false, "synthetic");
    defer cam.deinit() catch unreachable;
    try std.testing.expectEqual(@as(u32, 3), cam.info().main.plane_count);
    const info = cam.info();
    try std.testing.expectEqualStrings("YUV420", std.mem.sliceTo(&info.main.format, 0));
    try cam.enableWritable();
    try cam.start();
    var frame = try cam.acquire(0);
    defer frame.release() catch unreachable;
    try std.testing.expectError(error.UnsupportedFormat, frame.rgb());
    var mapped = try frame.mapStream(c.ZC_MAIN, true);
    defer mapped.deinit() catch unreachable;
    @memset(try mapped.writablePlane(0), 100);
    @memset(try mapped.writablePlane(1), 64);
    @memset(try mapped.writablePlane(2), 192);
    var rgb: [24]u8 = @splat(99);
    try std.testing.expectEqual(c.ZC_BUSY, core.zc_copy_frame_rgb(cam.handle, frame.value.token, &rgb, rgb.len));
    try std.testing.expectEqual(@as(u8, 99), rgb[0]);
    try mapped.deinit();
    try std.testing.expectEqual(c.ZC_OK, core.zc_copy_frame_rgb(cam.handle, frame.value.token, &rgb, rgb.len));
    for (0..8) |i| try std.testing.expectEqualSlices(u8, &.{ 190, 76, 0 }, rgb[i * 3 ..][0..3]);
}

test "Zig ICC image profiles retain owned blobs and reject mismatched or invalid descriptors" {
    if (@import("options").libcamera) return error.SkipZigTest;
    try std.testing.expectEqual(@as(usize, 24), @sizeOf(ImageProfile));
    var cfg = defaultConfig();
    cfg.width = 18;
    cfg.height = 10;
    const camera = try Camera.init(cfg);
    defer camera.deinit() catch {};
    try camera.start();
    defer camera.stop() catch {};
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var opts = defaultImageOptions();
    opts.format = c.ZC_IMAGE_TIFF;
    var profile = srgbImageProfile();
    const bytes = try frame.encodeStreamImageProfile(std.testing.allocator, c.ZC_MAIN, opts, &profile);
    defer std.testing.allocator.free(bytes);
    try std.testing.expectEqualSlices(u8, "II", bytes[0..2]);
    profile.struct_size = 0;
    try std.testing.expectError(error.Invalid, frame.encodeStreamImageProfile(std.testing.allocator, c.ZC_MAIN, opts, &profile));
    profile = customImageProfile("broken");
    try std.testing.expectError(error.Invalid, frame.encodeStreamImageProfile(std.testing.allocator, c.ZC_MAIN, opts, &profile));
    profile = srgbImageProfile();
    const color = try colorSpacePreset(c.ZC_COLOR_REC2020);
    try std.testing.expectError(error.UnsupportedProfile, still.checkProfileSource(&profile, color));
    try frame.release();
    try std.testing.expectError(error.StaleFrame, frame.encodeStreamImageProfile(std.testing.allocator, c.ZC_MAIN, opts, &profile));
}

test "staged encoded files publish after the source camera and every frame are destroyed" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    const files = @import("image_file.zig");
    var tmp = t.tmpDir(.{});
    defer tmp.cleanup();
    const parent = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(parent);
    const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/photo.png", .{parent}, 0);
    defer t.allocator.free(path);
    var output: ?*c.zc_image_file = null;
    try check(files.zc_image_file_create(path, &output));
    defer {
        _ = files.zc_image_file_finish(output.?, 0);
        var state: c.zc_image_file_state = undefined;
        while (true) {
            _ = files.zc_image_file_state_get(output.?, &state);
            if (state.finished != 0) break;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        _ = files.zc_image_file_close(output);
    }
    var cfg = defaultConfig();
    cfg.width = 18;
    cfg.height = 10;
    const camera = try Camera.init(cfg);
    try camera.start();
    var frame = try camera.acquire(0);
    var opts = defaultImageOptions();
    opts.format = c.ZC_IMAGE_PNG;
    const profile = srgbImageProfile();
    try check(core.zc_image_file_prepare(output.?, camera.handle, frame.value.token, c.ZC_MAIN, &opts, &profile));
    try frame.release();
    try camera.stop();
    try camera.deinit();
    try t.expectError(error.FileNotFound, tmp.dir.openFile("photo.png", .{}));
    try check(files.zc_image_file_finish(output.?, 1));
    var state: c.zc_image_file_state = undefined;
    var timer = try std.time.Timer.start();
    while (timer.read() < 10 * std.time.ns_per_s) {
        try check(files.zc_image_file_state_get(output.?, &state));
        if (state.finished != 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try t.expectEqual(@as(u32, 1), state.finished);
    try t.expectEqual(@as(u32, 1), state.committed);
    try check(state.result);
    const bytes = try tmp.dir.readFileAlloc(t.allocator, "photo.png", 65536);
    defer t.allocator.free(bytes);
    try t.expectEqualSlices(u8, "\x89PNG\r\n\x1a\n", bytes[0..8]);
    try t.expectEqualSlices(u8, "iCCP", bytes[37..41]);
}
