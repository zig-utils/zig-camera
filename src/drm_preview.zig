//! Public opaque-preview dispatch; SDL's native handle layout is unchanged.
const c = @import("abi.zig").c;
pub const available = @import("builtin").os.tag == .linux;
const impl = if (available) @import("drm_preview_linux.zig") else struct {};
pub fn owns(p: *c.zc_preview) bool {
    if (comptime available) return impl.find(p) != null;
    return false;
}
pub export fn zc_default_drm_preview_config(out: *c.zc_drm_preview_config) void {
    out.* = @import("std").mem.zeroes(c.zc_drm_preview_config);
    out.struct_size = @sizeOf(c.zc_drm_preview_config);
    out.format = c.ZC_RGB24;
    out.timeout_ms = 1000;
}
pub export fn zc_preview_open_drm(cfg: *const c.zc_drm_preview_config, out: *?*c.zc_preview) c_int {
    out.* = null;
    if (cfg.struct_size != @sizeOf(c.zc_drm_preview_config) or cfg.reserved != 0 or cfg.width == 0 or cfg.height == 0 or cfg.width > 16384 or cfg.height > 16384 or cfg.timeout_ms == 0 or cfg.timeout_ms > 60000) return c.ZC_INVALID;
    if (!@import("processed_format.zig").valid(cfg.format) or @import("std").mem.indexOfScalar(u8, &cfg.card, 0) == null) return c.ZC_INVALID;
    if (comptime available) return impl.open(cfg, out);
    return c.ZC_UNSUPPORTED;
}
pub export fn zc_drm_preview_state_get(p: *c.zc_preview, out: *c.zc_drm_preview_state) c_int {
    out.* = @import("std").mem.zeroes(c.zc_drm_preview_state);
    if (comptime available) return impl.state(p, out);
    return c.ZC_UNSUPPORTED;
}
pub fn close(p: *c.zc_preview) c_int {
    if (comptime available) return impl.close(p);
    return c.ZC_UNSUPPORTED;
}
pub fn show(p: *c.zc_preview, camera: *c.zc_camera, token: u64, stream: u32) c_int {
    if (comptime available) return impl.show(p, camera, token, stream);
    return c.ZC_UNSUPPORTED;
}
pub fn background(p: *c.zc_preview) c_int {
    if (comptime available) return impl.background(p);
    return c.ZC_UNSUPPORTED;
}
pub fn setView(p: *c.zc_preview, view: *const c.zc_preview_view) c_int {
    if (comptime available) return impl.setView(p, view);
    return c.ZC_UNSUPPORTED;
}
