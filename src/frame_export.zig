//! Low-level process handoff: one native access/lease owner, owned fd duplicates,
//! pointer-free descriptors and immutable metadata. Peer supervision is separate.
const std = @import("std");
const c = @import("abi.zig").c;
const core = @import("core.zig");
const catalogs = @import("catalog.zig");
const shared = @import("home/posix_shared_memory.zig");
const Admission = @import("home/owned_admission.zig").Registry(32);
const A = std.heap.c_allocator;
const maximum = 256 * 1024 * 1024;
var admission: Admission = .{ .max_bytes = 512 * 1024 * 1024, .max_items = 32 };
var mutex: std.Thread.Mutex = .{};
const Export = struct {
    map: *c.zc_frame_map,
    catalog: *c.zc_catalog,
    ticket: Admission.Ticket,
    payload_cost: usize,
    info: c.zc_export_info,
    raw_metadata: c.zc_raw_metadata,
    sources: [c.ZC_MAX_EXPORT_PLANES]c.zc_plane,
    descriptors: [c.ZC_MAX_EXPORT_PLANES]shared.Fd = @splat(.{}),
    staging: [c.ZC_MAX_EXPORT_PLANES]?shared.Region = @splat(null),
    shared_catalog: ?shared.Region = null,
};
fn owner(p: *const c.zc_frame_export) *Export {
    return @ptrCast(@alignCast(@constCast(p)));
}
fn release(ticket: Admission.Ticket) void {
    mutex.lock();
    defer mutex.unlock();
    admission.release(ticket) catch unreachable;
}
fn cleanup(self: *Export, writeback: bool) c_int {
    var result: c_int = c.ZC_OK;
    var commit = writeback;
    if (commit and self.info.flags & c.ZC_EXPORT_WRITABLE != 0) {
        // Consumers are joined before close. Check every backing file before
        // reading any mapped staging bytes, including deliberate truncation.
        for (self.staging, 0..) |stage, i| if (stage) |region| {
            const size = shared.extent(region.fd.value) catch {
                result = c.ZC_IO;
                commit = false;
                break;
            };
            if (size < self.sources[i].bytes_used) {
                result = c.ZC_IO;
                commit = false;
                break;
            }
        };
    }
    for (0..self.info.plane_count) |i| {
        if (self.staging[i]) |*region| {
            if (commit and self.info.flags & c.ZC_EXPORT_WRITABLE != 0) {
                const source = self.sources[i];
                const used: usize = @intCast(source.bytes_used);
                @memcpy(@constCast(source.data[0..used]), region.mapping.bytes[0..used]);
            }
            region.close() catch {
                result = c.ZC_IO;
            };
        }
        self.descriptors[i].close() catch {
            result = c.ZC_IO;
        };
    }
    if (self.shared_catalog) |*region| region.close() catch {
        result = c.ZC_IO;
    };
    catalogs.zc_catalog_close(self.catalog);
    const retired = core.zc_frame_map_close(self.map);
    if (retired != c.ZC_OK) result = retired;
    release(self.ticket);
    A.destroy(self);
    return result;
}
pub export fn zc_frame_export_open(camera: *c.zc_camera, token: u64, streams: u32, flags: u32, output: *?*c.zc_frame_export) c_int {
    output.* = null;
    if (streams == 0 or streams & ~@as(u32, 7) != 0 or flags & ~@as(u32, c.ZC_EXPORT_WRITABLE) != 0) return c.ZC_INVALID;
    mutex.lock();
    const ticket = admission.reserve(catalogs.limit) catch |err| {
        mutex.unlock();
        return if (err == error.BufferFull) c.ZC_BUSY else c.ZC_STATE;
    };
    mutex.unlock();
    var handed = false;
    defer if (!handed) release(ticket);
    var map: ?*c.zc_frame_map = null;
    const rc = core.zc_frame_map_open(camera, token, @ctz(streams), flags & c.ZC_EXPORT_WRITABLE, &map);
    if (rc != c.ZC_OK) return rc;
    defer if (!handed) {
        _ = core.zc_frame_map_close(map);
    };
    var catalog: ?*c.zc_catalog = null;
    const snapshot = core.zc_frame_metadata_catalog(camera, token, &catalog);
    if (snapshot != c.ZC_OK) return snapshot;
    defer if (!handed) catalogs.zc_catalog_close(catalog);
    var raw_metadata = std.mem.zeroes(c.zc_raw_metadata);
    const calibration = core.zc_get_raw_metadata(camera, token, &raw_metadata);
    if (calibration != c.ZC_OK and calibration != c.ZC_UNSUPPORTED) return calibration;
    if (calibration == c.ZC_UNSUPPORTED) raw_metadata = std.mem.zeroes(c.zc_raw_metadata);
    var info = std.mem.zeroes(c.zc_export_info);
    for (&info.planes) |*plane| plane.fd = -1;
    info.struct_size = @sizeOf(c.zc_export_info);
    info.flags = flags;
    var sources: [c.ZC_MAX_EXPORT_PLANES]c.zc_plane = undefined;
    var bytes: usize = 0;
    const metarc = core.zc_get_frame_metadata(camera, token, &info.metadata);
    if (metarc != c.ZC_OK) return metarc;
    for (0..3) |id| {
        if (streams & (@as(u32, 1) << @intCast(id)) == 0) continue;
        var stream: c.zc_stream = undefined;
        const status = core.zc_frame_map_get_stream(map.?, @intCast(id), &stream);
        if (status != c.ZC_OK) return status;
        if (stream.plane_count == 0 or stream.plane_count > c.ZC_MAX_PLANES or stream.width == 0 or stream.height == 0 or stream.stride == 0) return c.ZC_INVALID;
        const at = info.stream_count;
        const color = core.zc_get_stream_color_space(camera, @intCast(id), &info.colors[at]);
        if (color != c.ZC_OK) return color;
        info.streams[at] = .{ .stream = @intCast(id), .width = stream.width, .height = stream.height, .stride = stream.stride, .plane_count = stream.plane_count, .first_plane = info.plane_count, .format = stream.format };
        info.stream_count += 1;
        for (stream.planes[0..stream.plane_count]) |plane| {
            (shared.Span{ .offset = plane.offset, .length = plane.length, .used = plane.bytes_used }).validate(maximum) catch return c.ZC_INVALID;
            if (plane.data == null or plane.fd < -1) return c.ZC_INVALID;
            bytes = std.math.add(usize, bytes, @intCast(plane.length)) catch return c.ZC_INVALID;
            if (bytes > maximum) return c.ZC_INVALID;
            sources[info.plane_count] = plane;
            info.plane_count += 1;
        }
    }
    var metadata_size: u64 = 0;
    const queried = catalogs.zc_catalog_copy(catalog.?, null, 0, &metadata_size);
    if (queried != c.ZC_OK) return queried;
    const cost = std.math.add(usize, bytes, @intCast(metadata_size)) catch return c.ZC_INVALID;
    mutex.lock();
    admission.resize(ticket, cost) catch |err| {
        mutex.unlock();
        return if (err == error.BufferFull) c.ZC_BUSY else c.ZC_STATE;
    };
    mutex.unlock();
    const self = A.create(Export) catch return c.ZC_NOMEM;
    self.* = .{ .map = map.?, .catalog = catalog.?, .ticket = ticket, .payload_cost = cost, .info = info, .raw_metadata = raw_metadata, .sources = sources };
    handed = true;
    var complete = false;
    defer if (!complete) {
        _ = cleanup(self, false);
    };
    for (sources[0..info.plane_count], 0..) |plane, i| {
        var output_plane = c.zc_export_plane{ .fd = -1, .flags = flags, .offset = plane.offset, .length = plane.length, .bytes_used = plane.bytes_used };
        if (plane.fd >= 0) {
            self.descriptors[i] = shared.Fd.duplicate(plane.fd) catch return c.ZC_IO;
            output_plane.fd = self.descriptors[i].value;
        } else {
            self.staging[i] = shared.Region.create(@intCast(plane.length), maximum) catch return c.ZC_IO;
            const region = &self.staging[i].?;
            @memcpy(region.mapping.bytes[0..@intCast(plane.bytes_used)], plane.data[0..@intCast(plane.bytes_used)]);
            output_plane.fd = region.fd.value;
            output_plane.flags |= c.ZC_EXPORT_STAGED;
            output_plane.offset = 0;
            self.info.flags |= c.ZC_EXPORT_STAGED;
        }
        self.info.planes[i] = output_plane;
    }
    output.* = @ptrCast(self);
    complete = true;
    return c.ZC_OK;
}
pub export fn zc_frame_export_info(p: *const c.zc_frame_export, output: *c.zc_export_info) c_int {
    output.* = owner(p).info;
    return c.ZC_OK;
}
pub export fn zc_frame_export_catalog_copy(p: *const c.zc_frame_export, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    return catalogs.zc_catalog_copy(owner(p).catalog, data, capacity, length);
}
pub export fn zc_frame_export_close(p: ?*c.zc_frame_export) c_int {
    return if (p) |value| cleanup(owner(value), true) else c.ZC_OK;
}
/// Internal transport cache. Source owner/calls remain caller-serialized. One
/// bounded shared catalog per export; retries/queued sends only duplicate its fd.
pub fn sharedCatalog(p: *const c.zc_frame_export, fd: *c_int, size: *u64) c_int {
    const self = owner(p);
    const rc = catalogs.zc_catalog_copy(self.catalog, null, 0, size);
    if (rc != c.ZC_OK) return rc;
    if (self.shared_catalog == null) {
        mutex.lock();
        admission.resize(self.ticket, self.payload_cost + @as(usize, @intCast(size.*))) catch {
            mutex.unlock();
            return c.ZC_BUSY;
        };
        mutex.unlock();
        var complete = false;
        defer if (!complete) {
            mutex.lock();
            admission.resize(self.ticket, self.payload_cost) catch unreachable;
            mutex.unlock();
        };
        var region = shared.Region.create(@intCast(size.*), catalogs.limit) catch return c.ZC_IO;
        defer if (!complete) region.close() catch {};
        const copied = catalogs.zc_catalog_copy(self.catalog, region.mapping.bytes.ptr, size.*, size);
        if (copied != c.ZC_OK) return copied;
        self.shared_catalog = region;
        complete = true;
    }
    const region = &self.shared_catalog.?;
    const extent = shared.extent(region.fd.value) catch return c.ZC_IO;
    if (extent < size.*) return c.ZC_IO;
    fd.* = region.fd.value;
    return c.ZC_OK;
}

test "export info remains pointer free and ABI-stable" {
    try std.testing.expectEqual(@as(usize, 736), @sizeOf(c.zc_export_info));
    try std.testing.expectEqual(@as(usize, 352), @offsetOf(c.zc_export_info, "planes"));
    try std.testing.expectEqual(@as(usize, 32), @sizeOf(c.zc_export_plane));
}

pub export fn zc_frame_export_raw_metadata(p: *const c.zc_frame_export, out: *c.zc_raw_metadata) c_int {
    out.* = owner(p).raw_metadata;
    return c.ZC_OK;
}

pub export fn zc_frame_export_configuration_copy(p: *const c.zc_frame_export, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const catalog: *const catalogs.Catalog = @ptrCast(@alignCast(owner(p).catalog));
    const bytes = catalog.writer.finish() catch return c.ZC_INVALID;
    return @import("frame_configuration.zig").copy(bytes, data, capacity, length);
}
pub export fn zc_frame_export_properties_copy(p: *const c.zc_frame_export, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const catalog: *const catalogs.Catalog = @ptrCast(@alignCast(owner(p).catalog));
    const bytes = catalog.writer.finish() catch return c.ZC_INVALID;
    return @import("frame_properties.zig").copy(bytes, data, capacity, length);
}
