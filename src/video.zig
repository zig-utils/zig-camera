//! Native Home JPEG + streaming Matroska. No external codec/runtime dependency.
const std = @import("std");
const c = @import("abi.zig").c;
const jpeg = @import("home/jpeg_encoder.zig");
const mkv = @import("home/mjpeg_stream.zig");
const A = std.heap.c_allocator;
const Recorder = struct {
    file: std.fs.File,
    encoder: jpeg.Encoder,
    writer: mkv.Writer,
    config: c.zc_video_config,
    failed: bool = false,
    fn write(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *Recorder = @ptrCast(@alignCast(ctx));
        try self.file.writeAll(bytes);
    }
};
pub fn open(path: [*:0]const u8, cfg: *const c.zc_video_config, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (cfg.codec != c.ZC_MJPEG or !std.mem.endsWith(u8, std.mem.span(path), ".mkv")) return c.ZC_UNSUPPORTED;
    if (cfg.width == 0 or cfg.height == 0 or cfg.width > 16384 or cfg.height > 16384 or cfg.quality == 0 or cfg.quality > 100 or cfg.bitrate != 0 or cfg.gop != 0 or cfg.fps_num == 0 or cfg.fps_den == 0 or cfg.fps_num > 1000000 or cfg.fps_den > 1000000) return c.ZC_INVALID;
    const self = A.create(Recorder) catch return c.ZC_NOMEM;
    const file = std.fs.cwd().createFile(std.mem.span(path), .{}) catch {
        A.destroy(self);
        return c.ZC_IO;
    };
    self.* = .{ .file = file, .encoder = jpeg.Encoder.init(A), .writer = undefined, .config = cfg.* };
    self.writer = mkv.Writer.init(.{ .context = self, .write = Recorder.write }, cfg.width, cfg.height, cfg.fps_num, cfg.fps_den) catch {
        file.close();
        A.destroy(self);
        return c.ZC_IO;
    };
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub fn write(p: *c.zc_recorder, f: *const c.zc_frame, ts: u64) c_int {
    const self: *Recorder = @ptrCast(@alignCast(p));
    if (self.failed) return c.ZC_STATE;
    const s = f.main;
    if (f.token == 0 or s.width != self.config.width or s.height != self.config.height or s.plane_count != 1 or !std.mem.eql(u8, std.mem.sliceTo(&s.format, 0), "BGR888") or s.planes[0].bytes_used > s.planes[0].length) return c.ZC_INVALID;
    if (self.writer.frames != 0 and ts <= self.writer.last_ns) return c.ZC_INVALID;
    const bytes = self.encoder.encode(s.planes[0].data[0..@intCast(s.planes[0].bytes_used)], s.width, s.height, s.stride, 3, @intCast(self.config.quality)) catch |err| return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        else => c.ZC_INVALID,
    };
    self.writer.frame(bytes, ts) catch {
        self.failed = true;
        return c.ZC_IO;
    };
    return c.ZC_OK;
}
pub fn close(p: *c.zc_recorder) c_int {
    const self: *Recorder = @ptrCast(@alignCast(p));
    const rc: c_int = if (self.failed) c.ZC_IO else c.ZC_OK;
    self.file.close();
    self.encoder.deinit();
    A.destroy(self);
    return rc;
}
test {
    _ = jpeg;
    _ = mkv;
}
