//! Home codecs and containers with encoded circular history and IDR-aligned splits.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const jpeg = @import("home/jpeg_encoder.zig");
const mkv = @import("home/mjpeg_stream.zig");
const mp4 = @import("home/mp4_stream.zig");
const native = @import("home/native_encoder.zig");
const rgb = @import("home/rgb_i420.zig");
const Ring = @import("home/packet_ring.zig").Ring;
const av = @import("home/av_stream.zig");
const pcm = @import("home/pcm_timeline.zig");
const Policy = @import("home/recording_policy.zig").Policy;
const A = std.heap.c_allocator;
const Output = struct {
    file: std.fs.File,
    writer: ?mkv.Writer = null,
    mp4_writer: ?mp4.Writer = null,
    av_writer: ?av.Writer = null,
    bytes: u64 = 0,
    pending: std.ArrayList(u8) = .empty,
    pending_ns: u64 = 0,
    pending_key: bool = false,
    first_ns: u64 = 0,
    frames: u64 = 0,
    waiting_key: bool = true,
    fn sink(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *Output = @ptrCast(@alignCast(ctx));
        const next = try std.math.add(u64, self.bytes, bytes.len);
        try self.file.writeAll(bytes);
        self.bytes = next;
    }
    fn init(path: [*:0]const u8, cfg: *const c.zc_video_config, headers: []const u8, avoid: [2]?*Output, recording: *const c.zc_recording_options) !*Output {
        try validate(std.mem.span(path), cfg, recording.sample_rate != 0);
        const self = try A.create(Output);
        errdefer A.destroy(self);
        // Compare open file identities before truncation, including hardlinks.
        const file = try std.fs.cwd().createFile(std.mem.span(path), .{ .truncate = false, .exclusive = recording.exclusive != 0 });
        errdefer file.close();
        const identity = try std.posix.fstat(file.handle);
        for (avoid) |existing| if (existing) |other| {
            const other_id = try std.posix.fstat(other.file.handle);
            if (identity.dev == other_id.dev and identity.ino == other_id.ino) return error.Invalid;
        };
        try file.setEndPos(0);
        self.* = .{ .file = file };
        if (recording.sample_rate != 0) {
            var private: [8192]u8 = undefined;
            const bytes = if (cfg.codec == c.ZC_MJPEG) &.{} else try mp4.codecPrivate(if (cfg.codec == c.ZC_H264) .h264 else .hevc, headers, &private);
            self.av_writer = try av.Writer.init(.{ .context = self, .write = sink }, .{ .width = cfg.width, .height = cfg.height, .fps_num = cfg.fps_num, .fps_den = cfg.fps_den, .codec = cfg.codec, .sample_rate = recording.sample_rate, .channels = recording.channels, .codec_private = bytes });
        } else if (cfg.codec == c.ZC_MJPEG) self.writer = try mkv.Writer.init(.{ .context = self, .write = sink }, cfg.width, cfg.height, cfg.fps_num, cfg.fps_den) else self.mp4_writer = try mp4.Writer.init(.{ .context = self, .write = sink }, cfg.width, cfg.height, if (cfg.codec == c.ZC_H264) .h264 else .hevc, headers);
        return self;
    }
    fn deinit(self: *Output) void {
        self.file.close();
        self.pending.deinit(A);
        A.destroy(self);
    }
    fn flushPending(self: *Output, duration: u32) !void {
        if (self.pending.items.len != 0) {
            try self.mp4_writer.?.frame(self.pending.items, (self.pending_ns - self.first_ns) / 1000, duration, self.pending_key);
            self.pending.clearRetainingCapacity();
        }
    }
    fn packet(self: *Output, data: []const u8, timestamp: u64, key: bool) !void {
        if (self.waiting_key) {
            if (!key) return;
            self.first_ns = timestamp;
            self.waiting_key = false;
        }
        if (self.av_writer) |*writer| try writer.video(data, timestamp - self.first_ns, key) else if (self.writer) |*writer| try writer.frame(data, timestamp) else {
            if (self.pending.items.len != 0) {
                if (timestamp <= self.pending_ns or (timestamp - self.pending_ns) / 1000 > std.math.maxInt(u32) or (timestamp - self.pending_ns) / 1000 == 0) return error.Invalid;
                try self.flushPending(@intCast((timestamp - self.pending_ns) / 1000));
            }
            try self.pending.appendSlice(A, data);
            self.pending_ns = timestamp;
            self.pending_key = key;
        }
        self.frames += 1;
    }
    fn finish(self: *Output, nominal: u32, next: ?u64) !void {
        if (self.pending.items.len != 0) {
            const duration = if (next) |ts| (ts - self.pending_ns) / 1000 else nominal;
            if (duration == 0 or duration > std.math.maxInt(u32)) return error.Invalid;
            try self.flushPending(@intCast(duration));
        }
    }
};
const Recorder = struct {
    encoder: jpeg.Encoder,
    output: ?*Output = null,
    next: ?*Output = null,
    ring: ?Ring = null,
    codec: ?native.Encoder = null,
    headers: []u8 = &.{},
    i420: []u8 = &.{},
    config: c.zc_video_config,
    first_ns: u64 = 0,
    last_ns: u64 = 0,
    frames: u64 = 0,
    segments: u64 = 0,
    failed: bool = false,
    recording: c.zc_recording_options,
    audio: ?pcm.Queue = null,
    audio_frames: u64 = 0,
    audio_written: u64 = 0,
    last_packet_ns: ?u64 = null,
    rotation: Policy = .{},
    fn nominal(self: *const Recorder) u32 {
        return @intCast(@as(u64, 1000000) * self.config.fps_den / self.config.fps_num);
    }
    fn deinit(self: *Recorder) void {
        if (self.output) |out| out.deinit();
        if (self.next) |out| out.deinit();
        if (self.ring) |*ring| ring.deinit();
        if (self.audio) |*queue| queue.deinit();
        self.encoder.deinit();
        if (options.codecs) {
            if (self.codec) |*encoder| encoder.deinit();
        }
        A.free(self.headers);
        A.free(self.i420);
        A.destroy(self);
    }
    fn forceKey(self: *Recorder) !void {
        if (options.codecs) {
            if (self.codec) |*encoder| {
                if (!encoder.draining) try encoder.requestKeyframe();
            }
        }
    }
    fn packet(self: *Recorder, data: []const u8, timestamp: u64, key: bool) !void {
        if (self.ring) |*ring| _ = try ring.push(data, timestamp, key);
        if (self.next != null and key and self.output.?.frames != 0) {
            const old = self.output.?;
            try self.drainAudio(timestamp);
            try old.finish(self.nominal(), timestamp);
            old.deinit();
            self.output = self.next;
            self.next = null;
            self.segments += 1;
        }
        if (self.output) |out| {
            if (out.waiting_key and key) {
                out.first_ns = timestamp;
                out.waiting_key = false;
            }
            try self.drainAudio(timestamp);
            try out.packet(data, timestamp, key);
        }
        self.last_packet_ns = timestamp;
        // A split requested before the first input still gives the old output
        // its initial key. Request another IDR instead of creating an empty file.
        if (self.next != null and key) try self.forceKey();
    }
    fn drainAudio(self: *Recorder, cut: u64) !void {
        const out = self.output orelse return;
        if (out.waiting_key or self.audio == null) return;
        const minimum = try std.math.add(u64, self.first_ns, out.first_ns);
        const end = try std.math.add(u64, self.first_ns, cut);
        while (try self.audio.?.take(minimum, end)) |chunk| {
            try out.av_writer.?.audio(chunk.data, chunk.timestamp - minimum);
            self.audio_written += chunk.frames;
        }
    }
    fn encoded(self: *Recorder, encoded_packet: native.Packet) !void {
        if (encoded_packet.pts < 0) return error.Invalid;
        try self.packet(encoded_packet.data, @as(u64, @intCast(encoded_packet.pts)) * 1000, encoded_packet.key);
    }
    fn replay(self: *Recorder, out: *Output) !void {
        const ring = if (self.ring) |*ring| ring else return error.Unsupported;
        if (ring.count == 0) return error.EmptyBuffer;
        var largest: usize = 0;
        for (0..ring.count) |i| largest = @max(largest, ring.entry(i).?.length);
        const scratch = try A.alloc(u8, largest);
        defer A.free(scratch);
        for (0..ring.count) |i| {
            const e = ring.entry(i).?;
            try out.packet(try ring.copy(i, scratch), e.timestamp, e.key);
        }
    }
};
fn validate(path: []const u8, cfg: *const c.zc_video_config, audio: bool) !void {
    if (audio and !std.mem.endsWith(u8, path, ".mkv")) return error.Unsupported;
    if (cfg.codec == c.ZC_MJPEG) {
        if (!std.mem.endsWith(u8, path, ".mkv")) return error.Unsupported;
        if (cfg.bitrate != 0 or cfg.gop != 0) return error.Invalid;
    } else if (cfg.codec == c.ZC_H264 or cfg.codec == c.ZC_HEVC) {
        if (!options.codecs or (!audio and !std.mem.endsWith(u8, path, ".mp4"))) return error.Unsupported;
        if (cfg.width < 16 or cfg.height < 16 or cfg.width > 8192 or cfg.height > 8192 or (cfg.width | cfg.height) & 1 != 0 or cfg.gop > std.math.maxInt(c_int) or (cfg.bitrate != 0 and cfg.bitrate < 1000)) return error.Invalid;
    } else return error.Unsupported;
    if (cfg.width == 0 or cfg.height == 0 or cfg.width > 16384 or cfg.height > 16384 or cfg.quality == 0 or cfg.quality > 100 or cfg.fps_num == 0 or cfg.fps_den == 0 or cfg.fps_num > 1000000 or cfg.fps_den > 1000000 or @as(u64, 1000000) * cfg.fps_den / cfg.fps_num == 0 or @as(u64, 1000000) * cfg.fps_den / cfg.fps_num > std.math.maxInt(u32)) return error.Invalid;
}
fn init(cfg: *const c.zc_video_config) !*Recorder {
    try validate(if (cfg.codec == c.ZC_MJPEG) "check.mkv" else "check.mp4", cfg, false);
    const self = try A.create(Recorder);
    self.* = .{ .encoder = jpeg.Encoder.init(A), .config = cfg.*, .recording = defaultRecordingOptions() };
    errdefer self.deinit();
    if (options.codecs and cfg.codec != c.ZC_MJPEG) {
        self.codec = try native.Encoder.init(.{ .codec = cfg.codec, .width = cfg.width, .height = cfg.height, .fps_num = cfg.fps_num, .fps_den = cfg.fps_den, .bitrate = cfg.bitrate, .quality = cfg.quality, .gop = cfg.gop });
        self.headers = try A.dupe(u8, try self.codec.?.headers());
        self.i420 = try A.alloc(u8, @as(usize, cfg.width) * cfg.height * 3 / 2);
    }
    return self;
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.Unsupported => c.ZC_UNSUPPORTED,
        error.Invalid, error.InvalidConfiguration, error.InvalidFrame, error.InvalidGeometry, error.PacketTooLarge, error.InvalidTimestamp, error.InvalidPcm, error.InvalidRate, error.TimestampOverflow => c.ZC_INVALID,
        error.OutOfMemory => c.ZC_NOMEM,
        error.EmptyBuffer, error.NoOutput => c.ZC_STATE,
        error.Busy, error.BufferFull => c.ZC_BUSY,
        else => c.ZC_IO,
    };
}
fn recorder(p: *c.zc_recorder) *Recorder {
    return @ptrCast(@alignCast(p));
}
pub fn open(path: [*:0]const u8, cfg: *const c.zc_video_config, out: *?*c.zc_recorder) c_int {
    out.* = null;
    const self = init(cfg) catch |err| return status(err);
    self.output = Output.init(path, cfg, self.headers, .{ null, null }, &self.recording) catch |err| {
        self.deinit();
        return status(err);
    };
    self.segments = 1;
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub fn openCircular(cfg: *const c.zc_video_config, buffer: *const c.zc_buffer_config, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (buffer.struct_size != @sizeOf(c.zc_buffer_config) or buffer.max_bytes == 0 or buffer.max_bytes > 1024 * 1024 * 1024 or buffer.max_frames == 0 or buffer.max_frames > 65536 or buffer.duration_us == 0 or buffer.duration_us > std.math.maxInt(u64) / 1000) return c.ZC_INVALID;
    const self = init(cfg) catch |err| return status(err);
    self.ring = Ring.init(A, @intCast(buffer.max_bytes), buffer.max_frames, buffer.duration_us * 1000) catch |err| {
        self.deinit();
        return status(err);
    };
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub fn write(p: *c.zc_recorder, f: *const c.zc_frame, ts: u64) c_int {
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    const s = f.main;
    if (f.token == 0 or s.width != self.config.width or s.height != self.config.height or s.plane_count != 1 or !std.mem.eql(u8, std.mem.sliceTo(&s.format, 0), "BGR888") or s.stride < @as(u64, s.width) * 3 or s.planes[0].bytes_used > s.planes[0].length or s.planes[0].bytes_used < @as(u64, s.stride) * (s.height - 1) + @as(u64, s.width) * 3) return c.ZC_INVALID;
    if (self.frames != 0 and ts <= self.last_ns) return c.ZC_INVALID;
    const first = if (self.frames == 0) ts else self.first_ns;
    const pts = (ts - first) / 1000;
    if (self.config.codec != c.ZC_MJPEG and (pts > std.math.maxInt(i64) or (self.frames != 0 and (pts <= (self.last_ns - first) / 1000 or pts - (self.last_ns - first) / 1000 > std.math.maxInt(u32))))) return c.ZC_INVALID;
    self.first_ns = first;
    writeImpl(self, &s, ts - first, pts) catch |err| {
        self.failed = true;
        return status(err);
    };
    self.first_ns = first;
    self.last_ns = ts;
    self.frames += 1;
    return c.ZC_OK;
}
fn writeImpl(self: *Recorder, s: *const c.zc_stream, ns: u64, pts: u64) !void {
    const input = s.planes[0].data[0..@intCast(s.planes[0].bytes_used)];
    if (self.config.codec == c.ZC_MJPEG) try self.packet(try self.encoder.encode(input, s.width, s.height, s.stride, 3, @intCast(self.config.quality)), ns, true) else if (options.codecs) {
        try rgb.convert(input, s.width, s.height, s.stride, self.i420);
        const pixels = @as(usize, s.width) * s.height;
        if (try self.codec.?.encode(.{ self.i420[0..pixels], self.i420[pixels..][0 .. pixels / 4], self.i420[pixels + pixels / 4 ..] }, .{ s.width, s.width / 2, s.width / 2 }, s.width, s.height, @intCast(pts))) |packet| try self.encoded(packet);
    }
}
pub fn bufferStats(p: *c.zc_recorder, out: *c.zc_buffer_stats) c_int {
    const self = recorder(p);
    out.* = std.mem.zeroes(c.zc_buffer_stats);
    out.segments = self.segments;
    out.split_pending = @intFromBool(self.next != null);
    out.output_open = @intFromBool(self.output != null);
    if (self.ring) |*ring| {
        out.frames = ring.count;
        out.bytes = ring.used;
        out.evicted = ring.evicted;
        out.skipped = ring.skipped;
        if (ring.count != 0) {
            out.first_ns = ring.entry(0).?.timestamp;
            out.last_ns = ring.entry(ring.count - 1).?.timestamp;
        }
    }
    return c.ZC_OK;
}
pub fn saveBuffer(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    const self = recorder(p);
    if (self.audio != null) return c.ZC_UNSUPPORTED;
    if (self.failed) return c.ZC_STATE;
    if (self.ring == null) return c.ZC_UNSUPPORTED;
    if (self.ring.?.count == 0) return c.ZC_STATE;
    const out = Output.init(path, &self.config, self.headers, .{ self.output, self.next }, &self.recording) catch |err| return status(err);
    defer out.deinit();
    self.replay(out) catch |err| return status(err);
    out.finish(self.nominal(), null) catch |err| return status(err);
    return c.ZC_OK;
}
pub fn openOutput(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    const self = recorder(p);
    if (self.audio != null) return c.ZC_UNSUPPORTED;
    if (self.failed) return c.ZC_STATE;
    if (self.output != null or self.next != null) return c.ZC_BUSY;
    const out = Output.init(path, &self.config, self.headers, .{ null, null }, &self.recording) catch |err| return status(err);
    if (self.ring != null and self.ring.?.count != 0) self.replay(out) catch |err| {
        out.deinit();
        return status(err);
    };
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    self.output = out;
    self.segments += 1;
    return c.ZC_OK;
}
pub fn closeOutput(p: *c.zc_recorder) c_int {
    const self = recorder(p);
    if (self.audio != null) return c.ZC_UNSUPPORTED;
    if (self.next != null) return c.ZC_BUSY;
    const out = self.output orelse return c.ZC_STATE;
    self.output = null;
    defer out.deinit();
    out.finish(self.nominal(), null) catch |err| return status(err);
    return c.ZC_OK;
}
pub fn split(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    if (self.next != null) return c.ZC_BUSY;
    if (self.output == null) return c.ZC_STATE;
    const out = Output.init(path, &self.config, self.headers, .{ self.output, null }, &self.recording) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    self.next = out;
    return c.ZC_OK;
}
pub fn cancelSplit(p: *c.zc_recorder) c_int {
    const self = recorder(p);
    const out = self.next orelse return c.ZC_STATE;
    self.next = null;
    out.deinit();
    return c.ZC_OK;
}
pub fn close(p: *c.zc_recorder) c_int {
    const self = recorder(p);
    defer self.deinit();
    if (self.failed) return c.ZC_IO;
    if (options.codecs) {
        if (self.codec) |*encoder| {
            while (encoder.flush() catch return c.ZC_IO) |packet| self.encoded(packet) catch return c.ZC_IO;
        }
    }
    if (self.audio != null and self.frames != 0) self.drainAudio(std.math.add(u64, self.last_ns - self.first_ns, @as(u64, 1_000_000_000) * self.config.fps_den / self.config.fps_num) catch return c.ZC_INVALID) catch return c.ZC_IO;
    if (self.output) |out| out.finish(self.nominal(), null) catch return c.ZC_IO;
    return if (self.next != null) c.ZC_STATE else c.ZC_OK;
}
test {
    _ = jpeg;
    _ = mkv;
    _ = mp4;
    _ = rgb;
    _ = Ring;
}

pub fn defaultRecordingOptions() c.zc_recording_options {
    return .{ .struct_size = @sizeOf(c.zc_recording_options), .sample_rate = 0, .channels = 1, .buffer_frames = 96000, .max_blocks = 256, .exclusive = 0 };
}
pub fn openEx(path: [*:0]const u8, cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (opts.struct_size != @sizeOf(c.zc_recording_options) or opts.exclusive > 1) return c.ZC_INVALID;
    const self = init(cfg) catch |err| return status(err);
    self.recording = opts.*;
    if (opts.sample_rate != 0) self.audio = pcm.Queue.init(A, opts.sample_rate, opts.channels, opts.buffer_frames, opts.max_blocks) catch |err| {
        self.deinit();
        return status(err);
    };
    self.output = Output.init(path, cfg, self.headers, .{ null, null }, opts) catch |err| {
        self.deinit();
        return status(err);
    };
    self.segments = 1;
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub fn writeAudio(p: *c.zc_recorder, data: [*]const u8, length: u64, timestamp: u64) c_int {
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    if (self.audio == null) return c.ZC_UNSUPPORTED;
    if (length > std.math.maxInt(usize)) return c.ZC_INVALID;
    self.audio.?.push(data[0..@intCast(length)], timestamp) catch |err| return status(err);
    self.audio_frames += length / (self.recording.channels * 2);
    if (self.last_packet_ns) |cut| self.drainAudio(cut) catch |err| {
        self.failed = true;
        return status(err);
    };
    return c.ZC_OK;
}
pub fn setRotation(p: *c.zc_recorder, duration_ns: u64, max_bytes: u64) c_int {
    recorder(p).rotation = .{ .duration_ns = duration_ns, .max_bytes = max_bytes };
    return c.ZC_OK;
}
pub fn recordingStats(p: *c.zc_recorder, out: *c.zc_recording_stats) c_int {
    const self = recorder(p);
    out.* = std.mem.zeroes(c.zc_recording_stats);
    out.segments = self.segments;
    out.audio_enabled = @intFromBool(self.audio != null);
    out.audio_frames = self.audio_frames;
    out.audio_written_frames = self.audio_written;
    if (self.audio) |*queue| {
        out.audio_queued_frames = queue.used;
        out.audio_trimmed_frames = queue.trimmed;
    }
    if (self.output) |o| {
        out.output_bytes = o.bytes + o.pending.items.len;
        out.output_frames = o.frames;
        if (self.frames != 0 and self.last_ns - self.first_ns >= o.first_ns) out.output_duration_ns = self.last_ns - self.first_ns - o.first_ns;
        out.rotation_due = @intFromBool(self.rotation.due(o.frames, out.output_duration_ns, out.output_bytes, self.next != null));
    }
    return c.ZC_OK;
}
