pub const processed_format = @import("processed_format.zig");
pub const RelativeDelay = @import("home/relative_delay.zig").Delay;
pub const Tuning = @import("home/tuning.zig");
pub const TuningState = c.zc_tuning_state;
pub fn tuningState(backend: u32) Error!TuningState {
    var out: TuningState = undefined;
    try check(@import("tuning_session.zig").zc_get_tuning_state(backend, &out));
    return out;
}
pub const TuningSession = struct {
    handle: ?*c.zc_tuning_session,
    pub fn init(json: []const u8, backend: u32) Error!TuningSession {
        var out: ?*c.zc_tuning_session = null;
        try check(core.zc_tuning_session_open(json.ptr, json.len, backend, &out));
        return .{ .handle = out };
    }
    /// Close retains the owner on failure; retry after fixing cleanup errors.
    pub fn close(self: *TuningSession) Error!void {
        if (self.handle) |value| {
            try check(@import("tuning_session.zig").zc_tuning_session_close(value));
            self.handle = null;
        }
    }
};
test "public tuning session pins synthetic mode ownership until explicit close" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var tuning = try TuningSession.init("{\"one\":1}", c.ZC_SYNTHETIC);
    defer tuning.close() catch unreachable;
    var cfg: c.zc_config = undefined;
    core.zc_default_config(&cfg);
    cfg.width = 16;
    cfg.height = 16;
    var camera: ?*c.zc_camera = null;
    try check(core.zc_open(&cfg, &camera));
    try std.testing.expectEqual(@as(u32, 1), (try tuningState(c.ZC_SYNTHETIC)).manager_users);
    try check(core.zc_close(camera.?));
    try std.testing.expectEqual(@as(u32, 1), (try tuningState(c.ZC_SYNTHETIC)).session_users);
    try tuning.close();
    try std.testing.expectEqual(@as(u32, 0), (try tuningState(c.ZC_SYNTHETIC)).custom);
}
const std = @import("std");
pub const c = @import("abi.zig").c;
pub const CameraEvent = c.zc_camera_event;
pub const CameraWatchState = c.zc_camera_watch_state;
pub const CameraWatch = struct {
    handle: ?*c.zc_camera_watch,
    pub fn init(backend: u32, capacity: u32) Error!CameraWatch {
        var out: ?*c.zc_camera_watch = null;
        try check(@import("hotplug.zig").zc_camera_watch_open(backend, capacity, &out));
        return .{ .handle = out };
    }
    pub fn wait(self: CameraWatch, timeout_ms: u32) Error!CameraEvent {
        var out: CameraEvent = undefined;
        try check(@import("hotplug.zig").zc_camera_watch_wait(self.handle orelse return error.Stopped, timeout_ms, &out));
        return out;
    }
    pub fn state(self: CameraWatch) Error!CameraWatchState {
        var out: CameraWatchState = undefined;
        try check(@import("hotplug.zig").zc_camera_watch_get_state(self.handle orelse return error.Stopped, &out));
        return out;
    }
    pub fn stop(self: CameraWatch) Error!void {
        try check(@import("hotplug.zig").zc_camera_watch_stop(self.handle orelse return error.Stopped));
    }
    /// Stop and join waiters before retrying BUSY. Failed close retains ownership.
    pub fn close(self: *CameraWatch) Error!void {
        if (self.handle) |value| {
            try check(@import("hotplug.zig").zc_camera_watch_close(value));
            self.handle = null;
        }
    }
    pub fn simulateEvent(self: CameraWatch, kind: u32, id: []const u8) Error!void {
        if (id.len > c.ZC_MAX_CAMERA_ID) return error.Invalid;
        try check(@import("hotplug.zig").zc_camera_watch_simulate_event(self.handle orelse return error.Stopped, kind, id.ptr, @intCast(id.len)));
    }
};
pub const core = @import("core.zig");
comptime {
    _ = core;
}
pub const raw = @import("raw.zig");
pub const ImageTransform = @import("home/orientation.zig").Transform;
pub const still = @import("still.zig");
/// Home animation encoding over borrowed or owned raster copies. Capture
/// scheduling and sink staging remain explicit caller-owned operations.
pub const ApngEncoder = @import("home/apng_encoder.zig");
/// Home still GIF89a over borrowed gray/RGB/RGBA8/16 rows; checked palette,
/// explicit high-byte reduction and thresholded one-bit unassociated alpha.
pub const GifEncoder = @import("home/gif_encoder.zig");
pub const ImagePixels = @import("home/pixel_view.zig");
pub const ImageResample = @import("home/pixel_resample.zig");
pub const ImageOptions = c.zc_image_options;
pub const ImageProfile = c.zc_image_profile;
pub const ImageExif = c.zc_image_exif;
pub const Exif = @import("home/metadata/exif.zig");
pub fn defaultImageExif() ImageExif {
    var out: ImageExif = undefined;
    @import("exif.zig").zc_default_image_exif(&out);
    return out;
}
pub fn customImageExif(bytes: []const u8, capture_metadata: bool) ImageExif {
    return .{ .struct_size = @sizeOf(ImageExif), .flags = if (capture_metadata) c.ZC_IMAGE_EXIF_CAPTURE else 0, .data = bytes.ptr, .length = bytes.len };
}
pub fn checkImageMetadata(options: ImageOptions, profile: ?*const ImageProfile, image_exif: ?*const ImageExif) Error!void {
    try check(core.zc_check_image_metadata(&options, profile, image_exif));
}
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
pub const capture_quality = @import("home/capture_quality.zig");
pub const media = @import("media.zig");
pub const fanout = @import("fanout.zig");
comptime {
    _ = media;
    _ = fanout;
}
pub const pixels = @import("pixels.zig");
pub const Config = c.zc_config;
pub const ProcessedOptions = c.zc_processed_options;
pub const StreamAlignment = @import("home/stream_alignment.zig");
pub const AlignedConfiguration = struct { config: Config, pipeline: c.zc_pipeline_options };
pub fn alignStream(width: u32, height: u32, layout: StreamAlignment.Layout, profile: StreamAlignment.Profile, optimal: bool) Error!StreamAlignment.Plan {
    return StreamAlignment.aligned(width, height, layout, profile, optimal) catch return error.Invalid;
}
pub fn alignConfiguration(config: Config, pipeline: c.zc_pipeline_options, processed: ProcessedOptions, profile: StreamAlignment.Profile, optimal: bool) Error!AlignedConfiguration {
    var result: AlignedConfiguration = undefined;
    try check(core.zc_align_camera_configuration(&config, &pipeline, &processed, @intFromEnum(profile), @intFromBool(optimal), &result.config, &result.pipeline));
    return result;
}
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
pub const FrameSyncState = c.zc_frame_sync_state;
pub fn syncCaptureFilter(drop_frames: u32, after_ns: ?u64, exposure_guard: bool) Error!CaptureFilter {
    var filter = try captureFilter(drop_frames, after_ns, exposure_guard);
    filter.flags |= c.ZC_CAPTURE_SYNC_READY;
    return filter;
}
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
/// Owned compact stream ranges and request metadata; no borrowed camera pointer.
pub const StreamBundle = struct {
    layouts: [3]c.zc_packed_stream,
    count: u32,
    data: []u8,
    metadata: c.zc_metadata,
    pub fn bytes(self: StreamBundle, id: u32) ?[]const u8 {
        for (self.layouts[0..self.count]) |layout| if (layout.stream == id) return self.data[@intCast(layout.offset)..][0..@intCast(layout.length)];
        return null;
    }
    pub fn deinit(self: *StreamBundle, allocator: std.mem.Allocator) void {
        allocator.free(self.data);
        self.data = &.{};
        self.count = 0;
    }
};
pub const Error = error{ Invalid, Stopped, Timeout, Busy, StaleFrame, Io, OutOfMemory, Unsupported, Device, Disconnected, Cancelled };
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
        c.ZC_DISCONNECTED => error.Disconnected,
        c.ZC_CANCELLED => error.Cancelled,
        else => error.Device,
    };
}
pub fn defaultConfig() Config {
    var cfg: Config = undefined;
    core.zc_default_config(&cfg);
    return cfg;
}
/// Parent-owned atomic output; finish only after joined source/result validation.
pub const StagedImageFile = struct {
    handle: ?*c.zc_image_file,
    const api = @import("image_file.zig");
    pub fn init(path: [:0]const u8) Error!StagedImageFile {
        var out: ?*c.zc_image_file = null;
        try check(api.zc_image_file_create(path.ptr, &out));
        return .{ .handle = out.? };
    }
    pub fn prepareBytes(self: StagedImageFile, bytes: []const u8) Error!void {
        try check(api.zc_image_file_prepare_bytes(self.handle orelse return error.StaleFrame, bytes.ptr, bytes.len));
    }
    pub fn prepared(self: StagedImageFile) Error!bool {
        var result: c_int = undefined;
        const rc = api.zc_image_file_preparation_result(self.handle orelse return error.StaleFrame, &result);
        if (rc == c.ZC_TIMEOUT) return false;
        try check(rc);
        try check(result);
        return true;
    }
    pub fn state(self: StagedImageFile) Error!c.zc_image_file_state {
        var out: c.zc_image_file_state = undefined;
        try check(api.zc_image_file_state_get(self.handle orelse return error.StaleFrame, &out));
        return out;
    }
    pub fn finish(self: StagedImageFile, publish: bool) Error!void {
        try check(api.zc_image_file_finish(self.handle orelse return error.StaleFrame, @intFromBool(publish)));
    }
    pub fn deinit(self: *StagedImageFile) Error!void {
        const owned = self.handle orelse return;
        try check(api.zc_image_file_close(owned));
        self.handle = null;
    }
};
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
    pub fn deviceState(self: Camera) Error!c.zc_device_state {
        var out: c.zc_device_state = undefined;
        try check(core.zc_get_device_state(self.handle, &out));
        return out;
    }
    pub fn waitDisconnected(self: Camera, timeout_ms: u32) Error!c.zc_device_state {
        var out: c.zc_device_state = undefined;
        try check(core.zc_wait_disconnected(self.handle, timeout_ms, &out));
        return out;
    }
    pub fn simulateDisconnect(self: Camera) Error!void {
        try check(core.zc_simulate_disconnect(self.handle));
    }
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
    pub fn acquireAndStop(self: Camera, timeout_ms: u32) Error!Frame {
        var frame: c.zc_frame = undefined;
        try check(core.zc_acquire_and_stop(self.handle, timeout_ms, &frame));
        return .{ .camera = self, .value = frame };
    }
    pub fn acquireFiltered(self: Camera, filter: *CaptureFilter, timeout_ms: u32) Error!Frame {
        var frame: c.zc_frame = undefined;
        try check(core.zc_acquire_filtered(self.handle, filter, timeout_ms, &frame));
        return .{ .camera = self, .value = frame };
    }
    pub fn acquireSynced(self: Camera, timeout_ms: u32) Error!Frame {
        var filter = try syncCaptureFilter(0, null, false);
        return self.acquireFiltered(&filter, timeout_ms);
    }
};
test "public device loss API preserves typed terminal errors and completed frames" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 16;
    cfg.height = 16;
    const camera = try Camera.init(cfg);
    defer camera.deinit() catch unreachable;
    try std.testing.expectEqual(@as(u32, 1), (try camera.deviceState()).connected);
    try camera.start();
    var frame = try camera.acquire(0);
    try camera.simulateDisconnect();
    try std.testing.expectEqual(@as(u32, 0), (try camera.waitDisconnected(0)).connected);
    try std.testing.expectError(error.Disconnected, camera.acquire(0));
    try frame.release();
    try std.testing.expectError(error.Disconnected, camera.start());
}
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
/// Hold until every remote consumer has unmapped and acknowledged, or exited.
/// Descriptor numbers are borrowed until deinit; fd duplication is not a lease.
pub const FrameExport = struct {
    handle: ?*c.zc_frame_export,
    pub fn deinit(self: *FrameExport) Error!void {
        const owned = self.handle orelse return;
        self.handle = null;
        try check(@import("frame_export.zig").zc_frame_export_close(owned));
    }
    pub fn info(self: FrameExport) Error!c.zc_export_info {
        var out: c.zc_export_info = undefined;
        try check(@import("frame_export.zig").zc_frame_export_info(self.handle orelse return error.StaleFrame, &out));
        return out;
    }
    pub fn configurationCatalog(self: FrameExport, allocator: std.mem.Allocator) ![]u8 {
        const owned = self.handle orelse return error.StaleFrame;
        const configuration_api = @import("frame_export.zig");
        var size: u64 = 0;
        try check(configuration_api.zc_frame_export_configuration_copy(owned, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(configuration_api.zc_frame_export_configuration_copy(owned, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    pub fn metadataCatalog(self: FrameExport, allocator: std.mem.Allocator) ![]u8 {
        const owned = self.handle orelse return error.StaleFrame;
        const api = @import("frame_export.zig");
        var size: u64 = 0;
        try check(api.zc_frame_export_catalog_copy(owned, null, 0, &size));
        const data = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(data);
        try check(api.zc_frame_export_catalog_copy(owned, data.ptr, data.len, &size));
        return data;
    }
    pub fn rawMetadata(self: FrameExport) Error!c.zc_raw_metadata {
        var out: c.zc_raw_metadata = undefined;
        try check(@import("frame_export.zig").zc_frame_export_raw_metadata(self.handle orelse return error.StaleFrame, &out));
        return out;
    }
};
/// Local fd transport. No implicit camera retirement or child supervision.
/// Move-only owners; join remote views before ACK or sender export deinit.
pub const FrameChannel = struct {
    fd: i32 = -1,
    const api = @import("frame_channel.zig");
    pub fn pair() Error![2]FrameChannel {
        var fds: [2]i32 = undefined;
        try check(api.zc_frame_channel_pair(&fds));
        return .{ .{ .fd = fds[0] }, .{ .fd = fds[1] } };
    }
    pub fn fromFd(borrowed: i32) Error!FrameChannel {
        var fd: i32 = -1;
        try check(api.zc_frame_channel_duplicate(borrowed, &fd));
        return .{ .fd = fd };
    }
    pub fn deinit(self: *FrameChannel) Error!void {
        const owned = self.fd;
        self.fd = -1;
        try check(api.zc_frame_channel_close(owned));
    }
    pub fn send(self: FrameChannel, loan: FrameExport, cookie: u64) Error!void {
        try check(api.zc_frame_channel_send(self.fd, loan.handle orelse return error.StaleFrame, cookie));
    }
    pub const Receipt = struct { frame: RemoteFrame, cookie: u64 };
    pub fn receive(self: FrameChannel) Error!Receipt {
        var receipt: Receipt = .{ .frame = .{ .handle = null }, .cookie = 0 };
        try check(api.zc_frame_channel_receive(self.fd, &receipt.frame.handle, &receipt.cookie));
        return receipt;
    }
    pub fn acknowledge(self: FrameChannel, cookie: u64) Error!void {
        try check(api.zc_frame_channel_ack(self.fd, cookie));
    }
    pub fn receiveAcknowledgement(self: FrameChannel) Error!u64 {
        var cookie: u64 = 0;
        try check(api.zc_frame_channel_receive_ack(self.fd, &cookie));
        return cookie;
    }
};
pub fn defaultImageJobLimits() c.zc_image_job_limits {
    var limits: c.zc_image_job_limits = undefined;
    @import("image_job.zig").zc_default_image_job_limits(&limits);
    return limits;
}
/// Joined native still encoding. Caller retains an optional staged file until close.
pub const ImageEncodeJob = struct {
    handle: ?*c.zc_image_job,
    const api = @import("image_job.zig");
    pub fn state(self: ImageEncodeJob) Error!c.zc_image_job_state {
        var out: c.zc_image_job_state = undefined;
        try check(api.zc_image_job_state_get(self.handle orelse return error.StaleFrame, &out));
        return out;
    }
    pub fn cancel(self: ImageEncodeJob) Error!bool {
        return api.zc_image_job_cancel(self.handle orelse return error.StaleFrame) == 1;
    }
    pub fn take(self: ImageEncodeJob, allocator: std.mem.Allocator) Error![]u8 {
        var blob: ?*c.zc_image_blob = null;
        try check(api.zc_image_job_take_blob(self.handle orelse return error.StaleFrame, &blob));
        defer core.zc_image_blob_close(blob.?);
        var size: u64 = 0;
        try check(core.zc_image_blob_copy(blob.?, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(core.zc_image_blob_copy(blob.?, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    pub fn deinit(self: *ImageEncodeJob) Error!void {
        const owned = self.handle orelse return;
        try check(api.zc_image_job_close(owned));
        self.handle = null;
    }
};
pub const RemoteFrame = struct {
    handle: ?*c.zc_remote_frame,
    const api = @import("frame_channel.zig");
    pub fn deinit(self: *RemoteFrame) Error!void {
        const owned = self.handle orelse return;
        self.handle = null;
        try check(api.zc_remote_frame_close(owned));
    }
    pub fn info(self: RemoteFrame) Error!c.zc_export_info {
        var out: c.zc_export_info = undefined;
        try check(api.zc_remote_frame_info(self.handle orelse return error.StaleFrame, &out));
        return out;
    }
    pub fn stream(self: RemoteFrame, id: u32) Error!c.zc_stream {
        var out: c.zc_stream = undefined;
        try check(api.zc_remote_frame_stream(self.handle orelse return error.StaleFrame, id, &out));
        return out;
    }
    pub fn configurationCatalog(self: RemoteFrame, allocator: std.mem.Allocator) ![]u8 {
        const owned = self.handle orelse return error.StaleFrame;
        const configuration_api = @import("frame_channel.zig");
        var size: u64 = 0;
        try check(configuration_api.zc_remote_frame_configuration_copy(owned, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(configuration_api.zc_remote_frame_configuration_copy(owned, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    pub fn metadataCatalog(self: RemoteFrame, allocator: std.mem.Allocator) ![]u8 {
        const owned = self.handle orelse return error.StaleFrame;
        var size: u64 = 0;
        try check(api.zc_remote_frame_catalog_copy(owned, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(api.zc_remote_frame_catalog_copy(owned, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    pub fn copyRgb(self: RemoteFrame, allocator: std.mem.Allocator, id: u32, bits: u32) ![]u8 {
        const owned = self.handle orelse return error.StaleFrame;
        var size: u64 = 0;
        try check(api.zc_remote_frame_copy_rgb(owned, id, bits, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(api.zc_remote_frame_copy_rgb(owned, id, bits, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    pub fn rawMetadata(self: RemoteFrame) Error!c.zc_raw_metadata {
        var out: c.zc_raw_metadata = undefined;
        try check(api.zc_remote_frame_raw_metadata(self.handle orelse return error.StaleFrame, &out));
        return out;
    }
    pub fn copyStreams(self: RemoteFrame, allocator: std.mem.Allocator, ids: []const u32) Error!StreamBundle {
        const owned = self.handle orelse return error.StaleFrame;
        if (ids.len == 0 or ids.len > 3) return error.Invalid;
        var result: StreamBundle = .{ .layouts = undefined, .count = @intCast(ids.len), .data = &.{}, .metadata = (try self.info()).metadata };
        var size: u64 = 0;
        try check(api.zc_remote_frame_copy_streams(owned, ids.ptr, result.count, &result.layouts, 3, null, 0, &size));
        result.data = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(result.data);
        try check(api.zc_remote_frame_copy_streams(owned, ids.ptr, result.count, &result.layouts, 3, result.data.ptr, result.data.len, &size));
        return result;
    }
    pub fn copyRaw16(self: RemoteFrame, out: []u8) Error!void {
        var size: u64 = 0;
        try check(api.zc_remote_frame_copy_raw16(self.handle orelse return error.StaleFrame, out.ptr, out.len, &size));
    }
    pub fn encodeDng(self: RemoteFrame, allocator: std.mem.Allocator) Error![]u8 {
        var blob: ?*c.zc_image_blob = null;
        try check(api.zc_remote_frame_encode_dng(self.handle orelse return error.StaleFrame, &blob));
        defer core.zc_image_blob_close(blob.?);
        var size: u64 = 0;
        try check(core.zc_image_blob_copy(blob.?, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(core.zc_image_blob_copy(blob.?, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    pub fn saveDng(self: RemoteFrame, path: [:0]const u8) Error!void {
        try check(api.zc_remote_frame_save_dng(self.handle orelse return error.StaleFrame, path.ptr));
    }
    pub fn encodeImage(self: RemoteFrame, allocator: std.mem.Allocator, id: u32, opts: c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif) Error![]u8 {
        var blob: ?*c.zc_image_blob = null;
        try check(api.zc_remote_frame_encode_image_metadata(self.handle orelse return error.StaleFrame, id, &opts, profile, metadata, &blob));
        defer core.zc_image_blob_close(blob.?);
        var size: u64 = 0;
        try check(core.zc_image_blob_copy(blob.?, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(core.zc_image_blob_copy(blob.?, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    /// Owns the selected source before return; no remote maps/lease survive admission.
    pub fn encodeImageAsync(self: RemoteFrame, id: u32, opts: c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, limits: ?*const c.zc_image_job_limits, file: ?*c.zc_image_file) Error!ImageEncodeJob {
        var out: ?*c.zc_image_job = null;
        try check(api.zc_remote_frame_encode_async(self.handle orelse return error.StaleFrame, id, &opts, profile, metadata, limits, file, &out));
        return .{ .handle = out.? };
    }
    pub fn saveImage(self: RemoteFrame, id: u32, path: [:0]const u8, opts: c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif) Error!void {
        try check(api.zc_remote_frame_save_image_metadata(self.handle orelse return error.StaleFrame, id, path.ptr, &opts, profile, metadata));
    }
};
/// Native ownership/dispatch for cooperating process supervisors. The host must
/// verify OS peer exit before workerJoined; stopping/sending a signal is not proof.
pub const ProcessSession = struct {
    handle: ?*c.zc_process_session,
    const api = @import("process_session.zig");
    pub const Ticket = struct { cookie: u64, worker: u32, generation: u64 };
    pub fn init(workers: u32, items: u32, bytes: u64) Error!ProcessSession {
        var out: ?*c.zc_process_session = null;
        try check(api.zc_process_open(workers, items, bytes, &out));
        return .{ .handle = out };
    }
    fn open(self: ProcessSession) Error!*c.zc_process_session {
        return self.handle orelse error.StaleFrame;
    }
    /// BUSY retains this owner until tasks/callbacks and peers have joined.
    pub fn deinit(self: *ProcessSession) Error!void {
        const p = self.handle orelse return;
        try check(api.zc_process_close(p));
        self.handle = null;
    }
    pub fn submitMove(self: ProcessSession, loan: *FrameExport, args: []const u8) Error!Ticket {
        return self.submitMoveReserved(loan, args, 0);
    }
    pub fn submitMoveReserved(self: ProcessSession, loan: *FrameExport, args: []const u8, result_capacity: u64) Error!Ticket {
        var ticket: Ticket = undefined;
        try check(api.zc_process_submit(try self.open(), loan.handle orelse return error.StaleFrame, args.ptr, args.len, result_capacity, &ticket.cookie, &ticket.worker, &ticket.generation));
        loan.handle = null;
        return ticket;
    }
    pub fn next(self: ProcessSession, worker: u32, generation: u64) Error!?u64 {
        var cookie: u64 = 0;
        const rc = api.zc_process_next(try self.open(), worker, generation, &cookie);
        if (rc == c.ZC_TIMEOUT) return null;
        try check(rc);
        return cookie;
    }
    pub fn send(self: ProcessSession, cookie: u64, channel: FrameChannel) Error!void {
        try check(api.zc_process_send(try self.open(), cookie, channel.fd));
    }
    pub fn payload(self: ProcessSession, allocator: std.mem.Allocator, cookie: u64) ![]u8 {
        var size: u64 = 0;
        try check(api.zc_process_payload_copy(try self.open(), cookie, null, 0, &size));
        const bytes = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(bytes);
        try check(api.zc_process_payload_copy(try self.open(), cookie, bytes.ptr, bytes.len, &size));
        return bytes;
    }
    pub fn receiveAcknowledgement(self: ProcessSession, worker: u32, generation: u64, channel: FrameChannel) Error!u64 {
        var cookie: u64 = 0;
        try check(api.zc_process_receive_ack(try self.open(), worker, generation, channel.fd, &cookie));
        return cookie;
    }
    pub fn stopWorker(self: ProcessSession, worker: u32, generation: u64) Error!void {
        try check(api.zc_process_stop_worker(try self.open(), worker, generation));
    }
    pub fn workerJoined(self: ProcessSession, worker: u32, generation: u64) Error!void {
        try check(api.zc_process_worker_joined(try self.open(), worker, generation));
    }
    pub fn restartWorker(self: ProcessSession, worker: u32, generation: u64) Error!u64 {
        var next_generation: u64 = 0;
        try check(api.zc_process_restart_worker(try self.open(), worker, generation, &next_generation));
        return next_generation;
    }
    pub fn retire(self: ProcessSession, cookie: u64) Error!void {
        try check(api.zc_process_retire(try self.open(), cookie));
    }
    pub fn release(self: ProcessSession, cookie: u64) Error!void {
        try check(api.zc_process_release(try self.open(), cookie));
    }
    pub fn pendingThrough(self: ProcessSession, target: u64) Error!bool {
        var pending: u32 = 0;
        try check(api.zc_process_pending_through(try self.open(), target, &pending));
        return pending != 0;
    }
    pub fn state(self: ProcessSession) Error!c.zc_process_state {
        var out: c.zc_process_state = undefined;
        try check(api.zc_process_get_state(try self.open(), &out));
        return out;
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
    pub fn exportFrame(self: *const Frame, streams: u32, writable: bool) Error!FrameExport {
        if (self.value.token == 0) return error.StaleFrame;
        var out: ?*c.zc_frame_export = null;
        try check(@import("frame_export.zig").zc_frame_export_open(self.camera.handle, self.value.token, streams, @intFromBool(writable), &out));
        return .{ .handle = out.? };
    }
    pub fn stream(self: *const Frame, id: u32) Error!c.zc_stream {
        if (self.value.token == 0) return error.StaleFrame;
        var out: c.zc_stream = undefined;
        try check(core.zc_get_stream(self.camera.handle, self.value.token, id, &out));
        return out;
    }
    pub fn configurationCatalog(self: *const Frame) Error!Catalog {
        if (self.value.token == 0) return error.StaleFrame;
        var out: ?*c.zc_catalog = null;
        try check(core.zc_frame_configuration_catalog(self.camera.handle, self.value.token, &out));
        return .{ .handle = out.? };
    }
    pub fn metadataCatalog(self: *const Frame) Error!Catalog {
        if (self.value.token == 0) return error.StaleFrame;
        var out: ?*c.zc_catalog = null;
        try check(core.zc_frame_metadata_catalog(self.camera.handle, self.value.token, &out));
        return .{ .handle = out.? };
    }
    /// One independent compact RGB8/RGB16 copy. null preserves native precision;
    /// sixteen bits requires a word source. No camera/lease pointer is retained.
    pub fn makeImage(self: *const Frame, allocator: std.mem.Allocator, id: u32, bits: ?u8) !ImagePixels.Owned {
        if (self.value.token == 0) return error.StaleFrame;
        if (id == c.ZC_RAW) return error.Unsupported;
        const selected = try self.stream(id);
        const wide = processed_format.isWide(std.mem.sliceTo(&selected.format, 0));
        const precision: u8 = bits orelse if (wide) 16 else 8;
        if (precision != 8 and precision != 16) return error.Invalid;
        if (precision == 16 and !wide) return error.Unsupported;
        const row = try ImagePixels.packedRow(selected.width, .rgb, precision);
        const size = try std.math.mul(usize, row, selected.height);
        if (size > 256 * 1024 * 1024) return error.Invalid;
        const data = try allocator.alloc(u8, size);
        errdefer allocator.free(data);
        try check(if (precision == 16) core.zc_copy_stream_rgb16(self.camera.handle, self.value.token, id, data.ptr, data.len) else core.zc_copy_stream_rgb(self.camera.handle, self.value.token, id, data.ptr, data.len));
        return .{ .allocator = allocator, .view = .{ .data = data, .width = selected.width, .height = selected.height, .stride = row, .format = .rgb, .bits = precision, .endian = .little } };
    }
    pub fn metadata(self: *const Frame) Error!c.zc_metadata {
        if (self.value.token == 0) return error.StaleFrame;
        var out: c.zc_metadata = undefined;
        try check(core.zc_get_frame_metadata(self.camera.handle, self.value.token, &out));
        return out;
    }
    pub fn synchronization(self: *const Frame) Error!FrameSyncState {
        if (self.value.token == 0) return error.StaleFrame;
        var out: FrameSyncState = undefined;
        try check(core.zc_get_frame_sync_state(self.camera.handle, self.value.token, &out));
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
        return self.saveStreamImageMetadata(path, id, options, profile, null);
    }
    pub fn saveStreamImageMetadata(self: *const Frame, path: [:0]const u8, id: u32, options: ImageOptions, profile: ?*const ImageProfile, image_exif: ?*const ImageExif) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        try check(core.zc_save_stream_image_metadata(self.camera.handle, self.value.token, id, path, &options, profile, image_exif));
    }
    pub fn encodeImage(self: *const Frame, allocator: std.mem.Allocator, options: ImageOptions) Error![]u8 {
        return self.encodeStreamImage(allocator, if (options.format == c.ZC_IMAGE_DNG) c.ZC_RAW else c.ZC_MAIN, options);
    }
    /// Input is copied under the request gate before returning. Release the
    /// frame independently; retain this job until its worker finishes and joins.
    pub fn encodeImageAsync(self: *const Frame, id: u32, opts: ImageOptions, profile: ?*const ImageProfile, image_exif: ?*const ImageExif, limits: ?*const c.zc_image_job_limits, file: ?*c.zc_image_file) Error!ImageEncodeJob {
        if (self.value.token == 0) return error.StaleFrame;
        var out: ?*c.zc_image_job = null;
        try check(core.zc_encode_stream_image_async(self.camera.handle, self.value.token, id, &opts, profile, image_exif, limits, file, &out));
        return .{ .handle = out.? };
    }
    pub fn encodeStreamImage(self: *const Frame, allocator: std.mem.Allocator, id: u32, options: ImageOptions) Error![]u8 {
        return self.encodeStreamImageProfile(allocator, id, options, null);
    }
    pub fn encodeStreamImageProfile(self: *const Frame, allocator: std.mem.Allocator, id: u32, options: ImageOptions, profile: ?*const ImageProfile) Error![]u8 {
        return self.encodeStreamImageMetadata(allocator, id, options, profile, null);
    }
    pub fn encodeStreamImageMetadata(self: *const Frame, allocator: std.mem.Allocator, id: u32, options: ImageOptions, profile: ?*const ImageProfile, image_exif: ?*const ImageExif) Error![]u8 {
        if (self.value.token == 0) return error.StaleFrame;
        var blob: ?*c.zc_image_blob = null;
        try check(core.zc_encode_stream_image_metadata(self.camera.handle, self.value.token, id, &options, profile, image_exif, &blob));
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
    pub fn copyRaw16(self: *const Frame, out: []u8) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        try check(core.zc_copy_raw16(self.camera.handle, self.value.token, out.ptr, out.len));
    }
    pub fn copyStreamRgb16(self: *const Frame, id: u32, out: []u8) Error!void {
        if (self.value.token == 0) return error.StaleFrame;
        try check(core.zc_copy_stream_rgb16(self.camera.handle, self.value.token, id, out.ptr, out.len));
    }
    pub fn copyStreams(self: *const Frame, allocator: std.mem.Allocator, ids: []const u32) Error!StreamBundle {
        if (self.value.token == 0) return error.StaleFrame;
        if (ids.len == 0 or ids.len > 3) return error.Invalid;
        var result: StreamBundle = .{ .layouts = undefined, .count = @intCast(ids.len), .data = &.{}, .metadata = undefined };
        var size: u64 = 0;
        try check(core.zc_copy_frame_streams(self.camera.handle, self.value.token, ids.ptr, result.count, &result.layouts, 3, null, 0, &size, &result.metadata));
        if (size > std.math.maxInt(usize)) return error.Invalid;
        result.data = try allocator.alloc(u8, @intCast(size));
        errdefer allocator.free(result.data);
        try check(core.zc_copy_frame_streams(self.camera.handle, self.value.token, ids.ptr, result.count, &result.layouts, 3, result.data.ptr, result.data.len, &size, &result.metadata));
        return result;
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
    _ = ApngEncoder;
    _ = GifEncoder;
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
test "Zig alignment plans open the requested paired processed and raw stream geometry" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 191;
    cfg.height = 101;
    cfg.raw = 1;
    var pipe: c.zc_pipeline_options = undefined;
    core.zc_default_pipeline_options(&pipe);
    pipe.capture.unpacked_raw = 1;
    pipe.lores_width = 129;
    pipe.lores_height = 65;
    const geometry = try alignStream(191, 101, .packed_pixels, .pisp, true);
    try t.expectEqual(@as(u32, 128), geometry.width);
    try t.expectEqual(@as(u32, 100), geometry.height);
    const plan = try alignConfiguration(cfg, pipe, defaultProcessedOptions(), .pisp, true);
    try t.expectEqual(@as(u32, 191), cfg.width);
    try t.expectEqual(@as(u32, 129), pipe.lores_width);
    const camera = try Camera.initPipeline(plan.config, plan.pipeline);
    defer camera.deinit() catch unreachable;
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch unreachable;
    try t.expectEqual(@as(u32, 128), frame.value.main.width);
    try t.expectEqual(@as(u32, 100), frame.value.main.height);
    const lores = try frame.stream(c.ZC_LORES);
    try t.expectEqual(@as(u32, 128), lores.width);
    try t.expectEqual(@as(u32, 64), lores.height);
    try t.expectEqual(@as(u32, 128), frame.value.raw.width);
    try t.expectEqual(@as(u32, 100), frame.value.raw.height);
}
test "Zig synchronized acquisition composes typed controls filters and retained request metadata" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 8;
    cfg.height = 6;
    cfg.policy = c.ZC_FIFO;
    const camera = try Camera.init(cfg);
    defer camera.deinit() catch unreachable;
    var writer = try catalog_format.Writer.init(t.allocator, 6, 1024);
    defer writer.deinit();
    try writer.begin(.{ .id = 0x10001 + 10, .kind = .i32, .name = "SyncMode", .vendor = "rpi", .flags = 32 });
    var bytes: [4]u8 = undefined;
    std.mem.writeInt(i32, &bytes, 1, .little);
    try writer.append(.{ .kind = .i32, .data = &bytes });
    try writer.end();
    _ = try camera.setNativeControls(try writer.finish());
    try camera.start();
    var frame = try camera.acquireSynced(100);
    defer if (frame.value.token != 0) frame.release() catch unreachable;
    try t.expectEqual(@as(u64, 2), frame.value.sequence);
    try t.expectEqual(@as(u32, 1), (try frame.synchronization()).ready);
    var filter = try syncCaptureFilter(1, 0, true);
    try t.expectEqual(@as(u32, 7), filter.flags);
    var next = try camera.acquireFiltered(&filter, 100);
    defer if (next.value.token != 0) next.release() catch unreachable;
    try t.expectEqual(@as(u64, 4), next.value.sequence);
    try t.expect((try next.synchronization()).timer_us < 0);
    try next.release();
    try camera.stop();
    try t.expectEqual(@as(i64, 0), (try frame.synchronization()).timer_us);
    try frame.release();
    try t.expectError(error.StaleFrame, frame.synchronization());
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
    for ([_]u32{ 14, std.math.maxInt(u32) }) |format| {
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

test "public Home APNG encodes copied RGB and RGB16 captures after camera retirement" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const a = std.testing.allocator;
    inline for (.{ c.ZC_RGB24, c.ZC_RGB48 }) |format| {
        var cfg = defaultConfig();
        cfg.width = 16;
        cfg.height = 16;
        cfg.buffer_count = 2;
        const bits: u8 = if (format == c.ZC_RGB48) 16 else 8;
        const bytes_per_pixel: usize = 3 * @as(usize, bits / 8);
        var copies: [2][16 * 16 * bytes_per_pixel]u8 = undefined;
        {
            var pipeline: c.zc_pipeline_options = undefined;
            core.zc_default_pipeline_options(&pipeline);
            const camera = try Camera.initFormattedPipeline(cfg, pipeline, format, .{}, false);
            defer camera.deinit() catch unreachable;
            try camera.start();
            defer camera.stop() catch unreachable;
            for (&copies) |*copy| {
                var frame = try camera.acquire(1000);
                defer frame.release() catch unreachable;
                if (bits == 16) try frame.copyStreamRgb16(c.ZC_MAIN, copy) else try frame.copyStreamRgb(c.ZC_MAIN, copy);
            }
        }
        var frames: [2]ApngEncoder.Frame = undefined;
        for (&frames, &copies) |*frame, *copy| frame.* = .{
            .view = .{ .data = copy, .width = 16, .height = 16, .stride = 16 * bytes_per_pixel, .bits = bits },
            .delay = try ApngEncoder.Delay.fromMilliseconds(40),
        };
        const encoded = try ApngEncoder.encode(a, .{ .width = 16, .height = 16, .frames = &frames });
        defer a.free(encoded);
        const saved = std.hash.Crc32.hash(encoded);
        for (&copies) |*copy| @memset(copy, 0xee);
        try std.testing.expectEqual(saved, std.hash.Crc32.hash(encoded));
        try std.testing.expectEqualSlices(u8, &.{ 137, 80, 78, 71, 13, 10, 26, 10 }, encoded[0..8]);
        try std.testing.expectEqual(bits, encoded[24]);
        var at: usize = 8;
        var controls: usize = 0;
        var ended = false;
        while (at < encoded.len) {
            const length = std.mem.readInt(u32, encoded[at..][0..4], .big);
            const kind = encoded[at + 4 ..][0..4];
            if (std.mem.eql(u8, kind, "fcTL")) controls += 1;
            if (std.mem.eql(u8, kind, "IEND")) ended = true;
            at += 12 + length;
        }
        try std.testing.expectEqual(@as(usize, 2), controls);
        try std.testing.expect(ended);
    }
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

test "Zig capture Exif uses selected stream dimensions and returns owned metadata" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
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
    var descriptor = defaultImageExif();
    try checkImageMetadata(opts, null, &descriptor);
    const encoded = try frame.encodeStreamImageMetadata(t.allocator, c.ZC_MAIN, opts, null, &descriptor);
    defer t.allocator.free(encoded);
    try frame.release();
    var parsed = try Exif.parse(t.allocator, encoded);
    defer parsed.deinit();
    try t.expectEqualStrings("zig-camera", parsed.software.?);
    try t.expectEqual(@as(u32, 18), parsed.width);
    try t.expectEqual(@as(u32, 10), parsed.height);
    opts.format = c.ZC_IMAGE_BMP;
    try t.expectError(error.Unsupported, checkImageMetadata(opts, null, &descriptor));
    descriptor = customImageExif("broken", false);
    opts.format = c.ZC_IMAGE_JPEG;
    try t.expectError(error.Invalid, checkImageMetadata(opts, null, &descriptor));
}

test "Zig stream bundles retain compact source ranges and metadata after camera destruction" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 18;
    cfg.height = 10;
    cfg.raw = 1;
    cfg.policy = c.ZC_FIFO;
    var pipeline: c.zc_pipeline_options = undefined;
    core.zc_default_pipeline_options(&pipeline);
    pipeline.capture.unpacked_raw = 1;
    pipeline.lores_width = 8;
    pipeline.lores_height = 6;
    const camera = try Camera.initPipeline(cfg, pipeline);
    var live = true;
    defer if (live) camera.deinit() catch {};
    try camera.start();
    var frame = try camera.acquire(0);
    errdefer frame.release() catch {};
    var bundle = try frame.copyStreams(t.allocator, &.{ c.ZC_RAW, c.ZC_LORES, c.ZC_MAIN });
    defer bundle.deinit(t.allocator);
    try t.expectEqual(frame.value.sequence, bundle.metadata.sequence);
    try t.expectEqual(@as(usize, 360), bundle.bytes(c.ZC_RAW).?.len);
    try t.expectEqual(@as(usize, 72), bundle.bytes(c.ZC_LORES).?.len);
    try t.expectEqual(@as(?[]const u8, null), bundle.bytes(3));
    try frame.release();
    try camera.stop();
    try camera.deinit();
    live = false;
    try t.expectEqualSlices(u8, &.{ 0, 0, 0, 1, 0, 0 }, bundle.bytes(c.ZC_MAIN).?[0..6]);
}

test "Zig acquireAndStop transfers readable ownership without an extra native reference" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 8;
    cfg.height = 6;
    const camera = try Camera.init(cfg);
    defer camera.deinit() catch {};
    try camera.start();
    var request = try camera.acquireAndStop(0);
    defer request.release() catch {};
    try t.expectEqual(@as(u32, 1), try request.referenceCount());
    const rgb = try request.rgb();
    try t.expectEqual(@as(usize, 8), rgb.width);
    try t.expectEqual(@as(usize, 6), rgb.height);
    try t.expectEqual(@as(usize, 24), rgb.row(0).len);
    try t.expectError(error.Busy, camera.start());
    var sibling = try request.retain();
    defer sibling.release() catch {};
    try request.release();
    try t.expectEqual(@as(u32, 1), try sibling.referenceCount());
    try sibling.release();
    try camera.start();
    try camera.stop();
}

test "public Zig watch spans closed camera gaps and retains explicit terminal ownership" {
    var watch = try CameraWatch.init(c.ZC_SYNTHETIC, 2);
    defer watch.close() catch unreachable;
    try std.testing.expectError(error.Timeout, watch.wait(0));
    try watch.simulateEvent(c.ZC_CAMERA_ADDED, "Cam/1");
    const event = try watch.wait(0);
    try std.testing.expectEqualStrings("Cam/1", event.id[0..event.id_length]);
    try std.testing.expectEqual(@as(u32, 0), (try watch.state()).queued);
    var snapshot = try discover(c.ZC_SYNTHETIC);
    snapshot.deinit();
    try watch.stop();
    try std.testing.expectError(error.Cancelled, watch.wait(0));
    try watch.close();
    try std.testing.expectError(error.Stopped, watch.wait(0));
}

test "Zig owned image copies survive request and camera closure with no retained leases" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg = defaultConfig();
    cfg.width = 2;
    cfg.height = 2;
    const camera = try Camera.init(cfg);
    var active = true;
    defer if (active) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var image = try frame.makeImage(std.testing.allocator, c.ZC_MAIN, null);
    defer image.deinit();
    try std.testing.expectError(error.Unsupported, frame.makeImage(std.testing.allocator, c.ZC_RAW, null));
    try std.testing.expectError(error.Unsupported, frame.makeImage(std.testing.allocator, c.ZC_MAIN, 16));
    const before = image.view.sample16(1, 1);
    try frame.release();
    try camera.stop();
    try camera.deinit();
    active = false;
    try std.testing.expectEqual(before, image.view.sample16(1, 1));
    try std.testing.expectEqual(@as(usize, 12), image.view.data.len);
    var thumbnail = try ImageResample.resize(std.testing.allocator, image.view, 3, 1, .lanczos3, .{});
    defer thumbnail.deinit();
    try std.testing.expectEqual(@as(usize, 9), thumbnail.view.data.len);
    try std.testing.expectEqual(@as(u16, 65535), thumbnail.view.sample16(2, 0)[3]);
    try std.testing.expectError(error.StaleFrame, frame.makeImage(std.testing.allocator, c.ZC_MAIN, null));
}
test "public Zig frame export pins the source while catalog copies own their bytes" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 2;
    cfg.height = 2;
    const camera = try Camera.init(cfg);
    var active = true;
    defer if (active) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var loan = try frame.exportFrame(1, false);
    defer loan.deinit() catch {};
    const info = try loan.info();
    try t.expectEqual(@as(u32, 1), info.stream_count);
    try t.expectEqual(frame.value.sequence, info.metadata.sequence);
    const catalog = try loan.metadataCatalog(t.allocator);
    defer t.allocator.free(catalog);
    try frame.release();
    try camera.stop();
    try t.expectError(error.Busy, camera.deinit());
    try loan.deinit();
    try t.expectError(error.StaleFrame, loan.info());
    try camera.deinit();
    active = false;
    const reader = try @import("home/typed_catalog.zig").Reader.init(catalog);
    try t.expectEqual(@as(u32, 4), reader.catalog_kind);
}

test "public Zig remote frame owns local maps and copies until joined ACK retirement" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 4;
    cfg.height = 2;
    const camera = try Camera.init(cfg);
    var active = true;
    defer if (active) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var loan = try frame.exportFrame(1, false);
    defer loan.deinit() catch {};
    var ends = try FrameChannel.pair();
    defer for (&ends) |*end| end.deinit() catch {};
    var peer = try FrameChannel.fromFd(ends[1].fd);
    defer peer.deinit() catch {};
    try t.expectError(error.Timeout, ends[1].receive());
    try ends[0].send(loan, 9007199254740993);
    var receipt = try peer.receive();
    defer receipt.frame.deinit() catch {};
    try t.expectEqual(@as(u64, 9007199254740993), receipt.cookie);
    const info = try receipt.frame.info();
    try t.expectEqual(frame.value.sequence, info.metadata.sequence);
    const stream = try receipt.frame.stream(c.ZC_MAIN);
    try t.expectEqual(@as(u32, 4), stream.width);
    try t.expect(stream.planes[0].fd != (try loan.info()).planes[0].fd);
    const copied_pixels = try receipt.frame.copyRgb(t.allocator, c.ZC_MAIN, 8);
    defer t.allocator.free(copied_pixels);
    const catalog = try receipt.frame.metadataCatalog(t.allocator);
    defer t.allocator.free(catalog);
    try frame.release();
    try camera.stop();
    try t.expectError(error.Busy, camera.deinit());
    try receipt.frame.deinit();
    try t.expectError(error.StaleFrame, receipt.frame.stream(c.ZC_MAIN));
    try ends[1].acknowledge(receipt.cookie);
    try t.expectEqual(receipt.cookie, try ends[0].receiveAcknowledgement());
    try loan.deinit();
    try camera.deinit();
    active = false;
    try t.expectEqual(@as(usize, 24), copied_pixels.len);
    try t.expectEqual(@as(u32, 4), (try @import("home/typed_catalog.zig").Reader.init(catalog)).catalog_kind);
}
test "public Zig process ownership moves on success and keeps cleanup prefixes until release" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 2;
    cfg.height = 2;
    const camera = try Camera.init(cfg);
    var active_camera = true;
    defer if (active_camera) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var loan = try frame.exportFrame(1, false);
    defer loan.deinit() catch {};
    var session = try ProcessSession.init(1, 1, 8);
    defer session.deinit() catch {};
    try t.expectError(error.Invalid, session.submitMove(&loan, "123456789"));
    _ = try loan.info();
    const ticket = try session.submitMove(&loan, "data");
    try t.expect(loan.handle == null);
    const payload_bytes = try session.payload(t.allocator, ticket.cookie);
    defer t.allocator.free(payload_bytes);
    try t.expectEqualStrings("data", payload_bytes);
    var ends = try FrameChannel.pair();
    defer for (&ends) |*end| end.deinit() catch {};
    try session.send(ticket.cookie, ends[0]);
    try session.stopWorker(0, 1);
    try t.expectError(error.Busy, session.retire(ticket.cookie));
    var receipt = try ends[1].receive();
    defer receipt.frame.deinit() catch {};
    try frame.release();
    try camera.stop();
    try t.expectError(error.Busy, camera.deinit());
    try receipt.frame.deinit();
    try t.expectError(error.Busy, session.retire(ticket.cookie));
    try ends[1].acknowledge(ticket.cookie);
    try t.expectEqual(ticket.cookie, try session.receiveAcknowledgement(0, 1, ends[0]));
    try session.retire(ticket.cookie);
    try camera.deinit();
    active_camera = false;
    try t.expect(try session.pendingThrough(ticket.cookie));
    try t.expectEqual(@as(u32, 1), (try session.state()).retired);
    try t.expectError(error.Busy, session.deinit());
    try session.release(ticket.cookie);
    try t.expect(!try session.pendingThrough(ticket.cookie));
    // This fixture's local peer is fully unmapped/closed, with no child process.
    for (&ends) |*end| try end.deinit();
    try session.workerJoined(0, 1);
    try t.expectEqual(@as(u64, 2), try session.restartWorker(0, 1));
    try session.workerJoined(0, 2); // no replacement OS peer was started
    try session.deinit();
}

test "public remote packed bundles raw samples and calibrated DNG own results after retirement" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 17;
    cfg.height = 5;
    cfg.raw = 1;
    @memcpy(cfg.raw_format[0..13], "SRGGB12_CSI2P");
    const camera = try Camera.init(cfg);
    var active = true;
    defer if (active) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var original = try frame.copyStreams(t.allocator, &.{ c.ZC_RAW, c.ZC_MAIN });
    defer original.deinit(t.allocator);
    var expected: [17 * 5 * 2]u8 = undefined;
    try frame.copyRaw16(&expected);
    var image_options: c.zc_image_options = undefined;
    core.zc_default_image_options(&image_options);
    image_options.format = c.ZC_IMAGE_PNG;
    const expected_png = try frame.encodeImage(t.allocator, image_options);
    defer t.allocator.free(expected_png);
    var loan = try frame.exportFrame(3, false);
    defer loan.deinit() catch {};
    var ends = try FrameChannel.pair();
    defer for (&ends) |*end| end.deinit() catch {};
    try ends[0].send(loan, 7);
    var receipt = try ends[1].receive();
    defer receipt.frame.deinit() catch {};
    try t.expectEqual(@as(u32, 7), (try receipt.frame.rawMetadata()).valid);
    var copied_bundle = try receipt.frame.copyStreams(t.allocator, &.{ c.ZC_RAW, c.ZC_MAIN });
    defer copied_bundle.deinit(t.allocator);
    try t.expectEqualSlices(u8, original.data, copied_bundle.data);
    var words: [17 * 5 * 2]u8 = undefined;
    try receipt.frame.copyRaw16(&words);
    try t.expectEqualSlices(u8, &expected, &words);
    const remote_png = try receipt.frame.encodeImage(t.allocator, c.ZC_MAIN, image_options, null, null);
    defer t.allocator.free(remote_png);
    try t.expectEqualSlices(u8, expected_png, remote_png);
    const captured_dng = try receipt.frame.encodeDng(t.allocator);
    defer t.allocator.free(captured_dng);
    try receipt.frame.deinit();
    try ends[1].acknowledge(receipt.cookie);
    try t.expectEqual(receipt.cookie, try ends[0].receiveAcknowledgement());
    try loan.deinit();
    try frame.release();
    try camera.stop();
    try camera.deinit();
    active = false;
    try t.expectEqualSlices(u8, "II*\x00", captured_dng[0..4]);
    try t.expectEqualSlices(u8, original.data, copied_bundle.data);
}

test "request configuration owns pointer-free negotiated records across export remote and complete closure" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    const wire = @import("home/typed_catalog.zig");
    var cfg = defaultConfig();
    cfg.width = 18;
    cfg.height = 10;
    cfg.raw = 1;
    const camera = try Camera.init(cfg);
    var active = true;
    defer if (active) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var catalog = try frame.configurationCatalog();
    defer catalog.deinit();
    const original = try catalog.copy(t.allocator);
    defer t.allocator.free(original);
    var loan = try frame.exportFrame(1, false);
    defer loan.deinit() catch {};
    const exported = try loan.configurationCatalog(t.allocator);
    defer t.allocator.free(exported);
    try t.expectEqualSlices(u8, original, exported);
    var ends = try FrameChannel.pair();
    defer for (&ends) |*end| end.deinit() catch {};
    try ends[0].send(loan, 42);
    var receipt = try ends[1].receive();
    defer receipt.frame.deinit() catch {};
    const remote = try receipt.frame.configurationCatalog(t.allocator);
    defer t.allocator.free(remote);
    try t.expectEqualSlices(u8, original, remote);
    const token = frame.value.token;
    try frame.release();
    try camera.stop();
    try receipt.frame.deinit();
    try ends[1].acknowledge(42);
    try t.expectEqual(@as(u64, 42), try ends[0].receiveAcknowledgement());
    try loan.deinit();
    var stale: ?*c.zc_catalog = @ptrFromInt(1);
    try t.expectEqual(c.ZC_STALE, core.zc_frame_configuration_catalog(camera.handle, token, &stale));
    try t.expect(stale == null);
    try camera.deinit();
    active = false;
    try t.expectEqual(@as(u32, 7), (try wire.Reader.init(remote)).catalog_kind);
    try t.expectError(error.StaleFrame, frame.configurationCatalog());
    try t.expectError(error.StaleFrame, loan.configurationCatalog(t.allocator));
    try t.expectError(error.StaleFrame, receipt.frame.configurationCatalog(t.allocator));
}

test "public Zig async local image owns request input through camera closure" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 18;
    cfg.height = 10;
    const camera = try Camera.init(cfg);
    var active = true;
    defer if (active) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var opts = defaultImageOptions();
    opts.format = c.ZC_IMAGE_PNG;
    const expected = try frame.encodeImage(t.allocator, opts);
    defer t.allocator.free(expected);
    var worker = try frame.encodeImageAsync(c.ZC_MAIN, opts, null, null, null, null);
    defer worker.deinit() catch {};
    try frame.release();
    try camera.stop();
    try camera.deinit();
    active = false;
    try t.expectError(error.StaleFrame, frame.encodeImageAsync(c.ZC_MAIN, opts, null, null, null, null));
    var timer = try std.time.Timer.start();
    while ((try worker.state()).finished == 0) {
        if (timer.read() > 10 * std.time.ns_per_s) return error.TestTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try t.expectEqual(c.ZC_OK, (try worker.state()).result);
    const bytes = try worker.take(t.allocator);
    defer t.allocator.free(bytes);
    try t.expectEqualSlices(u8, expected, bytes);
    try worker.deinit();
    try t.expectError(error.StaleFrame, worker.state());
}
test "public Zig async remote image owns copied source beyond maps frame export and camera close" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    var cfg = defaultConfig();
    cfg.width = 18;
    cfg.height = 10;
    const camera = try Camera.init(cfg);
    var active = true;
    defer if (active) {
        camera.stop() catch {};
        camera.deinit() catch {};
    };
    try camera.start();
    var frame = try camera.acquire(0);
    defer frame.release() catch {};
    var opts = defaultImageOptions();
    opts.format = c.ZC_IMAGE_PNG;
    const expected = try frame.encodeImage(t.allocator, opts);
    defer t.allocator.free(expected);
    var loan = try frame.exportFrame(1, false);
    defer loan.deinit() catch {};
    var ends = try FrameChannel.pair();
    defer for (&ends) |*end| end.deinit() catch {};
    try ends[0].send(loan, 1);
    var receipt = try ends[1].receive();
    defer receipt.frame.deinit() catch {};
    var worker = try receipt.frame.encodeImageAsync(c.ZC_MAIN, opts, null, null, null, null);
    defer worker.deinit() catch {};
    try receipt.frame.deinit();
    try ends[1].acknowledge(1);
    try t.expectEqual(@as(u64, 1), try ends[0].receiveAcknowledgement());
    try loan.deinit();
    try frame.release();
    try camera.stop();
    try camera.deinit();
    active = false;
    var timer = try std.time.Timer.start();
    while ((try worker.state()).finished == 0) {
        if (timer.read() > 10 * std.time.ns_per_s) return error.TestTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try t.expectEqual(c.ZC_OK, (try worker.state()).result);
    const captured = try worker.take(t.allocator);
    defer t.allocator.free(captured);
    try t.expectEqualSlices(u8, expected, captured);
    try worker.deinit();
    try t.expectError(error.StaleFrame, worker.state());
}

test "public Zig staged bytes preserve a retryable close owner until explicit publication joins" {
    const t = std.testing;
    var tmp = t.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(dir);
    const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/encoded", .{dir}, 0);
    defer t.allocator.free(path);
    var file = try StagedImageFile.init(path);
    defer file.deinit() catch {};
    try t.expectError(error.Busy, file.deinit());
    try file.prepareBytes("encoded image");
    var timer = try std.time.Timer.start();
    while (!try file.prepared()) {
        if (timer.read() > 10 * std.time.ns_per_s) return error.TestTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try file.finish(true);
    while ((try file.state()).finished == 0) std.Thread.sleep(std.time.ns_per_ms);
    try file.deinit();
    try t.expectError(error.StaleFrame, file.state());
    const bytes = try tmp.dir.readFileAlloc(t.allocator, "encoded", 1024);
    defer t.allocator.free(bytes);
    try t.expectEqualStrings("encoded image", bytes);
}
