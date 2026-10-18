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
