//! Local descriptor transport, not a process supervisor. Sender owns the camera
//! export until all peer views retire and an ACK or verified exit is observed.
const std = @import("std");
const c = @import("abi.zig").c;
const channel = @import("home/descriptor_channel.zig");
const shared = channel.shared;
const exports = @import("frame_export.zig");
const catalogs = @import("catalog.zig");
const A = std.heap.c_allocator;
const info_size = @sizeOf(c.zc_export_info);
const header_size = 32;
const legacy_packet_size: usize = header_size + info_size;
const raw_size = @sizeOf(c.zc_raw_metadata);
const packet_size: usize = legacy_packet_size + raw_size;
const maximum = 256 * 1024 * 1024;
const Admission = @import("home/owned_admission.zig").Registry(32);
var admission: Admission = .{ .max_bytes = 512 * 1024 * 1024, .max_items = 32 };
var mutex: std.Thread.Mutex = .{};
const Remote = struct {
    ticket: Admission.Ticket,
    info: c.zc_export_info,
    raw_metadata: c.zc_raw_metadata,
    catalog: []u8,
    fds: [c.ZC_MAX_EXPORT_PLANES]shared.Fd = @splat(.{}),
    maps: [c.ZC_MAX_EXPORT_PLANES]?shared.Mapping = @splat(null),
};
fn owner(p: *const c.zc_remote_frame) *Remote {
    return @ptrCast(@alignCast(@constCast(p)));
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.WouldBlock => c.ZC_TIMEOUT,
        error.InvalidRecord, error.InvalidSpan, error.InvalidCatalog => c.ZC_INVALID,
        error.UnsupportedPlatform => c.ZC_UNSUPPORTED,
        error.OutOfMemory => c.ZC_NOMEM,
        else => c.ZC_IO,
    };
}
fn release(ticket: Admission.Ticket) void {
    mutex.lock();
    defer mutex.unlock();
    admission.release(ticket) catch unreachable;
}
fn cleanup(self: *Remote) c_int {
    var result: c_int = c.ZC_OK;
    for (&self.maps) |*mapping| if (mapping.*) |*m| m.close() catch {
        result = c.ZC_IO;
    };
    for (&self.fds) |*fd| fd.close() catch {
        result = c.ZC_IO;
    };
    A.free(self.catalog);
    release(self.ticket);
    A.destroy(self);
    return result;
}
fn put(comptime T: type, bytes: []u8, offset: usize, value: T) void {
    std.mem.writeInt(T, bytes[offset..][0..@sizeOf(T)], value, .little);
}
fn get(comptime T: type, bytes: []const u8, offset: usize) T {
    return std.mem.readInt(T, bytes[offset..][0..@sizeOf(T)], .little);
}
fn header(kind: u16, cookie: u64, fds: u32, catalog: u64) [header_size]u8 {
    var bytes: [header_size]u8 = @splat(0);
    @memcpy(bytes[0..4], "ZCFD");
    put(u16, &bytes, 4, if (kind == 1) 2 else 1);
    put(u16, &bytes, 6, kind);
    put(u32, &bytes, 8, if (kind == 1) info_size else 0);
    put(u32, &bytes, 12, fds);
    put(u64, &bytes, 16, cookie);
    put(u64, &bytes, 24, catalog);
    return bytes;
}
fn validHeader(bytes: []const u8, kind: u16) bool {
    return bytes.len >= header_size and std.mem.eql(u8, bytes[0..4], "ZCFD") and (get(u16, bytes, 4) == 1 or (kind == 1 and get(u16, bytes, 4) == 2)) and get(u16, bytes, 6) == kind and get(u32, bytes, 8) == (if (kind == 1) @as(u32, info_size) else 0) and get(u64, bytes, 16) != 0;
}
/// Validate all scalar layout/cost fields before any mapping or payload copy.
fn cost(info: c.zc_export_info, catalog_size: u64) !usize {
    if (info.struct_size != info_size or info.stream_count == 0 or info.stream_count > 3 or info.plane_count == 0 or info.plane_count > c.ZC_MAX_EXPORT_PLANES or info.flags & ~@as(u32, 3) != 0 or catalog_size < catalogs.wire.header_size or catalog_size > catalogs.limit) return error.InvalidRecord;
    var planes: u32 = 0;
    var mask: u32 = 0;
    for (info.streams[0..info.stream_count], 0..) |stream, i| {
        if (stream.stream > 2 or stream.width == 0 or stream.height == 0 or stream.stride == 0 or stream.plane_count == 0 or stream.plane_count > c.ZC_MAX_PLANES or stream.first_plane != planes or stream.plane_count > info.plane_count -| planes or stream.format[0] == 0 or std.mem.indexOfScalar(u8, &stream.format, 0) == null) return error.InvalidRecord;
        const bit = @as(u32, 1) << @intCast(stream.stream);
        if (mask & bit != 0) return error.InvalidRecord;
        mask |= bit;
        planes += stream.plane_count;
        const color = info.colors[i];
        if (color.struct_size != @sizeOf(c.zc_color_space) or color.present > 1 or (color.present == 1 and @import("color_policy.zig").fromSpace(color) == null)) return error.InvalidRecord;
    }
    if (planes != info.plane_count) return error.InvalidRecord;
    var total: usize = 0;
    var staged = false;
    for (info.planes[0..info.plane_count]) |plane| {
        if (plane.flags & ~@as(u32, 3) != 0 or plane.flags & c.ZC_EXPORT_WRITABLE != info.flags & c.ZC_EXPORT_WRITABLE) return error.InvalidRecord;
        try (shared.Span{ .offset = plane.offset, .length = plane.length, .used = plane.bytes_used }).validate(maximum);
        total = std.math.add(usize, total, @intCast(plane.length)) catch return error.InvalidRecord;
        if (total > maximum) return error.InvalidRecord;
        staged = staged or plane.flags & c.ZC_EXPORT_STAGED != 0;
    }
    if (staged != (info.flags & c.ZC_EXPORT_STAGED != 0)) return error.InvalidRecord;
    return total + @as(usize, @intCast(catalog_size));
}
pub export fn zc_frame_channel_pair(out: [*c]i32) c_int {
    out[0] = -1;
    out[1] = -1;
    const pair = channel.Pair.init() catch |err| return status(err);
    for (pair.ends, 0..) |fd, i| out[i] = fd.value;
    return c.ZC_OK;
}
pub export fn zc_frame_channel_duplicate(fd: i32, out: *i32) c_int {
    out.* = -1;
    if (fd < 0) return c.ZC_INVALID;
    var kind: c_int = 0;
    var length: std.c.socklen_t = @sizeOf(c_int);
    if (std.c.getsockopt(fd, std.c.SOL.SOCKET, std.c.SO.TYPE, &kind, &length) != 0 or kind != std.c.SOCK.DGRAM) return c.ZC_INVALID;
    var peer: std.c.sockaddr.storage = std.mem.zeroes(std.c.sockaddr.storage);
    length = @sizeOf(@TypeOf(peer));
    if (std.c.getpeername(fd, @ptrCast(&peer), &length) != 0 or peer.family != std.c.AF.UNIX) return c.ZC_INVALID;
    const dup = shared.Fd.duplicate(fd) catch |err| return status(err);
    out.* = dup.value;
    return c.ZC_OK;
}
pub export fn zc_frame_channel_close(fd: i32) c_int {
    var owned: shared.Fd = .{ .value = fd };
    owned.close() catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_frame_channel_send(fd: i32, source: *const c.zc_frame_export, cookie: u64) c_int {
    if (cookie == 0) return c.ZC_INVALID;
    var info: c.zc_export_info = undefined;
    const rc = exports.zc_frame_export_info(source, &info);
    if (rc != c.ZC_OK) return rc;
    var length: u64 = 0;
    const queried = exports.zc_frame_export_catalog_copy(source, null, 0, &length);
    if (queried != c.ZC_OK) return queried;
    _ = cost(info, length) catch |err| return status(err);
    // Metadata travels in one separately bounded shared file, so a 4 MiB HCAT
    // does not require large datagrams, chunk queues or partially sent records.
    var metadata_fd: c_int = -1;
    const copied = exports.sharedCatalog(source, &metadata_fd, &length);
    if (copied != c.ZC_OK) return copied;
    var fds: [c.ZC_MAX_EXPORT_PLANES + 1]c_int = undefined;
    for (info.planes[0..info.plane_count], 0..) |*plane, i| {
        fds[i] = plane.fd;
        plane.fd = -1; // Sender fd integers have no meaning in the peer.
    }
    fds[info.plane_count] = metadata_fd;
    var packet: [packet_size]u8 = undefined;
    packet[0..header_size].* = header(1, cookie, info.plane_count + 1, length);
    @memcpy(packet[header_size..legacy_packet_size], std.mem.asBytes(&info));
    var raw_metadata: c.zc_raw_metadata = undefined;
    const raw_rc = exports.zc_frame_export_raw_metadata(source, &raw_metadata);
    if (raw_rc != c.ZC_OK) return raw_rc;
    if (!validRaw(raw_metadata)) return c.ZC_INVALID;
    @memcpy(packet[legacy_packet_size..], std.mem.asBytes(&raw_metadata));
    channel.send(fd, &packet, fds[0 .. info.plane_count + 1]) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_frame_channel_receive(fd: i32, out: *?*c.zc_remote_frame, cookie: *u64) c_int {
    out.* = null;
    cookie.* = 0;
    mutex.lock();
    const ticket = admission.reserve(catalogs.limit) catch {
        mutex.unlock();
        return c.ZC_BUSY;
    };
    mutex.unlock();
    var handed = false;
    defer if (!handed) release(ticket);
    var packet: [packet_size]u8 = undefined;
    var record = channel.receive(fd, &packet) catch |err| return status(err);
    defer record.close() catch {};
    if (!validHeader(packet[0..record.bytes], 1)) return c.ZC_INVALID;
    const version = get(u16, &packet, 4);
    if (record.bytes != (if (version == 1) legacy_packet_size else packet_size)) return c.ZC_INVALID;
    var info: c.zc_export_info = undefined;
    @memcpy(std.mem.asBytes(&info), packet[header_size..legacy_packet_size]);
    var raw_metadata = std.mem.zeroes(c.zc_raw_metadata);
    if (version == 2) @memcpy(std.mem.asBytes(&raw_metadata), packet[legacy_packet_size..]);
    if (!validRaw(raw_metadata)) return c.ZC_INVALID;
    const size = get(u64, &packet, 24);
    const bytes = cost(info, size) catch |err| return status(err);
    if (record.count != info.plane_count + 1 or record.count != get(u32, &packet, 12)) return c.ZC_INVALID;
    mutex.lock();
    admission.resize(ticket, bytes) catch {
        mutex.unlock();
        return c.ZC_BUSY;
    };
    mutex.unlock();
    const self = A.create(Remote) catch return c.ZC_NOMEM;
    const catalog = A.alloc(u8, @intCast(size)) catch {
        A.destroy(self);
        return c.ZC_NOMEM;
    };
    self.* = .{ .ticket = ticket, .info = info, .raw_metadata = raw_metadata, .catalog = catalog };
    handed = true;
    var complete = false;
    defer if (!complete) {
        _ = cleanup(self);
    };
    // Collect/own all incoming descriptors before any step that can fail.
    for (0..info.plane_count) |i| self.fds[i] = record.take(i) catch unreachable;
    var metadata = record.take(info.plane_count) catch unreachable;
    defer metadata.close() catch {};
    var mapping = shared.Mapping.init(metadata.value, .{ .offset = 0, .length = size, .used = size }, false, catalogs.limit) catch |err| return status(err);
    defer mapping.close() catch {};
    @memcpy(catalog, mapping.bytes);
    const reader = catalogs.wire.Reader.init(catalog) catch return c.ZC_INVALID;
    if (reader.catalog_kind != c.ZC_CATALOG_METADATA) return c.ZC_INVALID;
    for (info.planes[0..info.plane_count], 0..) |plane, i| {
        self.maps[i] = shared.Mapping.init(self.fds[i].value, .{ .offset = plane.offset, .length = plane.length, .used = plane.bytes_used }, info.flags & c.ZC_EXPORT_WRITABLE != 0, maximum) catch |err| return status(err);
        self.info.planes[i].fd = self.fds[i].value;
    }
    out.* = @ptrCast(self);
    cookie.* = get(u64, &packet, 16);
    complete = true;
    return c.ZC_OK;
}
pub export fn zc_frame_channel_ack(fd: i32, cookie: u64) c_int {
    if (cookie == 0) return c.ZC_INVALID;
    const bytes = header(2, cookie, 0, 0);
    channel.send(fd, &bytes, &.{}) catch |err| return status(err);
    return c.ZC_OK;
}
pub export fn zc_frame_channel_receive_ack(fd: i32, cookie: *u64) c_int {
    cookie.* = 0;
    var bytes: [header_size]u8 = undefined;
    var record = channel.receive(fd, &bytes) catch |err| return status(err);
    defer record.close() catch {};
    if (record.bytes != header_size or record.count != 0 or !validHeader(&bytes, 2) or get(u32, &bytes, 12) != 0 or get(u64, &bytes, 24) != 0) return c.ZC_INVALID;
    cookie.* = get(u64, &bytes, 16);
    return c.ZC_OK;
}
pub export fn zc_remote_frame_info(p: *const c.zc_remote_frame, out: *c.zc_export_info) c_int {
    out.* = owner(p).info;
    return c.ZC_OK;
}
pub export fn zc_remote_frame_catalog_copy(p: *const c.zc_remote_frame, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const bytes = owner(p).catalog;
    length.* = bytes.len;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < bytes.len) return c.ZC_INVALID;
    @memcpy(data.?[0..bytes.len], bytes);
    return c.ZC_OK;
}
pub export fn zc_remote_frame_stream(p: *const c.zc_remote_frame, stream: u32, out: *c.zc_stream) c_int {
    const self = owner(p);
    for (self.info.streams[0..self.info.stream_count]) |s| {
        if (s.stream != stream) continue;
        out.* = std.mem.zeroes(c.zc_stream);
        out.width = s.width;
        out.height = s.height;
        out.stride = s.stride;
        out.format = s.format;
        out.plane_count = s.plane_count;
        for (0..s.plane_count) |i| {
            const index = s.first_plane + i;
            const plane = self.info.planes[index];
            out.planes[i] = .{ .data = self.maps[index].?.bytes.ptr, .length = plane.length, .bytes_used = plane.bytes_used, .offset = plane.offset, .fd = self.fds[index].value, .reserved = 0 };
        }
        return c.ZC_OK;
    }
    return c.ZC_UNSUPPORTED;
}
pub export fn zc_remote_frame_close(p: ?*c.zc_remote_frame) c_int {
    return if (p) |value| cleanup(owner(value)) else c.ZC_OK;
}
pub export fn zc_remote_frame_copy_rgb(p: *const c.zc_remote_frame, stream: u32, bits: u32, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    if (bits != 8 and bits != 16) return c.ZC_INVALID;
    if (stream == c.ZC_RAW) return c.ZC_UNSUPPORTED;
    var selected: c.zc_stream = undefined;
    const rc = zc_remote_frame_stream(p, stream, &selected);
    if (rc != c.ZC_OK) return rc;
    const rgb = @import("stream_rgb.zig");
    const size = rgb.size(selected) catch return c.ZC_INVALID;
    const bytes = size * (bits / 8);
    if (bytes > maximum) return c.ZC_INVALID;
    length.* = bytes;
    if (data == null) return if (capacity == 0) c.ZC_OK else c.ZC_INVALID;
    if (capacity < bytes) return c.ZC_INVALID;
    if (bits == 16) {
        rgb.copy16(selected, data.?[0..bytes]) catch |err| return @import("still.zig").status(err);
    } else {
        for (owner(p).info.streams[0..owner(p).info.stream_count], 0..) |s, i| {
            if (s.stream == stream) {
                rgb.copy(selected, owner(p).info.colors[i], data.?[0..bytes]) catch |err| return @import("still.zig").status(err);
                break;
            }
        }
    }
    return c.ZC_OK;
}

test "local channel header rejects wrong version kind zero cookie and lengths" {
    const t = std.testing;
    var bytes = header(1, 8, 2, 64);
    try t.expect(validHeader(&bytes, 1));
    try t.expect(!validHeader(&bytes, 2));
    try t.expect(!validHeader(bytes[0..31], 1));
    bytes[4] = 3;
    try t.expect(!validHeader(&bytes, 1));
    bytes = header(1, 0, 2, 64);
    try t.expect(!validHeader(&bytes, 1));
}

fn descriptorCount() usize {
    var count: usize = 0;
    for (0..1024) |fd| if (std.c.fcntl(@intCast(fd), std.c.F.GETFD) >= 0) {
        count += 1;
    };
    return count;
}
test "malformed and late mapping failures consume all fds and restore receiver admission" {
    if (@import("options").libcamera) return error.SkipZigTest;
    const t = std.testing;
    const core = @import("core.zig");
    var cfg: c.zc_config = undefined;
    core.zc_default_config(&cfg);
    cfg.width = 18;
    cfg.height = 10;
    cfg.raw = 1;
    @memcpy(cfg.raw_format[0..8], "SRGGB12\x00");
    var camera: ?*c.zc_camera = null;
    try t.expectEqual(c.ZC_OK, core.zc_open(&cfg, &camera));
    defer _ = core.zc_close(camera.?);
    try t.expectEqual(c.ZC_OK, core.zc_start(camera.?));
    defer _ = core.zc_stop(camera.?);
    var frame: c.zc_frame = undefined;
    try t.expectEqual(c.ZC_OK, core.zc_acquire(camera.?, 0, &frame));
    defer _ = core.zc_release(camera.?, frame.token);
    var loan: ?*c.zc_frame_export = null;
    try t.expectEqual(c.ZC_OK, exports.zc_frame_export_open(camera.?, frame.token, 3, 0, &loan));
    defer _ = exports.zc_frame_export_close(loan.?);
    var original: c.zc_export_info = undefined;
    try t.expectEqual(c.ZC_OK, exports.zc_frame_export_info(loan.?, &original));
    var metadata_fd: c_int = -1;
    var metadata_size: u64 = 0;
    try t.expectEqual(c.ZC_OK, exports.sharedCatalog(loan.?, &metadata_fd, &metadata_size));
    const cached_fd = metadata_fd;
    for (0..64) |_| {
        try t.expectEqual(c.ZC_OK, exports.sharedCatalog(loan.?, &metadata_fd, &metadata_size));
        try t.expectEqual(cached_fd, metadata_fd);
    }
    var ends = try channel.Pair.init();
    defer ends.close() catch unreachable;
    var tiny = try shared.Region.create(8, 8);
    defer tiny.close() catch unreachable;
    const tiny_extent = try shared.extent(tiny.fd.value);
    const before = descriptorCount();
    for (0..64) |iteration| {
        var info = original;
        var fds: [c.ZC_MAX_EXPORT_PLANES + 1]c_int = undefined;
        for (info.planes[0..info.plane_count], 0..) |plane, i| fds[i] = plane.fd;
        fds[info.plane_count] = metadata_fd;
        switch (iteration % 16) {
            0 => info.struct_size = 0,
            1 => info.stream_count = 4,
            2 => info.plane_count = 13,
            3 => info.flags |= 4,
            4 => info.streams[1].first_plane = 0,
            5 => info.streams[1].stream = 0,
            6 => info.streams[0].format = @splat(65),
            7 => info.planes[0].bytes_used = info.planes[0].length + 1,
            8 => info.planes[0].offset = std.math.maxInt(u64),
            9 => info.planes[0].flags ^= c.ZC_EXPORT_WRITABLE,
            10 => info.colors[0].present = 2,
            11 => info.streams[0].width = 0,
            12 => {
                // Valid first mapping, then a descriptor with too short an
                // extent. All previous maps/fds and the reservation must retire.
                fds[1] = tiny.fd.value;
                info.planes[1].length = tiny_extent + 1;
            },
            13 => fds[original.plane_count] = tiny.fd.value, // invalid HCAT bytes
            14 => info.planes[0].length = maximum + 1,
            15 => info.flags ^= c.ZC_EXPORT_STAGED,
            else => unreachable,
        }
        var bytes: [legacy_packet_size]u8 = undefined;
        bytes[0..header_size].* = header(1, 1, original.plane_count + 1, metadata_size);
        put(u16, &bytes, 4, 1);
        @memcpy(bytes[header_size..], std.mem.asBytes(&info));
        try channel.send(ends.ends[0].value, &bytes, fds[0 .. original.plane_count + 1]);
        var remote: ?*c.zc_remote_frame = null;
        var cookie: u64 = 123;
        // InvalidSpan maps to INVALID; no opaque output escapes a failed import.
        try t.expectEqual(c.ZC_INVALID, zc_frame_channel_receive(ends.ends[1].value, &remote, &cookie));
        try t.expect(remote == null);
        try t.expectEqual(@as(u64, 0), cookie);
        try t.expectEqual(before, descriptorCount());
    }
    // Independently malformed v2 calibration and exact-length/version contracts.
    for (0..40) |i| {
        var bytes: [packet_size]u8 = @splat(0);
        bytes[0..header_size].* = header(1, 2, original.plane_count + 1, metadata_size);
        @memcpy(bytes[header_size..legacy_packet_size], std.mem.asBytes(&original));
        var meta = std.mem.zeroes(c.zc_raw_metadata);
        var n: usize = bytes.len;
        switch (i % 5) {
            0 => meta.valid = 8,
            1 => meta.model = @splat(65),
            2 => n -= 1,
            3 => put(u16, &bytes, 4, 1), // v1 cannot carry an extension
            4 => put(u16, &bytes, 4, 3),
            else => unreachable,
        }
        @memcpy(bytes[legacy_packet_size..], std.mem.asBytes(&meta));
        var fds: [c.ZC_MAX_EXPORT_PLANES + 1]c_int = undefined;
        for (original.planes[0..original.plane_count], 0..) |plane, j| fds[j] = plane.fd;
        fds[original.plane_count] = metadata_fd;
        try channel.send(ends.ends[0].value, bytes[0..n], fds[0 .. original.plane_count + 1]);
        var remote: ?*c.zc_remote_frame = null;
        var cookie: u64 = 0;
        try t.expectEqual(c.ZC_INVALID, zc_frame_channel_receive(ends.ends[1].value, &remote, &cookie));
        try t.expect(remote == null);
        try t.expectEqual(before, descriptorCount());
    }
    // After more than the 32-slot capacity worth of failed imports, valid work
    // still succeeds, including query/copy atomicity and wrong-role fd cleanup.
    try t.expectEqual(c.ZC_OK, zc_frame_channel_send(ends.ends[0].value, loan.?, 77));
    var remote: ?*c.zc_remote_frame = null;
    var cookie: u64 = 0;
    try t.expectEqual(c.ZC_OK, zc_frame_channel_receive(ends.ends[1].value, &remote, &cookie));
    var destination: [2]u8 = @splat(99);
    var length: u64 = 0;
    try t.expectEqual(c.ZC_INVALID, zc_remote_frame_catalog_copy(remote.?, &destination, 2, &length));
    try t.expectEqualSlices(u8, &.{ 99, 99 }, &destination);
    try t.expectEqual(c.ZC_INVALID, zc_remote_frame_copy_rgb(remote.?, c.ZC_MAIN, 8, &destination, 2, &length));
    try t.expectEqualSlices(u8, &.{ 99, 99 }, &destination);
    var ids = [_]u32{ c.ZC_MAIN, c.ZC_RAW };
    var layouts: [2]c.zc_packed_stream = @splat(std.mem.zeroes(c.zc_packed_stream));
    var target: [2000]u8 = @splat(99);
    var size: u64 = 0;
    try t.expectEqual(c.ZC_INVALID, zc_remote_frame_copy_streams(remote.?, &ids, 2, &layouts, 2, &target, 1, &size));
    try t.expectEqual(@as(u64, 0), size);
    try t.expectEqual(@as(u32, 0), layouts[0].width);
    // A late malformed raw plane cannot leave main's output prefix behind.
    const stride = owner(remote.?).info.streams[1].stride;
    owner(remote.?).info.streams[1].stride = 0;
    try t.expectEqual(c.ZC_INVALID, zc_remote_frame_copy_streams(remote.?, &ids, 2, &layouts, 2, &target, target.len, &size));
    try t.expectEqualSlices(u8, &@as([2000]u8, @splat(99)), &target);
    try t.expectEqual(@as(u32, 0), layouts[0].width);
    owner(remote.?).info.streams[1].stride = stride;
    try t.expectEqual(c.ZC_OK, zc_remote_frame_copy_streams(remote.?, &ids, 2, &layouts, 2, &target, target.len, &size));
    try t.expect(size > 0);
    try t.expectEqual(c.ZC_INVALID, zc_remote_frame_copy_raw16(remote.?, &destination, destination.len, &length));
    try t.expectEqualSlices(u8, &.{ 99, 99 }, &destination);
    try t.expectEqual(c.ZC_INVALID, zc_remote_frame_copy_buffer(remote.?, c.ZC_MAIN, &destination, destination.len, &length));
    try t.expectEqualSlices(u8, &.{ 99, 99 }, &destination);
    try t.expectEqual(c.ZC_OK, zc_remote_frame_close(remote.?));
    const ack = header(2, 77, 1, 0);
    try channel.send(ends.ends[0].value, &ack, &.{tiny.fd.value});
    try t.expectEqual(c.ZC_INVALID, zc_frame_channel_receive_ack(ends.ends[1].value, &cookie));
    try t.expectEqual(before, descriptorCount());
}

fn validRaw(meta: c.zc_raw_metadata) bool {
    return meta.valid & ~@as(u32, 7) == 0 and std.mem.indexOfScalar(u8, &meta.model, 0) != null;
}
pub export fn zc_remote_frame_raw_metadata(p: *const c.zc_remote_frame, out: *c.zc_raw_metadata) c_int {
    out.* = owner(p).raw_metadata;
    return c.ZC_OK;
}
pub export fn zc_remote_frame_copy_streams(p: *const c.zc_remote_frame, ids: ?[*]const u32, count: u32, layouts: ?[*]c.zc_packed_stream, layout_capacity: u32, data: ?[*]u8, capacity: u64, size: *u64) c_int {
    size.* = 0;
    if (count == 0 or count > 3 or ids == null or layouts == null or layout_capacity < count or capacity > std.math.maxInt(usize) or (data == null and capacity != 0)) return c.ZC_INVALID;
    const bundles = @import("stream_bundle.zig");
    bundles.validate(ids.?[0..count]) catch return c.ZC_INVALID;
    var sources: [3]c.zc_stream = undefined;
    for (ids.?[0..count], 0..) |id, i| {
        const rc = zc_remote_frame_stream(p, id, &sources[i]);
        if (rc != c.ZC_OK) return rc;
    }
    const plan = bundles.Plan.init(ids.?[0..count], sources[0..count]) catch |err| return @import("still.zig").status(err);
    if (plan.size > maximum) return c.ZC_INVALID;
    if (data) |out| plan.copy(out[0..@intCast(capacity)]) catch |err| return @import("still.zig").status(err);
    @memcpy(layouts.?[0..count], plan.layouts[0..count]);
    size.* = plan.size;
    return c.ZC_OK;
}
pub export fn zc_remote_frame_copy_raw16(p: *const c.zc_remote_frame, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    if (capacity > std.math.maxInt(usize) or (data == null and capacity != 0)) return c.ZC_INVALID;
    var stream: c.zc_stream = undefined;
    const rc = zc_remote_frame_stream(p, c.ZC_RAW, &stream);
    if (rc != c.ZC_OK) return rc;
    const raw = @import("raw.zig");
    const format = raw.Format.parse(std.mem.sliceTo(&stream.format, 0)) catch return c.ZC_UNSUPPORTED;
    if (stream.plane_count != 1 or stream.planes[0].data == null or stream.planes[0].bytes_used > stream.planes[0].length) return c.ZC_INVALID;
    const size = std.math.mul(u64, @as(u64, stream.width) * stream.height, 2) catch return c.ZC_INVALID;
    if (size > maximum) return c.ZC_INVALID;
    const view = raw.View.init(stream.planes[0].data[0..@intCast(stream.planes[0].bytes_used)], stream.width, stream.height, stream.stride, format) catch return c.ZC_INVALID;
    length.* = size;
    if (data) |out| {
        if (capacity < size) return c.ZC_INVALID;
        view.copy16(out[0..@intCast(capacity)], @as(usize, stream.width) * 2) catch |err| return @import("still.zig").status(err);
    }
    return c.ZC_OK;
}
fn dngFrame(p: *const c.zc_remote_frame, frame: *c.zc_frame) c_int {
    frame.* = std.mem.zeroes(c.zc_frame);
    const meta = owner(p).info.metadata;
    frame.exposure_us = meta.exposure_us;
    frame.red_gain = meta.red_gain;
    frame.blue_gain = meta.blue_gain;
    return zc_remote_frame_stream(p, c.ZC_RAW, &frame.raw);
}
pub export fn zc_remote_frame_encode_dng(p: *const c.zc_remote_frame, out: *?*c.zc_image_blob) c_int {
    out.* = null;
    var frame: c.zc_frame = undefined;
    const rc = dngFrame(p, &frame);
    if (rc != c.ZC_OK) return rc;
    const size = @as(u64, frame.raw.width) * frame.raw.height;
    if (size > (maximum - 4096) / 2) return c.ZC_INVALID;
    var opts: c.zc_image_options = undefined;
    @import("core.zig").zc_default_image_options(&opts);
    opts.format = c.ZC_IMAGE_DNG;
    const still = @import("still.zig");
    const blob = A.create(still.Blob) catch return c.ZC_NOMEM;
    const bytes = still.encode(A, &frame, &owner(p).raw_metadata, &opts) catch |err| {
        A.destroy(blob);
        return still.status(err);
    };
    blob.* = .{ .bytes = bytes };
    out.* = @ptrCast(blob);
    return c.ZC_OK;
}
pub export fn zc_remote_frame_save_dng(p: *const c.zc_remote_frame, path: [*:0]const u8) c_int {
    var frame: c.zc_frame = undefined;
    const rc = dngFrame(p, &frame);
    if (rc != c.ZC_OK) return rc;
    @import("dng.zig").save(A, &frame, &owner(p).raw_metadata, std.mem.span(path)) catch |err| return switch (err) {
        error.UnsupportedFormat, error.MissingCalibration => c.ZC_UNSUPPORTED,
        error.OutOfMemory => c.ZC_NOMEM,
        error.InvalidGeometry, error.InvalidCalibration, error.BufferTooSmall, error.InvalidSample, error.FileTooLarge => c.ZC_INVALID,
        else => c.ZC_IO,
    };
    return c.ZC_OK;
}

pub export fn zc_remote_frame_copy_buffer(p: *const c.zc_remote_frame, id: u32, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    length.* = 0;
    if (capacity > std.math.maxInt(usize) or (data == null and capacity != 0)) return c.ZC_INVALID;
    var stream: c.zc_stream = undefined;
    const rc = zc_remote_frame_stream(p, id, &stream);
    if (rc != c.ZC_OK) return rc;
    var size: usize = 0;
    for (stream.planes[0..stream.plane_count]) |plane| {
        if (plane.bytes_used > plane.length) return c.ZC_INVALID;
        size = std.math.add(usize, size, @intCast(plane.bytes_used)) catch return c.ZC_INVALID;
    }
    if (size > maximum) return c.ZC_INVALID;
    length.* = size;
    if (data) |out| {
        if (capacity < size) return c.ZC_INVALID;
        var at: usize = 0;
        for (stream.planes[0..stream.plane_count]) |plane| {
            const n: usize = @intCast(plane.bytes_used);
            @memcpy(out[at..][0..n], plane.data[0..n]);
            at += n;
        }
    }
    return c.ZC_OK;
}

pub export fn zc_remote_frame_encode_image_metadata(p: *const c.zc_remote_frame, stream: u32, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif, out: *?*c.zc_image_blob) c_int {
    out.* = null;
    const core = @import("core.zig");
    var rc = core.imageStreamStatus(stream, opts);
    if (rc != c.ZC_OK) return rc;
    rc = core.zc_check_image_metadata(opts, profile, metadata);
    if (rc != c.ZC_OK) return rc;
    if (opts.format == c.ZC_IMAGE_DNG) return zc_remote_frame_encode_dng(p, out);
    var selected: c.zc_stream = undefined;
    rc = zc_remote_frame_stream(p, stream, &selected);
    if (rc != c.ZC_OK) return rc;
    const still = @import("still.zig");
    const rgb = @import("stream_rgb.zig");
    const size = rgb.size(selected) catch return c.ZC_INVALID;
    const wide = @import("processed_format.zig").isWide(std.mem.sliceTo(&selected.format, 0)) and opts.format != c.ZC_IMAGE_JPEG;
    if (size > maximum / @as(usize, if (wide) 2 else 1)) return c.ZC_INVALID;
    var color: c.zc_color_space = undefined;
    for (owner(p).info.streams[0..owner(p).info.stream_count], 0..) |description, i| {
        if (description.stream == stream) {
            color = owner(p).info.colors[i];
            break;
        }
    }
    still.checkProfileSource(profile, color) catch |err| return still.status(err);
    const generated = @import("remote_exif.zig").generate(A, owner(p).info.metadata, owner(p).raw_metadata, selected, owner(p).catalog, metadata) catch |err| return still.status(err);
    defer if (generated) |bytes| A.free(bytes);
    var empty = std.mem.zeroes(c.zc_frame);
    empty.exposure_us = owner(p).info.metadata.exposure_us;
    var source = rgb.Selected.image(A, empty, selected, color, opts.format) catch |err| return still.status(err);
    defer source.deinit(A);
    const bytes = still.encodeMetadata(A, &source.frame, null, opts, profile, generated orelse @import("exif.zig").bytes(metadata)) catch |err| return still.status(err);
    var transferred = false;
    defer if (!transferred) A.free(bytes);
    if (bytes.len > maximum) return c.ZC_INVALID;
    const blob = A.create(still.Blob) catch return c.ZC_NOMEM;
    blob.* = .{ .bytes = bytes };
    out.* = @ptrCast(blob);
    transferred = true;
    return c.ZC_OK;
}
pub export fn zc_remote_frame_save_image_metadata(p: *const c.zc_remote_frame, stream: u32, path: [*:0]const u8, opts: *const c.zc_image_options, profile: ?*const c.zc_image_profile, metadata: ?*const c.zc_image_exif) c_int {
    var blob: ?*c.zc_image_blob = null;
    const rc = zc_remote_frame_encode_image_metadata(p, stream, opts, profile, metadata, &blob);
    if (rc != c.ZC_OK) return rc;
    defer @import("core.zig").zc_image_blob_close(blob.?);
    const encoded: *const @import("still.zig").Blob = @ptrCast(@alignCast(blob.?));
    var atom = std.fs.cwd().atomicFile(std.mem.span(path), .{ .write_buffer = &.{} }) catch return c.ZC_IO;
    defer atom.deinit();
    atom.file_writer.file.writeAll(encoded.bytes) catch return c.ZC_IO;
    atom.finish() catch return c.ZC_IO;
    return c.ZC_OK;
}

pub export fn zc_remote_frame_configuration_copy(p: *const c.zc_remote_frame, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    return @import("frame_configuration.zig").copy(owner(p).catalog, data, capacity, length);
}
