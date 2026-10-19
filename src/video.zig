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
const aac = @import("home/native_aac.zig");
const packet_output = @import("home/packet_output.zig");
const aac_enabled = if (@hasDecl(options, "aac")) options.aac else false;
const Policy = @import("home/recording_policy.zig").Policy;
const A = std.heap.c_allocator;
// Two owned snapshots per recorder. File reservations survive recorder close;
// asynchronous writers never dereference live capture state.
const Identity = struct {
    dev: i128,
    ino: i128,
    fn of(file: std.fs.File) !Identity {
        const st = try std.posix.fstat(file.handle);
        return .{ .dev = st.dev, .ino = st.ino };
    }
    fn equal(a: Identity, b: Identity) bool {
        return a.dev == b.dev and a.ino == b.ino;
    }
};
const Reservations = struct {
    mutex: std.Thread.Mutex = .{},
    slots: [2]?Identity = .{ null, null },
    refs: usize = 1,
    fn check(s: *Reservations, id: Identity) !void {
        s.mutex.lock();
        defer s.mutex.unlock();
        for (s.slots) |slot| if (slot) |other| if (id.equal(other)) return error.Busy;
    }
    fn reserve(s: *Reservations, id: Identity) !usize {
        s.mutex.lock();
        defer s.mutex.unlock();
        for (s.slots) |slot| if (slot) |other| if (id.equal(other)) return error.Busy;
        for (&s.slots, 0..) |*slot, i| if (slot.* == null) {
            slot.* = id;
            s.refs += 1;
            return i;
        };
        return error.Busy;
    }
    fn release(s: *Reservations, slot: ?usize) void {
        s.mutex.lock();
        if (slot) |i| s.slots[i] = null;
        s.refs -= 1;
        const destroy = s.refs == 0;
        s.mutex.unlock();
        if (destroy) A.destroy(s);
    }
};
fn reserveFile(path: [*:0]const u8, exclusive: bool, avoid: [18]?*Output, reservations: ?*Reservations) !std.fs.File {
    const file = try std.fs.cwd().createFile(std.mem.span(path), .{ .truncate = false, .exclusive = exclusive });
    errdefer file.close();
    const id = try Identity.of(file);
    for (avoid) |existing| if (existing) |other| try other.checkIdentity(id);
    if (reservations) |r| try r.check(id);
    return file;
}
const Output = struct {
    failure: c_int = c.ZC_OK,
    generation: u64 = 0,
    split_state: u32 = 0,
    next: ?*Output = null,
    file: ?std.fs.File = null,
    callbacks: ?c.zc_output_callbacks = null,
    callback_headers: []u8 = &.{},
    callback_buffer: std.ArrayList(u8) = .empty,
    video_codec: u32 = 0,
    writer: ?mkv.Writer = null,
    mp4_writer: ?mp4.Writer = null,
    av_writer: ?av.Writer = null,
    aac_encoder: ?aac.Encoder = null,
    audio_first_ns: ?u64 = null,
    audio_frames: u64 = 0,
    audio_cursor: ?u64 = null,
    delivered_audio_frames: u64 = 0,
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
        if (self.callbacks) |cb| {
            if (cb.write.?(cb.context, bytes.ptr, bytes.len) != c.ZC_OK) return error.CallbackFailed;
        } else try self.file.?.writeAll(bytes);
        self.bytes = next;
    }
    fn patch(ctx: *anyopaque, offset: u64, bytes: []const u8) anyerror!void {
        const self: *Output = @ptrCast(@alignCast(ctx));
        if (self.callbacks) |cb| {
            if (cb.patch.?(cb.context, offset, bytes.ptr, bytes.len) != c.ZC_OK) return error.CallbackFailed;
        } else try self.file.?.pwriteAll(bytes, offset);
    }
    fn init(path: [*:0]const u8, cfg: *const c.zc_video_config, headers: []const u8, avoid: [18]?*Output, recording: *const c.zc_recording_options, audio_bitrate: u32, reservations: ?*Reservations) !*Output {
        try validate(std.mem.span(path), cfg, recording.sample_rate != 0);
        const file = try reserveFile(path, recording.exclusive != 0, avoid, reservations);
        errdefer file.close();
        return initFile(file, std.mem.endsWith(u8, std.mem.span(path), ".mp4"), cfg, headers, recording, audio_bitrate);
    }
    // Takes file ownership only on success. AAC and all output writes may run
    // on an independent snapshot worker after the immutable copy is frozen.
    fn initFile(file: std.fs.File, is_mp4: bool, cfg: *const c.zc_video_config, headers: []const u8, recording: *const c.zc_recording_options, audio_bitrate: u32) !*Output {
        var audio_codec: ?aac.Encoder = null;
        if (aac_enabled and recording.sample_rate != 0 and is_mp4) audio_codec = try aac.Encoder.init(.{ .sample_rate = recording.sample_rate, .channels = recording.channels, .bitrate = if (audio_bitrate != 0) audio_bitrate else 64000 * recording.channels });
        errdefer if (aac_enabled) {
            if (audio_codec) |*encoder| encoder.deinit();
        };
        const self = try A.create(Output);
        errdefer A.destroy(self);
        try file.setEndPos(0);
        self.* = .{ .file = file, .aac_encoder = audio_codec };
        try self.initWriters(cfg, headers, recording);
        return self;
    }
    fn initWriters(self: *Output, cfg: *const c.zc_video_config, headers: []const u8, recording: *const c.zc_recording_options) !void {
        self.video_codec = cfg.codec;
        if (aac_enabled and self.aac_encoder != null) {
            const encoder = &self.aac_encoder.?;
            self.mp4_writer = try mp4.Writer.initAv(.{ .context = self, .write = sink, .patch = patch }, cfg.width, cfg.height, if (cfg.codec == c.ZC_H264) .h264 else .hevc, headers, .{ .sample_rate = recording.sample_rate, .channels = recording.channels, .bitrate = encoder.config.bitrate, .delay = encoder.info.delay, .config = encoder.info.config[0..2].* });
        } else if (recording.sample_rate != 0) {
            var private: [8192]u8 = undefined;
            const bytes = if (cfg.codec == c.ZC_MJPEG) &.{} else try mp4.codecPrivate(if (cfg.codec == c.ZC_H264) .h264 else .hevc, headers, &private);
            self.av_writer = try av.Writer.init(.{ .context = self, .write = sink }, .{ .width = cfg.width, .height = cfg.height, .fps_num = cfg.fps_num, .fps_den = cfg.fps_den, .codec = cfg.codec, .sample_rate = recording.sample_rate, .channels = recording.channels, .codec_private = bytes });
        } else if (cfg.codec == c.ZC_MJPEG) self.writer = try mkv.Writer.init(.{ .context = self, .write = sink }, cfg.width, cfg.height, cfg.fps_num, cfg.fps_den) else self.mp4_writer = try mp4.Writer.init(.{ .context = self, .write = sink }, cfg.width, cfg.height, if (cfg.codec == c.ZC_H264) .h264 else .hevc, headers);
    }
    fn initCallbacks(cb: c.zc_output_callbacks, cfg: *const c.zc_video_config, headers: []const u8, recording: *const c.zc_recording_options, bitrate: u32) !*Output {
        const self = try A.create(Output);
        self.* = .{ .callbacks = cb, .video_codec = cfg.codec };
        errdefer self.deinit();
        if (cb.format == c.ZC_OUTPUT_PACKETS) {
            self.callback_headers = try A.dupe(u8, headers);
        } else {
            if (aac_enabled and cb.format == c.ZC_OUTPUT_MP4 and recording.sample_rate != 0) self.aac_encoder = try aac.Encoder.init(.{ .sample_rate = recording.sample_rate, .channels = recording.channels, .bitrate = if (bitrate != 0) bitrate else 64000 * recording.channels });
            try self.initWriters(cfg, headers, recording);
        }
        return self;
    }
    fn deinit(self: *Output) void {
        if (self.next) |out| out.deinit();
        if (self.file) |file| file.close();
        A.free(self.callback_headers);
        self.callback_buffer.deinit(A);
        if (aac_enabled) {
            if (self.aac_encoder) |*encoder| encoder.deinit();
        }
        self.pending.deinit(A);
        A.destroy(self);
    }
    fn checkIdentity(self: *const Output, id: Identity) !void {
        if (self.file) |file| if (id.equal(try Identity.of(file))) return error.Invalid;
        if (self.callbacks) |cb| for ([_]i32{ cb.file_fd, cb.pts_fd, cb.secondary_pts_fd }) |fd| {
            if (fd >= 0 and id.equal(try Identity.of(.{ .handle = fd }))) return error.Invalid;
        };
    }
    fn notify(self: *Output, data: []const u8, timestamp: u64, codec: u32, flags: u32) !void {
        const cb = self.callbacks orelse return;
        const callback = cb.packet orelse return;
        const event = c.zc_output_packet{ .data = if (data.len == 0) null else data.ptr, .length = data.len, .timestamp_ns = timestamp, .codec = codec, .flags = flags };
        if (callback(cb.context, &event) != c.ZC_OK) return error.CallbackFailed;
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
        if (self.callbacks != null and self.callbacks.?.format == c.ZC_OUTPUT_PACKETS) {
            var payload = data;
            var flags: u32 = @intFromBool(key);
            if (self.video_codec != c.ZC_MJPEG) {
                const prefix = if (self.frames == 0) self.callback_headers else &.{};
                try self.callback_buffer.resize(A, try std.math.add(usize, prefix.len, data.len));
                if (prefix.len != 0) _ = try packet_output.annexB(prefix, self.callback_buffer.items[0..prefix.len]);
                _ = try packet_output.annexB(data, self.callback_buffer.items[prefix.len..]);
                payload = self.callback_buffer.items;
                flags |= 4;
            }
            try self.notify(payload, timestamp - self.first_ns, self.video_codec, flags);
            self.frames += 1;
            self.bytes += payload.len;
            return;
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
        try self.notify(&.{}, timestamp - self.first_ns, self.video_codec, @intFromBool(key));
    }
    fn audioChunk(self: *Output, data: []const u8, timestamp: u64) !void {
        if (self.callbacks != null and self.callbacks.?.format == c.ZC_OUTPUT_PACKETS) {
            try self.notify(data, timestamp, c.ZC_PCM_S16LE, 2);
            self.bytes += data.len;
            return;
        }
        if (aac_enabled) {
            if (self.aac_encoder) |*encoder| {
                const first = self.audio_first_ns orelse timestamp;
                const expected = try pcm.at(first, self.audio_frames, encoder.config.sample_rate);
                if ((if (timestamp > expected) timestamp - expected else expected - timestamp) > 2) return error.InvalidTimestamp;
                self.audio_first_ns = first;
                const stride: usize = encoder.config.channels * 2;
                var offset: usize = 0;
                var stalled: usize = 0;
                while (offset < data.len) {
                    const count: usize = @min((data.len - offset) / stride, 1024);
                    const result = try encoder.encode(data[offset..][0 .. count * stride]);
                    if (result.data.len != 0) try self.mp4_writer.?.audio(result.data);
                    if (result.consumed_frames == 0) {
                        stalled += 1;
                        if (stalled > 16) return error.EncoderFailed;
                    } else stalled = 0;
                    offset += result.consumed_frames * stride;
                    self.audio_frames = try std.math.add(u64, self.audio_frames, result.consumed_frames);
                }
                return;
            }
        }
        try self.av_writer.?.audio(data, timestamp);
    }
    fn finish(self: *Output, nominal: u32, next: ?u64) !void {
        if (self.frames == 0) return;
        if (self.pending.items.len != 0) {
            const duration = if (next) |ts| (ts - self.pending_ns) / 1000 else nominal;
            if (duration == 0 or duration > std.math.maxInt(u32)) return error.Invalid;
            try self.flushPending(@intCast(duration));
        }
        if (aac_enabled) {
            if (self.aac_encoder) |*encoder| {
                while (try encoder.flush()) |audio_packet| try self.mp4_writer.?.audio(audio_packet);
                try self.mp4_writer.?.finish((self.audio_first_ns orelse 0) / 1000, self.audio_frames);
            }
        }
    }
};
const Recorder = struct {
    encoder: jpeg.Encoder,
    output: ?*Output = null,
    next: ?*Output = null,
    outputs: packet_output.Slots(*Output, 8) = .{},
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
    isolate: bool = false,
    recording: c.zc_recording_options,
    audio: ?pcm.Queue = null,
    audio_frames: u64 = 0,
    audio_written: u64 = 0,
    audio_bitrate: u32 = 0,
    last_packet_ns: ?u64 = null,
    rotation: Policy = .{},
    reservations: ?*Reservations = null,
    delay_ns: ?u64 = null,
    delay_cut: ?u64 = null,
    delay_scratch: []u8 = &.{},
    fn nominal(self: *const Recorder) u32 {
        return @intCast(@as(u64, 1000000) * self.config.fps_den / self.config.fps_num);
    }
    fn deinit(self: *Recorder) void {
        if (self.output) |out| out.deinit();
        if (self.next) |out| out.deinit();
        for (self.outputs.entries) |entry| if (entry.value) |out| out.deinit();
        if (self.ring) |*ring| ring.deinit();
        if (self.audio) |*queue| queue.deinit();
        if (self.reservations) |r| r.release(null);
        self.encoder.deinit();
        if (options.codecs) {
            if (self.codec) |*encoder| encoder.deinit();
        }
        A.free(self.headers);
        A.free(self.i420);
        A.free(self.delay_scratch);
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
        if (self.delay_ns != null) {
            try self.forward(timestamp);
            try self.ring.?.pushQueued(data, timestamp, key);
            try self.forward(timestamp);
        } else {
            if (self.ring) |*ring| _ = try ring.push(data, timestamp, key);
            try self.emit(data, timestamp, key);
        }
        self.last_packet_ns = timestamp;
    }
    fn forward(self: *Recorder, now: ?u64) !void {
        const ring = &self.ring.?;
        while (ring.ready(now, self.delay_ns.?)) {
            const entry = ring.entry(0).?;
            if (self.output != null or self.outputs.count != 0) {
                if (self.delay_scratch.len < entry.length) {
                    const scratch = try A.alloc(u8, entry.length);
                    A.free(self.delay_scratch);
                    self.delay_scratch = scratch;
                }
                try self.emit(try ring.copy(0, self.delay_scratch), entry.timestamp, entry.key);
            }
            self.delay_cut = entry.timestamp;
            ring.pop();
        }
    }
    fn outputEnd(self: *const Recorder) !u64 {
        if (self.delay_ns != null) {
            if (self.ring.?.entry(0)) |entry| return entry.timestamp;
            return try std.math.add(u64, self.delay_cut orelse return error.EmptyBuffer, @as(u64, self.nominal()) * 1000);
        }
        return self.packetEnd();
    }
    fn avoid(self: *const Recorder) [18]?*Output {
        var result: [18]?*Output = @splat(null);
        result[0] = self.output;
        result[1] = self.next;
        for (self.outputs.entries, 0..) |entry, i| {
            result[2 + i * 2] = entry.value;
            if (entry.value) |out| result[3 + i * 2] = out.next;
        }
        return result;
    }
    fn sinkError(self: *Recorder, out: *Output, err: anyerror) !void {
        if (out.failure == c.ZC_OK) out.failure = status(err);
        if (out.split_state == c.ZC_SPLIT_PENDING) out.split_state = c.ZC_SPLIT_FAILED;
        if (!self.isolate) return err;
    }
    fn transition(self: *Recorder, old: *Output, next: *Output, timestamp: u64) !bool {
        self.drainOutput(old, timestamp) catch |err| {
            try self.sinkError(old, err);
            return false;
        };
        old.finish(self.nominal(), timestamp) catch |err| {
            try self.sinkError(old, err);
            return false;
        };
        next.generation = old.generation + 1;
        next.split_state = c.ZC_SPLIT_COMMITTED;
        return true;
    }
    fn count(self: *const Recorder) usize {
        return self.outputs.count + @as(usize, @intFromBool(self.output != null));
    }
    fn prime(out: *Output, timestamp: u64, key: bool) void {
        if (out.waiting_key and key) {
            out.first_ns = timestamp;
            out.waiting_key = false;
        }
    }
    fn emit(self: *Recorder, data: []const u8, timestamp: u64, key: bool) !void {
        if (self.next != null and key and self.output.?.frames != 0 and self.output.?.failure == c.ZC_OK) {
            const old = self.output.?;
            if (try self.transition(old, self.next.?, timestamp)) {
                self.output = self.next;
                self.next = null;
                old.deinit();
                self.segments += 1;
            }
        }
        for (self.outputs.entries) |entry| if (entry.value) |old| {
            if (old.next != null and key and old.frames != 0 and old.failure == c.ZC_OK) {
                if (try self.transition(old, old.next.?, timestamp)) {
                    const next = old.next.?;
                    old.next = null;
                    _ = self.outputs.replace(entry.id, next) catch unreachable;
                    old.deinit();
                }
            }
        };
        if (self.output) |out| if (out.failure == c.ZC_OK) prime(out, timestamp, key);
        for (self.outputs.entries) |entry| if (entry.value) |out| if (out.failure == c.ZC_OK) prime(out, timestamp, key);
        try self.drainAudio(timestamp);
        if (self.output) |out| if (out.failure == c.ZC_OK) out.packet(data, timestamp, key) catch |err| try self.sinkError(out, err);
        for (self.outputs.entries) |entry| if (entry.value) |out| {
            if (out.failure == c.ZC_OK) out.packet(data, timestamp, key) catch |err| try self.sinkError(out, err);
        };
        if (self.next != null and key and self.output.?.failure == c.ZC_OK) try self.forceKey();
        for (self.outputs.entries) |entry| if (entry.value) |out| if (out.next != null and key and out.failure == c.ZC_OK) try self.forceKey();
    }
    fn drainOutput(self: *Recorder, out: *Output, cut: u64) !void {
        if (out.failure != c.ZC_OK or out.waiting_key or self.audio == null) return;
        const minimum = try std.math.add(u64, self.first_ns, out.first_ns);
        const end = try std.math.add(u64, self.first_ns, cut);
        const begin = @max(minimum, out.audio_cursor orelse minimum);
        if (self.audio.?.retention_floor) |floor| if (floor > begin) return error.BufferFull;
        var cursor: pcm.Cursor = .{};
        while (try self.audio.?.window(begin, end, &cursor)) |chunk| {
            try out.audioChunk(chunk.data, chunk.timestamp - minimum);
            out.audio_cursor = chunk.end_ns;
            out.delivered_audio_frames += chunk.frames;
            self.audio_written += chunk.frames;
        }
    }
    fn drainAudio(self: *Recorder, cut: u64) !void {
        if (self.output) |out| self.drainOutput(out, cut) catch |err| try self.sinkError(out, err);
        for (self.outputs.entries) |entry| if (entry.value) |out| self.drainOutput(out, cut) catch |err| try self.sinkError(out, err);
        // Non-circular PCM may be reclaimed only after every active consumer has
        // read it. Waiting-for-key and pending outputs need no preceding samples.
        if (self.audio == null or self.ring != null) return;
        var end = try std.math.add(u64, self.first_ns, cut);
        var minimum = end;
        var active: [9]?*Output = @splat(null);
        active[0] = self.output;
        for (self.outputs.entries, 1..) |entry, i| active[i] = entry.value;
        for (active) |entry| if (entry) |out| if (!out.waiting_key and out.failure == c.ZC_OK) {
            const start = try std.math.add(u64, self.first_ns, out.first_ns);
            minimum = @min(minimum, start);
            end = @min(end, out.audio_cursor orelse start);
        };
        while (try self.audio.?.take(minimum, end)) |_| {}
    }
    fn encoded(self: *Recorder, encoded_packet: native.Packet) !void {
        if (encoded_packet.pts < 0) return error.Invalid;
        try self.packet(encoded_packet.data, @as(u64, @intCast(encoded_packet.pts)) * 1000, encoded_packet.key);
    }
    fn packetEnd(self: *const Recorder) !u64 {
        const last = self.last_packet_ns orelse return error.EmptyBuffer;
        const input = (self.last_ns - self.first_ns) / 1000 * 1000;
        return if (input > last) input else try std.math.add(u64, last, @as(u64, self.nominal()) * 1000);
    }
    fn replayStart(self: *const Recorder) !usize {
        const ring = self.ring orelse return error.Unsupported;
        // An evicted PCM prefix may never become silent/missing pre-roll.
        // Start at the first retained video key covered by audio history.
        const floor = if (self.audio) |q| blk: {
            if (q.count == 0) return error.EmptyBuffer;
            break :blk q.retention_floor orelse 0;
        } else 0;
        for (0..ring.count) |i| {
            const e = ring.entry(i).?;
            if (e.key and try std.math.add(u64, self.first_ns, e.timestamp) >= floor) return i;
        }
        return error.EmptyBuffer;
    }
    const AudioReplay = struct { end: ?u64 = null, frames: u64 = 0 };
    fn checkSnapshotAudio(self: *const Recorder, start: usize, end: u64) !void {
        if (self.audio) |*q| {
            const minimum = try std.math.add(u64, self.first_ns, self.ring.?.entry(start).?.timestamp);
            const cut = try std.math.add(u64, self.first_ns, end);
            if ((q.last_end orelse 0) < cut) return error.Busy;
            var cursor: pcm.Cursor = .{};
            if (try q.window(minimum, cut, &cursor) == null) return error.Busy;
        }
    }
    fn replayAudio(self: *Recorder, out: *Output, cut: u64) !AudioReplay {
        const q = if (self.audio) |*q| q else return .{};
        const minimum = try std.math.add(u64, self.first_ns, out.first_ns);
        const end = try std.math.add(u64, self.first_ns, cut);
        var cursor: pcm.Cursor = .{};
        var result: AudioReplay = .{};
        while (try q.window(minimum, end, &cursor)) |chunk| {
            try out.audioChunk(chunk.data, chunk.timestamp - minimum);
            result.end = chunk.end_ns;
            result.frames += chunk.frames;
            out.delivered_audio_frames += chunk.frames;
        }
        return result;
    }
    fn replay(self: *Recorder, out: *Output) !void {
        const ring = if (self.ring) |*ring| ring else return error.Unsupported;
        const start = try self.replayStart();
        var largest: usize = 0;
        for (0..ring.count) |i| largest = @max(largest, ring.entry(i).?.length);
        const scratch = try A.alloc(u8, largest);
        defer A.free(scratch);
        for (start..ring.count) |i| {
            const e = ring.entry(i).?;
            try out.packet(try ring.copy(i, scratch), e.timestamp, e.key);
        }
    }
};
fn validate(path: []const u8, cfg: *const c.zc_video_config, audio: bool) !void {
    if (audio and !std.mem.endsWith(u8, path, ".mkv") and !(aac_enabled and std.mem.endsWith(u8, path, ".mp4"))) return error.Unsupported;
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
    self.output = Output.init(path, cfg, self.headers, .{null} ** 18, &self.recording, self.audio_bitrate, self.reservations) catch |err| {
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
    if (self.failed) return c.ZC_STATE;
    if (self.ring == null) return c.ZC_UNSUPPORTED;
    if (self.ring.?.count == 0) return c.ZC_STATE;
    const start = self.replayStart() catch |err| return status(err);
    const end = self.packetEnd() catch |err| return status(err);
    self.checkSnapshotAudio(start, end) catch |err| return status(err);
    const out = Output.init(path, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err);
    defer out.deinit();
    self.replay(out) catch |err| return status(err);
    _ = self.replayAudio(out, end) catch |err| return status(err);
    out.finish(self.nominal(), end) catch |err| return status(err);
    return c.ZC_OK;
}
pub fn openOutput(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    if (self.output != null or self.next != null or self.count() == 8) return c.ZC_BUSY;
    if (self.delay_ns == null and self.ring != null and self.ring.?.count != 0) _ = self.replayStart() catch |err| return status(err);
    const out = Output.init(path, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err);
    if (self.delay_ns == null and self.ring != null and self.ring.?.count != 0) self.replay(out) catch |err| {
        out.deinit();
        return status(err);
    };
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    const replayed: Recorder.AudioReplay = if (!out.waiting_key) self.replayAudio(out, self.last_packet_ns.?) catch |err| {
        out.deinit();
        return status(err);
    } else .{};
    out.audio_cursor = replayed.end;
    self.audio_written += replayed.frames;
    self.output = out;
    self.segments += 1;
    return c.ZC_OK;
}
pub fn closeOutput(p: *c.zc_recorder) c_int {
    const self = recorder(p);
    if (self.next != null) return c.ZC_BUSY;
    if (self.failed) return c.ZC_STATE;
    const out = self.output orelse return c.ZC_STATE;
    const end = if (out.frames != 0) self.outputEnd() catch |err| return status(err) else null;
    if (out.failure == c.ZC_OK) if (end) |cut| self.drainOutput(out, cut) catch |err| {
        self.failed = true;
        return status(err);
    };
    self.output = null;
    defer out.deinit();
    if (out.failure != c.ZC_OK and self.isolate) return c.ZC_OK;
    out.finish(self.nominal(), end) catch |err| return status(err);
    return c.ZC_OK;
}
pub fn split(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    if (self.next != null) return c.ZC_BUSY;
    if (self.output == null or self.output.?.failure != c.ZC_OK or self.output.?.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    const out = Output.init(path, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    self.output.?.split_state = c.ZC_SPLIT_PENDING;
    self.next = out;
    return c.ZC_OK;
}
pub fn cancelSplit(p: *c.zc_recorder) c_int {
    const self = recorder(p);
    const out = self.next orelse return c.ZC_STATE;
    self.next = null;
    if (self.output) |current| if (current.failure == c.ZC_OK) {
        current.split_state = c.ZC_SPLIT_CANCELLED;
    };
    out.deinit();
    return c.ZC_OK;
}
pub fn close(p: *c.zc_recorder) c_int {
    var count: u32 = 0;
    return closeReport(p, null, 0, &count);
}
pub fn closeReport(p: *c.zc_recorder, results: ?[*]c.zc_output_result, capacity: u32, count: *u32) c_int {
    count.* = 0;
    if (results != null and capacity < 8) return c.ZC_INVALID;
    const self = recorder(p);
    defer self.deinit();
    var result: c_int = if (self.failed) c.ZC_IO else c.ZC_OK;
    if (result == c.ZC_OK and options.codecs) {
        if (self.codec) |*encoder| {
            while (true) {
                const packet = encoder.flush() catch {
                    result = c.ZC_IO;
                    break;
                };
                self.encoded(packet orelse break) catch {
                    result = c.ZC_IO;
                    break;
                };
            }
        }
    }
    if (result == c.ZC_OK and self.delay_ns != null) self.forward(null) catch {
        result = c.ZC_IO;
    };
    if (result == c.ZC_OK and self.audio != null and self.frames != 0) self.drainAudio(std.math.add(u64, self.last_ns - self.first_ns, @as(u64, 1_000_000_000) * self.config.fps_den / self.config.fps_num) catch return c.ZC_INVALID) catch {
        result = c.ZC_IO;
    };
    var active: [9]?*Output = @splat(null);
    var ids: [9]u64 = @splat(0);
    active[0] = self.output;
    for (self.outputs.entries, 1..) |entry, i| {
        active[i] = entry.value;
        ids[i] = entry.id;
    }
    var pending = false;
    for (active, ids) |value, id| if (value) |out| {
        if (out.failure == c.ZC_OK or !self.isolate) out.finish(self.nominal(), null) catch |err| {
            if (out.failure == c.ZC_OK) out.failure = status(err);
            if (out.split_state == c.ZC_SPLIT_PENDING) out.split_state = c.ZC_SPLIT_FAILED;
            if (!self.isolate) result = out.failure;
        };
        if ((if (id == 0) self.next != null else out.next != null) and out.failure == c.ZC_OK) pending = true;
        if (results) |buffer| buffer[count.*] = .{ .id = id, .state = stateOf(out, if (id == 0) self.next != null else out.next != null) };
        count.* += 1;
    };
    return if (result != c.ZC_OK) result else if (pending) c.ZC_STATE else c.ZC_OK;
}

test {
    if (aac_enabled) _ = @import("home/native_aac_test.zig");
    _ = jpeg;
    _ = mkv;
    _ = mp4;
    _ = rgb;
    _ = Ring;
    _ = packet_output;
}

pub fn defaultRecordingOptions() c.zc_recording_options {
    return .{ .struct_size = @sizeOf(c.zc_recording_options), .sample_rate = 0, .channels = 1, .buffer_frames = 96000, .max_blocks = 256, .exclusive = 0 };
}
pub fn openAac(path: [*:0]const u8, cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, bitrate: u32, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (!aac_enabled) return c.ZC_UNSUPPORTED;
    if (opts.sample_rate == 0 or !std.mem.endsWith(u8, std.mem.span(path), ".mp4") or bitrate < 16000 or bitrate > 320000) return c.ZC_INVALID;
    return openWithBitrate(path, cfg, opts, bitrate, out);
}
pub fn openEx(path: [*:0]const u8, cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, out: *?*c.zc_recorder) c_int {
    return openWithBitrate(path, cfg, opts, 0, out);
}
fn openWithBitrate(path: [*:0]const u8, cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, bitrate: u32, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (opts.struct_size != @sizeOf(c.zc_recording_options) or opts.exclusive > 1) return c.ZC_INVALID;
    const self = init(cfg) catch |err| return status(err);
    self.recording = opts.*;
    self.audio_bitrate = bitrate;
    if (opts.sample_rate != 0) self.audio = pcm.Queue.init(A, opts.sample_rate, opts.channels, opts.buffer_frames, opts.max_blocks) catch |err| {
        self.deinit();
        return status(err);
    };
    self.output = Output.init(path, cfg, self.headers, .{null} ** 18, opts, bitrate, self.reservations) catch |err| {
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
    if (self.ring != null) {
        self.audio.?.pushRolling(data[0..@intCast(length)], timestamp) catch |err| return status(err);
    } else self.audio.?.push(data[0..@intCast(length)], timestamp) catch |err| return status(err);
    self.audio_frames += length / (self.recording.channels * 2);
    const audio_cut = if (self.delay_ns != null) self.delay_cut else self.last_packet_ns;
    if (audio_cut) |cut| self.drainAudio(cut) catch |err| {
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
        out.output_bytes = o.bytes + o.pending.items.len + (if (o.mp4_writer) |*writer| writer.audio_pending_len else @as(usize, 0));
        out.output_frames = o.frames;
        const latest = if (self.delay_ns != null) self.delay_cut orelse 0 else self.last_ns - self.first_ns;
        if (self.frames != 0 and latest >= o.first_ns and o.frames != 0) out.output_duration_ns = latest - o.first_ns;
        out.rotation_due = @intFromBool(o.failure == c.ZC_OK and self.rotation.due(o.frames, out.output_duration_ns, out.output_bytes, self.next != null));
    }
    return c.ZC_OK;
}

pub fn openCircularAv(cfg: *const c.zc_video_config, buffer: *const c.zc_buffer_config, opts: *const c.zc_recording_options, bitrate: u32, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (opts.struct_size != @sizeOf(c.zc_recording_options) or opts.sample_rate == 0 or opts.exclusive > 1 or (bitrate != 0 and (bitrate < 16000 or bitrate > 320000))) return c.ZC_INVALID;
    const result = openCircular(cfg, buffer, out);
    if (result != c.ZC_OK) return result;
    const self = recorder(out.*.?);
    self.recording = opts.*;
    self.audio_bitrate = bitrate;
    self.audio = pcm.Queue.init(A, opts.sample_rate, opts.channels, opts.buffer_frames, opts.max_blocks) catch |err| {
        self.deinit();
        out.* = null;
        return status(err);
    };
    return c.ZC_OK;
}
pub fn audioBufferStats(p: *c.zc_recorder, out: *c.zc_audio_buffer_stats) c_int {
    out.* = std.mem.zeroes(c.zc_audio_buffer_stats);
    const self = recorder(p);
    if (self.ring == null or self.audio == null) return c.ZC_UNSUPPORTED;
    const q = &self.audio.?;
    out.frames = q.used;
    out.bytes = q.used * q.channels * 2;
    out.evicted_frames = q.trimmed;
    if (q.count != 0) {
        var cursor: pcm.Cursor = .{};
        if (q.window(0, std.math.maxInt(u64), &cursor) catch return c.ZC_INVALID) |chunk| out.first_ns = chunk.timestamp;
        out.last_ns = q.last_end.?;
    }
    return c.ZC_OK;
}

const Frozen = struct {
    data: *Recorder,
    file: ?std.fs.File,
    is_mp4: bool,
    reservations: *Reservations,
    slot: usize,
    attempted: bool = false,
    fn deinit(s: *Frozen) void {
        s.data.deinit();
        if (s.file) |f| f.close();
        s.reservations.release(s.slot);
        A.destroy(s);
    }
};
pub fn freeze(p: *c.zc_recorder, path: [*:0]const u8, out: *?*c.zc_snapshot) c_int {
    out.* = null;
    const value = freezeImpl(recorder(p), path) catch |err| return status(err);
    out.* = @ptrCast(value);
    return c.ZC_OK;
}
fn freezeImpl(self: *Recorder, path: [*:0]const u8) !*Frozen {
    if (self.failed) return error.EmptyBuffer;
    const start = try self.replayStart();
    const end = try self.packetEnd();
    try self.checkSnapshotAudio(start, end);
    try validate(std.mem.span(path), &self.config, self.audio != null);
    if (self.reservations == null) {
        self.reservations = try A.create(Reservations);
        self.reservations.?.* = .{};
    }
    const r = self.reservations.?;
    const file = try reserveFile(path, self.recording.exclusive != 0, self.avoid(), r);
    errdefer file.close();
    const slot = try r.reserve(try Identity.of(file));
    errdefer r.release(slot);
    const copy = try A.create(Recorder);
    copy.* = .{ .encoder = jpeg.Encoder.init(A), .config = self.config, .recording = self.recording, .audio_bitrate = self.audio_bitrate, .first_ns = self.first_ns, .last_ns = self.last_ns, .last_packet_ns = self.last_packet_ns, .frames = self.frames };
    errdefer copy.deinit();
    copy.headers = try A.dupe(u8, self.headers);
    copy.ring = try self.ring.?.cloneFrom(A, start);
    if (self.audio) |*q| copy.audio = try q.cloneWindow(A, try std.math.add(u64, self.first_ns, copy.ring.?.entry(0).?.timestamp), try std.math.add(u64, self.first_ns, end));
    const frozen = try A.create(Frozen);
    frozen.* = .{ .data = copy, .file = file, .is_mp4 = std.mem.endsWith(u8, std.mem.span(path), ".mp4"), .reservations = r, .slot = slot };
    return frozen;
}
pub fn writeSnapshot(p: *c.zc_snapshot) c_int {
    const s: *Frozen = @ptrCast(@alignCast(p));
    if (s.attempted) return c.ZC_STATE;
    s.attempted = true;
    writeFrozen(s) catch |err| return status(err);
    return c.ZC_OK;
}
fn writeFrozen(s: *Frozen) !void {
    const self = s.data;
    const out = try Output.initFile(s.file.?, s.is_mp4, &self.config, self.headers, &self.recording, self.audio_bitrate);
    s.file = null;
    defer out.deinit();
    try self.replay(out);
    const end = try self.packetEnd();
    _ = try self.replayAudio(out, end);
    try out.finish(self.nominal(), end);
}
pub fn closeSnapshot(p: *c.zc_snapshot) void {
    const s: *Frozen = @ptrCast(@alignCast(p));
    s.deinit();
}

pub fn setDelay(p: *c.zc_recorder, delay: u64) c_int {
    const self = recorder(p);
    if (self.ring == null) return c.ZC_UNSUPPORTED;
    if (self.failed or (self.delay_ns == null and (self.frames != 0 or self.count() != 0))) return c.ZC_STATE;
    self.delay_ns = delay;
    return c.ZC_OK;
}

pub fn getHeaders(p: *c.zc_recorder, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const self = recorder(p);
    length.* = self.headers.len;
    if (capacity == 0) return c.ZC_OK;
    if (data == null or capacity < self.headers.len or capacity > std.math.maxInt(usize)) return c.ZC_INVALID;
    @memcpy(data.?[0..self.headers.len], self.headers);
    return c.ZC_OK;
}
pub fn formatPts(timestamp: u64, data: [*]u8, capacity: u32, length: *u32) c_int {
    length.* = 0;
    const bytes = packet_output.formatPts(timestamp, data[0..capacity]) catch return c.ZC_INVALID;
    length.* = @intCast(bytes.len);
    return c.ZC_OK;
}
fn callbackOutput(self: *Recorder, cb: *const c.zc_output_callbacks, splitting: bool) !*Output {
    if (cb.struct_size != @sizeOf(c.zc_output_callbacks) or cb.reserved != 0 or cb.format > c.ZC_OUTPUT_MKV or cb.file_fd < -1 or cb.pts_fd < -1 or cb.secondary_pts_fd < -1) return error.Invalid;
    if ((cb.format == c.ZC_OUTPUT_PACKETS and cb.packet == null) or (cb.format != c.ZC_OUTPUT_PACKETS and cb.write == null)) return error.Invalid;
    if (cb.format == c.ZC_OUTPUT_MP4 and self.audio != null and cb.patch == null) return error.Invalid;
    if (cb.format != c.ZC_OUTPUT_PACKETS) validate(if (cb.format == c.ZC_OUTPUT_MP4) "stream.mp4" else "stream.mkv", &self.config, self.audio != null) catch |err| return err;
    var identities: [3]?Identity = .{ null, null, null };
    for ([_]i32{ cb.file_fd, cb.pts_fd, cb.secondary_pts_fd }, 0..) |fd, i| {
        if (fd < 0) continue;
        const id = Identity.of(.{ .handle = fd }) catch return error.Invalid;
        for (identities[0..i]) |other| if (other) |value| if (id.equal(value)) return error.Invalid;
        if (self.output) |existing| {
            // A circular observer sidecar can span segment epochs. Only the
            // identical secondary descriptor may be shared, never media/PTS.
            const shared = splitting and i == 2 and existing.callbacks != null and existing.callbacks.?.secondary_pts_fd == fd;
            if (!shared) try existing.checkIdentity(id);
        }
        if (self.next) |existing| try existing.checkIdentity(id);
        for (self.outputs.entries) |entry| if (entry.value) |existing| {
            try existing.checkIdentity(id);
            if (existing.next) |pending| try pending.checkIdentity(id);
        };
        if (self.reservations) |r| r.check(id) catch |err| return err;
        identities[i] = id;
    }
    return Output.initCallbacks(cb.*, &self.config, self.headers, &self.recording, self.audio_bitrate);
}
// Create an output-less direct recorder; attachment can run user lifecycle hooks
// only after source metadata and the owned encoder are available.
pub fn create(cfg: *const c.zc_video_config, opts: *const c.zc_recording_options, bitrate: u32, out: *?*c.zc_recorder) c_int {
    out.* = null;
    if (opts.struct_size != @sizeOf(c.zc_recording_options) or opts.exclusive > 1 or (bitrate != 0 and (opts.sample_rate == 0 or bitrate < 16000 or bitrate > 320000))) return c.ZC_INVALID;
    const self = init(cfg) catch |err| return status(err);
    self.recording = opts.*;
    self.audio_bitrate = bitrate;
    if (opts.sample_rate != 0) self.audio = pcm.Queue.init(A, opts.sample_rate, opts.channels, opts.buffer_frames, opts.max_blocks) catch |err| {
        self.deinit();
        return status(err);
    };
    out.* = @ptrCast(self);
    return c.ZC_OK;
}
pub fn openCallbacks(p: *c.zc_recorder, cb: *const c.zc_output_callbacks) c_int {
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    if (self.output != null or self.next != null or self.count() == 8) return c.ZC_BUSY;
    if (self.delay_ns == null and self.ring != null and self.ring.?.count != 0) _ = self.replayStart() catch |err| return status(err);
    const out = callbackOutput(self, cb, false) catch |err| return status(err);
    if (self.delay_ns == null and self.ring != null and self.ring.?.count != 0) self.replay(out) catch |err| {
        out.deinit();
        return status(err);
    };
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    const replayed: Recorder.AudioReplay = if (!out.waiting_key) self.replayAudio(out, self.last_packet_ns.?) catch |err| {
        out.deinit();
        return status(err);
    } else .{};
    self.output = out;
    out.audio_cursor = replayed.end;
    self.audio_written += replayed.frames;
    self.segments += 1;
    return c.ZC_OK;
}
pub fn splitCallbacks(p: *c.zc_recorder, cb: *const c.zc_output_callbacks) c_int {
    const self = recorder(p);
    if (self.failed or self.output == null or self.output.?.failure != c.ZC_OK or self.output.?.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    if (self.next != null) return c.ZC_BUSY;
    const out = callbackOutput(self, cb, true) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    self.output.?.split_state = c.ZC_SPLIT_PENDING;
    self.next = out;
    return c.ZC_OK;
}

// Additions start at the next forwarded key, without replaying circular history.
// ID zero denotes the legacy primary output; other IDs are never reused.
pub fn addCallbacks(p: *c.zc_recorder, cb: *const c.zc_output_callbacks, id: *u64) c_int {
    const self = recorder(p);
    id.* = 0;
    if (self.failed) return c.ZC_STATE;
    if (self.count() == 8) return c.ZC_BUSY;
    const out = callbackOutput(self, cb, false) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    id.* = self.outputs.add(out) catch |err| {
        out.deinit();
        return status(err);
    };
    return c.ZC_OK;
}
pub fn addOutput(p: *c.zc_recorder, path: [*:0]const u8, id: *u64) c_int {
    const self = recorder(p);
    id.* = 0;
    if (self.failed) return c.ZC_STATE;
    if (self.count() == 8) return c.ZC_BUSY;
    const out = Output.init(path, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    id.* = self.outputs.add(out) catch |err| {
        out.deinit();
        return status(err);
    };
    return c.ZC_OK;
}
pub fn outputStats(p: *c.zc_recorder, id: u64, stats: *c.zc_output_stats) c_int {
    const self = recorder(p);
    stats.* = std.mem.zeroes(c.zc_output_stats);
    const out = (if (id == 0) self.output else self.outputs.get(id)) orelse return c.ZC_STATE;
    stats.* = .{ .id = id, .frames = out.frames, .bytes = out.bytes, .first_ns = out.first_ns, .audio_frames = out.delivered_audio_frames, .waiting_key = @intFromBool(out.waiting_key), .reserved = 0 };
    return c.ZC_OK;
}
pub fn removeOutput(p: *c.zc_recorder, id: u64) c_int {
    if (id == 0) return closeOutput(p);
    const self = recorder(p);
    const out = self.outputs.get(id) orelse return c.ZC_STATE;
    var result: c_int = c.ZC_OK;
    const end = if (out.frames != 0) self.outputEnd() catch |err| return status(err) else null;
    if (out.next != null) return c.ZC_BUSY;
    if (!self.failed and out.failure == c.ZC_OK) {
        if (end) |cut| self.drainOutput(out, cut) catch |err| {
            self.failed = true;
            result = status(err);
        };
    }
    _ = self.outputs.remove(id);
    defer out.deinit();
    if (out.failure != c.ZC_OK and self.isolate) return c.ZC_OK;
    out.finish(self.nominal(), end) catch |err| {
        return status(err);
    };
    return result;
}

fn stateOf(out: *const Output, pending: bool) c.zc_output_state {
    return .{ .generation = out.generation, .error_code = out.failure, .split_state = out.split_state, .pending = @intFromBool(pending), .reserved = 0 };
}
pub fn outputState(p: *c.zc_recorder, id: u64, state: *c.zc_output_state) c_int {
    const self = recorder(p);
    state.* = std.mem.zeroes(c.zc_output_state);
    const out = (if (id == 0) self.output else self.outputs.get(id)) orelse return c.ZC_STATE;
    state.* = stateOf(out, if (id == 0) self.next != null else out.next != null);
    return c.ZC_OK;
}
pub fn setIsolation(p: *c.zc_recorder, enabled: u32) c_int {
    const self = recorder(p);
    if (enabled > 1) return c.ZC_INVALID;
    if (self.frames != 0 or self.failed) return c.ZC_STATE;
    self.isolate = enabled == 1;
    return c.ZC_OK;
}
pub fn splitOutput(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks) c_int {
    if ((path == null) == (cb == null)) return c.ZC_INVALID;
    if (id == 0) return if (path) |file| split(p, file) else splitCallbacks(p, cb.?);
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    const old = self.outputs.get(id) orelse return c.ZC_STATE;
    if (old.failure != c.ZC_OK or old.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    if (old.next != null) return c.ZC_BUSY;
    const out = if (path) |file| Output.init(file, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err) else callbackOutput(self, cb.?, false) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    old.next = out;
    old.split_state = c.ZC_SPLIT_PENDING;
    return c.ZC_OK;
}
pub fn cancelOutputSplit(p: *c.zc_recorder, id: u64) c_int {
    if (id == 0) return cancelSplit(p);
    const old = recorder(p).outputs.get(id) orelse return c.ZC_STATE;
    const next = old.next orelse return c.ZC_STATE;
    old.next = null;
    if (old.failure == c.ZC_OK) old.split_state = c.ZC_SPLIT_CANCELLED;
    next.deinit();
    return c.ZC_OK;
}
