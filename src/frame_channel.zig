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
const packet_size = header_size + info_size;
const maximum = 256 * 1024 * 1024;
const Admission = @import("home/owned_admission.zig").Registry(32);
var admission: Admission = .{ .max_bytes = 512 * 1024 * 1024, .max_items = 32 };
var mutex: std.Thread.Mutex = .{};
const Remote = struct {
    ticket: Admission.Ticket,
    info: c.zc_export_info,
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
    put(u16, &bytes, 4, 1);
    put(u16, &bytes, 6, kind);
    put(u32, &bytes, 8, if (kind == 1) info_size else 0);
    put(u32, &bytes, 12, fds);
    put(u64, &bytes, 16, cookie);
    put(u64, &bytes, 24, catalog);
    return bytes;
}
fn validHeader(bytes: []const u8, kind: u16) bool {
    return bytes.len >= header_size and std.mem.eql(u8, bytes[0..4], "ZCFD") and get(u16, bytes, 4) == 1 and get(u16, bytes, 6) == kind and get(u32, bytes, 8) == (if (kind == 1) @as(u32, info_size) else 0) and get(u64, bytes, 16) != 0;
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
    @memcpy(packet[header_size..], std.mem.asBytes(&info));
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
    if (record.bytes != packet_size or !validHeader(&packet, 1)) return c.ZC_INVALID;
    var info: c.zc_export_info = undefined;
    @memcpy(std.mem.asBytes(&info), packet[header_size..]);
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
    self.* = .{ .ticket = ticket, .info = info, .catalog = catalog };
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
    bytes[4] = 2;
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
        var bytes: [packet_size]u8 = undefined;
        bytes[0..header_size].* = header(1, 1, original.plane_count + 1, metadata_size);
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
    try t.expectEqual(c.ZC_OK, zc_remote_frame_close(remote.?));
    const ack = header(2, 77, 1, 0);
    try channel.send(ends.ends[0].value, &ack, &.{tiny.fd.value});
    try t.expectEqual(c.ZC_INVALID, zc_frame_channel_receive_ack(ends.ends[1].value, &cookie));
    try t.expectEqual(before, descriptorCount());
}
