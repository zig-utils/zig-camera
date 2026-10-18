//! Optional C system-library adapters, exported through the stable C interface.
const c = @import("abi.zig").c;
const options = @import("options");
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
    return @import("video.zig").write(p, f, ts);
}
pub export fn zc_video_close(p: *c.zc_recorder) c_int {
    if (!options.video) return c.ZC_UNSUPPORTED;
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
    return @import("video.zig").bufferStats(p, out);
}
pub export fn zc_video_save_buffer(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    return @import("video.zig").saveBuffer(p, path);
}
pub export fn zc_video_open_output(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    return @import("video.zig").openOutput(p, path);
}
pub export fn zc_video_close_output(p: *c.zc_recorder) c_int {
    return @import("video.zig").closeOutput(p);
}
pub export fn zc_video_split(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    return @import("video.zig").split(p, path);
}
pub export fn zc_video_cancel_split(p: *c.zc_recorder) c_int {
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
    return @import("video.zig").writeAudio(p, data, length, timestamp);
}
pub export fn zc_video_set_rotation(p: *c.zc_recorder, duration: u64, bytes: u64) c_int {
    return @import("video.zig").setRotation(p, duration, bytes);
}
pub export fn zc_video_recording_stats(p: *c.zc_recorder, out: *c.zc_recording_stats) c_int {
    return @import("video.zig").recordingStats(p, out);
}
