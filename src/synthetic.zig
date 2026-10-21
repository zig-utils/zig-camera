//! Deliberately unpaced, deterministic test device. Never a hardware benchmark.
const std = @import("std");
const c = @import("abi.zig").c;
const Alloc = std.heap.c_allocator;
const orientation = @import("home/orientation.zig");
pub const model = "zig-camera synthetic";
pub const black_level: i32 = 1024;
pub const color_matrix = [9]f32{ 1, 0, 0, 0, 1, 0, 0, 0, 1 };
pub const Callback = @import("real.zig").Callback;
pub const Handle = struct {
    config: c.zc_config,
    context: ?*anyopaque,
    callback: Callback,
    buffers: [c.ZC_MAX_BUFFERS][]u8 = @splat(&.{}),
    lores_buffers: [c.ZC_MAX_BUFFERS][]u8 = @splat(&.{}),
    pipeline: c.zc_pipeline_info = std.mem.zeroes(c.zc_pipeline_info),
    info: c.zc_info,
    raw_buffers: [c.ZC_MAX_BUFFERS][]u8 = @splat(&.{}),
    catalog_metadata: [c.ZC_MAX_BUFFERS]c.zc_metadata = @splat(std.mem.zeroes(c.zc_metadata)),
    sequence: u64 = 0,
    revision: u64 = 0,
    applied_revision: u64 = 0,
    active: [31]c.zc_control = @splat(std.mem.zeroes(c.zc_control)),
    pending: [31]?c.zc_control = @splat(null),
    saved: [31]?c.zc_control = @splat(null),
    vendor_current: ?*@import("typed_synthetic.zig").Ref = null,
    vendor_saved: ?*@import("typed_synthetic.zig").Ref = null,
    vendor_frames: [c.ZC_MAX_BUFFERS]?*@import("typed_synthetic.zig").Ref = @splat(null),
    af_steps: u32 = 0,
    af_state: i32 = 0,
    af_pause_state: i32 = 0,
    omit_pause_metadata: bool = false,
    fail_af: bool = false,
    never_scan: bool = false,
    // Fault injection for the shared ownership state machine's tests.
    fail_queue: bool = false,
    fail_controls_once: bool = false,
    fail_sync_begin: bool = false,
    fail_sync_end: bool = false,
    fail_stop_once: bool = false,
    stop_calls: u32 = 0,
    writable: bool = false,
    fail_writable_once: bool = false,
};
pub fn enableWritable(h: *Handle) c_int {
    if (h.fail_writable_once) {
        h.fail_writable_once = false;
        return c.ZC_IO;
    }
    h.writable = true;
    return c.ZC_OK;
}
fn sampleRGB(transform: orientation.Transform, output: orientation.Extent, main_source: orientation.Extent, x: usize, y: usize, index: usize) [3]u8 {
    const source = transform.extent(output);
    const point = transform.sourcePoint(source, .{ .x = x, .y = y }) catch unreachable;
    return .{ @truncate(point.x * main_source.width / source.width), @truncate(point.y * main_source.height / source.height), @truncate(index * 37) };
}
fn attachProcessed(stream: *c.zc_stream, buf: []u8) void {
    const ysize = @as(usize, stream.stride) * stream.height;
    for (0..stream.plane_count) |i| {
        const offset = if (i == 0) 0 else ysize + (i - 1) * ysize / 4;
        const len = if (stream.plane_count == 1) buf.len else if (i == 0) ysize else ysize / 4;
        stream.planes[i] = .{ .data = buf[offset..].ptr, .length = len, .bytes_used = len, .fd = -1, .offset = 0, .reserved = 0 };
    }
}
fn fillProcessed(buf: []u8, stream: c.zc_stream, transform: orientation.Transform, main_source: orientation.Extent, index: usize) !void {
    @memset(buf, 0);
    const output = orientation.Extent{ .width = stream.width, .height = stream.height };
    if (stream.plane_count == 1) {
        for (0..stream.height) |y| for (0..stream.width) |x| {
            buf[y * stream.stride + x * 3 ..][0..3].* = sampleRGB(transform, output, main_source, x, y, index);
        };
    } else {
        // Synthetic setup only: real hardware supplies the negotiated YUV planes.
        const tmp = try Alloc.alloc(u8, @as(usize, stream.width) * stream.height * 3);
        defer Alloc.free(tmp);
        for (0..stream.height) |y| for (0..stream.width) |x| {
            tmp[(y * stream.width + x) * 3 ..][0..3].* = sampleRGB(transform, output, main_source, x, y, index);
        };
        const ysize = @as(usize, stream.stride) * stream.height;
        try @import("home/yuv_rgb.zig").encode420(tmp, stream.width, stream.height, stream.width * 3, .{ buf[0..ysize], buf[ysize..][0 .. ysize / 4], buf[ysize + ysize / 4 ..] }, .{ stream.stride, stream.stride / 2, stream.stride / 2 }, @import("home/yuv_rgb.zig").Conversion.init(.bt601, .full));
    }
}
pub fn open(config: *const c.zc_config, opts: *const c.zc_pipeline_options, main_format: u32, requested_orientation: u32, _: bool, actual: *u32, context: ?*anyopaque, callback: Callback, out: *?*Handle, info: *c.zc_info, pipeline: *c.zc_pipeline_info) c_int {
    const transform = orientation.Transform.fromOrientation(requested_orientation) catch return c.ZC_INVALID;
    if (opts.sensor_width != 0) {
        var found = false;
        for (modes) |mode| if (mode.width == opts.sensor_width and mode.height == opts.sensor_height and mode.bit_depth == opts.sensor_bit_depth) {
            found = true;
        };
        if (!found) return c.ZC_UNSUPPORTED;
    }
    if (config.camera_index != 0) return c.ZC_UNSUPPORTED;
    const h = Alloc.create(Handle) catch return c.ZC_NOMEM;
    const width = if (config.width == 0) 640 else config.width;
    const height = if (config.height == 0) 480 else config.height;
    const main_output = orientation.Extent{ .width = width, .height = height };
    const main_source = transform.extent(main_output);
    const stride = std.mem.alignForward(u32, width * @as(u32, if (main_format == c.ZC_RGB24) 3 else 1), 64);
    h.* = .{ .config = config.*, .context = context, .callback = callback, .info = std.mem.zeroes(c.zc_info) };
    h.pipeline.struct_size = @sizeOf(c.zc_pipeline_info);
    h.pipeline.sensor_width = if (opts.sensor_width != 0) opts.sensor_width else @intCast(main_source.width);
    h.pipeline.sensor_height = if (opts.sensor_width != 0) opts.sensor_height else @intCast(main_source.height);
    h.pipeline.sensor_bit_depth = if (opts.sensor_width != 0) opts.sensor_bit_depth else 12;
    if (opts.lores_width > width or opts.lores_height > height) {
        Alloc.destroy(h);
        return c.ZC_INVALID;
    }
    if (opts.lores_width != 0) {
        const l = &h.pipeline.lores;
        l.width = opts.lores_width;
        l.height = opts.lores_height;
        l.stride = std.mem.alignForward(u32, l.width * @as(u32, if (opts.lores_format == c.ZC_RGB24) 3 else 1), 64);
        l.plane_count = if (opts.lores_format == c.ZC_RGB24) 1 else 3;
        const name = if (opts.lores_format == c.ZC_RGB24) "BGR888" else "YUV420";
        @memcpy(l.format[0..name.len], name);
    }
    h.info.backend = c.ZC_SYNTHETIC;
    h.info.buffer_count = config.buffer_count;
    h.info.main.width = width;
    h.info.main.height = height;
    h.info.main.stride = stride;
    h.info.main.plane_count = if (main_format == c.ZC_RGB24) 1 else 3;
    @memcpy(h.info.main.format[0..6], if (main_format == c.ZC_RGB24) "BGR888" else "YUV420");
    @memcpy(h.info.camera_id[0..9], "synthetic");
    if (config.raw != 0) {
        const raw_output = transform.extent(.{ .width = h.pipeline.sensor_width, .height = h.pipeline.sensor_height });
        h.info.raw.width = @intCast(raw_output.width);
        h.info.raw.height = @intCast(raw_output.height);
        h.info.raw.stride = std.mem.alignForward(u32, h.info.raw.width * 2, 64);
        h.info.raw.plane_count = 1;
        const name = if (config.raw_format[0] == 0) (if (h.pipeline.sensor_bit_depth == 10) "SRGGB10" else "SRGGB12") else std.mem.sliceTo(&config.raw_format, 0);
        const format = @import("raw.zig").Format.parse(name) catch {
            Alloc.destroy(h);
            return c.ZC_UNSUPPORTED;
        };
        if (format.csi2_packed or format.bits == 8) {
            Alloc.destroy(h);
            return c.ZC_UNSUPPORTED;
        }
        const cfa = transform.tile(u8, format.pattern.cfa(), .{ .width = h.pipeline.sensor_width, .height = h.pipeline.sensor_height }) catch unreachable;
        var pattern: []const u8 = "";
        inline for (.{ .{ @import("raw.zig").Pattern.rggb, "RGGB" }, .{ @import("raw.zig").Pattern.bggr, "BGGR" }, .{ @import("raw.zig").Pattern.grbg, "GRBG" }, .{ @import("raw.zig").Pattern.gbrg, "GBRG" } }) |entry| {
            if (std.mem.eql(u8, &cfa, &entry[0].cfa())) pattern = entry[1];
        }
        _ = std.fmt.bufPrint(&h.info.raw.format, "S{s}{s}", .{ pattern, name[5..] }) catch unreachable;
    }
    for (0..config.buffer_count) |i| {
        h.buffers[i] = Alloc.alloc(u8, @as(usize, stride) * height * @as(usize, if (main_format == c.ZC_RGB24) 1 else 3) / @as(usize, if (main_format == c.ZC_RGB24) 1 else 2)) catch {
            close(h);
            return c.ZC_NOMEM;
        };
        fillProcessed(h.buffers[i], h.info.main, transform, main_source, i) catch {
            close(h);
            return c.ZC_NOMEM;
        };
        if (config.raw != 0) {
            const raw = h.info.raw;
            h.raw_buffers[i] = Alloc.alloc(u8, @as(usize, raw.stride) * raw.height) catch {
                close(h);
                return c.ZC_NOMEM;
            };
            @memset(h.raw_buffers[i], 0);
            const format = @import("raw.zig").Format.parse(std.mem.sliceTo(&raw.format, 0)) catch unreachable;
            const black: u32 = @as(u32, 1) << @intCast(format.bits - 6);
            for (0..raw.height) |y| for (0..raw.width) |x| {
                const point = transform.sourcePoint(.{ .width = h.pipeline.sensor_width, .height = h.pipeline.sensor_height }, .{ .x = x, .y = y }) catch unreachable;
                const value: u16 = @intCast(black + (point.x * 17 + point.y * 31 + i * 13) % (format.white() - black));
                std.mem.writeInt(u16, h.raw_buffers[i][y * raw.stride + x * 2 ..][0..2], value, .little);
            };
        }
        if (opts.lores_width != 0) {
            const l = h.pipeline.lores;
            const rgb = opts.lores_format == c.ZC_RGB24;
            h.lores_buffers[i] = Alloc.alloc(u8, @as(usize, l.stride) * l.height * @as(usize, if (rgb) 1 else 3) / @as(usize, if (rgb) 1 else 2)) catch {
                close(h);
                return c.ZC_NOMEM;
            };
            fillProcessed(h.lores_buffers[i], l, transform, main_source, i) catch {
                close(h);
                return c.ZC_NOMEM;
            };
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
    for (1..31) |id| if (id != c.ZC_AF_TRIGGER and id != c.ZC_AF_PAUSE) {
        h.saved[id] = h.active[id];
    };
    pipeline.* = h.pipeline;
    info.* = h.info;
    out.* = h;
    actual.* = requested_orientation;
    return c.ZC_OK;
}
pub fn start(h: *Handle) c_int {
    for (h.saved, 0..) |value, id| if (h.pending[id] == null) {
        h.pending[id] = value;
    };
    h.af_pause_state = 0;
    if (h.active[c.ZC_AF_MODE].values[0] == 2) {
        h.af_state = 1;
        h.af_steps = if (h.never_scan) 0 else 3;
    }
    return c.ZC_OK;
}
pub fn stop(h: *Handle) c_int {
    h.stop_calls += 1;
    if (h.fail_stop_once) {
        h.fail_stop_once = false;
        return c.ZC_IO;
    }
    h.pending = @splat(null);
    const refs = @import("typed_synthetic.zig").Ref;
    const saved = refs.retain(h.vendor_saved);
    refs.release(h.vendor_current);
    h.vendor_current = saved;
    h.af_steps = 0;
    h.af_state = 0;
    h.af_pause_state = 0;
    return c.ZC_OK;
}
pub fn close(h: *Handle) void {
    const refs = @import("typed_synthetic.zig").Ref;
    refs.release(h.vendor_current);
    refs.release(h.vendor_saved);
    for (h.vendor_frames) |p| refs.release(p);
    for (h.buffers[0..h.config.buffer_count]) |buf| Alloc.free(buf);
    for (h.raw_buffers[0..h.config.buffer_count]) |buf| Alloc.free(buf);
    for (h.lores_buffers[0..h.config.buffer_count]) |buf| Alloc.free(buf);
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
            const previous = h.active[id].values[0];
            h.active[id] = value;
            if (id == c.ZC_AF_MODE and value.values[0] != previous) {
                h.af_pause_state = 0;
                h.af_state = if (value.values[0] == 2) 1 else 0;
                h.af_steps = if (value.values[0] == 2 and !h.never_scan) 3 else 0;
            }
            if (id == c.ZC_AF_PAUSE and h.active[c.ZC_AF_MODE].values[0] == 2) {
                // Repeated pause commands do not resume a paused algorithm.
                if (value.values[0] == 2) {
                    if (h.af_pause_state != 0) {
                        h.af_pause_state = 0;
                        h.af_state = 1;
                        h.af_steps = if (h.never_scan) 0 else 3;
                    }
                } else if (h.af_pause_state == 0) {
                    h.af_pause_state = if (value.values[0] == 1 and h.af_state == 1) 1 else 2;
                }
            }
            if (id == c.ZC_AF_TRIGGER and h.active[c.ZC_AF_MODE].values[0] == 1) {
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
    const refs = @import("typed_synthetic.zig").Ref;
    refs.release(h.vendor_frames[index]);
    h.vendor_frames[index] = refs.retain(h.vendor_current);
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
    attachProcessed(&f.main, h.buffers[index]);
    f.sequence = h.sequence;
    h.sequence += 1;
    f.timestamp_ns = @import("capture_filter.zig").clockNs() catch return c.ZC_IO;
    f.exposure_us = @intFromFloat(h.active[c.ZC_EXPOSURE_TIME].values[0]);
    f.analogue_gain = @floatCast(h.active[c.ZC_ANALOGUE_GAIN].values[0]);
    f.red_gain = @floatCast(h.active[c.ZC_COLOUR_GAINS].values[0]);
    f.blue_gain = @floatCast(h.active[c.ZC_COLOUR_GAINS].values[1]);
    var meta = std.mem.zeroes(c.zc_metadata);
    meta.struct_size = @sizeOf(c.zc_metadata);
    meta.valid = 15 | 16 | 64;
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
    if (h.active[c.ZC_AF_MODE].values[0] == 2 and !h.omit_pause_metadata) {
        meta.valid |= 32;
        meta.af_pause_state = h.af_pause_state;
    }
    if (h.af_steps > 0 and h.af_pause_state != 2) {
        h.af_steps -= 1;
        if (h.af_steps == 0) {
            h.af_state = if (h.fail_af) 3 else 2;
            if (h.af_pause_state == 1) h.af_pause_state = 2;
        }
    }
    h.catalog_metadata[index] = meta;
    h.callback(h.context, index, &f, &meta, c.ZC_OK);
    return c.ZC_OK;
}

pub fn metadata(_: *Handle, _: u32, out: *c.zc_raw_metadata) c_int {
    out.* = std.mem.zeroes(c.zc_raw_metadata);
    out.valid = 7;
    out.black_levels = @splat(@floatFromInt(black_level));
    out.camera_to_srgb = color_matrix;
    @memcpy(out.model[0..model.len], model);
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
    if (h.fail_controls_once) {
        h.fail_controls_once = false;
        return c.ZC_IO;
    }
    if (h.revision == std.math.maxInt(u64)) return c.ZC_STATE;
    for (values[0..count]) |value| if (value.id == c.ZC_AE_ENABLE) {
        for ([_]u32{ c.ZC_EXPOSURE_TIME_MODE, c.ZC_ANALOGUE_GAIN_MODE }) |app| {
            var mode = h.saved[app].?;
            mode.values[0] = if (value.values[0] != 0) 0 else 1;
            h.pending[app] = mode;
            h.saved[app] = mode;
        }
    };
    for (values[0..count]) |value| {
        h.pending[value.id] = value;
        if (value.id != c.ZC_AF_TRIGGER and value.id != c.ZC_AF_PAUSE) h.saved[value.id] = value;
    }
    h.revision += 1;
    revision.* = h.revision;
    return c.ZC_OK;
}

const modes = [_]c.zc_sensor_mode{
    .{ .width = 640, .height = 480, .bit_depth = 12, .format = "SRGGB12".* ++ @as([25]u8, @splat(0)) },
    .{ .width = 1920, .height = 1080, .bit_depth = 10, .format = "SRGGB10".* ++ @as([25]u8, @splat(0)) },
    .{ .width = 4056, .height = 3040, .bit_depth = 12, .format = "SRGGB12".* ++ @as([25]u8, @splat(0)) },
};
pub fn sensorModes(_: *Handle, out: ?[*]c.zc_sensor_mode, capacity: u32, count: *u32) c_int {
    count.* = modes.len;
    if (out == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < modes.len) return c.ZC_INVALID;
    @memcpy(out.?[0..modes.len], &modes);
    return c.ZC_OK;
}
pub fn colorSpace(h: *Handle, stream: u32, out: *c.zc_color_space) c_int {
    if (stream > c.ZC_LORES) return c.ZC_INVALID;
    if (stream == c.ZC_RAW and h.config.raw == 0 or stream == c.ZC_LORES and h.pipeline.lores.plane_count == 0) return c.ZC_UNSUPPORTED;
    const raw = stream == c.ZC_RAW;
    out.* = .{ .struct_size = @sizeOf(c.zc_color_space), .present = 1, .primaries = if (raw) c.ZC_PRIMARIES_RAW else c.ZC_PRIMARIES_REC709, .transfer = if (raw) c.ZC_TRANSFER_LINEAR else c.ZC_TRANSFER_SRGB, .ycbcr_encoding = if ((stream == c.ZC_LORES and h.pipeline.lores.plane_count == 3) or (stream == c.ZC_MAIN and h.info.main.plane_count == 3)) c.ZC_YCBCR_REC601 else c.ZC_YCBCR_NONE, .range = c.ZC_RANGE_FULL };
    return c.ZC_OK;
}
pub fn lores(h: *Handle, index: u32, out: *c.zc_stream) c_int {
    out.* = h.pipeline.lores;
    if (out.plane_count == 0) return c.ZC_UNSUPPORTED;
    attachProcessed(out, h.lores_buffers[index]);
    return c.ZC_OK;
}

pub const discover = @import("synthetic_catalog.zig").discover;
pub fn catalog(h: *Handle, kind: u32, index: u32, sink: *const @import("catalog.zig").Sink) c_int {
    const implementation = @import("synthetic_catalog.zig");
    return switch (kind) {
        2 => implementation.properties(sink, 0),
        3 => implementation.controls(h, sink),
        4 => blk: {
            if (index >= h.info.buffer_count) break :blk c.ZC_INVALID;
            const rc = implementation.metadata(sink, h.catalog_metadata[index]);
            break :blk if (rc != 0) rc else @import("typed_synthetic.zig").metadata(h, index, sink);
        },
        else => c.ZC_INVALID,
    };
}

pub const device_id = "synthetic";
pub fn openId(config: *const c.zc_config, opts: *const c.zc_pipeline_options, main_format: u32, requested_orientation: u32, strict: bool, actual: *u32, id: []const u8, context: ?*anyopaque, callback: Callback, out: *?*Handle, info: *c.zc_info, pipeline: *c.zc_pipeline_info) c_int {
    out.* = null;
    if (!std.mem.eql(u8, id, device_id)) return c.ZC_DEVICE;
    return open(config, opts, main_format, requested_orientation, strict, actual, context, callback, out, info, pipeline);
}
pub fn cameraId(_: *Handle, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = device_id.len;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < device_id.len) return c.ZC_INVALID;
    @memcpy(data.?[0..device_id.len], device_id);
    return c.ZC_OK;
}

pub const PreparedControls = @import("typed_synthetic.zig").Prepared;
pub const prepareNative = @import("typed_synthetic.zig").prepare;
pub const commitNative = @import("typed_synthetic.zig").commit;
pub const closeNative = @import("typed_synthetic.zig").close;
