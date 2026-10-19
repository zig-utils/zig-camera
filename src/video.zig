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
// Two owned snapshots and eight prepared split targets per recorder. Snapshot
// reservations survive close; split recipes keep close BUSY until released.
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
    preparing: [8]?[3]?Identity = .{null} ** 8,
    opening: [8]bool = @splat(false),
    refs: usize = 1,
    fn check(s: *Reservations, id: Identity) !void {
        s.mutex.lock();
        defer s.mutex.unlock();
        for (s.opening) |pending| if (pending) return error.Busy;
        for (s.slots) |slot| if (slot) |other| if (id.equal(other)) return error.Busy;
        for (s.preparing) |slot| if (slot) |ids| for (ids) |other| if (other) |value| if (id.equal(value)) return error.Busy;
    }
    fn reserve(s: *Reservations, id: Identity) !usize {
        s.mutex.lock();
        defer s.mutex.unlock();
        for (s.opening) |pending| if (pending) return error.Busy;
        for (s.slots) |slot| if (slot) |other| if (id.equal(other)) return error.Busy;
        for (s.preparing) |slot| if (slot) |ids| for (ids) |other| if (other) |value| if (id.equal(value)) return error.Busy;
        for (&s.slots, 0..) |*slot, i| if (slot.* == null) {
            slot.* = id;
            s.refs += 1;
            return i;
        };
        return error.Busy;
    }
    fn reservePreparation(s: *Reservations, ids: [3]?Identity, opening: bool) !usize {
        s.mutex.lock();
        defer s.mutex.unlock();
        for (ids) |maybe| if (maybe) |id| {
            for (s.opening) |pending| if (pending) return error.Busy;
            for (s.slots) |slot| if (slot) |other| if (id.equal(other)) return error.Busy;
            for (s.preparing) |slot| if (slot) |others| for (others) |other| if (other) |value| if (id.equal(value)) return error.Busy;
        };
        for (&s.preparing, 0..) |*slot, i| if (slot.* == null) {
            slot.* = ids;
            s.opening[i] = opening;
            s.refs += 1;
            return i;
        };
        return error.Busy;
    }
    fn releasePreparation(s: *Reservations, slot: usize) void {
        s.mutex.lock();
        s.preparing[slot] = null;
        s.opening[slot] = false;
        s.mutex.unlock();
        s.release(null);
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
fn reserveFile(path: [*:0]const u8, exclusive: bool, avoid: [27]?*Output, reservations: ?*Reservations) !std.fs.File {
    const file = try std.fs.cwd().createFile(std.mem.span(path), .{ .truncate = false, .exclusive = exclusive });
    errdefer file.close();
    const id = try Identity.of(file);
    for (avoid) |existing| if (existing) |other| try other.checkIdentity(id);
    if (reservations) |r| try r.check(id);
    return file;
}
const Retry = @import("home/output_recovery.zig").Retry;
const io = @import("output_io.zig");
const Output = struct {
    io_config: ?io.Config = null,
    worker: ?*io.Worker = null,
    retired: ?*Output = null,
    split_error: c_int = c.ZC_OK,
    queue: ?Ring = null,
    queue_scratch: []u8 = &.{},
    delay_ns: u64 = 0,
    delivery_cut: ?u64 = null,
    retry: Retry = .{},
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
    fn enableIo(self: *Output, config: io.Config, previous: ?*io.Worker) !void {
        self.worker = try io.Worker.create(config, self, applyIo, previous);
        self.io_config = config;
    }
    fn applyIo(ctx: *anyopaque, event: io.Event, data: []const u8) c_int {
        const self: *Output = @ptrCast(@alignCast(ctx));
        if (self.callbacks) |cb| return switch (event.kind) {
            .write => cb.write.?(cb.context, data.ptr, data.len),
            .patch => cb.patch.?(cb.context, event.offset, data.ptr, data.len),
            .packet => blk: {
                const notification = c.zc_output_packet{ .data = if (data.len == 0) null else data.ptr, .length = data.len, .timestamp_ns = event.timestamp, .codec = event.codec, .flags = event.flags };
                break :blk cb.packet.?(cb.context, &notification);
            },
        };
        switch (event.kind) {
            .write => self.file.?.writeAll(data) catch |err| return status(err),
            .patch => self.file.?.pwriteAll(data, event.offset) catch |err| return status(err),
            .packet => unreachable,
        }
        return c.ZC_OK;
    }
    fn sync(self: *Output) void {
        if (self.worker) |worker| {
            const code = worker.errorCode();
            if (self.failure == c.ZC_OK and code != c.ZC_OK) {
                self.failure = code;
                if (self.split_state == c.ZC_SPLIT_PENDING) self.split_state = c.ZC_SPLIT_FAILED;
            }
        }
        if (self.retired) |old| {
            if (old.worker.?.ready()) {
                old.sync();
                self.split_error = old.failure;
                self.split_state = if (old.failure == c.ZC_OK) c.ZC_SPLIT_COMMITTED else c.ZC_SPLIT_FAILED;
                self.retired = null;
                old.deinit();
            }
        }
    }
    fn waitIo(self: *Output) void {
        if (self.worker) |worker| {
            worker.close(true);
            worker.done.event.wait();
        }
        if (self.retired) |old| old.worker.?.done.event.wait();
        self.sync();
    }
    fn sink(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *Output = @ptrCast(@alignCast(ctx));
        const next = try std.math.add(u64, self.bytes, bytes.len);
        if (self.worker) |worker| {
            try worker.send(.{ .kind = .write }, bytes);
        } else if (self.callbacks) |cb| {
            if (cb.write.?(cb.context, bytes.ptr, bytes.len) != c.ZC_OK) return error.CallbackFailed;
        } else try self.file.?.writeAll(bytes);
        self.bytes = next;
    }
    fn patch(ctx: *anyopaque, offset: u64, bytes: []const u8) anyerror!void {
        const self: *Output = @ptrCast(@alignCast(ctx));
        if (self.worker) |worker| {
            try worker.send(.{ .kind = .patch, .offset = offset }, bytes);
        } else if (self.callbacks) |cb| {
            if (cb.patch.?(cb.context, offset, bytes.ptr, bytes.len) != c.ZC_OK) return error.CallbackFailed;
        } else try self.file.?.pwriteAll(bytes, offset);
    }
    fn init(path: [*:0]const u8, cfg: *const c.zc_video_config, headers: []const u8, avoid: [27]?*Output, recording: *const c.zc_recording_options, audio_bitrate: u32, reservations: ?*Reservations) !*Output {
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
    fn transfer(old: *Output, next: *Output, recovery: bool) void {
        next.queue = old.queue;
        old.queue = null;
        next.queue_scratch = old.queue_scratch;
        old.queue_scratch = &.{};
        next.delay_ns = old.delay_ns;
        next.delivery_cut = if (recovery) null else old.delivery_cut;
        next.retry = old.retry;
        if (recovery) {
            next.retry.deadline = null;
            if (next.queue) |*queue| queue.reset();
        }
    }
    fn deinit(self: *Output) void {
        if (self.retired) |old| old.deinit();
        if (self.worker) |worker| worker.destroy();
        if (self.queue) |*queue| queue.deinit();
        A.free(self.queue_scratch);
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
        if (self.worker) |worker| return worker.send(.{ .kind = .packet, .timestamp = timestamp, .codec = codec, .flags = flags }, data);
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
    preparing: [8]?*Prepared = .{null} ** 8,
    jobs: [8]?*Preparation = .{null} ** 8,
    automatic: [8]?Automatic = .{null} ** 8,
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
    fn preparingId(self: *Recorder, id: u64) bool {
        if (hasJob(self, id)) return true;
        for (self.preparing) |slot| if (slot) |job| if (job.id == id) return true;
        return false;
    }
    fn pollIo(self: *Recorder) !void {
        if (self.output) |out| {
            out.sync();
            if (!self.isolate and (out.failure != c.ZC_OK or out.split_error != c.ZC_OK)) return error.AsyncOutputFailed;
        }
        for (self.outputs.entries) |entry| if (entry.value) |out| {
            out.sync();
            if (!self.isolate and (out.failure != c.ZC_OK or out.split_error != c.ZC_OK)) return error.AsyncOutputFailed;
        };
    }
    fn nominal(self: *const Recorder) u32 {
        return @intCast(@as(u64, 1000000) * self.config.fps_den / self.config.fps_num);
    }
    fn deinit(self: *Recorder) void {
        for (self.automatic) |entry| if (entry) |value| A.free(value.pattern);
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
    fn outputEnd(self: *const Recorder, out: *const Output) !u64 {
        if (out.queue) |*queue| {
            if (queue.entry(0)) |entry| return entry.timestamp;
            return try std.math.add(u64, out.delivery_cut orelse return error.EmptyBuffer, @as(u64, self.nominal()) * 1000);
        }
        if (self.delay_ns != null) {
            if (self.ring.?.entry(0)) |entry| return entry.timestamp;
            return try std.math.add(u64, self.delay_cut orelse return error.EmptyBuffer, @as(u64, self.nominal()) * 1000);
        }
        return self.packetEnd();
    }
    fn avoid(self: *const Recorder) [27]?*Output {
        var result: [27]?*Output = @splat(null);
        result[0] = self.output;
        result[1] = self.next;
        if (self.output) |out| result[2] = out.retired;
        for (self.outputs.entries, 0..) |entry, i| {
            result[3 + i * 3] = entry.value;
            if (entry.value) |out| {
                result[4 + i * 3] = out.next;
                result[5 + i * 3] = out.retired;
            }
        }
        return result;
    }
    fn sinkError(self: *Recorder, out: *Output, err: anyerror) !void {
        if (out.worker) |worker| worker.abort(status(err));
        out.sync();
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
        old.transfer(next, false);
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
    fn getOutput(self: *const Recorder, id: u64) ?*Output {
        const out = (if (id == 0) self.output else self.outputs.get(id)) orelse return null;
        out.sync();
        return out;
    }
    fn deliver(self: *Recorder, id: u64, data: []const u8, timestamp: u64, key: bool) !void {
        var out = self.getOutput(id) orelse return;
        if (out.failure != c.ZC_OK) return;
        const pending = if (id == 0) self.next else out.next;
        if (pending != null and key and out.frames != 0) {
            if (try self.transition(out, pending.?, timestamp)) {
                const old = out;
                out = pending.?;
                if (id == 0) {
                    self.output = out;
                    self.next = null;
                    self.segments += 1;
                } else {
                    old.next = null;
                    _ = self.outputs.replace(id, out) catch unreachable;
                }
                if (old.worker) |worker| {
                    worker.close(true);
                    out.retired = old;
                } else old.deinit();
            }
        }
        if (out.failure != c.ZC_OK) return;
        prime(out, timestamp, key);
        out.delivery_cut = timestamp;
        self.drainOutput(out, timestamp) catch |err| try self.sinkError(out, err);
        if (out.failure == c.ZC_OK) out.packet(data, timestamp, key) catch |err| try self.sinkError(out, err);
        if ((if (id == 0) self.next != null else out.next != null) and key and out.failure == c.ZC_OK) try self.forceKey();
    }
    fn forwardOutput(self: *Recorder, id: u64, now: ?u64) !void {
        // Reacquire after each delivery: a key may replace and free the sink.
        while (true) {
            const out = self.getOutput(id) orelse return;
            if (out.failure != c.ZC_OK) return;
            if (out.queue == null) return;
            const queue = &out.queue.?;
            if (!queue.ready(now, out.delay_ns)) return;
            const entry = queue.entry(0).?;
            const data = try queue.copy(0, out.queue_scratch);
            // Pop before delivery so ownership can transfer at a split.
            out.queue.?.pop();
            try self.deliver(id, data, entry.timestamp, entry.key);
        }
    }
    fn enqueueOutput(self: *Recorder, id: u64, data: []const u8, timestamp: u64, key: bool) !void {
        var out = self.getOutput(id) orelse return;
        if (out.failure != c.ZC_OK) return;
        if (out.queue == null) return self.deliver(id, data, timestamp, key);
        try self.forwardOutput(id, timestamp);
        out = self.getOutput(id).?;
        if (out.failure != c.ZC_OK) return;
        out.queue.?.pushQueued(data, timestamp, key) catch |err| {
            try self.sinkError(out, err);
            return;
        };
        try self.forwardOutput(id, timestamp);
    }
    fn emit(self: *Recorder, data: []const u8, timestamp: u64, key: bool) !void {
        if (self.output != null) try self.enqueueOutput(0, data, timestamp, key);
        for (self.outputs.entries) |entry| if (entry.value != null) try self.enqueueOutput(entry.id, data, timestamp, key);
        try self.drainAudio(timestamp);
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
        if (self.output) |out| self.drainOutput(out, if (out.queue != null) @min(cut, out.delivery_cut orelse (if (out.waiting_key) @as(u64, 0) else cut)) else cut) catch |err| try self.sinkError(out, err);
        for (self.outputs.entries) |entry| if (entry.value) |out| self.drainOutput(out, if (out.queue != null) @min(cut, out.delivery_cut orelse (if (out.waiting_key) @as(u64, 0) else cut)) else cut) catch |err| try self.sinkError(out, err);
        // Non-circular PCM may be reclaimed only after every active consumer has
        // read it. Queued first keys retain their PCM until delivery; pending
        // replacements need no samples preceding their split boundary.
        if (self.audio == null or self.ring != null) return;
        var end = try std.math.add(u64, self.first_ns, cut);
        var minimum = end;
        var active: [9]?*Output = @splat(null);
        active[0] = self.output;
        for (self.outputs.entries, 1..) |entry, i| active[i] = entry.value;
        for (active) |entry| if (entry) |out| if (out.failure == c.ZC_OK) {
            if (!out.waiting_key) {
                const start = try std.math.add(u64, self.first_ns, out.first_ns);
                minimum = @min(minimum, start);
                end = @min(end, out.audio_cursor orelse start);
            } else if (out.queue) |*queue| {
                // Retain audio for the first queued key even before it matures.
                for (0..queue.count) |i| {
                    const queued = queue.entry(i).?;
                    if (queued.key) {
                        const start = try std.math.add(u64, self.first_ns, queued.timestamp);
                        minimum = @min(minimum, start);
                        end = @min(end, start);
                        break;
                    }
                }
            }
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
    self.output = Output.init(path, cfg, self.headers, .{null} ** 27, &self.recording, self.audio_bitrate, self.reservations) catch |err| {
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
    _ = pollPreparations(p);
    self.first_ns = first;
    self.pollIo() catch |err| {
        self.failed = true;
        return status(err);
    };
    writeImpl(self, &s, ts - first, pts) catch |err| {
        self.failed = true;
        return status(err);
    };
    self.first_ns = first;
    self.last_ns = ts;
    self.frames += 1;
    scheduleAutomatic(self);
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
    _ = self.getOutput(0);
    out.split_pending = @intFromBool(self.next != null or (self.output != null and self.output.?.retired != null));
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
    if (self.preparingId(0)) return c.ZC_BUSY;
    if (self.next != null) return c.ZC_BUSY;
    if (self.failed) return c.ZC_STATE;
    const out = self.getOutput(0) orelse return c.ZC_STATE;
    if (out.retired != null) return c.ZC_BUSY;
    if (out.worker) |worker| worker.finalize();
    const end = if (out.frames != 0) self.outputEnd(out) catch |err| return status(err) else null;
    if (out.failure == c.ZC_OK) if (end) |cut| self.drainOutput(out, cut) catch |err| {
        self.failed = true;
        return status(err);
    };
    self.output = null;
    defer out.deinit();
    if (out.worker) |worker| worker.finalize();
    if (out.failure != c.ZC_OK and self.isolate) return c.ZC_OK;
    out.finish(self.nominal(), end) catch |err| return status(err);
    out.waitIo();
    return out.failure;
}
pub fn split(p: *c.zc_recorder, path: [*:0]const u8) c_int {
    const self = recorder(p);
    if (self.preparingId(0)) return c.ZC_BUSY;
    if (self.getOutput(0)) |current| if (current.retired != null) return c.ZC_BUSY;
    if (self.failed) return c.ZC_STATE;
    if (self.next != null) return c.ZC_BUSY;
    if (self.output == null or self.output.?.failure != c.ZC_OK or self.output.?.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    const out = Output.init(path, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err);
    if (self.output.?.io_config) |config| out.enableIo(config, self.output.?.worker) catch |err| {
        out.deinit();
        return status(err);
    };
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
    // External recipes remain caller-owned. Internal jobs are cancelled/joined
    // before recorder storage is consumed. Never strand a worker on close.
    for (self.preparing) |slot| if (slot) |recipe| {
        var internal = false;
        for (self.jobs) |job| if (job) |j| {
            if (j.recipe == recipe) internal = true;
        };
        if (!internal) return c.ZC_BUSY;
    };
    var closing_jobs: [8]?*Preparation = @splat(null);
    for (self.jobs, 0..) |maybe, i| if (maybe) |job| {
        if (job.automatic == null) closing_jobs[i] = job;
    };
    const preparation_error = closePreparations(self);
    defer self.deinit();
    if (self.output) |out| if (out.worker) |worker| worker.finalize();
    for (self.outputs.entries) |entry| if (entry.value) |out| {
        if (out.worker) |worker| worker.finalize();
    };
    self.pollIo() catch {};
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
    if (result == c.ZC_OK) {
        self.forwardOutput(0, null) catch {
            result = c.ZC_IO;
        };
        for (self.outputs.entries) |entry| if (entry.value != null) {
            self.forwardOutput(entry.id, null) catch {
                result = c.ZC_IO;
            };
        };
        // All tails have matured; the final audio drain includes the last frame.
        if (self.output) |out| out.delivery_cut = null;
        for (self.outputs.entries) |entry| if (entry.value) |out| {
            out.delivery_cut = null;
        };
    }
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
        out.waitIo();
        if (out.split_error != c.ZC_OK and !self.isolate) result = out.split_error;
        if (out.failure != c.ZC_OK and !self.isolate) result = out.failure;
        if ((if (id == 0) self.next != null else out.next != null) and out.failure == c.ZC_OK) pending = true;
        if (results) |buffer| buffer[count.*] = .{ .id = id, .state = stateOf(out, if (id == 0) self.next != null else out.next != null) };
        count.* += 1;
    };
    // Retained split handles include late retirement errors observed by close.
    for (closing_jobs) |maybe| if (maybe) |job| {
        if (job.staged and job.result == c.ZC_OK) if (self.getOutput(job.id)) |out| {
            job.result = if (out.split_error != c.ZC_OK) out.split_error else out.failure;
        };
    };
    return if (result != c.ZC_OK) result else if (preparation_error != c.ZC_OK) preparation_error else if (pending) c.ZC_STATE else c.ZC_OK;
}

test {
    _ = @import("video_async_test.zig");
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
    self.output = Output.init(path, cfg, self.headers, .{null} ** 27, opts, bitrate, self.reservations) catch |err| {
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
    self.pollIo() catch |err| {
        self.failed = true;
        return status(err);
    };
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
        const latest = if (o.queue != null) o.delivery_cut orelse 0 else if (self.delay_ns != null) self.delay_cut orelse 0 else self.last_ns - self.first_ns;
        if (self.frames != 0 and latest >= o.first_ns and o.frames != 0) out.output_duration_ns = latest - o.first_ns;
        out.rotation_due = @intFromBool(o.failure == c.ZC_OK and self.rotation.due(o.frames, out.output_duration_ns, out.output_bytes, self.next != null or o.retired != null));
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
fn checkCallbacks(self: *Recorder, cb: *const c.zc_output_callbacks, splitting: bool) !void {
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
            if (existing.retired) |old| try old.checkIdentity(id);
        }
        if (self.next) |existing| try existing.checkIdentity(id);
        for (self.outputs.entries) |entry| if (entry.value) |existing| {
            try existing.checkIdentity(id);
            if (existing.next) |pending| try pending.checkIdentity(id);
            if (existing.retired) |old| try old.checkIdentity(id);
        };
        if (self.reservations) |r| r.check(id) catch |err| return err;
        identities[i] = id;
    }
}
fn callbackOutput(self: *Recorder, cb: *const c.zc_output_callbacks, splitting: bool) !*Output {
    try checkCallbacks(self, cb, splitting);
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
    if (self.preparingId(0)) return c.ZC_BUSY;
    if (self.getOutput(0)) |current| if (current.retired != null) return c.ZC_BUSY;
    if (self.failed or self.output == null or self.output.?.failure != c.ZC_OK or self.output.?.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    if (self.next != null) return c.ZC_BUSY;
    const out = callbackOutput(self, cb, true) catch |err| return status(err);
    if (self.output.?.io_config) |config| out.enableIo(config, self.output.?.worker) catch |err| {
        out.deinit();
        return status(err);
    };
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
    const out = self.getOutput(id) orelse return c.ZC_STATE;
    stats.* = .{ .id = id, .frames = out.frames, .bytes = out.bytes, .first_ns = out.first_ns, .audio_frames = out.delivered_audio_frames, .waiting_key = @intFromBool(out.waiting_key), .reserved = 0 };
    return c.ZC_OK;
}
pub fn removeOutput(p: *c.zc_recorder, id: u64) c_int {
    if (id == 0) return closeOutput(p);
    const self = recorder(p);
    if (self.preparingId(id)) return c.ZC_BUSY;
    const out = self.getOutput(id) orelse return c.ZC_STATE;
    var result: c_int = c.ZC_OK;
    if (out.retired != null or out.next != null) return c.ZC_BUSY;
    if (out.worker) |worker| worker.finalize();
    const end = if (out.frames != 0) self.outputEnd(out) catch |err| return status(err) else null;
    if (!self.failed and out.failure == c.ZC_OK) {
        if (end) |cut| self.drainOutput(out, cut) catch |err| {
            self.failed = true;
            result = status(err);
        };
    }
    _ = self.outputs.remove(id);
    defer out.deinit();
    if (out.worker) |worker| worker.finalize();
    if (out.failure != c.ZC_OK and self.isolate) return c.ZC_OK;
    out.finish(self.nominal(), end) catch |err| {
        return status(err);
    };
    out.waitIo();
    if (out.worker != null and out.failure != c.ZC_OK) return out.failure;
    return result;
}

fn stateOf(out: *Output, pending: bool) c.zc_output_state {
    return .{ .generation = out.generation, .error_code = out.failure, .split_state = out.split_state, .pending = @intFromBool(pending or out.retired != null), .reserved = 0 };
}
pub fn outputState(p: *c.zc_recorder, id: u64, state: *c.zc_output_state) c_int {
    const self = recorder(p);
    state.* = std.mem.zeroes(c.zc_output_state);
    const out = self.getOutput(id) orelse return c.ZC_STATE;
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
    if (self.preparingId(id)) return c.ZC_BUSY;
    if (self.failed) return c.ZC_STATE;
    const old = self.getOutput(id) orelse return c.ZC_STATE;
    if (old.failure != c.ZC_OK or old.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    if (old.next != null or old.retired != null) return c.ZC_BUSY;
    const out = if (path) |file| Output.init(file, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err) else callbackOutput(self, cb.?, false) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    if (old.io_config) |config| out.enableIo(config, old.worker) catch |err| {
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

pub fn setOutputDelay(p: *c.zc_recorder, id: u64, delay: u64, bytes: u64, frames: u32) c_int {
    const self = recorder(p);
    if (self.failed) return c.ZC_STATE;
    if (bytes == 0 or bytes > 1024 * 1024 * 1024 or frames == 0 or frames > 65536) return c.ZC_INVALID;
    const out = self.getOutput(id) orelse return c.ZC_STATE;
    if (out.queue) |*queue| {
        if (queue.bytes.len == bytes and queue.entries.len == frames) {
            out.delay_ns = delay;
            return c.ZC_OK;
        }
        if (queue.count != 0) return c.ZC_BUSY;
    }
    var queue = Ring.init(A, @intCast(bytes), frames, 1) catch |err| return status(err);
    const scratch = A.alloc(u8, @intCast(bytes)) catch |err| {
        queue.deinit();
        return status(err);
    };
    if (out.queue) |*old| old.deinit();
    A.free(out.queue_scratch);
    out.queue = queue;
    out.queue_scratch = scratch;
    out.delay_ns = delay;
    return c.ZC_OK;
}
pub fn outputDelay(p: *c.zc_recorder, id: u64, state: *c.zc_output_delay) c_int {
    state.* = std.mem.zeroes(c.zc_output_delay);
    const out = recorder(p).getOutput(id) orelse return c.ZC_STATE;
    state.delay_ns = out.delay_ns;
    if (out.queue) |queue| {
        state.queued_frames = queue.count;
        state.queued_bytes = queue.used;
        state.max_frames = @intCast(queue.entries.len);
        state.max_bytes = queue.bytes.len;
    }
    return c.ZC_OK;
}
pub fn setOutputRecovery(p: *c.zc_recorder, id: u64, limit: u32, initial: u64, maximum: u64) c_int {
    const self = recorder(p);
    if (self.preparingId(id)) return c.ZC_BUSY;
    if (self.failed or !self.isolate) return c.ZC_STATE;
    const out = self.getOutput(id) orelse return c.ZC_STATE;
    out.retry = Retry.init(limit, initial, maximum) catch return c.ZC_INVALID;
    return c.ZC_OK;
}
pub fn outputRetryDue(p: *c.zc_recorder, id: u64, due: *u32) c_int {
    due.* = 0;
    const self = recorder(p);
    if (self.preparingId(id)) return c.ZC_OK;
    if (self.failed or !self.isolate) return c.ZC_STATE;
    const out = self.getOutput(id) orelse return c.ZC_STATE;
    if (out.retired != null or (out.worker != null and out.failure != c.ZC_OK and !out.worker.?.ready())) return c.ZC_OK;
    due.* = @intFromBool(out.retry.poll(self.last_ns, out.failure != c.ZC_OK));
    return c.ZC_OK;
}
pub fn outputRecovery(p: *c.zc_recorder, id: u64, state: *c.zc_output_recovery_state) c_int {
    state.* = std.mem.zeroes(c.zc_output_recovery_state);
    const out = recorder(p).getOutput(id) orelse return c.ZC_STATE;
    state.* = .{ .limit = out.retry.limit, .attempts = out.retry.attempts, .exhausted = @intFromBool(out.retry.exhausted()), .pending = @intFromBool(out.retry.deadline != null), .deadline_ns = out.retry.deadline orelse 0 };
    return c.ZC_OK;
}
pub fn recoverOutput(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks) c_int {
    if ((path == null) == (cb == null)) return c.ZC_INVALID;
    const self = recorder(p);
    if (self.preparingId(id)) return c.ZC_BUSY;
    if (self.failed or !self.isolate) return c.ZC_STATE;
    const old = self.getOutput(id) orelse return c.ZC_STATE;
    if (old.failure == c.ZC_OK or old.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    if ((if (id == 0) self.next else old.next) != null) return c.ZC_BUSY;
    if (old.retired != null or (old.worker != null and !old.worker.?.ready())) return c.ZC_BUSY;
    const out = if (path) |file| Output.init(file, &self.config, self.headers, self.avoid(), &self.recording, self.audio_bitrate, self.reservations) catch |err| return status(err) else callbackOutput(self, cb.?, id == 0) catch |err| return status(err);
    self.forceKey() catch |err| {
        out.deinit();
        return status(err);
    };
    if (old.io_config) |config| out.enableIo(config, null) catch |err| {
        out.deinit();
        return status(err);
    };
    old.transfer(out, true);
    out.generation = old.generation + 1;
    if (id == 0) {
        self.output = out;
        self.segments += 1;
    } else _ = self.outputs.replace(id, out) catch unreachable;
    old.deinit();
    return c.ZC_OK;
}

pub fn setOutputIo(p: *c.zc_recorder, id: u64, bytes: u64, items: u32, wait: u64) c_int {
    const self = recorder(p);
    if (self.preparingId(id)) return c.ZC_BUSY;
    if (bytes == 0 or bytes > 1024 * 1024 * 1024 or items == 0 or items > 65536 or wait > 60_000_000_000) return c.ZC_INVALID;
    const out = self.getOutput(id) orelse return c.ZC_STATE;
    if (self.failed or out.failure != c.ZC_OK or out.worker != null or out.retired != null or (if (id == 0) self.next != null else out.next != null)) return c.ZC_STATE;
    out.enableIo(.{ .bytes = @intCast(bytes), .items = items, .wait_ns = wait }, null) catch |err| return status(err);
    return c.ZC_OK;
}
pub fn outputIoStats(p: *c.zc_recorder, id: u64, out: *c.zc_output_io_stats) c_int {
    out.* = std.mem.zeroes(c.zc_output_io_stats);
    const sink = recorder(p).getOutput(id) orelse return c.ZC_STATE;
    if (sink.worker) |worker| worker.stats(out);
    out.split_error = sink.split_error;
    return c.ZC_OK;
}
pub fn drainOutputIo(p: *c.zc_recorder, id: u64) c_int {
    const out = recorder(p).getOutput(id) orelse return c.ZC_STATE;
    var previous: c_int = c.ZC_OK;
    if (out.retired) |old| previous = old.worker.?.drain();
    if (out.worker) |worker| {
        const code = worker.drain();
        out.sync();
        return if (previous != c.ZC_OK) previous else code;
    }
    return out.failure;
}
pub fn drainOutputAsync(p: *c.zc_recorder, id: u64, result: *?*c.zc_output_job) c_int {
    result.* = null;
    const out = recorder(p).getOutput(id) orelse return c.ZC_STATE;
    if (out.worker == null and out.failure != c.ZC_OK) return out.failure;
    const job = io.Drain.create(out.worker, if (out.retired) |old| old.worker else null) catch |err| return status(err);
    job.initial_failure = out.failure;
    result.* = @ptrCast(job);
    return c.ZC_OK;
}

const Prepared = struct {
    owner: ?*Recorder,
    registry: *Reservations,
    slot: usize,
    id: u64,
    generation: u64,
    config: c.zc_video_config,
    recording: c.zc_recording_options,
    bitrate: u32,
    headers: []u8,
    callbacks: ?c.zc_output_callbacks,
    file: ?std.fs.File,
    is_mp4: bool,
    recovering: bool = false,
    deferred_path: ?[:0]u8 = null,
    created_identity: ?Identity = null,
    attempted: bool = false,
    built: bool = false,
    io_config: ?io.Config,
    predecessor: ?*io.Worker,
    output: ?*Output = null,
};
pub fn prepareSplit(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, result: *?*c.zc_prepared_output) c_int {
    result.* = null;
    if ((path == null) == (cb == null)) return c.ZC_INVALID;
    const self = recorder(p);
    const old = self.getOutput(id) orelse return c.ZC_STATE;
    if (self.failed or old.failure != c.ZC_OK or old.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    if (self.preparingId(id) or old.retired != null or (if (id == 0) self.next != null else old.next != null)) return c.ZC_BUSY;
    prepareImpl(self, old, id, path, cb, false, false, result) catch |err| return status(err);
    return c.ZC_OK;
}
fn prepareImpl(self: *Recorder, old: *Output, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, recovering: bool, deferred: bool, result: *?*c.zc_prepared_output) !void {
    if (self.reservations == null) {
        self.reservations = try A.create(Reservations);
        self.reservations.?.* = .{};
    }
    const registry = self.reservations.?;
    var file: ?std.fs.File = null;
    errdefer if (file) |owned| owned.close();
    var ids: [3]?Identity = .{ null, null, null };
    if (path) |name| {
        try validate(std.mem.span(name), &self.config, self.audio != null);
        if (!deferred) {
            file = try reserveFile(name, self.recording.exclusive != 0, self.avoid(), registry);
            ids[0] = try Identity.of(file.?);
        }
    } else {
        try checkCallbacks(self, cb.?, id == 0);
        for ([_]i32{ cb.?.file_fd, cb.?.pts_fd, cb.?.secondary_pts_fd }, 0..) |fd, i| {
            if (fd >= 0) ids[i] = try Identity.of(.{ .handle = fd });
        }
    }
    const slot = try registry.reservePreparation(ids, deferred and path != null);
    errdefer registry.releasePreparation(slot);
    const headers = try A.dupe(u8, self.headers);
    errdefer A.free(headers);
    const deferred_path = if (deferred and path != null) try A.dupeZ(u8, std.mem.span(path.?)) else null;
    errdefer if (deferred_path) |name| A.free(name);
    const job = try A.create(Prepared);
    job.* = .{ .owner = self, .registry = registry, .slot = slot, .id = id, .generation = old.generation, .config = self.config, .recording = self.recording, .bitrate = self.audio_bitrate, .headers = headers, .callbacks = if (cb) |value| value.* else null, .file = file, .is_mp4 = if (path) |name| std.mem.endsWith(u8, std.mem.span(name), ".mp4") else false, .io_config = old.io_config, .predecessor = if (recovering) null else old.worker, .recovering = recovering, .deferred_path = deferred_path };
    self.preparing[slot] = job;
    result.* = @ptrCast(job);
}
pub fn buildPrepared(p: *c.zc_prepared_output) c_int {
    const job: *Prepared = @ptrCast(@alignCast(p));
    if (job.attempted) return c.ZC_STATE;
    job.attempted = true;
    if (job.deferred_path) |name| {
        // Opening slots reject alias-bearing lifecycle operations until their
        // new identity is published. Never hold a registry mutex across open:
        // another output must still admit preparation if filesystem I/O stalls.
        job.file = std.fs.cwd().createFile(name, .{ .truncate = false, .exclusive = true }) catch |err| return status(err);
        job.created_identity = Identity.of(job.file.?) catch |err| return status(err);
        job.registry.mutex.lock();
        job.registry.preparing[job.slot] = .{ job.created_identity, null, null };
        job.registry.opening[job.slot] = false;
        job.registry.mutex.unlock();
    }
    job.output = if (job.callbacks) |cb| Output.initCallbacks(cb, &job.config, job.headers, &job.recording, job.bitrate) catch |err| return status(err) else Output.initFile(job.file.?, job.is_mp4, &job.config, job.headers, &job.recording, job.bitrate) catch |err| return status(err);
    job.file = null;
    // The registered recipe prevents removal/recovery/close of its predecessor.
    // Worker allocation and startup therefore also happen off capture locks.
    if (job.io_config) |config| job.output.?.enableIo(config, job.predecessor) catch |err| return status(err);
    job.built = true;
    return c.ZC_OK;
}
pub fn commitPrepared(p: *c.zc_recorder, prepared: *c.zc_prepared_output) c_int {
    const self = recorder(p);
    const job: *Prepared = @ptrCast(@alignCast(prepared));
    if (job.owner != self or !job.built or job.output == null or self.failed) return c.ZC_STATE;
    const old = self.getOutput(job.id) orelse return c.ZC_STATE;
    if ((if (job.recovering) old.failure == c.ZC_OK or !self.isolate else old.failure != c.ZC_OK) or old.generation != job.generation or old.retired != null or (if (job.id == 0) self.next != null else old.next != null)) return c.ZC_STATE;
    if (job.recovering and old.worker != null and !old.worker.?.ready()) return c.ZC_BUSY;
    const out = job.output.?;
    // No sink I/O or user hooks here: expensive writers/AAC/header operations
    // were completed on the preparation owner before this publication boundary.
    self.forceKey() catch |err| return status(err);
    if (job.recovering) {
        old.transfer(out, true);
        out.generation = old.generation + 1;
        if (job.id == 0) {
            self.output = out;
            self.segments += 1;
        } else _ = self.outputs.replace(job.id, out) catch unreachable;
        // Failed workers are complete; defer destruction to the recipe's worker.
        job.output = old;
    } else {
        if (job.id == 0) self.next = out else old.next = out;
        old.split_state = c.ZC_SPLIT_PENDING;
        job.output = null;
    }
    detachPrepared(job);
    return c.ZC_OK;
}
fn detachPrepared(job: *Prepared) void {
    if (job.owner) |owner| {
        owner.preparing[job.slot] = null;
        job.owner = null;
    }
}
pub fn closePrepared(p: *c.zc_prepared_output) void {
    const job: *Prepared = @ptrCast(@alignCast(p));
    detachPrepared(job);
    if (job.output) |out| out.deinit();
    if (job.file) |file| file.close();
    job.registry.releasePreparation(job.slot);
    if (job.deferred_path) |name| A.free(name);
    A.free(job.headers);
    A.destroy(job);
}

const Gate = @import("home/preparation_gate.zig").Gate;
const PathPattern = @import("home/recording_path.zig").Pattern;
const Automatic = struct {
    id: u64,
    pattern: []u8,
    next_index: u64,
    recovery: bool,
    exhausted_index: bool = false,
    error_code: c_int = c.ZC_OK,
};
const Preparation = struct {
    owner: ?*Recorder,
    slot: usize,
    id: u64,
    generation: u64,
    recipe: ?*Prepared,
    path: ?[:0]u8,
    identity: ?Identity = null,
    thread: ?std.Thread = null,
    ready: std.atomic.Value(bool) = .init(false),
    release: std.Thread.ResetEvent = .{},
    finished: std.Thread.ResetEvent = .{},
    gate: Gate = .{},
    build_code: c_int = c.ZC_OK,
    result: c_int = c.ZC_TIMEOUT,
    cleanup_code: c_int = c.ZC_OK,
    released: bool = false,
    staged: bool = false,
    keep: bool = false,
    automatic: ?usize = null,
    fn run(self: *Preparation) void {
        const recipe = self.recipe.?;
        self.build_code = buildPrepared(@ptrCast(recipe));
        self.identity = recipe.created_identity;
        self.ready.store(true, .release);
        self.release.wait();
        // Recorder publication/detachment happens before release. No worker
        // touches mutable recorder state, even when cancellation wins the race.
        if (!self.keep) self.cleanup_code = self.removeCreated();
        closePrepared(@ptrCast(recipe));
        self.finished.set();
    }
    fn removeCreated(self: *Preparation) c_int {
        const identity = self.identity orelse return c.ZC_OK;
        const path = self.path orelse return c.ZC_OK;
        const stat = std.posix.fstatat(std.posix.AT.FDCWD, path, std.posix.AT.SYMLINK_NOFOLLOW) catch |err| return if (err == error.FileNotFound) c.ZC_OK else c.ZC_IO;
        if (stat.dev == identity.dev and stat.ino == identity.ino) std.fs.cwd().deleteFile(path) catch |err| return if (err == error.FileNotFound) c.ZC_OK else c.ZC_IO;
        return c.ZC_OK;
    }
    fn destroy(self: *Preparation) void {
        if (self.thread) |thread| thread.join();
        if (self.path) |path| A.free(path);
        A.destroy(self);
    }
};
fn hasJob(self: *Recorder, id: u64) bool {
    for (self.jobs) |job| if (job) |value| if (value.id == id and value.result == c.ZC_TIMEOUT) return true;
    return false;
}
fn beginPreparation(self: *Recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, recovery: bool, automatic: ?usize, result: *?*c.zc_preparation_job) c_int {
    result.* = null;
    if ((path == null) == (cb == null)) return c.ZC_INVALID;
    const old = self.getOutput(id) orelse return c.ZC_STATE;
    if (self.failed or old.generation == std.math.maxInt(u64) or (if (recovery) !self.isolate or old.failure == c.ZC_OK else old.failure != c.ZC_OK)) return c.ZC_STATE;
    if (self.preparingId(id) or hasJob(self, id) or old.retired != null or (if (id == 0) self.next != null else old.next != null)) return c.ZC_BUSY;
    if (recovery and old.worker != null and !old.worker.?.ready()) return c.ZC_BUSY;
    var slot: ?usize = null;
    for (self.jobs, 0..) |job, i| if (job == null) {
        slot = i;
        break;
    };
    const index = slot orelse return c.ZC_BUSY;
    const name = if (path) |value| A.dupeZ(u8, std.mem.span(value)) catch return c.ZC_NOMEM else null;
    var prepared: ?*c.zc_prepared_output = null;
    prepareImpl(self, old, id, path, cb, recovery, path != null, &prepared) catch |err| {
        if (name) |value| A.free(value);
        return status(err);
    };
    const job = A.create(Preparation) catch {
        closePrepared(prepared.?);
        if (name) |value| A.free(value);
        return c.ZC_NOMEM;
    };
    job.* = .{ .owner = self, .slot = index, .id = id, .generation = old.generation, .recipe = @ptrCast(@alignCast(prepared.?)), .path = name, .automatic = automatic };
    _ = job.gate.claim();
    self.jobs[index] = job;
    job.thread = std.Thread.spawn(.{}, Preparation.run, .{job}) catch {
        self.jobs[index] = null;
        closePrepared(prepared.?);
        if (name) |value| A.free(value);
        A.destroy(job);
        return c.ZC_NOMEM;
    };
    result.* = @ptrCast(job);
    return c.ZC_OK;
}
pub fn prepareRecovery(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, result: *?*c.zc_prepared_output) c_int {
    result.* = null;
    if ((path == null) == (cb == null)) return c.ZC_INVALID;
    const self = recorder(p);
    const old = self.getOutput(id) orelse return c.ZC_STATE;
    if (self.failed or !self.isolate or old.failure == c.ZC_OK or old.generation == std.math.maxInt(u64)) return c.ZC_STATE;
    if (self.preparingId(id) or hasJob(self, id) or old.retired != null or (if (id == 0) self.next != null else old.next != null) or (old.worker != null and !old.worker.?.ready())) return c.ZC_BUSY;
    prepareImpl(self, old, id, path, cb, true, false, result) catch |err| return status(err);
    return c.ZC_OK;
}
pub fn prepareAsync(p: *c.zc_recorder, id: u64, path: ?[*:0]const u8, cb: ?*const c.zc_output_callbacks, recovery: u32, result: *?*c.zc_preparation_job) c_int {
    if (recovery > 1) {
        result.* = null;
        return c.ZC_INVALID;
    }
    return beginPreparation(recorder(p), id, path, cb, recovery != 0, null, result);
}
fn advancePreparation(self: *Recorder, job: *Preparation) void {
    if (job.result != c.ZC_TIMEOUT) return;
    if (!job.released and job.ready.load(.acquire)) {
        if (job.build_code != c.ZC_OK) {
            _ = job.gate.fail();
        } else if (!job.gate.cancel_requested and !self.failed) {
            _ = job.gate.ready();
            job.build_code = commitPrepared(@ptrCast(self), @ptrCast(job.recipe.?));
            if (job.build_code == c.ZC_OK) {
                job.staged = true;
                job.keep = true;
                _ = job.gate.publish();
            } else _ = job.gate.fail();
        } else if (!job.gate.cancel_requested) {
            job.build_code = c.ZC_STATE;
            _ = job.gate.fail();
        }
        // Unregister on the serialized owner before the worker destroys owned
        // headers/writers/files. Mutators remain blocked by the live job slot.
        detachPrepared(job.recipe.?);
        job.recipe = null;
        job.released = true;
        job.release.set();
    }
    if (!job.released or !job.finished.isSet()) return;
    if (!job.staged) {
        _ = job.gate.cleaned();
        job.result = if (job.build_code != c.ZC_OK) job.build_code else if (job.cleanup_code != c.ZC_OK) job.cleanup_code else c.ZC_STALE;
        return;
    }
    const out = self.getOutput(job.id) orelse {
        job.result = c.ZC_STATE;
        return;
    };
    out.sync();
    if (out.generation > job.generation) {
        if (out.retired != null) return;
        job.result = if (out.split_error != c.ZC_OK) out.split_error else out.failure;
    } else if (out.failure != c.ZC_OK or self.failed) {
        _ = cancelOutputSplit(@ptrCast(self), job.id);
        const cleanup = job.removeCreated();
        job.result = if (out.failure != c.ZC_OK) out.failure else if (cleanup != c.ZC_OK) cleanup else c.ZC_IO;
    }
}
pub fn pollPreparations(p: *c.zc_recorder) c_int {
    const self = recorder(p);
    for (&self.jobs) |*slot| if (slot.*) |job| {
        advancePreparation(self, job);
        if (job.automatic) |index| {
            if (job.result != c.ZC_TIMEOUT) {
                if (self.automatic[index]) |*automatic| {
                    automatic.error_code = job.result;
                    if (job.result == c.ZC_OK and !automatic.recovery) {
                        automatic.next_index = std.math.add(u64, automatic.next_index, 1) catch blk: {
                            automatic.error_code = c.ZC_INVALID;
                            automatic.exhausted_index = true;
                            break :blk automatic.next_index;
                        };
                    }
                }
                slot.* = null;
                job.owner = null;
                job.destroy();
            }
        }
    };
    return c.ZC_OK;
}
pub fn preparationState(p: *c.zc_preparation_job, state: *c.zc_preparation_job_state) c_int {
    const job: *Preparation = @ptrCast(@alignCast(p));
    state.* = .{ .id = job.id, .generation = job.generation, .phase = @intFromEnum(job.gate.phase), .staged = @intFromBool(job.staged), .done = @intFromBool(job.result != c.ZC_TIMEOUT), .error_code = job.result };
    return c.ZC_OK;
}
pub fn cancelPreparation(p: *c.zc_preparation_job) c_int {
    const job: *Preparation = @ptrCast(@alignCast(p));
    if (job.result != c.ZC_TIMEOUT or job.staged) return c.ZC_STATE;
    return if (job.gate.cancel()) c.ZC_OK else c.ZC_STATE;
}
pub fn closePreparation(p: *c.zc_preparation_job) c_int {
    const job: *Preparation = @ptrCast(@alignCast(p));
    if (job.result == c.ZC_TIMEOUT) return c.ZC_BUSY;
    if (job.owner) |owner| owner.jobs[job.slot] = null;
    job.destroy();
    return c.ZC_OK;
}
fn closePreparations(self: *Recorder) c_int {
    var failure: c_int = c.ZC_OK;
    for (&self.jobs) |*slot| if (slot.*) |job| {
        const pending_on_close = job.result == c.ZC_TIMEOUT;
        if (pending_on_close) {
            if (!job.staged) _ = job.gate.cancel();
            // Explicit teardown can wait for uninterruptible user/native I/O.
            while (!job.ready.load(.acquire)) std.Thread.sleep(100_000);
            advancePreparation(self, job);
            job.finished.wait();
            advancePreparation(self, job);
            if (job.result == c.ZC_TIMEOUT) {
                const out = self.getOutput(job.id);
                if (out != null and out.?.generation > job.generation) {
                    job.result = c.ZC_OK; // recorder finalization drains retired I/O
                } else {
                    _ = cancelOutputSplit(@ptrCast(self), job.id);
                    const cleanup = job.removeCreated();
                    if (cleanup != c.ZC_OK and failure == c.ZC_OK) failure = cleanup;
                    job.result = c.ZC_STALE;
                }
            }
        }
        if (pending_on_close and job.cleanup_code != c.ZC_OK and failure == c.ZC_OK) failure = job.cleanup_code;
        job.owner = null;
        slot.* = null;
        if (job.automatic != null) job.destroy();
    };
    return failure;
}
pub fn setAutomatic(p: *c.zc_recorder, id: u64, pattern: ?[*:0]const u8, next: u64, recovery: u32, duration: u64, bytes: u64) c_int {
    const self = recorder(p);
    if (recovery > 1 or self.getOutput(id) == null or hasJob(self, id) or self.preparingId(id)) return c.ZC_STATE;
    var slot: ?usize = null;
    for (self.automatic, 0..) |entry, i| if (entry) |value| {
        if (value.id == id) {
            slot = i;
            break;
        }
    };
    if (pattern == null) {
        if (slot) |i| {
            A.free(self.automatic[i].?.pattern);
            self.automatic[i] = null;
        }
        return c.ZC_OK;
    }
    if (recovery != 0 and !self.isolate) return c.ZC_STATE;
    if (recovery == 0 and (id != 0 or (duration == 0 and bytes == 0))) return c.ZC_INVALID;
    const text = std.mem.span(pattern.?);
    const parsed = PathPattern.init(text) catch return c.ZC_INVALID;
    var buffer: [4097]u8 = undefined;
    const name = parsed.format(&buffer, next) catch return c.ZC_INVALID;
    validate(name, &self.config, self.audio != null) catch |err| return status(err);
    if (slot == null) for (self.automatic, 0..) |entry, i| if (entry == null) {
        slot = i;
        break;
    };
    const i = slot orelse return c.ZC_BUSY;
    const owned = A.dupe(u8, text) catch return c.ZC_NOMEM;
    if (self.automatic[i]) |value| A.free(value.pattern);
    self.automatic[i] = .{ .id = id, .pattern = owned, .next_index = next, .recovery = recovery != 0 };
    if (recovery == 0) self.rotation = .{ .duration_ns = duration, .max_bytes = bytes };
    return c.ZC_OK;
}
pub fn automaticState(p: *c.zc_recorder, id: u64, state: *c.zc_automatic_state) c_int {
    const self = recorder(p);
    state.* = std.mem.zeroes(c.zc_automatic_state);
    for (self.automatic) |entry| if (entry) |value| if (value.id == id) {
        state.* = .{ .next_index = value.next_index, .error_code = value.error_code, .pending = @intFromBool(hasJob(self, id)) };
        return c.ZC_OK;
    };
    return c.ZC_STATE;
}
fn scheduleAutomatic(self: *Recorder) void {
    for (&self.automatic, 0..) |*entry, index| if (entry.*) |*automatic| {
        if (automatic.exhausted_index or (!automatic.recovery and automatic.error_code != c.ZC_OK) or hasJob(self, automatic.id) or self.preparingId(automatic.id)) continue;
        var free = false;
        for (self.jobs) |slot| if (slot == null) {
            free = true;
            break;
        };
        if (!free) continue; // no retry claim when bounded admission is full
        var due: u32 = 0;
        if (automatic.recovery) {
            if (outputRetryDue(@ptrCast(self), automatic.id, &due) != c.ZC_OK or due == 0) continue;
        } else {
            var stats: c.zc_recording_stats = undefined;
            _ = recordingStats(@ptrCast(self), &stats);
            if (stats.rotation_due == 0) continue;
        }
        var buffer: [4097]u8 = undefined;
        const pattern = PathPattern.init(automatic.pattern) catch unreachable;
        const name = pattern.format(&buffer, automatic.next_index) catch {
            automatic.error_code = c.ZC_INVALID;
            continue;
        };
        var job: ?*c.zc_preparation_job = null;
        automatic.error_code = beginPreparation(self, automatic.id, name, null, automatic.recovery, index, &job);
        // Every recovery construction uses a fresh name, including failures.
        if (automatic.recovery) automatic.next_index = std.math.add(u64, automatic.next_index, 1) catch blk: {
            automatic.error_code = c.ZC_INVALID;
            automatic.exhausted_index = true;
            break :blk automatic.next_index;
        };
    };
}

test "unresolved exclusive paths guard aliases without blocking other preparation slots" {
    const registry = try A.create(Reservations);
    registry.* = .{};
    defer registry.release(null);
    const first = try registry.reservePreparation(.{ null, null, null }, true);
    defer registry.releasePreparation(first);
    const second = try registry.reservePreparation(.{ null, null, null }, true);
    defer registry.releasePreparation(second);
    const identity: Identity = .{ .dev = 1, .ino = 2 };
    try std.testing.expectError(error.Busy, registry.check(identity));
    try std.testing.expectError(error.Busy, registry.reserve(identity));
    try std.testing.expectError(error.Busy, registry.reservePreparation(.{ identity, null, null }, false));
}
