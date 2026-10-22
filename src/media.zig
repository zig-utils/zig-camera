//! Optional C system-library adapters, exported through the stable C interface.
const c = @import("abi.zig").c;
const options = @import("options");
pub export fn zc_default_preparation_state(out: *c.zc_preparation_state) void {
    out.* = .{ .phase = 0, .cancel_requested = 0 };
}
pub export fn zc_preparation_step(out: *c.zc_preparation_state, action: u32) c_int {
    const gate = @import("home/preparation_gate.zig");
    if (out.cancel_requested > 1) return c.ZC_INVALID;
    var state: gate.Gate = .{ .phase = @import("std").meta.intToEnum(gate.Phase, out.phase) catch return c.ZC_INVALID, .cancel_requested = out.cancel_requested != 0 };
    const accepted = switch (action) {
        c.ZC_PREP_CLAIM => state.claim(),
        c.ZC_PREP_READY => state.ready(),
        c.ZC_PREP_PUBLISH => state.publish(),
        c.ZC_PREP_CANCEL => state.cancel(),
        c.ZC_PREP_CLEANED => state.cleaned(),
        c.ZC_PREP_FAIL => state.fail(),
        else => return c.ZC_INVALID,
    };
    out.* = .{ .phase = @intFromEnum(state.phase), .cancel_requested = @intFromBool(state.cancel_requested) };
    return @intFromBool(accepted);
}
pub export fn zc_video_prepare_split(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, out: *?*c.zc_prepared_output) c_int {
    out.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").prepareSplit(p, id, path, cb, out);
}
pub export fn zc_prepared_output_build(p: *c.zc_prepared_output) c_int {
    return @import("video.zig").buildPrepared(p);
}
pub export fn zc_video_commit_split(p: *c.zc_recorder, out: *c.zc_prepared_output) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").commitPrepared(p, out);
}
pub export fn zc_prepared_output_close(p: ?*c.zc_prepared_output) void {
    @import("video.zig").closePrepared(p orelse return);
}
extern fn zcm_preview_open([*:0]const u8, u32, u32, *?*c.zc_preview) c_int;
extern fn zcm_preview_open_background([*:0]const u8, u32, u32, *?*c.zc_preview) c_int;
extern fn zcm_preview_show(*c.zc_preview, *const c.zc_frame) c_int;
extern fn zcm_preview_close(*c.zc_preview) c_int;
pub export fn zc_preview_open(title: [*:0]const u8, width: u32, height: u32, out: *?*c.zc_preview) c_int {
    out.* = null;
    if (!options.preview) return c.ZC_UNSUPPORTED;
    return zcm_preview_open(title, width, height, out);
}
pub export fn zc_preview_open_background(title: [*:0]const u8, width: u32, height: u32, out: *?*c.zc_preview) c_int {
    out.* = null;
    if (!options.preview) return c.ZC_UNSUPPORTED;
    return zcm_preview_open_background(title, width, height, out);
}
pub export fn zc_preview_show(p: *c.zc_preview, f: *const c.zc_frame) c_int {
    if (!options.preview) return c.ZC_UNSUPPORTED;
    return @import("preview_input.zig").zc_preview_show_input(p, f, null);
}
pub export fn zc_preview_close(p: *c.zc_preview) c_int {
    if (!options.preview) return c.ZC_UNSUPPORTED;
    return zcm_preview_close(p);
}
pub export fn zc_video_apply_quality_tier(cfg: *c.zc_video_config, value: u32) c_int {
    const policy = @import("home/capture_quality.zig");
    const tier = @import("std").meta.intToEnum(policy.Tier, value) catch return c.ZC_INVALID;
    const next = policy.apply(cfg.*, tier) catch |err| return if (err == error.Unsupported) c.ZC_UNSUPPORTED else c.ZC_INVALID;
    cfg.* = next;
    return c.ZC_OK;
}
pub export fn zc_default_video_config(out: *c.zc_video_config) void {
    out.* = .{ .width = 1920, .height = 1080, .fps_num = 30, .fps_den = 1, .codec = c.ZC_MJPEG, .bitrate = 0, .quality = 90, .gop = 0 };
}
pub export fn zc_video_open(path: [*:0]const u8, cfg: *const c.zc_video_config, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!options.video) return c.ZC_UNSUPPORTED;
    return @import("video.zig").open(path, cfg, out);
}
pub export fn zc_video_set_repeat_headers(p: *c.zc_recorder, enabled: u32) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setRepeatHeaders(p, enabled);
}
pub export fn zc_video_get_repeat_headers(p: *c.zc_recorder, enabled: *u32) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").getRepeatHeaders(p, enabled);
}
pub export fn zc_producer_job_restart_repeat_headers(p: *c.zc_producer_job, enabled: u32) c_int {
    return @import("video.zig").restartRepeatHeaders(@ptrCast(@alignCast(p)), enabled);
}
pub export fn zc_video_request_keyframe(p: *c.zc_recorder) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").requestKeyframe(p);
}
pub export fn zc_video_keyframe_state(p: *c.zc_recorder, out: *c.zc_keyframe_state) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").keyframeState(p, out);
}
pub export fn zc_video_producer_keyframe(p: *c.zc_recorder, out: *?*c.zc_producer_job) c_int {
    return @import("video.zig").producerKeyframe(p, out);
}
pub export fn zc_video_write(p: *c.zc_recorder, f: *const c.zc_frame, ts: u64) c_int {
    if (!options.video) return c.ZC_UNSUPPORTED;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").write(p, f, ts);
}
pub export fn zc_video_write_input(p: *c.zc_recorder, f: *const c.zc_frame, color: *const c.zc_color_space, ts: u64) c_int {
    if (!options.video) return c.ZC_UNSUPPORTED;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").writeInput(p, f, ts, color.*);
}
pub export fn zc_video_check_input_color(color: *const c.zc_color_space, format: u32) c_int {
    if (format > c.ZC_VYUY) return c.ZC_INVALID;
    @import("video_input.zig").validateColor(color.*, @import("processed_format.zig").yuv(format)) catch return c.ZC_UNSUPPORTED;
    return c.ZC_OK;
}
pub export fn zc_video_check_input_color_for(color: *const c.zc_color_space, format: u32, target: ?*const c.zc_color_space) c_int {
    if (format > c.ZC_VYUY) return c.ZC_INVALID;
    @import("video_input.zig").validateColorFor(color.*, @import("processed_format.zig").yuv(format), if (target) |value| value.* else @import("recording_color.zig").legacy()) catch |err| return if (err == error.InvalidConfiguration) c.ZC_INVALID else c.ZC_UNSUPPORTED;
    return c.ZC_OK;
}
pub export fn zc_default_video_color(out: *c.zc_color_space) void {
    out.* = @import("recording_color.zig").legacy();
}
pub export fn zc_video_check_color(cfg: *const c.zc_video_config, color: ?*const c.zc_color_space) c_int {
    return @import("video.zig").checkColor(cfg, color);
}
pub export fn zc_video_set_color(p: *c.zc_recorder, color: ?*const c.zc_color_space) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setColor(p, color);
}
pub export fn zc_video_get_color(p: *c.zc_recorder, color: *c.zc_color_space) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").getColor(p, color);
}
pub export fn zc_default_codec_options(out: *c.zc_codec_options) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_codec_options), .profile = 0, .preset = 0, .qp = 0 };
}
pub export fn zc_video_check_codec_options(cfg: *const c.zc_video_config, value: ?*const c.zc_codec_options) c_int {
    return @import("video.zig").checkCodecOptions(cfg, value);
}
pub export fn zc_video_set_codec_options(p: *c.zc_recorder, value: ?*const c.zc_codec_options) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setCodecOptions(p, value);
}
pub export fn zc_video_get_codec_options(p: *c.zc_recorder, out: *c.zc_codec_options) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").getCodecOptions(p, out);
}
pub export fn zc_default_codec_limits(out: *c.zc_codec_limits) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_codec_limits), .level = 0, .max_bitrate = 0, .buffer_bits = 0 };
}
pub export fn zc_video_check_codec_limits(cfg: *const c.zc_video_config, policy: ?*const c.zc_codec_options, value: ?*const c.zc_codec_limits) c_int {
    return @import("video.zig").checkCodecLimits(cfg, policy, value);
}
pub export fn zc_video_set_codec_limits(p: *c.zc_recorder, value: ?*const c.zc_codec_limits) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setCodecLimits(p, value);
}
pub export fn zc_video_get_codec_limits(p: *c.zc_recorder, out: *c.zc_codec_limits) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").getCodecLimits(p, out);
}
pub export fn zc_video_close(p: *c.zc_recorder) c_int {
    if (!options.video) return c.ZC_UNSUPPORTED;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").close(p);
}

pub export fn zc_copy_rgb(f: *const c.zc_frame, out: [*]u8, length: u64) c_int {
    if (f.token == 0 or length > @import("std").math.maxInt(usize)) return c.ZC_INVALID;
    const view = @import("stream_rgb.zig").packedView(f.main) catch |err| return if (err == error.UnsupportedFormat) c.ZC_UNSUPPORTED else c.ZC_INVALID;
    view.convert(out[0..@intCast(length)], @as(usize, f.main.width) * 3, .rgb) catch return c.ZC_INVALID;
    return c.ZC_OK;
}

/// Tight owned-copy byte count. Does not dereference source plane pointers.
pub export fn zc_stream_copy_size(m: *const c.zc_stream, out: *u64) c_int {
    return @import("stream_copy.zig").byteCount(m, out);
}
pub const streamPlanes = @import("stream_copy.zig").plan;
/// Descriptors and DMA access remain borrowed for the duration of this call.
pub export fn zc_copy_stream(m: *const c.zc_stream, out: [*]u8, length: u64) c_int {
    if (length > @import("std").math.maxInt(usize)) return c.ZC_INVALID;
    @import("stream_copy.zig").copy(m, out[0..@intCast(length)]) catch |err| return if (err == error.UnsupportedFormat) c.ZC_UNSUPPORTED else c.ZC_INVALID;
    return c.ZC_OK;
}

pub export fn zc_default_buffer_config(out: *c.zc_buffer_config) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_buffer_config), .max_frames = 300, .max_bytes = 64 * 1024 * 1024, .duration_us = 5_000_000 };
}
pub export fn zc_video_open_circular(cfg: *const c.zc_video_config, buffer: *const c.zc_buffer_config, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!options.video) return c.ZC_UNSUPPORTED;
    return @import("video.zig").openCircular(cfg, buffer, out);
}
pub export fn zc_video_buffer_stats(p: *c.zc_recorder, out: *c.zc_buffer_stats) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").bufferStats(p, out);
}
pub export fn zc_video_save_buffer(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").saveBuffer(p, path);
}
pub export fn zc_video_open_output(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").openOutput(p, path);
}
pub export fn zc_video_close_output(p: *c.zc_recorder) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").closeOutput(p);
}
pub export fn zc_video_split(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").split(p, path);
}
pub export fn zc_video_cancel_split(p: *c.zc_recorder) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").cancelSplit(p);
}

pub export fn zc_default_recording_options(out: *c.zc_recording_options) void {
    out.* = @import("video.zig").defaultRecordingOptions();
}
pub export fn zc_video_open_ex(path: [*:0]const u8, cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!options.video) return c.ZC_UNSUPPORTED;
    return @import("video.zig").openEx(path, cfg, opts, out);
}
pub export fn zc_video_write_audio(p: *c.zc_recorder, data: [*]const u8, length: u64, timestamp: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").writeAudio(p, data, length, timestamp);
}
pub export fn zc_video_set_rotation(p: *c.zc_recorder, duration: u64, bytes: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setRotation(p, duration, bytes);
}
pub export fn zc_video_recording_stats(p: *c.zc_recorder, out: *c.zc_recording_stats) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").recordingStats(p, out);
}

pub export fn zc_video_open_aac(path: [*:0]const u8, cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, bitrate: u32, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!options.video) return c.ZC_UNSUPPORTED;
    return @import("video.zig").openAac(path, cfg, opts, bitrate, out);
}

pub export fn zc_video_open_circular_av(cfg: *const c.zc_video_config, buffer: *const c.zc_buffer_config, opts: *const c.zc_recording_options, bitrate: u32, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!options.video) return c.ZC_UNSUPPORTED;
    return @import("video.zig").openCircularAv(cfg, buffer, opts, bitrate, out);
}
pub export fn zc_video_audio_buffer_stats(p: *c.zc_recorder, out: *c.zc_audio_buffer_stats) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").audioBufferStats(p, out);
}

pub export fn zc_video_freeze_buffer(p: *c.zc_recorder, path: [*:0]const u8, out: *?*c.zc_snapshot) c_int {
    out.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").freeze(p, path, out);
}
pub export fn zc_snapshot_write(p: *c.zc_snapshot) c_int {
    return @import("video.zig").writeSnapshot(p);
}
pub export fn zc_snapshot_close(p: *c.zc_snapshot) void {
    @import("video.zig").closeSnapshot(p);
}

pub export fn zc_video_set_delay(p: *c.zc_recorder, delay_ns: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setDelay(p, delay_ns);
}

pub export fn zc_video_open_callbacks(p: *c.zc_recorder, cb: *const c.zc_output_callbacks) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").openCallbacks(p, cb);
}
pub export fn zc_video_get_headers(p: *c.zc_recorder, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").getHeaders(p, data, capacity, length);
}
pub export fn zc_format_pts(timestamp: u64, data: [*]u8, capacity: u32, length: *u32) c_int {
    return @import("video.zig").formatPts(timestamp, data, capacity, length);
}

pub export fn zc_video_create(cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, bitrate: u32, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!options.video) return c.ZC_UNSUPPORTED;
    return @import("video.zig").create(cfg, opts, bitrate, out);
}
pub export fn zc_video_split_callbacks(p: *c.zc_recorder, cb: *const c.zc_output_callbacks) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").splitCallbacks(p, cb);
}

pub export fn zc_video_add_callbacks(p: *c.zc_recorder, cb: *const c.zc_output_callbacks, id: *u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").addCallbacks(p, cb, id);
}
pub export fn zc_video_add_output(p: *c.zc_recorder, path: [*:0]const u8, id: *u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").addOutput(p, path, id);
}
pub export fn zc_video_remove_output(p: *c.zc_recorder, id: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").removeOutput(p, id);
}
pub export fn zc_video_output_stats(p: *c.zc_recorder, id: u64, stats: *c.zc_output_stats) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").outputStats(p, id, stats);
}

pub export fn zc_video_set_failure_isolation(p: *c.zc_recorder, enabled: u32) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setIsolation(p, enabled);
}
pub export fn zc_video_output_state(p: *c.zc_recorder, id: u64, state: *c.zc_output_state) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").outputState(p, id, state);
}
pub export fn zc_video_split_output(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").splitOutput(p, id, path, cb);
}
pub export fn zc_video_cancel_output_split(p: *c.zc_recorder, id: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").cancelOutputSplit(p, id);
}
pub export fn zc_video_close_outputs(p: *c.zc_recorder, results: [*]c.zc_output_result, capacity: u32, count: *u32) c_int {
    if (@import("video.zig").producerBusy(p)) {
        count.* = 0;
        return c.ZC_BUSY;
    }
    return @import("video.zig").closeReport(p, results, capacity, count);
}

pub export fn zc_video_set_output_delay(p: *c.zc_recorder, id: u64, delay: u64, bytes: u64, frames: u32) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setOutputDelay(p, id, delay, bytes, frames);
}
pub export fn zc_video_output_delay(p: *c.zc_recorder, id: u64, state: *c.zc_output_delay) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").outputDelay(p, id, state);
}
pub export fn zc_video_set_output_recovery(p: *c.zc_recorder, id: u64, limit: u32, initial: u64, maximum: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setOutputRecovery(p, id, limit, initial, maximum);
}
pub export fn zc_video_output_retry_due(p: *c.zc_recorder, id: u64, due: *u32) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").outputRetryDue(p, id, due);
}
pub export fn zc_video_output_recovery(p: *c.zc_recorder, id: u64, state: *c.zc_output_recovery_state) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").outputRecovery(p, id, state);
}
pub export fn zc_video_recover_output(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").recoverOutput(p, id, path, cb);
}

pub export fn zc_video_set_output_io(p: *c.zc_recorder, id: u64, bytes: u64, items: u32, wait: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setOutputIo(p, id, bytes, items, wait);
}
pub export fn zc_video_output_io_stats(p: *c.zc_recorder, id: u64, out: *c.zc_output_io_stats) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").outputIoStats(p, id, out);
}
pub export fn zc_video_drain_output_io(p: *c.zc_recorder, id: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").drainOutputIo(p, id);
}
pub export fn zc_video_drain_output_async(p: *c.zc_recorder, id: u64, job: *?*c.zc_output_job) c_int {
    job.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").drainOutputAsync(p, id, job);
}
pub export fn zc_output_job_wait(job: *c.zc_output_job, timeout_ms: u32) c_int {
    const drain: *@import("output_io.zig").Drain = @ptrCast(@alignCast(job));
    return drain.wait(timeout_ms);
}
pub export fn zc_output_job_close(job: ?*c.zc_output_job) void {
    const drain: *@import("output_io.zig").Drain = @ptrCast(@alignCast(job orelse return));
    drain.destroy();
}

pub export fn zc_video_prepare_recovery(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, out: *?*c.zc_prepared_output) c_int {
    out.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").prepareRecovery(p, id, path, cb, out);
}
pub export fn zc_video_prepare_async(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, recovery: u32, out: *?*c.zc_preparation_job) c_int {
    out.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").prepareAsync(p, id, path, cb, recovery, out);
}
pub export fn zc_video_poll_preparations(p: *c.zc_recorder) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").pollPreparations(p);
}
pub export fn zc_preparation_job_state_get(p: *c.zc_preparation_job, out: *c.zc_preparation_job_state) c_int {
    return @import("video.zig").preparationState(p, out);
}
pub export fn zc_preparation_job_cancel(p: *c.zc_preparation_job) c_int {
    return @import("video.zig").cancelPreparation(p);
}
pub export fn zc_preparation_job_close(p: *c.zc_preparation_job) c_int {
    return @import("video.zig").closePreparation(p);
}
pub export fn zc_video_set_automatic(p: *c.zc_recorder, id: u64, pattern: ?[*:0]const u8, next: u64, recovery: u32, duration: u64, bytes: u64) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setAutomatic(p, id, pattern, next, recovery, duration, bytes);
}
pub export fn zc_video_automatic_state(p: *c.zc_recorder, id: u64, out: *c.zc_automatic_state) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").automaticState(p, id, out);
}

pub export fn zc_video_prepare_held(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, recovery: u32, result: *?*c.zc_preparation_job) c_int {
    result.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").prepareHeld(p, id, path, cb, recovery, result);
}
pub export fn zc_preparation_job_publish(p: *c.zc_preparation_job) c_int {
    return @import("video.zig").publishPreparation(p);
}
pub export fn zc_video_fail_output(p: *c.zc_recorder, id: u64, code: c_int) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").failOutput(p, id, code);
}
pub export fn zc_preparation_job_abort_pending(p: *c.zc_preparation_job) c_int {
    return @import("video.zig").abortPendingPreparation(p);
}

pub export fn zc_video_hold_output(p: *c.zc_recorder, id: u64, held: u32) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").holdOutput(p, id, held);
}
pub export fn zc_video_open_held_callbacks(p: *c.zc_recorder, cb: *const c.zc_output_callbacks) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").openHeldCallbacks(p, cb);
}
pub export fn zc_video_step_held_output(p: *c.zc_recorder) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").stepHeldOutput(p);
}
pub export fn zc_video_publish_held_output(p: *c.zc_recorder) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").publishHeldOutput(p);
}
pub export fn zc_video_discard_held_output(p: *c.zc_recorder) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").discardHeldOutput(p);
}
pub export fn zc_default_pts_clock(out: *c.zc_pts_clock) void {
    out.* = @import("std").mem.zeroes(c.zc_pts_clock);
}
pub export fn zc_pts_clock_accept(state: *c.zc_pts_clock, source: u64, out: *u64) c_int {
    if (state.initialized > 1 or state.reserved != 0 or (state.initialized == 1 and state.last_ns < state.first_ns)) return c.ZC_INVALID;
    var clock: @import("home/pts_clock.zig").Clock = .{ .first = if (state.initialized != 0) state.first_ns else null, .last = if (state.initialized != 0) state.last_ns else null };
    const value = clock.accept(source) catch return c.ZC_INVALID;
    state.* = .{ .first_ns = clock.first.?, .last_ns = clock.last.?, .initialized = 1, .reserved = 0 };
    out.* = value;
    return c.ZC_OK;
}
pub export fn zc_video_freeze_callbacks(p: *c.zc_recorder, out: *?*c.zc_snapshot) c_int {
    out.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").freezeCallbacks(p, out);
}
pub export fn zc_snapshot_open_callbacks(p: *c.zc_snapshot, live: ?*c.zc_recorder, cb: *const c.zc_output_callbacks) c_int {
    if (live) |owner| if (@import("video.zig").producerBusy(owner)) return c.ZC_BUSY;
    return @import("video.zig").openSnapshotCallbacks(p, live, cb);
}
pub export fn zc_snapshot_step(p: *c.zc_snapshot) c_int {
    return @import("video.zig").stepSnapshot(p);
}
pub export fn zc_video_set_factory(p: *c.zc_recorder, id: u64, cfg: ?*const c.zc_factory_config) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").setFactory(p, id, cfg);
}
pub export fn zc_video_factory_state(p: *c.zc_recorder, id: u64, state: *c.zc_factory_state) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").factoryState(p, id, state);
}
pub export fn zc_video_claim_factory(p: *c.zc_recorder, id: u64, state: *c.zc_factory_state) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").claimFactory(p, id, state);
}
pub export fn zc_video_prepare_factory(p: *c.zc_recorder, id: u64, ticket: u64, cb: *const c.zc_output_callbacks, out: *?*c.zc_preparation_job) c_int {
    out.* = null;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").prepareFactory(p, id, ticket, cb, out);
}
pub export fn zc_video_finish_factory(p: *c.zc_recorder, id: u64, ticket: u64, code: c_int) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").finishFactory(p, id, ticket, code);
}
pub export fn zc_video_set_producer_limits(p: *c.zc_recorder, bytes: u64, jobs: u32) c_int {
    return @import("video.zig").setProducerLimits(p, bytes, jobs);
}
pub export fn zc_video_producer_stats(p: *c.zc_recorder, out: *c.zc_producer_stats) c_int {
    return @import("video.zig").producerStats(p, out);
}
pub export fn zc_video_producer_frame(p: *c.zc_recorder, frame: *const c.zc_frame, timestamp: u64, out: *?*c.zc_producer_job) c_int {
    return @import("video.zig").producerFrame(p, frame, timestamp, out);
}
pub export fn zc_video_producer_audio(p: *c.zc_recorder, data: [*]const u8, length: u64, timestamp: u64, out: *?*c.zc_producer_job) c_int {
    return @import("video.zig").producerAudio(p, data, length, timestamp, out);
}
pub export fn zc_producer_job_start(p: *c.zc_producer_job) c_int {
    return @import("video.zig").startProducer(p);
}
pub export fn zc_producer_job_finish(p: *c.zc_producer_job, code: *c_int) c_int {
    const job: *@import("producer.zig").Job = @ptrCast(@alignCast(p));
    return job.owner.finish(job, code);
}
pub export fn zc_producer_job_close(p: *c.zc_producer_job) c_int {
    const job: *@import("producer.zig").Job = @ptrCast(@alignCast(p));
    return job.owner.release(job);
}
pub export fn zc_producer_job_cancel(p: *c.zc_producer_job) c_int {
    const job: *@import("producer.zig").Job = @ptrCast(@alignCast(p));
    return job.owner.cancel(job);
}
pub export fn zc_video_producer_barrier(p: *c.zc_recorder, flush: u32, out: *?*c.zc_producer_job) c_int {
    return @import("video.zig").producerBarrier(p, flush, out);
}
pub export fn zc_producer_job_drain_outputs(p: *c.zc_producer_job) c_int {
    return @import("producer.zig").pollOutputs(@ptrCast(@alignCast(p)));
}
pub export fn zc_video_session_state(p: *c.zc_recorder, out: *c.zc_session_state) c_int {
    out.* = @import("std").mem.zeroes(c.zc_session_state);
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").sessionState(p, out);
}
pub export fn zc_video_producer_restart(p: *c.zc_recorder, kind: u32, path: ?[*:0]const u8, out: *?*c.zc_producer_job) c_int {
    return @import("video.zig").producerRestart(p, kind, path, out);
}
pub export fn zc_video_session_config(p: *c.zc_recorder, cfg: *c.zc_video_config, opts: *c.zc_recording_options, bitrate: *u32) c_int {
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").sessionConfig(p, cfg, opts, bitrate);
}
pub export fn zc_video_resolve_session_config(cfg: *c.zc_video_config, opts: *const c.zc_recording_options, bitrate: u32, width: u32, height: u32, exact: u32) c_int {
    return @import("video.zig").resolveSession(cfg, opts, bitrate, width, height, exact);
}
pub export fn zc_producer_job_restart_configure(p: *c.zc_producer_job, cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, bitrate: u32) c_int {
    return @import("video.zig").restartConfigure(@ptrCast(@alignCast(p)), cfg, opts, bitrate);
}
pub export fn zc_producer_job_restart_color(p: *c.zc_producer_job, color: ?*const c.zc_color_space) c_int {
    return @import("video.zig").restartColor(@ptrCast(@alignCast(p)), color);
}
pub export fn zc_producer_job_restart_codec_options(p: *c.zc_producer_job, value: ?*const c.zc_codec_options) c_int {
    return @import("video.zig").restartCodecOptions(@ptrCast(@alignCast(p)), value);
}
pub export fn zc_producer_job_restart_codec_limits(p: *c.zc_producer_job, value: ?*const c.zc_codec_limits) c_int {
    return @import("video.zig").restartCodecLimits(@ptrCast(@alignCast(p)), value);
}
pub export fn zc_producer_job_restart_stage(p: *c.zc_producer_job, stage: *u32) c_int {
    const job: *@import("producer.zig").Job = @ptrCast(@alignCast(p));
    if (job.operation != .restart) return c.ZC_STATE;
    stage.* = job.restart_stage.load(.acquire);
    return c.ZC_OK;
}
pub export fn zc_producer_job_restart_io(p: *c.zc_producer_job, bytes: u64, operations: u32, wait_ns: u64) c_int {
    if (bytes == 0 or bytes > 1024 * 1024 * 1024 or operations == 0 or operations > 65536 or wait_ns > 60_000_000_000) return c.ZC_INVALID;
    const job: *@import("producer.zig").Job = @ptrCast(@alignCast(p));
    job.owner.mutex.lock();
    defer job.owner.mutex.unlock();
    if (job.operation != .restart or job.restart_kind != 1 or job.started) return c.ZC_STATE;
    job.restart_io = .{ .bytes = @intCast(bytes), .items = operations, .wait_ns = wait_ns };
    return c.ZC_OK;
}
pub export fn zc_producer_job_restart_headers(p: *c.zc_producer_job, data: [*]u8, capacity: u32, count: *u32) c_int {
    return @import("video.zig").restartHeaders(@ptrCast(@alignCast(p)), data, capacity, count);
}
pub export fn zc_producer_job_restart_bind(p: *c.zc_producer_job, cb: *const c.zc_output_callbacks) c_int {
    return @import("video.zig").restartBind(@ptrCast(@alignCast(p)), cb);
}
pub export fn zc_producer_job_restart_publish(p: *c.zc_producer_job) c_int {
    return @import("video.zig").restartPublish(@ptrCast(@alignCast(p)));
}
pub export fn zc_producer_jobs_restart_publish(jobs: ?[*]const ?*c.zc_producer_job, count: u32) c_int {
    if (count == 0 or count > 8) return c.ZC_INVALID;
    var values: [8]*@import("producer.zig").Job = undefined;
    const pointers = jobs orelse return c.ZC_INVALID;
    for (pointers[0..count], 0..) |value, i| values[i] = @ptrCast(@alignCast(value orelse return c.ZC_INVALID));
    return @import("video.zig").restartPublishGroup(values[0..count]);
}
pub export fn zc_video_producer_drain(p: *c.zc_recorder, out: *?*c.zc_producer_drain) c_int {
    return @import("video.zig").producerDrain(p, out);
}
pub export fn zc_producer_drain_poll(p: *c.zc_producer_drain) c_int {
    const drain: *@import("producer.zig").Drain = @ptrCast(@alignCast(p));
    return drain.poll();
}
pub export fn zc_producer_drain_close(p: *c.zc_producer_drain) void {
    const drain: *@import("producer.zig").Drain = @ptrCast(@alignCast(p));
    drain.destroy();
}

pub export fn zc_video_close_outputs_async(p: *c.zc_recorder, results: [*]c.zc_output_result, capacity: u32, count: *u32) c_int {
    if (@import("video.zig").producerBusy(p)) {
        count.* = 0;
        return c.ZC_BUSY;
    }
    const previous = @import("output_mailbox.zig").producerScope(true);
    defer _ = @import("output_mailbox.zig").producerScope(previous);
    return @import("video.zig").closeReport(p, results, capacity, count);
}
pub export fn zc_producer_job_handoffs(p: *c.zc_producer_job, out: [*]c.zc_producer_handoff, capacity: u32, count: *u32) c_int {
    count.* = 0;
    if (capacity < 8) return c.ZC_INVALID;
    const job: *@import("producer.zig").Job = @ptrCast(@alignCast(p));
    const available = job.handoff_count.load(.acquire);
    @memcpy(out[0..available], job.handoffs[0..available]);
    count.* = available;
    return c.ZC_OK;
}
pub export fn zc_video_producer_av(p: *c.zc_recorder, frame: *const c.zc_frame, timestamp: u64, inputs: ?[*]const c.zc_producer_audio_input, count: u32, out: *?*c.zc_producer_job) c_int {
    return @import("video.zig").producerAv(p, frame, timestamp, inputs, count, out);
}
pub export fn zc_video_producer_input_av(p: *c.zc_recorder, frame: *const c.zc_frame, color: *const c.zc_color_space, timestamp: u64, inputs: ?[*]const c.zc_producer_audio_input, count: u32, out: *?*c.zc_producer_job) c_int {
    return @import("video.zig").producerInputAv(p, frame, timestamp, color.*, inputs, count, out);
}

test "raw copies preserve unpacked and CSI2 bytes while removing padding and reject short planes atomically" {
    const std = @import("std");
    var stream = std.mem.zeroes(c.zc_stream);
    stream.width = 3;
    stream.height = 2;
    stream.stride = 8;
    stream.plane_count = 1;
    @memcpy(stream.format[0..7], "SRGGB12");
    const input = [_]u8{ 1, 2, 3, 4, 5, 6, 99, 99, 7, 8, 9, 10, 11, 12 };
    stream.planes[0].data = &input;
    stream.planes[0].length = input.len;
    stream.planes[0].bytes_used = input.len;
    var size: u64 = 0;
    try std.testing.expectEqual(c.ZC_OK, zc_stream_copy_size(&stream, &size));
    try std.testing.expectEqual(@as(u64, 12), size);
    var out: [12]u8 = @splat(42);
    try std.testing.expectEqual(c.ZC_OK, zc_copy_stream(&stream, &out, out.len));
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 }, &out);
    stream.format = @splat(0);
    @memcpy(stream.format[0..13], "SRGGB12_CSI2P");
    try std.testing.expectEqual(c.ZC_OK, zc_stream_copy_size(&stream, &size));
    try std.testing.expectEqual(@as(u64, 12), size);
    try std.testing.expectEqual(c.ZC_OK, zc_copy_stream(&stream, &out, out.len));
    out = @splat(42);
    stream.planes[0].bytes_used -= 1;
    try std.testing.expectEqual(c.ZC_INVALID, zc_copy_stream(&stream, &out, out.len));
    try std.testing.expectEqualSlices(u8, &@as([12]u8, @splat(42)), &out);
    stream.format = @splat(0);
    @memcpy(stream.format[0..18], "SRGGB16_PISP_COMP1");
    size = 99;
    try std.testing.expectEqual(c.ZC_UNSUPPORTED, zc_stream_copy_size(&stream, &size));
    try std.testing.expectEqual(@as(u64, 99), size);
}
