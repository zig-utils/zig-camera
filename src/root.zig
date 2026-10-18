const std = @import("std");
pub const c = @import("abi.zig").c;
pub const core = @import("core.zig");
comptime {
    _ = core;
}
pub const raw = @import("raw.zig");
pub const dng = @import("dng.zig");
pub const media = @import("media.zig");
comptime {
    _ = media;
}
pub const pixels = @import("pixels.zig");
pub const Config = c.zc_config;
pub const Info = c.zc_info;
pub const Stats = c.zc_stats;
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
}
