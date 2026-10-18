//! Explicit synthetic/ALSA capture. No microphone is opened by camera creation.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const home = @import("home/native_capture.zig");
const timeline = @import("home/pcm_timeline.zig");
const enabled = if (@hasDecl(options, "audio")) options.audio else false;
const Handle = struct { config: c.zc_audio_config, capture: ?home.Capture = null, frames: u64 = 0 };
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
pub export fn zc_audio_read(p: *c.zc_audio, data: [*]u8, capacity: u64, timeout_ms: u32, out: *c.zc_audio_block) c_int {
    const h: *Handle = @ptrCast(@alignCast(p));
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
