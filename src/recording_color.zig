//! One copied recording description shared by sample conversion and VUI/nclx.
//! Gamut/transfer must already match input; matrix/range conversion is explicit.
const c = @import("abi.zig").c;
const policy = @import("color_policy.zig");
const yuv = @import("home/yuv_rgb.zig");
pub fn legacy() c.zc_color_space {
    return policy.toSpace(.{ .primaries = .rec709, .transfer = .srgb, .matrix = .rec601, .range = .limited });
}
pub fn description(value: c.zc_color_space) !policy.home.Description {
    const result = policy.fromSpace(value) orelse return error.InvalidConfiguration;
    _ = result.signal() catch return error.InvalidConfiguration;
    return result;
}
pub fn eql(a: c.zc_color_space, b: c.zc_color_space) bool {
    const left = policy.fromSpace(a) orelse return false;
    const right = policy.fromSpace(b) orelse return false;
    return left.eql(right);
}
pub fn checkConfig(config: c.zc_video_config, value: ?c.zc_color_space) !void {
    if (value) |color| {
        _ = try description(color);
        if (config.codec == c.ZC_MJPEG) return error.Unsupported;
    }
    if (config.codec != c.ZC_H264 and config.codec != c.ZC_HEVC and config.codec != c.ZC_MJPEG) return error.InvalidConfiguration;
}
pub fn encoder(value: c.zc_color_space) !@import("home/native_encoder.zig").Color {
    const signal = try (try description(value)).signal();
    return .{ .primaries = signal.primaries, .transfer = signal.transfer, .matrix = signal.matrix, .full_range = @intFromBool(signal.full_range) };
}
pub fn container(value: c.zc_color_space) !@import("home/mp4_stream.zig").Color {
    const signal = try (try description(value)).signal();
    return .{ .primaries = signal.primaries, .transfer = signal.transfer, .matrix = signal.matrix, .full_range = signal.full_range };
}
pub fn matrix(value: c.zc_color_space) !yuv.Matrix {
    return switch ((try description(value)).matrix) {
        .rec601 => .bt601,
        .rec709 => .bt709,
        .rec2020 => .bt2020,
        .none => unreachable,
    };
}
pub fn range(value: c.zc_color_space) !yuv.Range {
    return if ((try description(value)).range == .full) .full else .limited;
}
pub fn conversion(value: c.zc_color_space) !yuv.Conversion {
    return yuv.Conversion.init(try matrix(value), try range(value));
}
test {
    _ = @import("recording_color_test.zig");
}
