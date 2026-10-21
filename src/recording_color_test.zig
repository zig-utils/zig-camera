//! Profile recipe ownership, failure atomicity and producer admission boundaries.
const std = @import("std");
const c = @import("abi.zig").c;
const m = @import("media.zig");
const v = @import("video.zig");
const profile = @import("recording_color.zig");
const colors = @import("color_policy.zig");
const t = std.testing;
test "recording profile validates every component without conflating MJPEG with AVC or HEVC" {
    var cfg: c.zc_video_config = undefined;
    m.zc_default_video_config(&cfg);
    try t.expectEqual(c.ZC_OK, m.zc_video_check_color(&cfg, null));
    var space = profile.legacy();
    cfg.codec = c.ZC_MJPEG;
    try t.expectEqual(c.ZC_UNSUPPORTED, m.zc_video_check_color(&cfg, &space));
    for ([_]u32{ c.ZC_H264, c.ZC_HEVC }) |codec| {
        cfg.codec = codec;
        for ([_]u32{ c.ZC_COLOR_SYCC, c.ZC_COLOR_SMPTE170M, c.ZC_COLOR_REC709, c.ZC_COLOR_REC2020 }) |preset| {
            try t.expectEqual(c.ZC_OK, colors.zc_color_space_preset(preset, &space));
            try t.expectEqual(c.ZC_OK, m.zc_video_check_color(&cfg, &space));
            const signal = try profile.encoder(space);
            const container = try profile.container(space);
            try t.expectEqual(signal.primaries, container.primaries);
            try t.expectEqual(signal.transfer, container.transfer);
            try t.expectEqual(signal.matrix, container.matrix);
            try t.expectEqual(signal.full_range != 0, container.full_range);
        }
        inline for (.{ "struct_size", "present", "primaries", "transfer", "ycbcr_encoding", "range" }) |field| {
            var bad = profile.legacy();
            @field(bad, field) = 0;
            try t.expectEqual(c.ZC_INVALID, m.zc_video_check_color(&cfg, &bad));
        }
        _ = colors.zc_color_space_preset(c.ZC_COLOR_SRGB, &space);
        try t.expectEqual(c.ZC_INVALID, m.zc_video_check_color(&cfg, &space));
    }
    cfg.codec = 0;
    try t.expectEqual(c.ZC_INVALID, m.zc_video_check_color(&cfg, null));
}
test "native profile recipes copy inputs, reject before producer PCM admission and forbid mutation after attachment" {
    if (!@import("options").codecs) return error.SkipZigTest;
    var cfg: c.zc_video_config = undefined;
    m.zc_default_video_config(&cfg);
    cfg.codec = c.ZC_H264;
    cfg.width = 32;
    cfg.height = 24;
    var opts = v.defaultRecordingOptions();
    opts.sample_rate = 48000;
    opts.channels = 2;
    var rec: ?*c.zc_recorder = null;
    try t.expectEqual(c.ZC_OK, m.zc_video_create(&cfg, &opts, 0, &rec));
    defer _ = m.zc_video_close(rec.?);
    var requested: c.zc_color_space = undefined;
    _ = colors.zc_color_space_preset(c.ZC_COLOR_REC2020, &requested);
    const expected = requested;
    try t.expectEqual(c.ZC_OK, m.zc_video_set_color(rec.?, &requested));
    requested.transfer = c.ZC_TRANSFER_LINEAR;
    var actual: c.zc_color_space = undefined;
    try t.expectEqual(c.ZC_OK, m.zc_video_get_color(rec.?, &actual));
    try t.expect(profile.eql(expected, actual));
    requested.present = 0;
    try t.expectEqual(c.ZC_INVALID, m.zc_video_set_color(rec.?, &requested));
    try t.expectEqual(c.ZC_OK, m.zc_video_get_color(rec.?, &actual));
    try t.expect(profile.eql(expected, actual));
    var pixels: [32 * 24 * 3]u8 = @splat(100);
    var frame = std.mem.zeroes(c.zc_frame);
    frame.token = 1;
    frame.main.width = 32;
    frame.main.height = 24;
    frame.main.stride = 96;
    frame.main.plane_count = 1;
    @memcpy(frame.main.format[0..6], "BGR888");
    frame.main.planes[0] = .{ .fd = -1, .offset = 0, .length = pixels.len, .bytes_used = pixels.len, .data = &pixels };
    var pcm: [1920 * 4]u8 = @splat(0);
    const block = c.zc_producer_audio_input{ .data = &pcm, .length = pcm.len, .timestamp_ns = 0 };
    var job: ?*c.zc_producer_job = @ptrFromInt(16);
    // Legacy untagged RGB is sRGB/Rec.709; it cannot be silently relabeled 2020.
    try t.expectEqual(c.ZC_UNSUPPORTED, m.zc_video_producer_av(rec.?, &frame, 0, @ptrCast(&block), 1, &job));
    try t.expect(job == null);
    var stats: c.zc_recording_stats = undefined;
    _ = m.zc_video_recording_stats(rec.?, &stats);
    try t.expectEqual(@as(u64, 0), stats.audio_frames);
    // No producer was allocated by rejected admission, so a pristine reset works.
    try t.expectEqual(c.ZC_OK, m.zc_video_set_color(rec.?, null));
    var source = expected;
    source.ycbcr_encoding = c.ZC_YCBCR_NONE;
    source.range = c.ZC_RANGE_FULL;
    try t.expectEqual(c.ZC_UNSUPPORTED, m.zc_video_check_input_color_for(&source, c.ZC_RGB24, null));
    try t.expectEqual(c.ZC_OK, m.zc_video_check_input_color_for(&source, c.ZC_RGB24, &expected));
    try t.expectEqual(c.ZC_OK, m.zc_video_set_color(rec.?, &expected));
    // Immutable profile is copied into the attached MP4 before any input.
    var dir = t.tmpDir(.{});
    defer dir.cleanup();
    const absolute = try dir.dir.realpathAlloc(t.allocator, ".");
    defer t.allocator.free(absolute);
    const path = try std.fmt.allocPrintSentinel(t.allocator, "{s}/profile.mp4", .{absolute}, 0);
    defer t.allocator.free(path);
    try t.expectEqual(c.ZC_OK, m.zc_video_open_output(rec.?, path));
    try t.expectEqual(c.ZC_BUSY, m.zc_video_set_color(rec.?, null));
    const bytes = try dir.dir.readFileAlloc(t.allocator, "profile.mp4", 16384);
    defer t.allocator.free(bytes);
    const at = std.mem.indexOf(u8, bytes, "nclx") orelse return error.MissingNclx;
    try t.expectEqualSlices(u8, &.{ 0, 9, 0, 1, 0, 9, 0 }, bytes[at + 4 ..][0..7]);
}
