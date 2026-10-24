//! Honest virtual-device capabilities and request-local metadata for CI.
const std = @import("std");
const c = @import("abi.zig").c;
const api = @import("catalog.zig");
const Sink = api.Sink;
const b = api.bridge;
const synthetic = @import("synthetic.zig");
pub const names = [_][]const u8{ "", "AeEnable", "ExposureTime", "AnalogueGain", "ExposureValue", "AwbEnable", "ColourGains", "Brightness", "Contrast", "Saturation", "Sharpness", "FrameDurationLimits", "LensPosition", "AfMode", "AfTrigger", "AfRange", "AfSpeed", "AfMetering", "AfWindows", "ScalerCrop", "NoiseReductionMode", "AeMeteringMode", "AeExposureMode", "AwbMode", "ExposureTimeMode", "AnalogueGainMode", "AfPause", "AeConstraintMode", "ColourTemperature", "AeFlickerMode", "AeFlickerPeriod", "HdrMode" };
fn begin(s: *const Sink, group: u32, id: u32, name: []const u8, kind: u32, app_id: u32, flags: u32, extent: u32) c_int {
    const vendor = "synthetic";
    const r: b.zcd_catalog_record = .{ .group = group, .id = id, .app_id = app_id, .native_type = kind, .kind = kind, .flags = flags | 32, .extent = extent, .name = name.ptr, .name_length = name.len, .vendor = vendor.ptr, .vendor_length = vendor.len };
    return s.begin.?(s.context, &r);
}
fn value(s: *const Sink, role: u32, kind: u32, count: u32, data: []const u8, is_array: bool) c_int {
    const v: b.zcd_catalog_value = .{ .role = role, .kind = kind, .native_type = kind, .flags = (if (is_array) @as(u32, 1) else 0) | (if (@import("builtin").cpu.arch.endian() == .little) @as(u32, 2) else 0), .count = count, .data = data.ptr, .length = data.len, .label = null, .label_length = 0 };
    return s.value.?(s.context, &v);
}
fn field(s: *const Sink, group: u32, id: u32, name: []const u8, kind: u32, count: u32, data: []const u8, is_array: bool) c_int {
    var rc = begin(s, group, id, name, kind, 0, 2 | 8 | 16 | (if (is_array) @as(u32, 4) else 0), if (is_array) count else 0);
    if (rc != 0) return rc;
    rc = value(s, 0, kind, count, data, is_array);
    if (rc != 0) return rc;
    return s.end.?(s.context);
}
pub fn properties(s: *const Sink, group: u32) c_int {
    var rc = field(s, group, 1, "Model", 6, synthetic.model.len, synthetic.model, true);
    if (rc != 0) return rc;
    const size = [_]u32{ 4056, 3040 };
    rc = field(s, group, 2, "PixelArraySize", 8, 1, std.mem.asBytes(&size), false);
    if (rc != 0) return rc;
    const areas = [_]u32{ 0, 0, 4056, 3040 };
    return field(s, group, 3, "PixelArrayActiveAreas", 7, 1, std.mem.asBytes(&areas), true);
}
pub fn discover(s: *const Sink) c_int {
    const name = synthetic.device_id;
    const rc = field(s, 0, 0, "CameraId", 6, name.len, name, true);
    if (rc != 0) return rc;
    return properties(s, 0);
}
pub fn controls(h: *@import("synthetic.zig").Handle, s: *const Sink) c_int {
    for (1..names.len) |id| {
        var info: c.zc_control_info = undefined;
        var rc = @import("synthetic.zig").controlInfo(h, @intCast(id), &info);
        if (rc != 0) return rc;
        const count = info.min_count;
        const kind: u32 = if (info.type == c.ZC_BOOL) 1 else if (info.type == c.ZC_FLOAT) 5 else if (info.type == c.ZC_RECT) 7 else if (id == c.ZC_FRAME_DURATION_LIMITS) 4 else 3;
        const is_array = (count > 1 and kind != 7) or id == c.ZC_AF_WINDOWS;
        rc = begin(s, 0, @intCast(id), names[id], kind, @intCast(id), 1 | 8 | 16 | (if (is_array) @as(u32, 4) else 0), if (is_array) (if (kind == 7) std.math.maxInt(u32) else info.max_count) else 0);
        if (rc != 0) return rc;
        const ranges = [_][4]f64{ info.min, info.max, info.def };
        for (ranges, 1..) |numbers, role| {
            var data: [32]u8 = @splat(0);
            var width: usize = 4;
            const elements: usize = if (kind == 7) count / 4 else count;
            if (kind == 1) {
                width = 1;
                data[0] = @intFromBool(numbers[0] != 0);
            } else if (kind == 4) {
                width = 8;
                for (0..elements) |i| std.mem.writeInt(i64, data[i * width ..][0..8], @intFromFloat(numbers[i]), @import("builtin").cpu.arch.endian());
            } else if (kind == 7) {
                width = 16;
                for (0..4) |i| std.mem.writeInt(i32, data[i * 4 ..][0..4], @intFromFloat(numbers[i]), @import("builtin").cpu.arch.endian());
            } else for (0..elements) |i| {
                const bits: u32 = if (kind == 5) @bitCast(@as(f32, @floatCast(numbers[i]))) else @bitCast(@as(i32, @intFromFloat(numbers[i])));
                std.mem.writeInt(u32, data[i * width ..][0..4], bits, @import("builtin").cpu.arch.endian());
            }
            rc = value(s, @intCast(role), kind, @intCast(elements), data[0 .. width * elements], is_array);
            if (rc != 0) return rc;
        }
        for (0..64) |i| if (info.enum_mask & (@as(u64, 1) << @intCast(i)) != 0) {
            const val: i32 = @intCast(i);
            rc = value(s, 4, 3, 1, std.mem.asBytes(&val), false);
            if (rc != 0) return rc;
        };
        rc = s.end.?(s.context);
        if (rc != 0) return rc;
    }
    return @import("typed_synthetic.zig").capabilities(h, s);
}
pub fn metadata(s: *const Sink, m: c.zc_metadata, wallclock_ns: i64, hdr_mode: i32) c_int {
    const digital_gain: f32 = 1;
    const timestamp: i64 = @intCast(m.timestamp_ns);
    const duration: i64 = @intCast(m.frame_duration_us);
    const exposure: i32 = @intCast(m.exposure_us);
    const gains = [_]f32{ m.red_gain, m.blue_gain };
    const matrix = synthetic.color_matrix;
    const black: [4]i32 = @splat(synthetic.black_level);
    const Fields = struct { id: u32, name: []const u8, kind: u32, count: u32 = 1, data: []const u8, is_array: bool = false };
    const fields = [_]Fields{
        .{ .id = 100, .name = "SensorTimestamp", .kind = 4, .data = std.mem.asBytes(&timestamp) },
        .{ .id = 101, .name = "ExposureTime", .kind = 3, .data = std.mem.asBytes(&exposure) },
        .{ .id = 102, .name = "AnalogueGain", .kind = 5, .data = std.mem.asBytes(&m.analogue_gain) },
        .{ .id = 103, .name = "ColourGains", .kind = 5, .count = 2, .data = std.mem.asBytes(&gains), .is_array = true },
        .{ .id = 104, .name = "LensPosition", .kind = 5, .data = std.mem.asBytes(&m.lens_position) },
        .{ .id = 105, .name = "FrameDuration", .kind = 4, .data = std.mem.asBytes(&duration) },
        .{ .id = 106, .name = "ScalerCrop", .kind = 7, .data = std.mem.asBytes(&m.crop) },
        .{ .id = 107, .name = "AfState", .kind = 3, .data = std.mem.asBytes(&m.af_state) },
        .{ .id = 108, .name = "ColourCorrectionMatrix", .kind = 5, .count = 9, .data = std.mem.asBytes(&matrix), .is_array = true },
        .{ .id = 109, .name = "SensorBlackLevels", .kind = 3, .count = 4, .data = std.mem.asBytes(&black), .is_array = true },
        .{ .id = 111, .name = "DigitalGain", .kind = 5, .data = std.mem.asBytes(&digital_gain) },
        .{ .id = 112, .name = "FrameWallClock", .kind = 4, .data = std.mem.asBytes(&wallclock_ns) },
        .{ .id = 113, .name = "SyntheticHdrMode", .kind = 3, .data = std.mem.asBytes(&hdr_mode) },
        .{ .id = 0xf0000001, .name = "SyntheticOpaque", .kind = 255, .count = 2, .data = &.{ 0, 255, 127 }, .is_array = true },
    };
    for (fields) |f| {
        const rc = field(s, 0, f.id, f.name, f.kind, f.count, f.data, f.is_array);
        if (rc != 0) return rc;
    }
    if (m.valid & 32 != 0) return field(s, 0, 110, "AfPauseState", 3, 1, std.mem.asBytes(&m.af_pause_state), false);
    return c.ZC_OK;
}
