//! Owned image encoding over validated, externally leased capture planes.
const std = @import("std");
const c = @import("abi.zig").c;
const raster = @import("home/raster_encoder.zig");
pub const PngFilter = raster.Filter;
pub const Blob = struct { bytes: []u8 };
pub fn formatFromName(name: []const u8) !u32 {
    inline for (.{ .{ "jpg", c.ZC_IMAGE_JPEG }, .{ "jpeg", c.ZC_IMAGE_JPEG }, .{ "png", c.ZC_IMAGE_PNG }, .{ "bmp", c.ZC_IMAGE_BMP }, .{ "tif", c.ZC_IMAGE_TIFF }, .{ "tiff", c.ZC_IMAGE_TIFF }, .{ "ppm", c.ZC_IMAGE_PPM }, .{ "dng", c.ZC_IMAGE_DNG } }) |entry| {
        if (std.ascii.eqlIgnoreCase(name, entry[0])) return entry[1];
    }
    return error.UnsupportedFormat;
}
pub fn formatFromPath(path: []const u8) !u32 {
    const dot = std.mem.lastIndexOfScalar(u8, path, '.') orelse return error.UnsupportedFormat;
    return formatFromName(path[dot + 1 ..]);
}
pub fn valid(options: *const c.zc_image_options) bool {
    return options.struct_size == @sizeOf(c.zc_image_options) and options.format >= c.ZC_IMAGE_JPEG and options.format <= c.ZC_IMAGE_DNG and options.png_compression <= 9 and options.png_filter <= c.ZC_PNG_PAETH and (options.format != c.ZC_IMAGE_JPEG or (options.quality >= 1 and options.quality <= 100));
}
pub fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.UnsupportedFormat, error.MissingCalibration => c.ZC_UNSUPPORTED,
        error.CompressionFailed => c.ZC_IO,
        else => c.ZC_INVALID,
    };
}
const Buffer = struct {
    allocator: std.mem.Allocator,
    bytes: std.ArrayList(u8) = .empty,
    pub fn writeAll(self: *Buffer, bytes: []const u8) !void {
        try self.bytes.appendSlice(self.allocator, bytes);
    }
};
pub fn encode(allocator: std.mem.Allocator, frame: *const c.zc_frame, raw_metadata: ?*const c.zc_raw_metadata, options: *const c.zc_image_options) ![]u8 {
    if (!valid(options)) return error.InvalidOptions;
    if (options.format == c.ZC_IMAGE_DNG) {
        var buffer = Buffer{ .allocator = allocator };
        errdefer buffer.bytes.deinit(allocator);
        try @import("dng.zig").write(allocator, frame, raw_metadata orelse return error.MissingCalibration, &buffer);
        return buffer.bytes.toOwnedSlice(allocator);
    }
    const stream = frame.main;
    if (stream.plane_count != 1 or !std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR888")) return error.UnsupportedFormat;
    const plane = stream.planes[0];
    if (plane.bytes_used > plane.length or plane.bytes_used > std.math.maxInt(usize)) return error.BufferTooSmall;
    const view = raster.View{ .data = plane.data[0..@intCast(plane.bytes_used)], .width = stream.width, .height = stream.height, .stride = stream.stride };
    const row_bytes = try view.validate();
    return switch (options.format) {
        c.ZC_IMAGE_PNG => raster.png(allocator, view, .{ .compression = options.png_compression, .filter = @enumFromInt(options.png_filter) }),
        c.ZC_IMAGE_BMP => raster.bmp(allocator, view),
        c.ZC_IMAGE_TIFF => raster.tiff(allocator, view),
        c.ZC_IMAGE_JPEG => block: {
            var encoder = @import("home/jpeg_encoder.zig").Encoder.init(allocator);
            defer encoder.deinit();
            const bytes = try encoder.encode(view.data, view.width, view.height, view.stride, 3, @intCast(options.quality));
            break :block allocator.dupe(u8, bytes);
        },
        c.ZC_IMAGE_PPM => block: {
            var buffer = Buffer{ .allocator = allocator };
            errdefer buffer.bytes.deinit(allocator);
            var text: [64]u8 = undefined;
            try buffer.writeAll(try std.fmt.bufPrint(&text, "P6\n{d} {d}\n255\n", .{ view.width, view.height }));
            for (0..view.height) |y| try buffer.writeAll(view.data[y * view.stride ..][0..row_bytes]);
            break :block buffer.bytes.toOwnedSlice(allocator);
        },
        else => error.UnsupportedFormat,
    };
}
