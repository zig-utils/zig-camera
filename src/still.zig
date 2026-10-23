//! Owned image encoding over validated, externally leased capture planes.
const std = @import("std");
const c = @import("abi.zig").c;
const raster = @import("home/raster_encoder.zig");
pub const PngFilter = raster.Filter;
pub const Blob = struct { bytes: []u8 };
pub fn checkProfile(options: *const c.zc_image_options, profile: ?*const c.zc_image_profile) !void {
    if (!valid(options)) return error.InvalidOptions;
    const p = profile orelse return;
    if (options.format != c.ZC_IMAGE_JPEG and options.format != c.ZC_IMAGE_PNG and options.format != c.ZC_IMAGE_TIFF) return error.UnsupportedFormat;
    if (p.struct_size != @sizeOf(c.zc_image_profile)) return error.InvalidOptions;
    if (p.flags == c.ZC_IMAGE_PROFILE_SRGB) {
        if (p.data != null or p.length != 0) return error.InvalidOptions;
    } else if (p.flags == 0) {
        if (p.data == null or p.length == 0 or p.length > @import("home/metadata/icc_layout.zig").max_bytes) return error.InvalidOptions;
        if (options.format == c.ZC_IMAGE_JPEG and p.length > 65519 * 255) return error.MetadataTooLarge;
        _ = try @import("home/metadata/icc_layout.zig").validateRgb(p.data[0..@intCast(p.length)]);
    } else return error.InvalidOptions;
}
pub fn checkProfileSource(profile: ?*const c.zc_image_profile, space: c.zc_color_space) !void {
    if (profile) |p| if (p.flags == c.ZC_IMAGE_PROFILE_SRGB and (space.present != 1 or space.primaries != c.ZC_PRIMARIES_REC709 or space.transfer != c.ZC_TRANSFER_SRGB)) return error.UnsupportedProfile;
}
pub fn embedProfile(allocator: std.mem.Allocator, options: *const c.zc_image_options, profile: *const c.zc_image_profile, bytes: []const u8) ![]u8 {
    const generated = if (profile.flags == c.ZC_IMAGE_PROFILE_SRGB) try @import("home/metadata/icc.zig").createSRGBProfile(allocator) else null;
    defer if (generated) |data| allocator.free(data);
    return @import("home/metadata_embed.zig").embed(allocator, switch (options.format) {
        c.ZC_IMAGE_JPEG => .jpeg,
        c.ZC_IMAGE_PNG => .png,
        c.ZC_IMAGE_TIFF => .tiff,
        else => return error.UnsupportedFormat,
    }, bytes, generated orelse profile.data[0..@intCast(profile.length)]);
}
pub fn formatFromName(name: []const u8) !u32 {
    inline for (.{ .{ "jpg", c.ZC_IMAGE_JPEG }, .{ "jpeg", c.ZC_IMAGE_JPEG }, .{ "png", c.ZC_IMAGE_PNG }, .{ "bmp", c.ZC_IMAGE_BMP }, .{ "tif", c.ZC_IMAGE_TIFF }, .{ "tiff", c.ZC_IMAGE_TIFF }, .{ "ppm", c.ZC_IMAGE_PPM }, .{ "dng", c.ZC_IMAGE_DNG }, .{ "gif", c.ZC_IMAGE_GIF } }) |entry| {
        if (std.ascii.eqlIgnoreCase(name, entry[0])) return entry[1];
    }
    return error.UnsupportedFormat;
}
pub fn formatFromPath(path: []const u8) !u32 {
    const dot = std.mem.lastIndexOfScalar(u8, path, '.') orelse return error.UnsupportedFormat;
    return formatFromName(path[dot + 1 ..]);
}
pub fn valid(options: *const c.zc_image_options) bool {
    return options.struct_size == @sizeOf(c.zc_image_options) and options.format >= c.ZC_IMAGE_JPEG and options.format <= c.ZC_IMAGE_GIF and options.png_compression <= 9 and options.png_filter <= c.ZC_PNG_PAETH and (options.format != c.ZC_IMAGE_JPEG or (options.quality >= 1 and options.quality <= 100));
}
pub fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.UnsupportedFormat, error.MissingCalibration, error.UnsupportedProfile => c.ZC_UNSUPPORTED,
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
    return encodeMetadata(allocator, frame, raw_metadata, options, null, null);
}
pub fn encodeMetadata(allocator: std.mem.Allocator, frame: *const c.zc_frame, raw_metadata: ?*const c.zc_raw_metadata, options: *const c.zc_image_options, profile: ?*const c.zc_image_profile, exif: ?[]const u8) ![]u8 {
    try checkProfile(options, profile);
    if (exif != null and options.format != c.ZC_IMAGE_JPEG and options.format != c.ZC_IMAGE_PNG and options.format != c.ZC_IMAGE_TIFF) return error.UnsupportedFormat;
    const generated = if (profile != null and profile.?.flags == c.ZC_IMAGE_PROFILE_SRGB) try @import("home/metadata/icc.zig").createSRGBProfile(allocator) else null;
    defer if (generated) |data| allocator.free(data);
    const metadata: @import("home/jpeg_metadata.zig").Metadata = .{ .icc = generated orelse if (profile) |p| p.data[0..@intCast(p.length)] else null, .exif = exif };
    if (options.format == c.ZC_IMAGE_JPEG) return encodePixels(allocator, frame, raw_metadata, options, metadata);
    if (metadata.icc == null and metadata.exif == null) return encodePixels(allocator, frame, raw_metadata, options, .{});
    const format: @import("home/metadata_embed.zig").Format = if (options.format == c.ZC_IMAGE_PNG) .png else .tiff;
    _ = try @import("home/metadata_embed.zig").check(format, metadata);
    const base = try encodePixels(allocator, frame, raw_metadata, options, .{});
    defer allocator.free(base);
    return @import("home/metadata_embed.zig").embedMetadata(allocator, format, base, metadata);
}
fn encodePixels(allocator: std.mem.Allocator, frame: *const c.zc_frame, raw_metadata: ?*const c.zc_raw_metadata, options: *const c.zc_image_options, metadata: @import("home/jpeg_metadata.zig").Metadata) ![]u8 {
    if (!valid(options)) return error.InvalidOptions;
    if (options.format == c.ZC_IMAGE_DNG) {
        var buffer = Buffer{ .allocator = allocator };
        errdefer buffer.bytes.deinit(allocator);
        try @import("dng.zig").write(allocator, frame, raw_metadata orelse return error.MissingCalibration, &buffer);
        return buffer.bytes.toOwnedSlice(allocator);
    }
    const stream = frame.main;
    const wide = std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR161616");
    if (stream.plane_count != 1 or (!wide and !std.mem.eql(u8, std.mem.sliceTo(&stream.format, 0), "BGR888"))) return error.UnsupportedFormat;
    if (wide and options.format == c.ZC_IMAGE_JPEG) return error.UnsupportedFormat;
    const plane = stream.planes[0];
    if (plane.bytes_used > plane.length or plane.bytes_used > std.math.maxInt(usize)) return error.BufferTooSmall;
    const view = raster.View{ .data = plane.data[0..@intCast(plane.bytes_used)], .width = stream.width, .height = stream.height, .stride = stream.stride, .bits = if (wide) 16 else 8 };
    const row_bytes = try view.validate();
    return switch (options.format) {
        c.ZC_IMAGE_PNG => raster.png(allocator, view, .{ .compression = options.png_compression, .filter = @enumFromInt(options.png_filter) }),
        c.ZC_IMAGE_BMP => raster.bmp(allocator, view),
        c.ZC_IMAGE_TIFF => raster.tiff(allocator, view),
        c.ZC_IMAGE_GIF => @import("home/gif_encoder.zig").encode(allocator, view, .{}),
        c.ZC_IMAGE_JPEG => block: {
            var encoder = @import("home/jpeg_encoder.zig").Encoder.init(allocator);
            defer encoder.deinit();
            break :block encoder.encodeOwned(view.data, view.width, view.height, view.stride, 3, @intCast(options.quality), metadata);
        },
        c.ZC_IMAGE_PPM => block: {
            var buffer = Buffer{ .allocator = allocator };
            errdefer buffer.bytes.deinit(allocator);
            var text: [64]u8 = undefined;
            try buffer.writeAll(try std.fmt.bufPrint(&text, "P6\n{d} {d}\n{d}\n", .{ view.width, view.height, if (wide) @as(u32, 65535) else @as(u32, 255) }));
            for (0..view.height) |y| {
                const row = view.data[y * view.stride ..][0..row_bytes];
                if (!wide) {
                    try buffer.writeAll(row);
                } else {
                    try buffer.bytes.ensureUnusedCapacity(allocator, row_bytes);
                    const start = buffer.bytes.items.len;
                    buffer.bytes.items.len += row_bytes;
                    for (0..row_bytes / 2) |i| {
                        buffer.bytes.items[start + i * 2] = row[i * 2 + 1];
                        buffer.bytes.items[start + i * 2 + 1] = row[i * 2];
                    }
                }
            }
            break :block buffer.bytes.toOwnedSlice(allocator);
        },
        else => error.UnsupportedFormat,
    };
}
