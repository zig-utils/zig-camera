const std = @import("std");
const options = @import("options");
const c = @import("abi.zig").c;
pub const bridge = @cImport({
    @cInclude("zig_camera_allocator_bridge.h");
});
pub const Home = @import("home/capture_backing.zig");
const backend: u32 = if (options.libcamera) c.ZC_LIBCAMERA else c.ZC_SYNTHETIC;
const Provider = if (options.libcamera) @import("home/capture_dma_heap.zig").LinuxHeap else Home.Ram;
const Owner = Home.Owner(16, Provider);
const linux = @import("builtin").os.tag == .linux;
const ImportProvider = if (linux) @import("home/capture_import_linux.zig").Linux(@import("home/posix_shared_memory.zig")) else Home.Ram;
const ImportedOwner = Home.Owner(16, ImportProvider);
const Storage = union(enum) {
    managed: Owner,
    imported: ImportedOwner,
    pub fn cache(self: *Storage) *Owner.Cache {
        return switch (self.*) {
            inline else => |*value| &value.cache,
        };
    }
    fn checkoutEvictingConcurrent(self: *Storage, layout: *const Home.policy.Layout) !Owner.Cache.Checkout {
        return switch (self.*) {
            .managed => |*value| value.checkoutEvictingConcurrent(layout),
            .imported => |*value| value.checkoutExisting(layout),
        };
    }
    fn view(self: *Storage, claim: Home.policy.Claim, stream: u32, buffer: u32, writable: bool) !Home.View {
        return switch (self.*) {
            inline else => |*value| value.view(claim, stream, buffer, writable),
        };
    }
    fn planeCount(self: *Storage, claim: Home.policy.Claim, stream: u32, buffer: u32) !u8 {
        return switch (self.*) {
            inline else => |*value| value.planeCount(claim, stream, buffer),
        };
    }
    fn viewPlane(self: *Storage, claim: Home.policy.Claim, stream: u32, buffer: u32, plane: u32, writable: bool) !Home.View {
        return switch (self.*) {
            inline else => |*value| value.viewPlane(claim, stream, buffer, plane, writable),
        };
    }
    fn trim(self: *Storage) !void {
        return switch (self.*) {
            inline else => |*value| value.trim(),
        };
    }
    fn close(self: *Storage) !void {
        return switch (self.*) {
            inline else => |*value| value.close(),
        };
    }
    fn release(self: *Storage, claim: Home.policy.Claim) !void {
        return switch (self.*) {
            inline else => |*value| value.release(claim),
        };
    }
    pub fn discard(self: *Storage, claim: Home.policy.Claim) !void {
        return switch (self.*) {
            inline else => |*value| value.discard(claim),
        };
    }
};
pub const Pool = struct {
    mutex: std.Thread.Mutex = .{},
    owner: Storage,
    factory: @import("capture_factory.zig").State = .{},
    pins: @import("home/lease_pool.zig").Pool(1, 257) = .{},
    root_pin: u64 = 0,
    closing: bool = false,
    fn handle(self: *Pool) *c.zc_capture_allocator {
        return @ptrCast(self);
    }
};
pub fn factoryPool(handle: *c.zc_capture_allocator) *Pool {
    return pool(handle);
}
pub fn factoryStatus(failure: anyerror) c_int {
    return status(failure);
}
fn pool(handle: *c.zc_capture_allocator) *Pool {
    return @ptrCast(@alignCast(handle));
}
fn status(failure: anyerror) c_int {
    return switch (failure) {
        error.Busy, error.BufferFull, error.LayoutBusy, error.ResourceBusy, error.ReferenceLimit => c.ZC_BUSY,
        error.OutOfMemory => c.ZC_NOMEM,
        error.Unsupported, error.LayoutUnavailable => c.ZC_UNSUPPORTED,
        error.StaleClaim, error.StaleLease, error.StaleTicket => c.ZC_STALE,
        error.SequenceExhausted, error.SequenceOverflow, error.InvalidState => c.ZC_STATE,
        error.OverlappingPlanes, error.AliasedResource, error.InvalidLayout, error.InvalidPath, error.InvalidResource, error.InvalidConfiguration, error.SizeOverflow, error.PayloadTooLarge => c.ZC_INVALID,
        else => c.ZC_IO,
    };
}
pub export fn zc_default_capture_allocator_config(out: *c.zc_capture_allocator_config) void {
    out.* = .{ .struct_size = @sizeOf(c.zc_capture_allocator_config), .backend = backend, .max_entries = 4, .reserved = 0, .max_bytes = 512 * 1024 * 1024 };
}
pub export fn zc_capture_allocator_open(config: *const c.zc_capture_allocator_config, path: ?[*]const u8, length: u32, out: *?*c.zc_capture_allocator) c_int {
    out.* = null;
    if (config.struct_size != @sizeOf(c.zc_capture_allocator_config) or config.reserved != 0 or config.max_entries == 0 or config.max_entries > 16 or config.max_bytes == 0 or config.max_bytes > @as(u64, 8) * 1024 * 1024 * 1024 or
        ((path == null) != (length == 0)) or length > 4096) return c.ZC_INVALID;
    if (config.backend != backend) return c.ZC_UNSUPPORTED;
    if (!options.libcamera and length != 0) return c.ZC_INVALID;
    const self = std.heap.c_allocator.create(Pool) catch return c.ZC_NOMEM;
    const provider: Provider = if (options.libcamera) Provider.open(if (path) |bytes| bytes[0..length] else null) catch |failure| {
        std.heap.c_allocator.destroy(self);
        return status(failure);
    } else .{ .allocator = std.heap.c_allocator };
    self.* = .{ .owner = .{ .managed = Owner.initWithAllocator(provider, @intCast(config.max_bytes), config.max_entries, std.heap.c_allocator) catch unreachable } };
    self.root_pin = self.pins.acquire(0) catch unreachable;
    out.* = self.handle();
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_pin(handle: *c.zc_capture_allocator, out: *u64) c_int {
    out.* = 0;
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.closing) return c.ZC_STATE;
    out.* = self.pins.retain(self.root_pin) catch |failure| return status(failure);
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_open_imported(config: *const c.zc_capture_allocator_config, out: *?*c.zc_capture_allocator) c_int {
    out.* = null;
    if (config.struct_size != @sizeOf(c.zc_capture_allocator_config) or config.reserved != 0 or config.max_entries == 0 or config.max_entries > 16 or
        config.max_bytes == 0 or config.max_bytes > @as(u64, 8) * 1024 * 1024 * 1024) return c.ZC_INVALID;
    if (!linux or config.backend != backend) return c.ZC_UNSUPPORTED;
    if (comptime linux) {
        const self = std.heap.c_allocator.create(Pool) catch return c.ZC_NOMEM;
        self.* = .{ .owner = .{ .imported = ImportedOwner.initWithAllocator(.{ .dma_buf = options.libcamera }, @intCast(config.max_bytes), config.max_entries, std.heap.c_allocator) catch unreachable } };
        self.root_pin = self.pins.acquire(0) catch unreachable;
        out.* = self.handle();
        return c.ZC_OK;
    } else return c.ZC_UNSUPPORTED;
}
pub export fn zc_capture_allocator_import(handle: *c.zc_capture_allocator, id: ?[*]const u8, id_length: u32, streams: ?[*]const c.zc_capture_import_stream, count: u32, buffers: ?[*]const c.zc_capture_import_buffer, buffer_count: u32) c_int {
    if (id == null or id_length == 0 or id_length > c.ZC_MAX_CAMERA_ID or streams == null or count == 0 or count > Home.policy.max_streams or
        buffers == null or buffer_count == 0 or buffer_count > Home.policy.max_streams * Home.policy.max_buffers) return c.ZC_INVALID;
    var descriptors: [Home.policy.max_streams]Home.policy.Stream = undefined;
    var expected: usize = 0;
    for (streams.?[0..count], 0..) |stream, i| {
        if (stream.buffer_count < 2 or stream.buffer_count > c.ZC_MAX_BUFFERS or stream.frame_bytes > std.math.maxInt(u32)) return c.ZC_INVALID;
        descriptors[i] = Home.policy.Stream.init(stream.width, stream.height, stream.stride, stream.frame_bytes, stream.buffer_count, std.mem.sliceTo(&stream.format, 0), stream.modifier) catch return c.ZC_INVALID;
        expected += stream.buffer_count;
    }
    if (expected != buffer_count) return c.ZC_INVALID;
    var inputs: [Home.policy.max_streams * Home.policy.max_buffers]Home.ImportBuffer = undefined;
    for (buffers.?[0..buffer_count], 0..) |buffer, i| {
        if (buffer.reserved != 0 or buffer.fd < 0) return c.ZC_INVALID;
        inputs[i] = .{ .fd = buffer.fd, .offset = buffer.offset };
    }
    const layout = Home.policy.Layout.init(id.?[0..id_length], descriptors[0..count]) catch return c.ZC_INVALID;
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.closing) return c.ZC_STATE;
    if (comptime linux) switch (self.owner) {
        .managed => return c.ZC_STATE,
        .imported => |*value| value.importBuffers(&layout, inputs[0..buffer_count]) catch |failure| return status(failure),
    } else return c.ZC_UNSUPPORTED;
    return c.ZC_OK;
}
/// Pointer-free input decoding shared by explicit import and factory supply.
pub fn decodeFrames(layout: *const Home.policy.Layout, inputs: []const c.zc_capture_import_frame, out: *[192]Home.ImportFrame) ![]const Home.ImportFrame {
    var expected: usize = 0;
    for (layout.streams[0..layout.stream_count]) |stream| expected += stream.buffer_count;
    if (inputs.len != expected or inputs.len > out.len) return error.InvalidResource;
    var at: usize = 0;
    for (layout.streams[0..layout.stream_count]) |stream| for (0..stream.buffer_count) |_| {
        out[at] = try @import("capture_planes.zig").decode(&inputs[at]);
        try @import("capture_planes.zig").validate(&stream, &out[at]);
        at += 1;
    };
    return out[0..at];
}
pub export fn zc_capture_allocator_import_frames(handle: *c.zc_capture_allocator, id: ?[*]const u8, id_length: u32, streams: ?[*]const c.zc_capture_import_stream, count: u32, buffers: ?[*]const c.zc_capture_import_frame, buffer_count: u32) c_int {
    if (id == null or id_length == 0 or id_length > c.ZC_MAX_CAMERA_ID or streams == null or count == 0 or count > Home.policy.max_streams or
        buffers == null or buffer_count == 0 or buffer_count > 192) return c.ZC_INVALID;
    var descriptors: [Home.policy.max_streams]Home.policy.Stream = undefined;
    for (streams.?[0..count], 0..) |stream, i| {
        if (stream.buffer_count < 2 or stream.buffer_count > c.ZC_MAX_BUFFERS or stream.frame_bytes > std.math.maxInt(u32)) return c.ZC_INVALID;
        descriptors[i] = Home.policy.Stream.init(stream.width, stream.height, stream.stride, stream.frame_bytes, stream.buffer_count, std.mem.sliceTo(&stream.format, 0), stream.modifier) catch return c.ZC_INVALID;
    }
    const layout = Home.policy.Layout.init(id.?[0..id_length], descriptors[0..count]) catch return c.ZC_INVALID;
    var decoded: [192]Home.ImportFrame = undefined;
    const frames = decodeFrames(&layout, buffers.?[0..buffer_count], &decoded) catch |failure| return status(failure);
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.closing) return c.ZC_STATE;
    if (comptime linux) switch (self.owner) {
        .managed => return c.ZC_STATE,
        .imported => |*value| value.importFrames(&layout, frames) catch |failure| return status(failure),
    } else return c.ZC_UNSUPPORTED;
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_unpin(handle: *c.zc_capture_allocator, token: u64) c_int {
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (token == self.root_pin) return c.ZC_STALE;
    const final = self.pins.release(token) catch |failure| return status(failure);
    std.debug.assert(!final);
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_state_get(handle: *c.zc_capture_allocator, out: *c.zc_capture_allocator_state) c_int {
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    const cache = self.owner.cache();
    out.* = std.mem.zeroes(c.zc_capture_allocator_state);
    out.struct_size = @sizeOf(c.zc_capture_allocator_state);
    out.backend = backend;
    out.max_entries = @intCast(cache.reservations.max_items);
    out.entries = @intCast(cache.reservations.count);
    out.borrowed = @intCast(cache.owners.used);
    out.pins = @intCast(self.pins.used - 1);
    out.max_bytes = cache.reservations.max_bytes;
    out.used_bytes = cache.reservations.used;
    out.high_bytes = cache.reservations.high_bytes;
    out.preparations = cache.preparations;
    out.reuses = cache.reuses;
    out.retired = cache.retired;
    out.closing = @intFromBool(self.closing);
    switch (self.owner) {
        inline else => |*owner| {
            for (owner.retirements) |retirement| if (retirement != null) {
                out.retiring += 1;
            };
            out.allocations = owner.allocations;
            out.writable_maps = owner.writable_maps;
            out.cleanup_errors = owner.cleanup_errors;
            if (@hasField(@TypeOf(owner.provider), "last_errno")) out.last_errno = owner.provider.last_errno;
        },
    }
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_trim(handle: *c.zc_capture_allocator) c_int {
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.owner.trim() catch |failure| return status(failure);
    return c.ZC_OK;
}
pub export fn zc_capture_allocator_close(handle: *c.zc_capture_allocator) c_int {
    const self = pool(handle);
    self.mutex.lock();
    if (self.pins.used != 1 or self.owner.cache().owners.used != 0) {
        self.mutex.unlock();
        return c.ZC_BUSY;
    }
    self.closing = true;
    self.owner.close() catch |failure| {
        self.mutex.unlock();
        return status(failure);
    };
    const final = self.pins.release(self.root_pin) catch unreachable;
    std.debug.assert(final);
    self.mutex.unlock();
    std.heap.c_allocator.destroy(self);
    return c.ZC_OK;
}
pub fn borrow(handle: *c.zc_capture_allocator, id: []const u8, streams: []const Home.policy.Stream, out: *u64) c_int {
    out.* = 0;
    const layout = Home.policy.Layout.init(id, streams) catch |failure| return status(failure);
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    if (self.closing) return c.ZC_STATE;
    const result = self.owner.checkoutEvictingConcurrent(&layout) catch |failure| {
        const code = status(failure);
        if (failure == error.LayoutUnavailable or failure == error.LayoutBusy)
            return @import("capture_factory.zig").wait(self, handle, &layout, code, out);
        return code;
    };
    out.* = result.claim.token;
    return c.ZC_OK;
}
pub export fn zci_capture_allocator_acquire(handle: *c.zc_capture_allocator, id: ?[*]const u8, id_length: u32, streams: ?[*]const bridge.zci_allocation_stream, count: u32, out: *u64) c_int {
    out.* = 0;
    if (id == null or id_length == 0 or id_length > c.ZC_MAX_CAMERA_ID or streams == null or count == 0 or count > Home.policy.max_streams) return c.ZC_INVALID;
    var descriptors: [Home.policy.max_streams]Home.policy.Stream = undefined;
    for (streams.?[0..count], 0..) |stream, i| {
        if (stream.buffer_count < 2 or stream.buffer_count > c.ZC_MAX_BUFFERS or stream.frame_bytes > std.math.maxInt(u32)) return c.ZC_INVALID;
        descriptors[i] = Home.policy.Stream.init(stream.width, stream.height, stream.stride, stream.frame_bytes, stream.buffer_count, std.mem.sliceTo(&stream.format, 0), stream.modifier) catch |failure| return status(failure);
    }
    return borrow(handle, id.?[0..id_length], descriptors[0..count], out);
}
pub export fn zci_capture_allocator_frame(handle: *c.zc_capture_allocator, loan: u64, stream: u32, buffer: u32, writable: u32, out: *bridge.zci_allocation_frame) c_int {
    out.* = std.mem.zeroes(bridge.zci_allocation_frame);
    for (&out.planes) |*plane| plane.fd = -1;
    if (writable > 1) return c.ZC_INVALID;
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    const count = self.owner.planeCount(.{ .token = loan }, stream, buffer) catch |failure| return status(failure);
    for (0..count) |p| {
        const result = self.owner.viewPlane(.{ .token = loan }, stream, buffer, @intCast(p), writable != 0) catch |failure| return status(failure);
        out.planes[p] = .{ .data = result.bytes.ptr, .length = result.bytes.len, .frame_bytes = result.frame_bytes, .fd = result.fd, .reserved = 0, .offset = result.offset };
    }
    out.plane_count = count;
    return c.ZC_OK;
}
pub export fn zci_capture_allocator_buffer(handle: *c.zc_capture_allocator, loan: u64, stream: u32, buffer: u32, writable: u32, out: *bridge.zci_allocation_buffer) c_int {
    out.* = std.mem.zeroes(bridge.zci_allocation_buffer);
    out.fd = -1;
    if (writable > 1) return c.ZC_INVALID;
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    const result = self.owner.view(.{ .token = loan }, stream, buffer, writable != 0) catch |failure| return status(failure);
    out.* = .{ .data = result.bytes.ptr, .length = result.bytes.len, .frame_bytes = result.frame_bytes, .fd = result.fd, .reserved = 0, .offset = result.offset };
    return c.ZC_OK;
}
pub export fn zci_capture_allocator_release(handle: *c.zc_capture_allocator, loan: u64) void {
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    // Internal SDK ownership invariant. This is bookkeeping with no fallible
    // physical cleanup, so Device destructors cannot lose an I/O cleanup error.
    self.owner.release(.{ .token = loan }) catch @panic("capture allocator SDK loan released incorrectly");
}
pub export fn zci_capture_allocator_discard(handle: *c.zc_capture_allocator, loan: u64) void {
    const self = pool(handle);
    self.mutex.lock();
    defer self.mutex.unlock();
    self.owner.discard(.{ .token = loan }) catch @panic("capture allocator SDK loan discarded incorrectly");
}

test "allocator handle pins are bounded distinct and retained through failed close" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    var config: c.zc_capture_allocator_config = undefined;
    zc_default_capture_allocator_config(&config);
    var handle: ?*c.zc_capture_allocator = null;
    try t.expectEqual(c.ZC_OK, zc_capture_allocator_open(&config, null, 0, &handle));
    var tokens: [256]u64 = undefined;
    for (&tokens) |*token| try t.expectEqual(c.ZC_OK, zc_capture_allocator_pin(handle.?, token));
    var extra: u64 = 42;
    try t.expectEqual(c.ZC_BUSY, zc_capture_allocator_pin(handle.?, &extra));
    try t.expectEqual(@as(u64, 0), extra);
    try t.expectEqual(c.ZC_BUSY, zc_capture_allocator_close(handle.?));
    var state: c.zc_capture_allocator_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_capture_allocator_state_get(handle.?, &state));
    try t.expectEqual(@as(u32, 256), state.pins);
    for (tokens) |token| try t.expectEqual(c.ZC_OK, zc_capture_allocator_unpin(handle.?, token));
    try t.expectEqual(c.ZC_STALE, zc_capture_allocator_unpin(handle.?, tokens[0]));
    try t.expectEqual(c.ZC_STALE, zc_capture_allocator_unpin(handle.?, pool(handle.?).root_pin));
    try t.expectEqual(c.ZC_OK, zc_capture_allocator_close(handle.?));
    config.max_entries = 17;
    try t.expectEqual(c.ZC_INVALID, zc_capture_allocator_open(&config, null, 0, &handle));
    try t.expect(handle == null);
    config.max_entries = 1;
    config.backend = c.ZC_LIBCAMERA;
    try t.expectEqual(c.ZC_UNSUPPORTED, zc_capture_allocator_open(&config, null, 0, &handle));
    try t.expect(handle == null);
}
