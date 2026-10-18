//! Deliberately unpaced, deterministic test device. Never a hardware benchmark.
const std = @import("std");
const c = @import("abi.zig").c;
const Alloc = std.heap.c_allocator;
pub const Callback = @import("real.zig").Callback;
pub const Handle = struct {
    config: c.zc_config,
    context: ?*anyopaque,
    callback: Callback,
    buffers: [c.ZC_MAX_BUFFERS][]u8 = undefined,
    info: c.zc_info,
    raw_buffers: [c.ZC_MAX_BUFFERS][]u8 = @splat(&.{}),
    sequence: u64 = 0,
    // Fault injection for the shared ownership state machine's tests.
    fail_queue: bool = false,
    fail_sync_begin: bool = false,
    fail_sync_end: bool = false,
    fail_stop_once: bool = false,
    stop_calls: u32 = 0,
};
pub fn open(config: *const c.zc_config, opts: *const c.zc_capture_options, context: ?*anyopaque, callback: Callback, out: *?*Handle, info: *c.zc_info) c_int {
    _ = opts;
    if (config.camera_index != 0) return c.ZC_UNSUPPORTED;
    const h = Alloc.create(Handle) catch return c.ZC_NOMEM;
    const width = if (config.width == 0) 640 else config.width;
    const height = if (config.height == 0) 480 else config.height;
    const stride = std.mem.alignForward(u32, width * 3, 64);
    h.* = .{ .config = config.*, .context = context, .callback = callback, .info = std.mem.zeroes(c.zc_info) };
    h.info.backend = c.ZC_SYNTHETIC;
    h.info.buffer_count = config.buffer_count;
    h.info.main.width = width;
    h.info.main.height = height;
    h.info.main.stride = stride;
    h.info.main.plane_count = 1;
    @memcpy(h.info.main.format[0..6], "BGR888");
    @memcpy(h.info.camera_id[0..9], "synthetic");
    if (config.raw != 0) {
        h.info.raw.width = width;
        h.info.raw.height = height;
        h.info.raw.stride = std.mem.alignForward(u32, width * 2, 64);
        h.info.raw.plane_count = 1;
        const name = if (config.raw_format[0] == 0) "SRGGB12" else std.mem.sliceTo(&config.raw_format, 0);
        const format = @import("raw.zig").Format.parse(name) catch {
            Alloc.destroy(h);
            return c.ZC_UNSUPPORTED;
        };
        if (format.csi2_packed or format.bits == 8) {
            Alloc.destroy(h);
            return c.ZC_UNSUPPORTED;
        }
        @memcpy(h.info.raw.format[0..name.len], name);
    }
    var allocated: usize = 0;
    for (0..config.buffer_count) |i| {
        h.buffers[i] = Alloc.alloc(u8, @as(usize, stride) * height) catch {
            for (h.buffers[0..allocated]) |buf| Alloc.free(buf);
            for (h.raw_buffers[0..allocated]) |buf| Alloc.free(buf);
            Alloc.destroy(h);
            return c.ZC_NOMEM;
        };
        if (config.raw != 0) {
            h.raw_buffers[i] = Alloc.alloc(u8, @as(usize, h.info.raw.stride) * height) catch {
                Alloc.free(h.buffers[i]);
                for (h.buffers[0..allocated]) |buf| Alloc.free(buf);
                for (h.raw_buffers[0..allocated]) |buf| Alloc.free(buf);
                Alloc.destroy(h);
                return c.ZC_NOMEM;
            };
            @memset(h.raw_buffers[i], 0);
            const format = @import("raw.zig").Format.parse(std.mem.sliceTo(&h.info.raw.format, 0)) catch unreachable;
            const black: u32 = @as(u32, 1) << @intCast(format.bits - 6);
            for (0..height) |y| for (0..width) |x| {
                const value: u16 = @intCast(black + (x * 17 + y * 31 + i * 13) % (format.white() - black));
                std.mem.writeInt(u16, h.raw_buffers[i][y * h.info.raw.stride + x * 2 ..][0..2], value, .little);
            };
        }
        allocated += 1;
        @memset(h.buffers[i], 0);
        for (0..height) |y| {
            for (0..width) |x| {
                const off = y * stride + x * 3;
                h.buffers[i][off..][0..3].* = .{ @truncate(x), @truncate(y), @truncate(i * 37) };
            }
        }
    }
    info.* = h.info;
    out.* = h;
    return c.ZC_OK;
}
pub fn start(_: *Handle) c_int {
    return c.ZC_OK;
}
pub fn stop(h: *Handle) c_int {
    h.stop_calls += 1;
    if (h.fail_stop_once) {
        h.fail_stop_once = false;
        return c.ZC_IO;
    }
    return c.ZC_OK;
}
pub fn close(h: *Handle) void {
    for (h.buffers[0..h.config.buffer_count]) |buf| Alloc.free(buf);
    for (h.raw_buffers[0..h.config.buffer_count]) |buf| Alloc.free(buf);
    Alloc.destroy(h);
}
pub fn sync(h: *Handle, _: u32, begin: bool) c_int {
    if ((begin and h.fail_sync_begin) or (!begin and h.fail_sync_end)) return c.ZC_IO;
    return c.ZC_OK;
}
pub fn queue(h: *Handle, index: u32) c_int {
    if (h.fail_queue) return c.ZC_DEVICE;
    var f = std.mem.zeroes(c.zc_frame);
    f.main = h.info.main;
    if (h.config.raw != 0) {
        f.raw = h.info.raw;
        f.raw.planes[0].data = h.raw_buffers[index].ptr;
        f.raw.planes[0].length = h.raw_buffers[index].len;
        f.raw.planes[0].bytes_used = h.raw_buffers[index].len;
        f.raw.planes[0].fd = -1;
    }
    f.main.planes[0].data = h.buffers[index].ptr;
    f.main.planes[0].length = h.buffers[index].len;
    f.main.planes[0].bytes_used = h.buffers[index].len;
    f.main.planes[0].fd = -1;
    f.sequence = h.sequence;
    h.sequence += 1;
    f.timestamp_ns = @intCast(@max(0, std.time.nanoTimestamp()));
    f.exposure_us = if (h.config.exposure_us == 0) 10000 else h.config.exposure_us;
    f.analogue_gain = if (h.config.analogue_gain == 0) 1 else h.config.analogue_gain;
    f.red_gain = 1;
    f.blue_gain = 1;
    h.callback(h.context, index, &f, c.ZC_OK);
    return c.ZC_OK;
}

pub fn metadata(_: *Handle, _: u32, out: *c.zc_raw_metadata) c_int {
    out.* = std.mem.zeroes(c.zc_raw_metadata);
    out.valid = 7;
    out.black_levels = @splat(1024);
    out.camera_to_srgb = .{ 1, 0, 0, 0, 1, 0, 0, 0, 1 };
    @memcpy(out.model[0..20], "zig-camera synthetic");
    return c.ZC_OK;
}
