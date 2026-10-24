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
pub const TestHooks = if (@import("builtin").is_test) struct {
    pub var after_map: ?*const fn (*c.zc_camera, u64) void = null;
} else struct {};
var admission: Admission = .{ .max_bytes = 512 * 1024 * 1024, .max_items = 32 };
var mutex: std.Thread.Mutex = .{};
// Occupies the original admission slot until all physical mappings retire.
// Caller-facing handles remain consumed, including on failed cleanup.
var deferred: [32]?*Export = @splat(null);
var draining: [32]bool = @splat(false);
const Export = struct {
    map: *c.zc_frame_map,
    catalog: *c.zc_catalog,
    ticket: Admission.Ticket,
    payload_cost: usize,
    retained_cost: usize,
    info: c.zc_export_info,
    raw_metadata: c.zc_raw_metadata,
    sources: [c.ZC_MAX_EXPORT_PLANES]c.zc_plane,
    descriptors: [c.ZC_MAX_EXPORT_PLANES]shared.Fd = @splat(.{}),
    staging: [c.ZC_MAX_EXPORT_PLANES]?shared.Region = @splat(null),
    shared_catalog: ?shared.Region = null,
    catalog_ready: bool = false,
};
fn owner(p: *const c.zc_frame_export) *Export {
    return @ptrCast(@alignCast(@constCast(p)));
}
fn release(ticket: Admission.Ticket) void {
    mutex.lock();
    defer mutex.unlock();
    admission.release(ticket) catch unreachable;
}
fn physicalCleanup(self: *Export) c_int {
    var result: c_int = c.ZC_OK;
    for (&self.staging) |*stage| if (stage.*) |*region| region.close() catch {
        result = c.ZC_IO;
    };
    for (&self.descriptors) |*fd| fd.close() catch {
        result = c.ZC_IO;
    };
    if (self.shared_catalog) |*region| region.close() catch {
        result = c.ZC_IO;
    };
    return result;
}
fn mapped(self: *const Export) bool {
    for (self.staging) |stage| if (stage) |region| {
        if (region.mapping.base != null) return true;
    };
    if (self.shared_catalog) |region| if (region.mapping.base != null) return true;
    return false;
}
pub const CleanupState = struct { owners: u32 = 0, busy: u32 = 0, bytes: u64 = 0 };
pub fn cleanupState() CleanupState {
    mutex.lock();
    defer mutex.unlock();
    var state: CleanupState = .{};
    for (deferred, 0..) |entry, i| if (entry) |self| {
        state.owners += 1;
        state.busy += @intFromBool(draining[i]);
        state.bytes += self.retained_cost;
    };
    return state;
}
/// One bounded pass; concurrent callers cannot operate on the same owner.
pub fn drainCleanup() c_int {
    var result: c_int = c.ZC_OK;
    for (0..deferred.len) |i| {
        mutex.lock();
        if (deferred[i] == null or draining[i]) {
            mutex.unlock();
            continue;
        }
        const self = deferred[i].?;
        draining[i] = true;
        mutex.unlock();
        if (physicalCleanup(self) != c.ZC_OK) result = c.ZC_IO;
        const pending = mapped(self);
        mutex.lock();
        draining[i] = false;
        if (!pending) {
            deferred[i] = null;
            admission.release(self.ticket) catch unreachable;
        }
        mutex.unlock();
        if (!pending) A.destroy(self);
    }
    return result;
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
        }
    }
    if (physicalCleanup(self) != c.ZC_OK) result = c.ZC_IO;
    catalogs.zc_catalog_close(self.catalog);
    const retired = core.zc_frame_map_close(self.map);
    if (retired != c.ZC_OK) result = retired;
    if (mapped(self)) {
        mutex.lock();
        std.debug.assert(deferred[self.ticket.slot] == null);
        deferred[self.ticket.slot] = self;
        mutex.unlock();
    } else {
        release(self.ticket);
        A.destroy(self);
    }
    return result;
}
pub export fn zc_frame_export_open(camera: *c.zc_camera, token: u64, streams: u32, flags: u32, output: *?*c.zc_frame_export) c_int {
    var cleanup_result: c_int = c.ZC_OK;
    const result = openExport(camera, token, streams, flags, output, &cleanup_result, true);
    return if (cleanup_result != c.ZC_OK) cleanup_result else result;
}
fn openExport(camera: *c.zc_camera, token: u64, streams: u32, flags: u32, output: *?*c.zc_frame_export, cleanup_result: *c_int, publish_fds: bool) c_int {
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
        const code = core.zc_frame_map_close(map);
        if (code != c.ZC_OK) cleanup_result.* = code;
    };
    if (comptime @import("builtin").is_test) {
        if (TestHooks.after_map) |hook| hook(camera, token);
    }
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
    self.* = .{ .map = map.?, .catalog = catalog.?, .ticket = ticket, .payload_cost = cost, .retained_cost = cost, .info = info, .raw_metadata = raw_metadata, .sources = sources };
    handed = true;
    var complete = false;
    defer if (!complete) {
        const code = cleanup(self, false);
        if (code != c.ZC_OK) cleanup_result.* = code;
    };
    for (sources[0..info.plane_count], 0..) |plane, i| {
        var output_plane = c.zc_export_plane{ .fd = -1, .flags = flags, .offset = plane.offset, .length = plane.length, .bytes_used = plane.bytes_used };
        if (!publish_fds) {
            self.info.planes[i] = output_plane;
            continue;
        }
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
        // Publish ownership before copying: an error must leave any failed
        // unmap reachable through this export and charged to its reservation.
        self.shared_catalog = shared.Region.create(@intCast(size.*), catalogs.limit) catch {
            mutex.lock();
            admission.resize(self.ticket, self.payload_cost) catch unreachable;
            mutex.unlock();
            return c.ZC_IO;
        };
        self.retained_cost = self.payload_cost + @as(usize, @intCast(size.*));
    }
    if (!self.catalog_ready) {
        const region = &self.shared_catalog.?;
        const copied = catalogs.zc_catalog_copy(self.catalog, region.mapping.bytes.ptr, size.*, size);
        if (copied != c.ZC_OK) return copied;
        self.catalog_ready = true;
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

/// Internal native consumer: retain the existing read map/catalog, without
/// duplicating/staging pointer-free process FDs that this consumer never uses.
pub fn openNativeRead(camera: *c.zc_camera, token: u64, stream: u32, out: *?*c.zc_frame_export) c_int {
    var cleanup_result: c_int = c.ZC_OK;
    if (stream != c.ZC_MAIN and stream != c.ZC_LORES) {
        out.* = null;
        return c.ZC_INVALID;
    }
    const rc = openExport(camera, token, @as(u32, 1) << @as(u5, @intCast(stream)), 0, out, &cleanup_result, false);
    return if (cleanup_result != c.ZC_OK) cleanup_result else rc;
}
/// Borrowed only until export close; never exposed through the C/Bun ABI.
pub fn nativeStream(p: *c.zc_frame_export, out: *c.zc_stream) c_int {
    const self = owner(p);
    if (self.info.stream_count != 1) return c.ZC_INVALID;
    return core.zc_frame_map_get_stream(self.map, self.info.streams[0].stream, out);
}

test "native read consumer pins a camera map without staged files or pixel copies" {
    if (@import("options").libcamera) return error.SkipZigTest;
    var cfg: c.zc_config = undefined;
    core.zc_default_config(&cfg);
    cfg.width = 8;
    cfg.height = 6;
    cfg.buffer_count = 3;
    var camera: ?*c.zc_camera = null;
    try std.testing.expectEqual(c.ZC_OK, core.zc_open(&cfg, &camera));
    defer _ = core.zc_close(camera.?);
    try std.testing.expectEqual(c.ZC_OK, core.zc_start(camera.?));
    defer _ = core.zc_stop(camera.?);
    var frame: c.zc_frame = undefined;
    try std.testing.expectEqual(c.ZC_OK, core.zc_acquire(camera.?, 0, &frame));
    var source: ?*c.zc_frame_export = null;
    try std.testing.expectEqual(c.ZC_OK, openNativeRead(camera.?, frame.token, c.ZC_MAIN, &source));
    defer if (source) |value| {
        _ = zc_frame_export_close(value);
    };
    try std.testing.expectEqual(c.ZC_OK, core.zc_release(camera.?, frame.token));
    var info: c.zc_export_info = undefined;
    try std.testing.expectEqual(c.ZC_OK, zc_frame_export_info(source.?, &info));
    try std.testing.expectEqual(@as(c_int, -1), info.planes[0].fd);
    try std.testing.expectEqual(@as(u32, 0), info.flags & c.ZC_EXPORT_STAGED);
    var stream: c.zc_stream = undefined;
    try std.testing.expectEqual(c.ZC_OK, nativeStream(source.?, &stream));
    try std.testing.expectEqual(frame.main.planes[0].data, stream.planes[0].data);
    var stats: c.zc_stats = undefined;
    try std.testing.expectEqual(c.ZC_OK, core.zc_get_stats(camera.?, &stats));
    try std.testing.expectEqual(@as(u32, 1), stats.leased);
    try std.testing.expectEqual(c.ZC_OK, zc_frame_export_close(source.?));
    source = null;
    try std.testing.expectEqual(c.ZC_OK, core.zc_get_stats(camera.?, &stats));
    try std.testing.expectEqual(@as(u32, 0), stats.leased);
}
