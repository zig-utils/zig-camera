//! Pixel-component admission for explicit physical plane imports. Home owns
//! range/identity/whole-object policy; this host supplies linear format minima.
const std = @import("std");
const c = @import("abi.zig").c;
const Home = @import("home/capture_backing.zig");
pub fn decode(input: *const c.zc_capture_import_frame) !Home.ImportFrame {
    if (input.struct_size != @sizeOf(c.zc_capture_import_frame) or input.plane_count == 0 or input.plane_count > 4) return error.InvalidResource;
    var planes: [4]Home.ImportPlane = undefined;
    for (input.planes[0..input.plane_count], 0..) |plane, p| {
        if (plane.reserved != 0 or plane.fd < 0 or plane.length == 0 or plane.length > std.math.maxInt(u32) or
            plane.offset > std.math.maxInt(u32) - plane.length) return error.InvalidResource;
        planes[p] = .{ .fd = plane.fd, .offset = plane.offset, .bytes = plane.length };
    }
    return Home.ImportFrame.init(planes[0..input.plane_count]);
}
pub fn validate(stream: *const Home.policy.Stream, frame: *const Home.ImportFrame) !void {
    if (frame.plane_count == 0 or frame.plane_count > 4) return error.InvalidResource;
    if (frame.plane_count == 1) {
        if (frame.planes[0].bytes < stream.frame_bytes) return error.InvalidResource;
        return;
    }
    if (stream.modifier != 0) return error.Unsupported;
    const name = std.mem.sliceTo(&stream.format, 0);
    const semi = std.mem.eql(u8, name, "NV12") or std.mem.eql(u8, name, "NV21");
    const planar = std.mem.eql(u8, name, "YUV420") or std.mem.eql(u8, name, "YVU420");
    if ((!semi and !planar) or frame.plane_count != @as(u8, if (semi) 2 else 3)) return error.Unsupported;
    if ((stream.width | stream.height | stream.stride) & 1 != 0 or stream.stride < stream.width) return error.InvalidResource;
    const y = @as(u64, stream.stride) * stream.height;
    const chroma = y / @as(u64, if (semi) 2 else 4);
    if (frame.planes[0].bytes < y) return error.InvalidResource;
    for (frame.planes[1..frame.plane_count]) |plane| if (plane.bytes < chroma) return error.InvalidResource;
}

test "separate linear components validate their individual row minima and reject unrelated layouts" {
    const t = std.testing;
    var stream = try Home.policy.Stream.init(8, 4, 8, 48, 2, "YUV420", 0);
    var frame = try Home.ImportFrame.init(&.{ .{ .fd = 1, .bytes = 32 }, .{ .fd = 2, .bytes = 8 }, .{ .fd = 3, .bytes = 8 } });
    try validate(&stream, &frame);
    frame.planes[1].bytes = 7;
    try t.expectError(error.InvalidResource, validate(&stream, &frame));
    frame.planes[1].bytes = 8;
    stream.modifier = 1;
    try t.expectError(error.Unsupported, validate(&stream, &frame));
    stream = try Home.policy.Stream.init(8, 4, 8, 48, 2, "NV21", 0);
    try t.expectError(error.Unsupported, validate(&stream, &frame));
    frame = try Home.ImportFrame.init(&.{ .{ .fd = 1, .bytes = 32 }, .{ .fd = 2, .bytes = 16 } });
    try validate(&stream, &frame);
    stream.height = 3;
    try t.expectError(error.InvalidResource, validate(&stream, &frame));
    stream = try Home.policy.Stream.init(8, 4, 8, 48, 2, "SRGGB12", 0);
    try t.expectError(error.Unsupported, validate(&stream, &frame));
}
test "plane frame ABI checks sizes, reserved fields, counts and SDK end ranges before import" {
    const t = std.testing;
    try t.expectEqual(@as(usize, 24), @sizeOf(c.zc_capture_import_plane));
    try t.expectEqual(@as(usize, 104), @sizeOf(c.zc_capture_import_frame));
    var input = std.mem.zeroes(c.zc_capture_import_frame);
    input.struct_size = @sizeOf(c.zc_capture_import_frame);
    input.plane_count = 1;
    input.planes[0] = .{ .fd = 1, .reserved = 0, .offset = 4093, .length = 16 };
    _ = try decode(&input);
    input.planes[0].reserved = 1;
    try t.expectError(error.InvalidResource, decode(&input));
    input.planes[0].reserved = 0;
    input.planes[0].offset = std.math.maxInt(u64);
    try t.expectError(error.InvalidResource, decode(&input));
    input.plane_count = 5;
    try t.expectError(error.InvalidResource, decode(&input));
}
