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
