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
extern fn zcm_preview_show(*c.zc_preview, *const c.zc_frame) c_int;
extern fn zcm_preview_close(*c.zc_preview) c_int;
pub export fn zc_preview_open(title: [*:0]const u8, width: u32, height: u32, out: *?*c.zc_preview) c_int {
    out.* = null;
    if (!options.preview) return c.ZC_UNSUPPORTED;
    return zcm_preview_open(title, width, height, out);
}
pub export fn zc_preview_show(p: *c.zc_preview, f: *const c.zc_frame) c_int {
    if (!options.preview) return c.ZC_UNSUPPORTED;
    return zcm_preview_show(p, f);
}
pub export fn zc_preview_close(p: *c.zc_preview) c_int {
    if (!options.preview) return c.ZC_UNSUPPORTED;
    return zcm_preview_close(p);
}
pub export fn zc_default_video_config(out: *c.zc_video_config) void {
    out.* = .{ .width = 1920, .height = 1080, .fps_num = 30, .fps_den = 1, .codec = c.ZC_MJPEG, .bitrate = 0, .quality = 90, .gop = 0 };
}
pub export fn zc_video_open(path: [*:0]const u8, cfg: *const c.zc_video_config, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!options.video) return c.ZC_UNSUPPORTED;
    return @import("video.zig").open(path, cfg, out);
}
pub export fn zc_video_write(p: *c.zc_recorder, f: *const c.zc_frame, ts: u64) c_int {
    if (!options.video) return c.ZC_UNSUPPORTED;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").write(p, f, ts);
}
pub export fn zc_video_close(p: *c.zc_recorder) c_int {
    if (!options.video) return c.ZC_UNSUPPORTED;
    if (@import("video.zig").producerBusy(p)) return c.ZC_BUSY;
    return @import("video.zig").close(p);
}

pub export fn zc_copy_rgb(f: *const c.zc_frame, out: [*]u8, length: u64) c_int {
    const m = f.main;
    if (f.token == 0 or m.width == 0 or m.height == 0 or m.plane_count != 1 or m.width > 16384 or m.height > 16384 or m.stride < @as(u64, m.width) * 3 or m.planes[0].bytes_used > m.planes[0].length or m.planes[0].bytes_used < @as(u64, m.stride) * (m.height - 1) + @as(u64, m.width) * 3 or length < @as(u64, m.width) * m.height * 3) return c.ZC_INVALID;
    const std = @import("std");
    if (!std.mem.eql(u8, std.mem.sliceTo(&m.format, 0), "BGR888")) return c.ZC_UNSUPPORTED;
    for (0..m.height) |y| @memcpy(out[y * @as(usize, m.width) * 3 ..][0 .. m.width * 3], m.planes[0].data[y * @as(usize, m.stride) ..][0 .. m.width * 3]);
    return c.ZC_OK;
}

/// Descriptors and DMA access remain borrowed for the duration of this call.
pub export fn zc_copy_stream(m: *const c.zc_stream, out: [*]u8, length: u64) c_int {
    const std = @import("std");
    const pack = @import("home/plane_pack.zig");
    if (m.width == 0 or m.height == 0 or m.width > 16384 or m.height > 16384 or m.plane_count == 0 or m.plane_count > c.ZC_MAX_PLANES or length > std.math.maxInt(usize)) return c.ZC_INVALID;
    for (m.planes[0..m.plane_count]) |p| {
        if (p.data == null or p.bytes_used > p.length or p.bytes_used > std.math.maxInt(usize)) return c.ZC_INVALID;
    }
    const name = std.mem.sliceTo(&m.format, 0);
    if (std.mem.eql(u8, name, "BGR888")) {
        if (m.plane_count != 1) return c.ZC_INVALID;
        pack.rows(m.planes[0].data[0..@intCast(m.planes[0].bytes_used)], m.stride, @as(usize, m.width) * 3, m.height, out[0..@intCast(length)]) catch return c.ZC_INVALID;
    } else if (std.mem.eql(u8, name, "YUV420")) {
        if ((m.stride | m.width | m.height) & 1 != 0) return c.ZC_INVALID;
        var planes: [3][]const u8 = undefined;
        if (m.plane_count == 3) {
            for (0..3) |i| planes[i] = m.planes[i].data[0..@intCast(m.planes[i].bytes_used)];
        } else if (m.plane_count == 1) {
            const ysize = @as(usize, m.stride) * m.height;
            const data = m.planes[0].data[0..@intCast(m.planes[0].bytes_used)];
            if (data.len < ysize + ysize / 4) return c.ZC_INVALID;
            planes = .{ data[0..ysize], data[ysize..][0 .. ysize / 4], data[ysize + ysize / 4 ..] };
        } else return c.ZC_UNSUPPORTED;
        pack.packI420(planes, .{ m.stride, m.stride / 2, m.stride / 2 }, m.width, m.height, out[0..@intCast(length)]) catch return c.ZC_INVALID;
    } else return c.ZC_UNSUPPORTED;
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
