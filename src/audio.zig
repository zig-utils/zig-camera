//! Explicit synthetic/ALSA capture. No microphone is opened by camera creation.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const home = @import("home/native_capture.zig");
const timeline = @import("home/pcm_timeline.zig");
const enabled = if (@hasDecl(options, "audio")) options.audio else false;
const Handle = struct { config: c.zc_audio_config, capture: ?home.Capture = null, frames: u64 = 0, shared: bool = false };
pub export fn zc_default_audio_config(out: *c.zc_audio_config) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_audio_config), .backend = c.ZC_AUDIO_ALSA, .sample_rate = 48000, .channels = 1, .block_frames = 480, .reserved = 0, .start_ns = 0 };
}
pub export fn zc_audio_open(cfg: *const c.zc_audio_config, device: [*:0]const u8, out: *?*c.zc_audio) c_int {
    out.* = null;
    if (cfg.struct_size != @sizeOf(c.zc_audio_config) or cfg.backend > 1 or cfg.sample_rate < 8000 or cfg.sample_rate > 192000 or cfg.channels < 1 or cfg.channels > 2 or cfg.block_frames == 0 or cfg.block_frames > 4096 or cfg.reserved != 0 or (cfg.backend == 1 and cfg.start_ns != 0)) return c.ZC_INVALID;
    if (cfg.backend == 1 and !enabled) return c.ZC_UNSUPPORTED;
    const h = std.heap.c_allocator.create(Handle) catch return c.ZC_NOMEM;
    h.* = .{ .config = cfg.* };
    if (enabled and cfg.backend == 1) h.capture = home.Capture.init(.{ .sample_rate = cfg.sample_rate, .channels = cfg.channels, .block_frames = cfg.block_frames }, std.mem.span(device)) catch |err| {
        std.heap.c_allocator.destroy(h);
        return if (err == error.OutOfMemory) c.ZC_NOMEM else c.ZC_DEVICE;
    };
    out.* = @ptrCast(h);
    return c.ZC_OK;
}
pub export fn zc_audio_can_share(p: *c.zc_audio) c_int {
    const h: *Handle = @ptrCast(@alignCast(p));
    return if (h.shared) c.ZC_BUSY else c.ZC_OK;
}
pub export fn zc_audio_read(p: *c.zc_audio, data: [*]u8, capacity: u64, timeout_ms: u32, out: *c.zc_audio_block) c_int {
    const h: *Handle = @ptrCast(@alignCast(p));
    if (h.shared) return c.ZC_BUSY;
    return readHandle(h, data, capacity, timeout_ms, out);
}
fn readHandle(h: *Handle, data: [*]u8, capacity: u64, timeout_ms: u32, out: *c.zc_audio_block) c_int {
    out.* = std.mem.zeroes(c.zc_audio_block);
    const bytes = @as(usize, h.config.block_frames) * h.config.channels * 2;
    if (capacity < bytes or timeout_ms > 1000) return c.ZC_INVALID;
    if (enabled) {
        if (h.capture) |*capture| {
            const block = (capture.read(data[0..bytes], timeout_ms) catch return c.ZC_DEVICE) orelse return c.ZC_TIMEOUT;
            out.* = .{ .timestamp_ns = block.timestamp_ns, .clock_error_ns = block.clock_error_ns, .frames = block.frames, .reserved = 0 };
            return c.ZC_OK;
        }
    }
    const timestamp = timeline.at(h.config.start_ns, h.frames, h.config.sample_rate) catch return c.ZC_INVALID;
    _ = timeline.at(h.config.start_ns, std.math.add(u64, h.frames, h.config.block_frames) catch return c.ZC_INVALID, h.config.sample_rate) catch return c.ZC_INVALID;
    for (0..h.config.block_frames) |i| for (0..h.config.channels) |ch| {
        const sample: i16 = @intCast((@as(i32, @intCast((h.frames + i) % 200)) - 100) * 100 * (if (ch == 0) @as(i32, 1) else -1));
        std.mem.writeInt(i16, data[(i * h.config.channels + ch) * 2 ..][0..2], sample, .little);
    };
    h.frames += h.config.block_frames;
    out.* = .{ .timestamp_ns = timestamp, .clock_error_ns = 0, .frames = h.config.block_frames, .reserved = 0 };
    return c.ZC_OK;
}
pub export fn zc_audio_close(p: *c.zc_audio) c_int {
    const h: *Handle = @ptrCast(@alignCast(p));
    if (h.shared) return c.ZC_BUSY;
    if (enabled) {
        if (h.capture) |*capture| capture.deinit();
    }
    std.heap.c_allocator.destroy(h);
    return c.ZC_OK;
}
test "synthetic PCM sample clock and exact ramp; truncation and overflow reject" {
    var cfg: c.zc_audio_config = undefined;
    zc_default_audio_config(&cfg);
    cfg.backend = 0;
    cfg.channels = 2;
    cfg.block_frames = 48;
    cfg.start_ns = std.math.maxInt(u64) - 1;
    var overflow: ?*c.zc_audio = null;
    try std.testing.expectEqual(c.ZC_OK, zc_audio_open(&cfg, "", &overflow));
    var untouched = [_]u8{77} ** 192;
    var invalid: c.zc_audio_block = undefined;
    try std.testing.expectEqual(c.ZC_INVALID, zc_audio_read(overflow.?, &untouched, 192, 0, &invalid));
    try std.testing.expectEqual(@as(u8, 77), untouched[0]);
    try std.testing.expectEqual(c.ZC_OK, zc_audio_close(overflow.?));
    cfg.start_ns = 0;
    var handle: ?*c.zc_audio = null;
    try std.testing.expectEqual(c.ZC_OK, zc_audio_open(&cfg, "", &handle));
    defer _ = zc_audio_close(handle.?);
    var bytes: [192]u8 = undefined;
    var block: c.zc_audio_block = undefined;
    try std.testing.expectEqual(c.ZC_INVALID, zc_audio_read(handle.?, &bytes, 191, 0, &block));
    try std.testing.expectEqual(c.ZC_OK, zc_audio_read(handle.?, &bytes, 192, 0, &block));
    try std.testing.expectEqual(@as(u64, 0), block.timestamp_ns);
    try std.testing.expectEqual(@as(i16, -10000), std.mem.readInt(i16, bytes[0..2], .little));
    try std.testing.expectEqual(@as(i16, 10000), std.mem.readInt(i16, bytes[2..4], .little));
    try std.testing.expectEqual(c.ZC_OK, zc_audio_read(handle.?, &bytes, 192, 0, &block));
    try std.testing.expectEqual(@as(u64, 1000000), block.timestamp_ns);
}

const shared_pcm = @import("home/pcm_fanout.zig");
const Shared = struct {
    source: *Handle,
    fanout: shared_pcm.Fanout(8),
    scratch: []u8,
    pending: ?c.zc_audio_block = null,
    reads: u64 = 0,
    clock_error: i64 = 0,
    failure: c_int = 0,
};
fn shared(p: *c.zc_audio_fanout) *Shared {
    return @ptrCast(@alignCast(p));
}
fn pcmStatus(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.Capacity, error.Busy => c.ZC_BUSY,
        error.Stale => c.ZC_STALE,
        error.Overrun => c.ZC_IO,
        error.Closed => c.ZC_STATE,
        else => c.ZC_INVALID,
    };
}
fn consumerState(value: shared_pcm.State, out: *c.zc_pcm_consumer_state) void {
    out.* = .{ .id = value.id, .next_ns = value.next_ns orelse 0, .ticket = if (value.pending) |pending| pending.ticket else 0, .frames = value.frames, .overruns = value.overruns, .cancelled = value.cancelled, .flags = @as(u32, @intFromBool(value.active)) | (@as(u32, @intFromBool(value.pending != null)) << 1) | (@as(u32, @intFromBool(value.overruns != 0)) << 2) | (@as(u32, @intFromBool(value.next_ns != null)) << 3), .reserved = 0 };
}
pub export fn zc_audio_fanout_open(source: *c.zc_audio, config: *const c.zc_audio_fanout_config, out: *?*c.zc_audio_fanout) c_int {
    out.* = null;
    const h: *Handle = @ptrCast(@alignCast(source));
    if (h.shared) return c.ZC_BUSY;
    if (config.struct_size != @sizeOf(c.zc_audio_fanout_config) or config.reserved != 0 or config.max_frames < h.config.block_frames or config.max_frames > h.config.sample_rate * 10 or config.max_blocks == 0 or config.max_blocks > 256) return c.ZC_INVALID;
    const allocator = std.heap.c_allocator;
    const value = allocator.create(Shared) catch return c.ZC_NOMEM;
    value.* = .{ .source = h, .fanout = shared_pcm.Fanout(8).init(allocator, h.config.sample_rate, h.config.channels, config.max_frames, config.max_blocks) catch |err| {
        allocator.destroy(value);
        return pcmStatus(err);
    }, .scratch = undefined };
    value.scratch = allocator.alloc(u8, @as(usize, h.config.block_frames) * h.config.channels * 2) catch {
        value.fanout.deinit();
        allocator.destroy(value);
        return c.ZC_NOMEM;
    };
    h.shared = true;
    out.* = @ptrCast(value);
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_close(p: *c.zc_audio_fanout) c_int {
    const s = shared(p);
    if (s.fanout.slots.count != 0) return c.ZC_BUSY;
    s.source.shared = false;
    s.fanout.deinit();
    std.heap.c_allocator.free(s.scratch);
    std.heap.c_allocator.destroy(s);
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_add(p: *c.zc_audio_fanout, out: *u64) c_int {
    const s = shared(p);
    if (s.failure != 0) return s.failure;
    out.* = s.fanout.add() catch |err| return pcmStatus(err);
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_fill(p: *c.zc_audio_fanout, cut: u64, max_reads: u32) c_int {
    const s = shared(p);
    if (max_reads == 0 or max_reads > 256) return c.ZC_INVALID;
    if (s.failure != 0) return s.failure;
    if (s.fanout.prepared()) return c.ZC_BUSY;
    var reads: u32 = 0;
    while (true) {
        if (s.fanout.queue.last_end) |end| if (end >= cut) return c.ZC_OK;
        if (s.pending == null) {
            if (reads == max_reads) {
                s.failure = c.ZC_BUSY;
                return s.failure;
            }
            var block: c.zc_audio_block = undefined;
            const code = readHandle(s.source, s.scratch.ptr, s.scratch.len, 0, &block);
            if (code == c.ZC_TIMEOUT) return c.ZC_OK;
            if (code != c.ZC_OK) {
                s.failure = code;
                return code;
            }
            reads += 1;
            s.reads +|= 1;
            s.clock_error = block.clock_error_ns;
            s.pending = block;
        }
        const block = s.pending.?;
        if (block.timestamp_ns >= cut) return c.ZC_OK;
        const length = @as(usize, block.frames) * s.source.config.channels * 2;
        s.fanout.push(s.scratch[0..length], block.timestamp_ns) catch |err| {
            s.failure = pcmStatus(err);
            return s.failure;
        };
        s.pending = null;
    }
}
pub export fn zc_audio_fanout_prepare(p: *c.zc_audio_fanout, id: u64, minimum: u64, cut: u64, out: [*]c.zc_pcm_span, capacity: u32, batch: *c.zc_pcm_batch) c_int {
    batch.* = std.mem.zeroes(c.zc_pcm_batch);
    const s = shared(p);
    if (capacity > 256) return c.ZC_INVALID;
    if (s.failure != 0) return s.failure;
    var chunks: [256]shared_pcm.Chunk = undefined;
    const value = s.fanout.prepare(id, minimum, cut, chunks[0..capacity]) catch |err| return pcmStatus(err);
    for (chunks[0..value.blocks], out[0..value.blocks]) |chunk, *span| span.* = .{ .data = chunk.data.ptr, .length = chunk.data.len, .timestamp_ns = chunk.timestamp };
    batch.* = .{ .ticket = value.ticket, .frames = value.frames, .next_ns = value.next_ns, .blocks = @intCast(value.blocks), .reserved = 0 };
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_finish(p: *c.zc_audio_fanout, id: u64, ticket: u64, accepted: u32, out: *c.zc_pcm_consumer_state) c_int {
    if (accepted > 1) return c.ZC_INVALID;
    consumerState(shared(p).fanout.finish(id, ticket, accepted != 0) catch |err| return pcmStatus(err), out);
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_check(p: *c.zc_audio_fanout, id: u64) c_int {
    _ = shared(p).fanout.check(id) catch |err| return pcmStatus(err);
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_state(p: *c.zc_audio_fanout, id: u64, out: *c.zc_pcm_consumer_state) c_int {
    consumerState(shared(p).fanout.state(id) catch |err| return pcmStatus(err), out);
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_retire(p: *c.zc_audio_fanout, id: u64, out: *c.zc_pcm_consumer_state) c_int {
    consumerState(shared(p).fanout.retire(id) catch |err| return pcmStatus(err), out);
    return c.ZC_OK;
}
pub export fn zc_audio_fanout_stats(p: *c.zc_audio_fanout, out: *c.zc_pcm_fanout_stats) c_int {
    const s = shared(p);
    const f = &s.fanout;
    out.* = .{ .frames = f.queue.used, .blocks = f.queue.count, .max_frames = f.queue.capacity, .max_blocks = f.queue.entries.len, .high_frames = f.high_frames, .high_blocks = f.high_blocks, .pushed_frames = f.pushed_frames, .evicted_frames = f.queue.trimmed, .sample_rate = f.queue.rate, .channels = f.queue.channels, .clock_error_ns = s.clock_error, .reads = s.reads, .pending_future = @intFromBool(s.pending != null), .error_code = s.failure };
    return c.ZC_OK;
}
