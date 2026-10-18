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
    revision: u64 = 0,
    applied_revision: u64 = 0,
    active: [31]c.zc_control = @splat(std.mem.zeroes(c.zc_control)),
    pending: [31]?c.zc_control = @splat(null),
    af_steps: u32 = 0,
    af_state: i32 = 0,
    fail_af: bool = false,
    never_scan: bool = false,
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
    for (1..31) |id| {
        var descriptor: c.zc_control_info = undefined;
        _ = controlInfo(h, @intCast(id), &descriptor);
        var value = std.mem.zeroes(c.zc_control);
        value.id = @intCast(id);
        value.type = descriptor.type;
        value.count = descriptor.min_count;
        @memcpy(value.values[0..@min(4, value.count)], descriptor.def[0..@min(4, value.count)]);
        h.active[id] = value;
    }
    if (config.exposure_us != 0) h.active[c.ZC_EXPOSURE_TIME].values[0] = @floatFromInt(config.exposure_us);
    if (config.analogue_gain != 0) h.active[c.ZC_ANALOGUE_GAIN].values[0] = config.analogue_gain;
    if (config.frame_duration_us != 0) h.active[c.ZC_FRAME_DURATION_LIMITS].values[0..2].* = @splat(@floatFromInt(config.frame_duration_us));
    if (config.lens_position >= 0) {
        h.active[c.ZC_LENS_POSITION].values[0] = config.lens_position;
        h.active[c.ZC_AF_MODE].values[0] = 0;
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
    for (&h.pending, 0..) |*entry, id| {
        if (entry.*) |value| {
            h.active[id] = value;
            if (id == c.ZC_AF_TRIGGER) {
                if (value.values[0] == 0 and !h.never_scan) {
                    h.af_steps = 3;
                    h.af_state = 1;
                } else {
                    h.af_steps = 0;
                    h.af_state = 0;
                }
            }
            entry.* = null;
        }
    }
    h.applied_revision = h.revision;
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
    f.exposure_us = @intFromFloat(h.active[c.ZC_EXPOSURE_TIME].values[0]);
    f.analogue_gain = @floatCast(h.active[c.ZC_ANALOGUE_GAIN].values[0]);
    f.red_gain = @floatCast(h.active[c.ZC_COLOUR_GAINS].values[0]);
    f.blue_gain = @floatCast(h.active[c.ZC_COLOUR_GAINS].values[1]);
    var meta = std.mem.zeroes(c.zc_metadata);
    meta.struct_size = @sizeOf(c.zc_metadata);
    meta.valid = 15;
    meta.sequence = f.sequence;
    meta.timestamp_ns = f.timestamp_ns;
    meta.control_revision = h.applied_revision;
    meta.exposure_us = f.exposure_us;
    meta.analogue_gain = f.analogue_gain;
    meta.red_gain = f.red_gain;
    meta.blue_gain = f.blue_gain;
    meta.lens_position = @floatCast(h.active[c.ZC_LENS_POSITION].values[0]);
    meta.frame_duration_us = @intFromFloat(h.active[c.ZC_FRAME_DURATION_LIMITS].values[0]);
    for (0..4) |i| meta.crop[i] = @intFromFloat(h.active[c.ZC_SCALER_CROP].values[i]);
    meta.af_state = h.af_state;
    meta.af_pause_state = -1;
    if (h.af_steps > 0) {
        h.af_steps -= 1;
        if (h.af_steps == 0) h.af_state = if (h.fail_af) 3 else 2;
    }
    h.callback(h.context, index, &f, &meta, c.ZC_OK);
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

pub fn controlInfo(h: *Handle, id: u32, out: *c.zc_control_info) c_int {
    out.* = std.mem.zeroes(c.zc_control_info);
    out.id = id;
    out.type = c.ZC_INT;
    out.min_count = 1;
    out.max_count = 1;
    var lo: f64 = 0;
    var hi: f64 = 1;
    var def: f64 = 0;
    switch (id) {
        1, 5 => {
            out.type = c.ZC_BOOL;
            def = 1;
        },
        2 => {
            lo = 1;
            hi = 1000000;
            def = 10000;
        },
        3 => {
            out.type = c.ZC_FLOAT;
            lo = 1;
            hi = 64;
            def = 1;
        },
        4 => {
            out.type = c.ZC_FLOAT;
            lo = -8;
            hi = 8;
        },
        6 => {
            out.type = c.ZC_FLOAT;
            out.min_count = 2;
            out.max_count = 2;
            lo = 0.01;
            hi = 32;
            def = 1;
        },
        7 => {
            out.type = c.ZC_FLOAT;
            lo = -1;
            hi = 1;
        },
        8, 9, 10 => {
            out.type = c.ZC_FLOAT;
            hi = 16;
            def = 1;
        },
        11 => {
            out.min_count = 2;
            out.max_count = 2;
            lo = 1;
            hi = 1000000000;
            def = 33333;
        },
        12 => {
            out.type = c.ZC_FLOAT;
            hi = 100;
        },
        13 => {
            hi = 2;
            def = 2;
            out.enum_mask = 7;
        },
        14, 16, 17, 24, 25 => {
            out.enum_mask = 3;
        },
        15, 26 => {
            hi = 2;
            out.enum_mask = 7;
        },
        18, 19 => {
            out.type = c.ZC_RECT;
            out.min_count = 4;
            out.max_count = if (id == 18) 16 else 4;
            out.min = .{ 0, 0, 1, 1 };
            out.max = .{ 0, 0, @floatFromInt(h.info.main.width), @floatFromInt(h.info.main.height) };
            out.def = out.max;
            return c.ZC_OK;
        },
        20 => {
            hi = 4;
            def = 2;
            out.enum_mask = 31;
        },
        21, 22, 27 => {
            hi = 3;
            out.enum_mask = 15;
        },
        23 => {
            hi = 7;
            out.enum_mask = 255;
        },
        28 => {
            lo = 1000;
            hi = 20000;
            def = 6500;
        },
        29 => {
            hi = 2;
            out.enum_mask = 7;
        },
        30 => {
            hi = 1000000;
        },
        else => return c.ZC_UNSUPPORTED,
    }
    out.min = @splat(lo);
    out.max = @splat(hi);
    out.def = @splat(def);
    return c.ZC_OK;
}
pub fn setControls(h: *Handle, values: [*]const c.zc_control, count: u32, revision: *u64) c_int {
    if (h.revision == std.math.maxInt(u64)) return c.ZC_STATE;
    for (values[0..count]) |value| h.pending[value.id] = value;
    h.revision += 1;
    revision.* = h.revision;
    return c.ZC_OK;
}
