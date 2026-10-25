//! IMX708 pre-open sensor-layout controls. Public ownership and bounded snapshots
//! live here; the SDK bridge only provides an exclusive temporary manager scope.
const std = @import("std");
const c = @import("abi.zig").c;
const options = @import("options");
const A = std.heap.c_allocator;
const Tuning = @import("tuning_session.zig");
const Linux = @import("imx708_linux.zig");
const Identity = @import("home/device_identity.zig").Identity(c.ZC_MAX_CAMERA_ID);
const Boolean = @import("home/boolean_control.zig");
const Catalog = @import("catalog.zig");
const Wire = Catalog.wire;
const Sim = @import("sensor_hdr_sim.zig");
extern fn zcd_imx708_mutate([*]const u8, u32, ?*anyopaque, *const fn (?*anyopaque) callconv(.c) c_int) c_int;
var registry: std.Thread.Mutex = .{};
var live: usize = 0;
const Owner = struct {
    operation: std.Thread.Mutex = .{},
    backend: u32,
    identity: Identity,
    device: ?Linux.Device = null,
};
fn owner(p: *c.zc_imx708) *Owner {
    return @ptrCast(@alignCast(p));
}
fn status(err: anyerror) c_int {
    return switch (err) {
        error.OutOfMemory => c.ZC_NOMEM,
        error.Busy, error.ScanLimit => c.ZC_BUSY,
        error.Unsupported, error.NoSensorNode, error.NoCamera => c.ZC_UNSUPPORTED,
        error.Disconnected => c.ZC_DISCONNECTED,
        error.AmbiguousSensor, error.Device, error.ControlNotApplied => c.ZC_DEVICE,
        error.InvalidCatalog, error.InvalidIdentity, error.IdentityTooLong, error.InvalidString, error.InvalidStringQuery, error.AmbiguousString => c.ZC_INVALID,
        else => c.ZC_IO,
    };
}
fn selected(reader: Wire.Reader, backend: u32, index: u32, requested: ?Identity) !Identity {
    return @import("sensor_discovery.zig").selected(reader, backend, index, requested, "imx708");
}
fn discover(backend: u32, index: u32, requested: ?Identity) !Identity {
    return @import("sensor_discovery.zig").discover(backend, index, requested, "imx708");
}
pub export fn zc_imx708_open(backend: u32, index: u32, id: ?[*]const u8, length: u32, out: *?*c.zc_imx708) c_int {
    out.* = null;
    if (backend > 1 or length > c.ZC_MAX_CAMERA_ID or (id == null) != (length == 0) or (length != 0 and index != std.math.maxInt(u32))) return c.ZC_INVALID;
    if (backend == c.ZC_LIBCAMERA and !options.libcamera) return c.ZC_UNSUPPORTED;
    const requested: ?Identity = if (id) |bytes| Identity.init(bytes[0..length]) catch return c.ZC_INVALID else null;
    registry.lock();
    if (live == 16) {
        registry.unlock();
        return c.ZC_BUSY;
    }
    live += 1;
    registry.unlock();
    var success = false;
    defer if (!success) {
        registry.lock();
        live -= 1;
        registry.unlock();
    };
    const self = A.create(Owner) catch return c.ZC_NOMEM;
    defer if (!success) A.destroy(self);
    self.* = .{ .backend = backend, .identity = discover(backend, index, requested) catch |err| return status(err) };
    if (backend == c.ZC_LIBCAMERA) {
        if (options.libcamera) self.device = Linux.Device.open(self.identity) catch |err| return status(err) else return c.ZC_UNSUPPORTED;
    }
    out.* = @ptrCast(self);
    success = true;
    return c.ZC_OK;
}
fn state(self: *Owner, out: *c.zc_sensor_hdr_state) void {
    var tuning: c.zc_tuning_state = undefined;
    _ = Tuning.zc_get_tuning_state(self.backend, &tuning);
    out.* = .{ .struct_size = @sizeOf(c.zc_sensor_hdr_state), .backend = self.backend, .flags = if (self.backend == c.ZC_SYNTHETIC) c.ZC_SENSOR_HDR_SYNTHETIC else 0, .system_errno = 0, .manager_generation = tuning.generation, .enabled = 0, .previous_enabled = 0 };
}
fn refreshGeneration(self: *Owner, out: *c.zc_sensor_hdr_state) void {
    var tuning: c.zc_tuning_state = undefined;
    _ = Tuning.zc_get_tuning_state(self.backend, &tuning);
    out.manager_generation = tuning.generation;
}
fn observed(out: *c.zc_sensor_hdr_state, result: Boolean.Outcome) void {
    if (result.current != null) out.flags |= c.ZC_SENSOR_HDR_CURRENT;
    if (result.previous != null) out.flags |= c.ZC_SENSOR_HDR_PREVIOUS;
    if (result.changed() orelse false) out.flags |= c.ZC_SENSOR_HDR_CHANGED;
    if (result.write_attempted) out.flags |= c.ZC_SENSOR_HDR_WRITE_ATTEMPTED;
    if (result.write_succeeded) out.flags |= c.ZC_SENSOR_HDR_WRITE_SUCCEEDED;
    out.enabled = @intFromBool(result.current orelse false);
    out.previous_enabled = @intFromBool(result.previous orelse false);
}
pub export fn zc_imx708_camera_id(p: *c.zc_imx708, data: ?[*]u8, capacity: u64, length: *u64) c_int {
    const self = owner(p);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    defer self.operation.unlock();
    const bytes = self.identity.bytes();
    length.* = bytes.len;
    if (data) |destination| {
        if (capacity < bytes.len) return c.ZC_INVALID;
        @memcpy(destination[0..bytes.len], bytes);
    } else if (capacity != 0) return c.ZC_INVALID;
    return c.ZC_OK;
}
pub export fn zc_imx708_get_hdr_mode(p: *c.zc_imx708, out: *c.zc_sensor_hdr_state) c_int {
    const self = owner(p);
    state(self, out);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    defer self.operation.unlock();
    if (self.backend == c.ZC_SYNTHETIC) {
        out.flags |= c.ZC_SENSOR_HDR_CURRENT;
        out.enabled = @intFromBool(Sim.enabled());
        return c.ZC_OK;
    }
    if (options.libcamera) {
        const device = &self.device.?;
        device.reset();
        device.validate() catch |err| {
            out.system_errno = device.first_errno;
            return status(err);
        };
        out.enabled = @intFromBool(device.read() catch |err| {
            out.system_errno = device.first_errno;
            return status(err);
        });
        out.flags |= c.ZC_SENSOR_HDR_CURRENT;
        return c.ZC_OK;
    }
    return c.ZC_UNSUPPORTED;
}
const VirtualIo = struct {
    pub fn validate(_: *@This()) !void {}
    pub fn read(_: *@This()) !bool {
        return Sim.enabled();
    }
    pub fn write(_: *@This(), enabled: bool) !void {
        Sim.set(enabled);
    }
};
const Apply = struct { self: *Owner, out: *c.zc_sensor_hdr_state, enabled: bool };
fn physicalApply(context: ?*anyopaque) callconv(.c) c_int {
    const input: *Apply = @ptrCast(@alignCast(context.?));
    const device = &input.self.device.?;
    device.reset();
    const result = Boolean.apply(device, input.enabled);
    observed(input.out, result);
    input.out.system_errno = device.first_errno;
    return if (result.failure) |err| status(err) else c.ZC_OK;
}
pub export fn zc_imx708_set_hdr_mode(p: *c.zc_imx708, enabled: u32, out: *c.zc_sensor_hdr_state) c_int {
    const self = owner(p);
    state(self, out);
    if (enabled > 1) return c.ZC_INVALID;
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    defer self.operation.unlock();
    var rc: c_int = c.ZC_UNSUPPORTED;
    if (self.backend == c.ZC_SYNTHETIC) {
        rc = Tuning.beginExclusive(self.backend);
        if (rc != c.ZC_OK) return rc;
        var io = VirtualIo{};
        const result = Boolean.apply(&io, enabled != 0);
        observed(out, result);
        const cleanup = Tuning.endExclusive(self.backend);
        rc = if (result.failure) |err| status(err) else cleanup;
    } else if (options.libcamera) {
        var input = Apply{ .self = self, .out = out, .enabled = enabled != 0 };
        const identity = self.identity.bytes();
        rc = zcd_imx708_mutate(identity.ptr, @intCast(identity.len), &input, physicalApply);
    }
    if (out.flags & c.ZC_SENSOR_HDR_WRITE_ATTEMPTED != 0) out.flags |= c.ZC_SENSOR_HDR_CATALOG_INVALIDATED;
    refreshGeneration(self, out);
    return rc;
}
pub export fn zc_imx708_close(p: ?*c.zc_imx708) c_int {
    const self = owner(p orelse return c.ZC_OK);
    if (!self.operation.tryLock()) return c.ZC_BUSY;
    if (self.device) |*device| device.close();
    self.operation.unlock();
    A.destroy(self);
    registry.lock();
    live -= 1;
    registry.unlock();
    return c.ZC_OK;
}

fn fixture(writer: *Wire.Writer, group: u32, id: []const u8, model: ?[]const u8) !void {
    try writer.begin(.{ .group = group, .name = "CameraId", .kind = .string });
    try writer.append(.{ .kind = .string, .flags = Wire.array, .count = @intCast(id.len), .data = id });
    try writer.end();
    if (model) |name| {
        try writer.begin(.{ .group = group, .name = "Model", .kind = .string });
        try writer.append(.{ .kind = .string, .flags = Wire.array, .count = @intCast(name.len), .data = name });
        try writer.end();
    }
}
test "IMX708 selection owns exact IDs validates all groups and skips unrelated models" {
    const t = std.testing;
    var writer = try Wire.Writer.init(t.allocator, c.ZC_CATALOG_DISCOVERY, 8192);
    defer writer.deinit();
    const id = "/base/soc/i2c@1/imx708@1a";
    try fixture(&writer, 0, "/base/soc/unknown@1a", null);
    try fixture(&writer, 1, id, "imx708");
    const reader = try Wire.Reader.init(try writer.finish());
    const automatic = try selected(reader, c.ZC_LIBCAMERA, std.math.maxInt(u32), null);
    const indexed = try selected(reader, c.ZC_LIBCAMERA, 1, null);
    const exact = try selected(reader, c.ZC_LIBCAMERA, std.math.maxInt(u32), try Identity.init(id));
    try t.expectEqualStrings(id, automatic.bytes());
    try t.expectEqualStrings(id, indexed.bytes());
    try t.expectEqualStrings(id, exact.bytes());
    try t.expectError(error.Unsupported, selected(reader, c.ZC_LIBCAMERA, 0, null));
    try t.expectError(error.NoCamera, selected(reader, c.ZC_LIBCAMERA, std.math.maxInt(u32), try Identity.init("/base/soc/i2c@1/imx708@1")));
    try writer.begin(.{ .group = 1, .name = "Model", .kind = .string });
    try writer.append(.{ .kind = .string, .flags = Wire.array, .count = 6, .data = "imx708" });
    try writer.end();
    try t.expectError(error.AmbiguousString, selected(try Wire.Reader.init(try writer.finish()), c.ZC_LIBCAMERA, std.math.maxInt(u32), null));
    @memset(writer.bytes.items, 0);
    try t.expectEqualStrings(id, automatic.bytes());
}
fn testOpen() !*c.zc_imx708 {
    var out: ?*c.zc_imx708 = null;
    try std.testing.expectEqual(c.ZC_OK, zc_imx708_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), null, 0, &out));
    return out.?;
}
fn testRestore(p: *c.zc_imx708) void {
    var value: c.zc_sensor_hdr_state = undefined;
    std.debug.assert(zc_imx708_set_hdr_mode(p, 0, &value) == c.ZC_OK);
    std.debug.assert(zc_imx708_close(p) == c.ZC_OK);
}
test "sensor HDR requires idle camera and watch ownership and next opens receive fresh mode catalogs" {
    if (options.libcamera) return error.SkipZigTest;
    const t = std.testing;
    const core = @import("core.zig");
    const p = try testOpen();
    defer testRestore(p);
    var state_value: c.zc_sensor_hdr_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_imx708_set_hdr_mode(p, 0, &state_value));
    try t.expectEqual(c.ZC_OK, zc_imx708_set_hdr_mode(p, 1, &state_value));
    try t.expectEqual(@as(u32, 127), state_value.flags);
    try t.expect(state_value.enabled == 1 and state_value.previous_enabled == 0);
    const generation = state_value.manager_generation;
    try t.expectEqual(c.ZC_OK, zc_imx708_set_hdr_mode(p, 1, &state_value));
    try t.expectEqual(@as(u32, 67), state_value.flags);
    try t.expect(state_value.manager_generation > generation);
    var cfg: c.zc_config = undefined;
    core.zc_default_config(&cfg);
    cfg.width = 18;
    cfg.height = 10;
    var camera: ?*c.zc_camera = null;
    defer if (camera) |handle| {
        _ = core.zc_close(handle);
    };
    try t.expectEqual(c.ZC_OK, core.zc_open(&cfg, &camera));
    var count: u32 = 0;
    try t.expectEqual(c.ZC_OK, core.zc_get_sensor_modes(camera.?, null, 0, &count));
    try t.expectEqual(@as(u32, 1), count);
    try t.expectEqual(c.ZC_BUSY, zc_imx708_set_hdr_mode(p, 0, &state_value));
    try t.expectEqual(c.ZC_OK, zc_imx708_get_hdr_mode(p, &state_value));
    try t.expectEqual(@as(u32, 1), state_value.enabled);
    try t.expectEqual(c.ZC_OK, core.zc_close(camera.?));
    camera = null;
    var watch: ?*c.zc_camera_watch = null;
    const hotplug = @import("hotplug.zig");
    try t.expectEqual(c.ZC_OK, hotplug.zc_camera_watch_open(c.ZC_SYNTHETIC, 2, &watch));
    try t.expectEqual(c.ZC_BUSY, zc_imx708_set_hdr_mode(p, 0, &state_value));
    try t.expectEqual(c.ZC_OK, hotplug.zc_camera_watch_close(watch.?));
    try t.expectEqual(c.ZC_OK, zc_imx708_set_hdr_mode(p, 0, &state_value));
    try t.expectEqual(c.ZC_OK, core.zc_open(&cfg, &camera));
    try t.expectEqual(c.ZC_OK, core.zc_get_sensor_modes(camera.?, null, 0, &count));
    try t.expectEqual(@as(u32, 3), count);
    try t.expectEqual(c.ZC_OK, core.zc_close(camera.?));
    camera = null;
}
test "IMX708 descriptors are bounded copied exact and close preserves sensor setting" {
    const t = std.testing;
    var id: [9]u8 = "synthetic".*;
    var p: ?*c.zc_imx708 = null;
    try t.expectEqual(c.ZC_OK, zc_imx708_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), &id, id.len, &p));
    @memset(&id, 0);
    var output: [9]u8 = @splat(99);
    var length: u64 = 0;
    try t.expectEqual(c.ZC_INVALID, zc_imx708_camera_id(p.?, &output, 8, &length));
    try t.expectEqualSlices(u8, &(@as([9]u8, @splat(99))), &output);
    try t.expectEqual(c.ZC_OK, zc_imx708_camera_id(p.?, &output, 9, &length));
    try t.expectEqualStrings("synthetic", &output);
    var state_value: c.zc_sensor_hdr_state = undefined;
    try t.expectEqual(c.ZC_OK, zc_imx708_set_hdr_mode(p.?, 1, &state_value));
    try t.expectEqual(c.ZC_OK, zc_imx708_close(p.?));
    p = null;
    p = try testOpen();
    defer testRestore(p.?);
    try t.expectEqual(c.ZC_OK, zc_imx708_get_hdr_mode(p.?, &state_value));
    try t.expectEqual(@as(u32, 1), state_value.enabled);
    const handle = owner(p.?);
    handle.operation.lock();
    try t.expectEqual(c.ZC_BUSY, zc_imx708_close(p));
    handle.operation.unlock();
    try t.expectEqual(c.ZC_INVALID, zc_imx708_set_hdr_mode(p.?, 2, &state_value));
    var helpers: [15]?*c.zc_imx708 = @splat(null);
    defer for (helpers) |item| {
        _ = zc_imx708_close(item);
    };
    for (&helpers) |*item| item.* = try testOpen();
    var rejected: ?*c.zc_imx708 = @ptrFromInt(1);
    try t.expectEqual(c.ZC_BUSY, zc_imx708_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), null, 0, &rejected));
    try t.expect(rejected == null);
}
test "IMX708 invalid selection and unknown observations never publish fictitious control state" {
    const t = std.testing;
    for (0..5) |fault| {
        var out: ?*c.zc_imx708 = @ptrFromInt(1);
        const code = switch (fault) {
            0 => zc_imx708_open(2, 0, null, 0, &out),
            1 => zc_imx708_open(c.ZC_SYNTHETIC, 0, "synthetic".ptr, 9, &out),
            2 => zc_imx708_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), "synthetic".ptr, 0, &out),
            3 => zc_imx708_open(c.ZC_SYNTHETIC, std.math.maxInt(u32), "bad\x00id".ptr, 6, &out),
            4 => zc_imx708_open(c.ZC_SYNTHETIC, 1, null, 0, &out),
            else => unreachable,
        };
        try t.expectEqual(if (fault == 4) c.ZC_UNSUPPORTED else c.ZC_INVALID, code);
        try t.expect(out == null);
    }
    var value = std.mem.zeroes(c.zc_sensor_hdr_state);
    observed(&value, .{ .previous = false, .current = null, .write_attempted = true, .write_succeeded = true, .failure = error.InputOutput });
    try t.expect(value.flags & c.ZC_SENSOR_HDR_CURRENT == 0);
    try t.expect(value.flags & c.ZC_SENSOR_HDR_PREVIOUS != 0);
    try t.expect(value.flags & c.ZC_SENSOR_HDR_CHANGED == 0);
    try t.expectEqual(@as(u32, 0), value.previous_enabled);
}
