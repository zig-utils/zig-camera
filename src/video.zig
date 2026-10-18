//! Home JPEG/Matroska and header-checked AVC/HEVC with streaming fragmented MP4.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const jpeg = @import("home/jpeg_encoder.zig");
const mkv = @import("home/mjpeg_stream.zig");
const mp4 = @import("home/mp4_stream.zig");
const native = @import("home/native_encoder.zig");
const rgb = @import("home/rgb_i420.zig");
const A = std.heap.c_allocator;
const Recorder = struct {
    file: std.fs.File,
    encoder: jpeg.Encoder,
    writer: ?mkv.Writer = null,
    mp4_writer: ?mp4.Writer = null,
    codec: ?native.Encoder = null,
    i420: []u8 = &.{},
    pending: std.ArrayList(u8) = .empty,
    pending_pts: u64 = 0,
    pending_key: bool = false,
    config: c.zc_video_config,
    first_ns: u64 = 0,
    last_ns: u64 = 0,
    frames: u64 = 0,
    failed: bool = false,
    fn sink(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *Recorder = @ptrCast(@alignCast(ctx));
        try self.file.writeAll(bytes);
    }
    fn deinit(self: *Recorder) void {
        self.file.close();
        self.encoder.deinit();
        if (options.codecs) {
            if (self.codec) |*encoder| encoder.deinit();
        }
        A.free(self.i420);
        self.pending.deinit(A);
        A.destroy(self);
    }
    fn packet(self: *Recorder, encoded: native.Packet) !void {
        if (encoded.pts < 0) return error.UnexpectedTimestamp;
        const pts: u64 = @intCast(encoded.pts);
        if (self.pending.items.len != 0) {
            if (pts <= self.pending_pts or pts - self.pending_pts > std.math.maxInt(u32)) return error.UnexpectedTimestamp;
            try self.flushPending(@intCast(pts - self.pending_pts));
        }
        try self.pending.appendSlice(A, encoded.data);
        self.pending_pts = pts;
        self.pending_key = encoded.key;
    }
    fn flushPending(self: *Recorder, duration: u32) !void {
        if (self.pending.items.len != 0) {
            try self.mp4_writer.?.frame(self.pending.items, self.pending_pts, duration, self.pending_key);
            self.pending.clearRetainingCapacity();
        }
    }
};
fn validate(path: []const u8, cfg: *const c.zc_video_config) !void {
    if (cfg.codec == c.ZC_MJPEG) {
        if (!std.mem.endsWith(u8, path, ".mkv")) return error.Unsupported;
        if (cfg.bitrate != 0 or cfg.gop != 0) return error.Invalid;
    } else if (cfg.codec == c.ZC_H264 or cfg.codec == c.ZC_HEVC) {
        if (!options.codecs or !std.mem.endsWith(u8, path, ".mp4")) return error.Unsupported;
        if (cfg.width < 16 or cfg.height < 16 or cfg.width > 8192 or cfg.height > 8192 or (cfg.width | cfg.height) & 1 != 0 or cfg.gop > std.math.maxInt(c_int) or (cfg.bitrate != 0 and cfg.bitrate < 1000)) return error.Invalid;
    } else return error.Unsupported;
    if (cfg.width == 0 or cfg.height == 0 or cfg.width > 16384 or cfg.height > 16384 or cfg.quality == 0 or cfg.quality > 100 or cfg.fps_num == 0 or cfg.fps_den == 0 or cfg.fps_num > 1000000 or cfg.fps_den > 1000000 or @as(u64, 1000000) * cfg.fps_den / cfg.fps_num == 0 or @as(u64, 1000000) * cfg.fps_den / cfg.fps_num > std.math.maxInt(u32)) return error.Invalid;
}
fn openImpl(path: [*:0]const u8, cfg: *const c.zc_video_config) !*Recorder {
    try validate(std.mem.span(path), cfg);
    const self = try A.create(Recorder);
    errdefer A.destroy(self);
    var codec: ?native.Encoder = null;
    if (options.codecs and cfg.codec != c.ZC_MJPEG) {
        codec = try native.Encoder.init(.{ .codec = cfg.codec, .width = cfg.width, .height = cfg.height, .fps_num = cfg.fps_num, .fps_den = cfg.fps_den, .bitrate = cfg.bitrate, .quality = cfg.quality, .gop = cfg.gop });
    }
    errdefer if (options.codecs) {
        if (codec) |*encoder| encoder.deinit();
    };
    const planes_buffer = if (cfg.codec != c.ZC_MJPEG) try A.alloc(u8, @as(usize, cfg.width) * cfg.height * 3 / 2) else try A.alloc(u8, 0);
    errdefer A.free(planes_buffer);
    const file = try std.fs.cwd().createFile(std.mem.span(path), .{});
    errdefer file.close();
    self.* = .{ .file = file, .encoder = jpeg.Encoder.init(A), .config = cfg.*, .codec = codec, .i420 = planes_buffer };
    if (cfg.codec == c.ZC_MJPEG) {
        self.writer = try mkv.Writer.init(.{ .context = self, .write = Recorder.sink }, cfg.width, cfg.height, cfg.fps_num, cfg.fps_den);
    } else if (options.codecs) {
        self.mp4_writer = try mp4.Writer.init(.{ .context = self, .write = Recorder.sink }, cfg.width, cfg.height, if (cfg.codec == c.ZC_H264) .h264 else .hevc, try self.codec.?.headers());
    }
    return self;
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.Unsupported => c.ZC_UNSUPPORTED,
        error.Invalid, error.InvalidConfiguration, error.InvalidFrame, error.InvalidGeometry => c.ZC_INVALID,
        error.OutOfMemory => c.ZC_NOMEM,
        else => c.ZC_IO,
    };
}
pub fn open(path: [*:0]const u8, cfg: *const c.zc_video_config, out: *?*c.zc_recorder) c_int {
    out.* = null;
    out.* = @ptrCast(openImpl(path, cfg) catch |err| return status(err));
    return c.ZC_OK;
}
pub fn write(p: *c.zc_recorder, f: *const c.zc_frame, ts: u64) c_int {
    const self: *Recorder = @ptrCast(@alignCast(p));
    if (self.failed) return c.ZC_STATE;
    const s = f.main;
    if (f.token == 0 or s.width != self.config.width or s.height != self.config.height or s.plane_count != 1 or !std.mem.eql(u8, std.mem.sliceTo(&s.format, 0), "BGR888") or s.stride < @as(u64, s.width) * 3 or s.planes[0].bytes_used > s.planes[0].length or s.planes[0].bytes_used < @as(u64, s.stride) * (s.height - 1) + @as(u64, s.width) * 3) return c.ZC_INVALID;
    if (self.frames != 0 and ts <= self.last_ns) return c.ZC_INVALID;
    const first = if (self.frames == 0) ts else self.first_ns;
    const pts = (ts - first) / 1000;
    if (self.config.codec != c.ZC_MJPEG and (pts > std.math.maxInt(i64) or (self.frames != 0 and (pts <= (self.last_ns - first) / 1000 or pts - (self.last_ns - first) / 1000 > std.math.maxInt(u32))))) return c.ZC_INVALID;
    writeImpl(self, &s, ts, pts) catch |err| {
        self.failed = true;
        return status(err);
    };
    self.first_ns = first;
    self.last_ns = ts;
    self.frames += 1;
    return c.ZC_OK;
}
fn writeImpl(self: *Recorder, s: *const c.zc_stream, ts: u64, pts: u64) !void {
    const input = s.planes[0].data[0..@intCast(s.planes[0].bytes_used)];
    if (self.config.codec == c.ZC_MJPEG) {
        const bytes = try self.encoder.encode(input, s.width, s.height, s.stride, 3, @intCast(self.config.quality));
        try self.writer.?.frame(bytes, ts);
    } else if (options.codecs) {
        try rgb.convert(input, s.width, s.height, s.stride, self.i420);
        const pixels = @as(usize, s.width) * s.height;
        const packet = try self.codec.?.encode(.{ self.i420[0..pixels], self.i420[pixels..][0 .. pixels / 4], self.i420[pixels + pixels / 4 ..] }, .{ s.width, s.width / 2, s.width / 2 }, s.width, s.height, @intCast(pts));
        if (packet) |encoded| try self.packet(encoded);
    }
}
pub fn close(p: *c.zc_recorder) c_int {
    const self: *Recorder = @ptrCast(@alignCast(p));
    defer self.deinit();
    if (self.failed) return c.ZC_IO;
    if (options.codecs) {
        if (self.codec) |*encoder| {
            while (encoder.flush() catch return c.ZC_IO) |encoded| self.packet(encoded) catch return c.ZC_IO;
        }
    }
    if (self.config.codec != c.ZC_MJPEG) self.flushPending(@intCast(@as(u64, 1000000) * self.config.fps_den / self.config.fps_num)) catch return c.ZC_IO;
    return c.ZC_OK;
}
test {
    _ = jpeg;
    _ = mkv;
    _ = mp4;
    _ = rgb;
}
