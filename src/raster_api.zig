//! Synchronous borrowed pixels, checked Home conversion/encoding, owned blobs.
const std = @import("std");
const c = @import("abi.zig").c;
const pixel = @import("home/pixel_view.zig");
const resample = @import("home/pixel_resample.zig");
const still = @import("still.zig");
const files = @import("image_file.zig");
const exif = @import("exif.zig");
const A = std.heap.c_allocator;
const maximum = 256 * 1024 * 1024;
pub fn read(source: ?*const c.zc_raster) !pixel.View {
    const value = source orelse return error.InvalidOptions;
    if (value.struct_size != @sizeOf(c.zc_raster) or value.format > 2 or value.big_endian > 1 or (value.bits != 8 and value.bits != 16) or value.stride > std.math.maxInt(usize) or value.length > std.math.maxInt(usize) or value.data == null) return error.InvalidOptions;
    const view = pixel.View{ .data = value.data[0..@intCast(value.length)], .width = value.width, .height = value.height, .stride = @intCast(value.stride), .format = @enumFromInt(value.format), .bits = @intCast(value.bits), .endian = if (value.big_endian == 1) .big else .little };
    const row = try view.validate();
    const size = std.math.mul(usize, row, view.height) catch return error.InvalidGeometry;
    if (size > maximum) return error.InvalidGeometry;
    return view;
}
fn copy(source: pixel.View, format: u32, bits: u32, big: u32, output: ?[*]u8, capacity: u64, length: *u64) c_int {
    if (format > 2 or (bits != 8 and bits != 16) or big > 1) return c.ZC_INVALID;
    const kind: pixel.Format = @enumFromInt(format);
    const row = pixel.packedRow(source.width, kind, @intCast(bits)) catch return c.ZC_INVALID;
    const size = std.math.mul(usize, row, source.height) catch return c.ZC_INVALID;
    if (size > maximum) return c.ZC_INVALID;
    length.* = size;
    const data = output orelse return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < size) return c.ZC_INVALID;
    source.convert(data[0..size], row, kind, @intCast(bits), if (big == 1) .big else .little) catch |err| return still.status(err);
    return c.ZC_OK;
}
pub export fn zc_raster_convert(source: ?*const c.zc_raster, format: u32, bits: u32, big: u32, output: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    return copy(read(source) catch |err| return still.status(err), format, bits, big, output, capacity, length);
}
pub export fn zc_raster_crop(source: ?*const c.zc_raster, x: u32, y: u32, width: u32, height: u32, output: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    const view = read(source) catch |err| return still.status(err);
    const region = view.crop(x, y, width, height) catch |err| return still.status(err);
    return copy(region, @intFromEnum(view.format), view.bits, @intFromBool(view.endian == .big), output, capacity, length);
}
pub export fn zc_raster_pixel16(source: ?*const c.zc_raster, x: u32, y: u32, output: *[4]u16) c_int {
    const view = read(source) catch |err| return still.status(err);
    if (x >= view.width or y >= view.height) return c.ZC_INVALID;
    output.* = view.sample16(x, y);
    return c.ZC_OK;
}
pub export fn zc_raster_resize(source: ?*const c.zc_raster, width: u32, height: u32, algorithm: u32, output: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    if (algorithm > @intFromEnum(resample.Algorithm.lanczos3)) return c.ZC_INVALID;
    const filter: resample.Algorithm = @enumFromInt(algorithm);
    const view = read(source) catch |err| return still.status(err);
    const size = resample.checkedSize(view, width, height, filter, .{}) catch |err| return still.status(err);
    length.* = size;
    const data = output orelse return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < size) return c.ZC_INVALID;
    const row = pixel.packedRow(width, view.format, view.bits) catch unreachable;
    resample.into(A, view, data[0..size], width, height, row, filter, .{}) catch |err| return still.status(err);
    return c.ZC_OK;
}
pub export fn zc_raster_transform(source: ?*const c.zc_raster, orientation: u32, output: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    const oriented = @import("home/oriented_pixels.zig");
    const transform = oriented.Transform.fromOrientation(orientation) catch return c.ZC_INVALID;
    const view = read(source) catch |err| return still.status(err);
    const planned = oriented.info(view, transform) catch |err| return still.status(err);
    if (planned.size > maximum) return c.ZC_INVALID;
    length.* = planned.size;
    const data = output orelse return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < planned.size) return c.ZC_INVALID;
    oriented.into(view, transform, data[0..planned.size], planned.row_bytes) catch |err| return still.status(err);
    return c.ZC_OK;
}
fn validated(source: ?*const c.zc_raster, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, color: ?*const c.zc_color_space) !pixel.View {
    const view = try read(source);
    if (options.format == c.ZC_IMAGE_PPM or options.format == c.ZC_IMAGE_BMP) {
        const channels: usize = if (options.format == c.ZC_IMAGE_BMP and view.format == .rgba) 4 else 3;
        const row = @as(usize, view.width) * channels * (if (options.format == c.ZC_IMAGE_PPM) @as(usize, view.bits / 8) else 1);
        const stride = if (options.format == c.ZC_IMAGE_BMP) std.mem.alignForward(usize, row, 4) else row;
        const span = std.math.mul(usize, stride, view.height) catch return error.InvalidGeometry;
        if (span > maximum) return error.InvalidGeometry;
    }
    try still.checkProfile(options, profile);
    try exif.check(options, metadata);
    if (metadata) |value| if (value.flags & c.ZC_IMAGE_EXIF_CAPTURE != 0) return error.UnsupportedFormat;
    var space = std.mem.zeroes(c.zc_color_space);
    if (color) |value| {
        if (value.struct_size != @sizeOf(c.zc_color_space) or value.present > 1 or value.primaries > c.ZC_PRIMARIES_REC2020 or value.transfer > c.ZC_TRANSFER_REC709 or value.ycbcr_encoding > c.ZC_YCBCR_REC2020 or value.range > c.ZC_RANGE_LIMITED) return error.InvalidOptions;
        space = value.*;
    }
    try still.checkProfileSource(profile, space);
    return view;
}
fn encoded(source: ?*const c.zc_raster, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, color: ?*const c.zc_color_space) ![]u8 {
    const view = try validated(source, options, profile, metadata, color);
    const bytes = try still.encodeRasterMetadata(A, view, options, profile, exif.bytes(metadata));
    if (bytes.len > maximum) {
        A.free(bytes);
        return error.InvalidGeometry;
    }
    return bytes;
}
pub export fn zc_raster_encode_async(source: ?*const c.zc_raster, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, color: ?*const c.zc_color_space, limits: ?*const c.zc_image_job_limits, file: ?*c.zc_image_file, output: *?*c.zc_image_job) c_int {
    output.* = null;
    const view = validated(source, options, profile, metadata, color) catch |err| return still.status(err);
    return @import("image_job.zig").submitRaster(view, options, profile, metadata, limits, file, output);
}
pub export fn zc_raster_encode(source: ?*const c.zc_raster, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, color: ?*const c.zc_color_space, output: *?*c.zc_image_blob) c_int {
    output.* = null;
    const bytes = encoded(source, options, profile, metadata, color) catch |err| return still.status(err);
    const blob = A.create(still.Blob) catch {
        A.free(bytes);
        return c.ZC_NOMEM;
    };
    blob.* = .{ .bytes = bytes };
    output.* = @ptrCast(blob);
    return c.ZC_OK;
}
pub export fn zc_raster_save(source: ?*const c.zc_raster, path: [*:0]const u8, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, color: ?*const c.zc_color_space) c_int {
    const text = std.mem.span(path);
    if (text.len == 0 or text.len > 4096) return c.ZC_INVALID;
    const bytes = encoded(source, options, profile, metadata, color) catch |err| return still.status(err);
    defer A.free(bytes);
    var file = std.fs.cwd().atomicFile(text, .{ .write_buffer = &.{} }) catch return c.ZC_IO;
    defer file.deinit();
    file.file_writer.file.writeAll(bytes) catch return c.ZC_IO;
    file.finish() catch return c.ZC_IO;
    return c.ZC_OK;
}
pub export fn zc_image_file_prepare_raster(output: *c.zc_image_file, source: ?*const c.zc_raster, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, color: ?*const c.zc_color_space) c_int {
    const rc = files.begin(output);
    if (rc != 0) return rc;
    const bytes = encoded(source, options, profile, metadata, color) catch |err| return files.prepared(output, still.status(err));
    defer A.free(bytes);
    return files.prepared(output, files.write(output, bytes));
}
test "raster ABI validates descriptors bounds caps and overlap before prefix writes" {
    const t = std.testing;
    var data: [32]u8 = @splat(73);
    var raster = c.zc_raster{ .struct_size = @sizeOf(c.zc_raster), .width = 2, .height = 2, .format = 1, .bits = 8, .big_endian = 0, .stride = 7, .length = 13, .data = &data };
    var size: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_raster_convert(&raster, 2, 16, 1, null, 0, &size));
    try t.expectEqual(@as(u64, 32), size);
    var out: [40]u8 = @splat(91);
    try t.expectEqual(c.ZC_INVALID, zc_raster_convert(&raster, 2, 16, 1, &out, 31, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_convert(&raster, 1, 8, 0, &data, data.len, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_crop(&raster, 1, 0, 2, 1, &out, out.len, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_convert(null, 1, 8, 0, &out, out.len, &size));
    raster.length = 12;
    try t.expectEqual(c.ZC_INVALID, zc_raster_convert(&raster, 1, 8, 0, &out, out.len, &size));
    for (data) |value| try t.expectEqual(@as(u8, 73), value);
    for (out) |value| try t.expectEqual(@as(u8, 91), value);
}
test "raster resizing queries geometry and working limits before touching outputs" {
    const t = std.testing;
    var input: [12]u8 = @splat(99);
    const source = c.zc_raster{ .struct_size = @sizeOf(c.zc_raster), .width = 2, .height = 2, .format = 0, .bits = 8, .big_endian = 0, .stride = 2, .length = input.len, .data = &input };
    var out: [12]u8 = @splat(73);
    var size: u64 = 99;
    try t.expectEqual(c.ZC_OK, zc_raster_resize(&source, 3, 2, c.ZC_RESAMPLE_BICUBIC, null, 0, &size));
    try t.expectEqual(@as(u64, 6), size);
    try t.expectEqual(c.ZC_INVALID, zc_raster_resize(&source, 3, 2, 5, &out, out.len, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_resize(&source, 3, 2, 0, &out, 5, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_resize(&source, 3, 2, 0, &input, input.len, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_resize(&source, 0x7fffffff, 2, 0, null, 0, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_resize(&source, 3000000, 1, 1, null, 0, &size));
    for (out) |v| try t.expectEqual(@as(u8, 73), v);
    for (input) |v| try t.expectEqual(@as(u8, 99), v);
}

test "orthogonal raster ABI validates full spans caps and overlap before writing prefixes" {
    const t = std.testing;
    var data: [40]u8 = @splat(33);
    var source = c.zc_raster{ .struct_size = @sizeOf(c.zc_raster), .width = 3, .height = 2, .format = 1, .bits = 16, .big_endian = 1, .stride = 19, .length = 37, .data = &data };
    var output: [40]u8 = @splat(73);
    var size: u64 = 999;
    try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, 0, &output, output.len, &size));
    try t.expectEqual(@as(u64, 0), size);
    try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, 9, &output, output.len, &size));
    try t.expectEqual(c.ZC_INVALID, zc_raster_transform(null, 1, &output, output.len, &size));
    for (1..9) |orientation| {
        try t.expectEqual(c.ZC_OK, zc_raster_transform(&source, @intCast(orientation), null, 0, &size));
        try t.expectEqual(@as(u64, 36), size);
        try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, @intCast(orientation), &output, 35, &size));
        try t.expectEqual(@as(u64, 36), size);
        try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, @intCast(orientation), &data, data.len, &size));
    }
    try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, 1, null, 1, &size));
    source.length = 36;
    try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, 1, &output, output.len, &size));
    try t.expectEqual(@as(u64, 0), size);
    source.length = 37;
    source.height = 0x10000000;
    try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, 1, &output, output.len, &size));
    source.height = 2;
    source.big_endian = 2;
    try t.expectEqual(c.ZC_INVALID, zc_raster_transform(&source, 1, &output, output.len, &size));
    try t.expect(std.mem.allEqual(u8, &output, 73));
    try t.expect(std.mem.allEqual(u8, &data, 33));
}
